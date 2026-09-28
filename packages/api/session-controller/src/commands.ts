/** Session commands whose activation policy is explicit at each Remote method. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart, FileAttachmentRef, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type { CommandExecution, CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import {
  ReasoningEffortId, assistantStreamChunks, boundContextSummary, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  SessionAttachmentDownload,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionHandoffRequest,
  SessionHandoffValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
} from './types.ts'

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
  ) {}

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
  }

  /**
   * Validate and install one Session-local model selection.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        try {
          await this.ctx.agentDefaultModel.saveSelection(selected)
        } catch (error) {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        }
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from one completed-turn prefix.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const lastSeq = source.events.at(-1)?.seq ?? -1
    const anchoredBoundary = atSeq === undefined
      ? undefined
      : source.events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
    const boundary = anchoredBoundary
      ?? (atSeq === undefined || atSeq > lastSeq
        ? source.events.findLast(event => event.type === 'turn/end')
        : undefined)
    if (boundary === undefined) {
      throw new RemoteError(
        'session/fork-unavailable',
        atSeq !== undefined && atSeq <= lastSeq
          ? `session "${request.sessionId}" has not completed the turn containing event ${String(atSeq)}`
          : `session "${request.sessionId}" has no completed turn to fork from`,
        { sessionId: request.sessionId },
      )
    }
    const cut = SessionLogOffset(boundary.seq + 1)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed: source.events.slice(0, cut),
        inheritedEventCount: cut,
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Continue one Session in a new one whose whole history is its condensed form.
   *
   * A long Session is retained in full for the life of the process, and neither
   * archiving it nor compacting it changes that: the archive set is a durable
   * flag, and compaction keeps the shadowed content in the log by contract. The
   * only thing that actually shrinks the working set is a Session whose log is
   * small, so this creates one and carries the condensation into it.
   *
   * The summary is the compaction backend's own output rather than a second
   * summarizer, so a continued Session is condensed the same way an in-place
   * `/compact` would condense it. A Session already condensed and untouched
   * since has nothing new to condense, so its newest recorded summary is
   * carried instead of refusing the handoff.
   *
   * The source is archived last, and a failure there does not discard the new
   * Session: it is reported in the result, because a caller that cannot open
   * the continuation has lost the work of producing it.
   * @param request - the Session to continue elsewhere.
   * @param signal - cancels the summarization, not the Session it produces.
   * @returns the new Session identity and whether its source was archived.
   */
  async handoff(request: SessionHandoffRequest, signal: AbortSignal): Promise<SessionHandoffValue> {
    const fail = (reason: string, message: string): RemoteError =>
      new RemoteError('session/handoff-unavailable', message, { sessionId: request.sessionId, reason })
    const observed = await this.observeForHandoff(request.sessionId)
    using source = observed
    // Resolved, never required to be live already. A deployment may
    // deliberately leave a Session with no Agent until an operation needs one
    // (`promoteOnHistoryOpen: false`), so the act of looking at a Session
    // cannot be what makes this operation possible — requiring a live Agent
    // here refuses on exactly the deployments that need condensing most.
    // The observation already in hand is what the resume is built from, so
    // resolution costs no second read.
    const found = await this.agents.resolveObservedAgent(source)
    if ('error' in found) throw found.error
    const agent = found.agent
    const summary = await this.condense(agent, fail, signal)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error: unknown) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve handoff workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        // No seed: the continuation is a new conversation, and its one opening
        // message is written below rather than inherited as a prefix.
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: false,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error: unknown) {
      throw new RemoteError(
        'gateway/internal',
        `failed to start the continuation of session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const continuation = this.ctx.sessions.get(childId)
    if (continuation === undefined) {
      throw new RemoteError(
        'gateway/internal',
        `continuation "${childId}" was created but is not in the Session store`,
        {},
      )
    }
    continuation.append('user/message', createUserMessage({
      content: carriedHistory(summary),
      source: handoffSource(),
    }), { surfaceOp: 'append' })
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error: unknown) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was continued but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    let archived = false
    try {
      await this.ctx.workspaceRegistry.archiveSession(request.sessionId)
      archived = true
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `handoff: continuation "${childId}" was created but archiving "${request.sessionId}" failed: ${String(error)}`,
      )
    }
    return { sessionId: childId, archived }
  }

  /** Observe one handoff source, mapping its absence the way `fork` does. */
  private async observeForHandoff(sessionId: SessionId): Promise<SessionObservation> {
    try {
      return await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `handoff source unavailable for session "${sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Condense one live Agent's history the way `/compact` would, and read back
   * the summary that produced.
   *
   * The backend is reached through the human command rather than a service
   * lookup, because a preset may isolate it. This deployment disables the
   * host-plane compaction row and mounts a backend per preset inside
   * `isolate: { compaction: true }`, so the group's instance is invisible from
   * outside the group: `ctx.get('compaction')` is undefined at this
   * controller's plane, and the only context that can see the backend is the
   * one the command runs in. Going through the command also means a handoff
   * condenses exactly as typing `/compact` does, refusals included.
   *
   * The summary is read from the log afterwards rather than taken from the
   * command's result: a command result carries text and a seq, not blocks, and
   * the log is where the continuation's history has to come from anyway. When
   * the command found nothing to condense, the newest recorded summary is
   * whatever an earlier compaction left, which is the case a handoff of an
   * already-condensed Session carries.
   *
   * @param agent - live Agent whose history is condensed.
   * @param fail - refusal constructor for this operation's own error class.
   * @param signal - cancels the compaction, not the Session it reads.
   * @returns the carried summary blocks.
   * @throws {RemoteError} `session/handoff-unavailable` naming the precondition.
   */
  private async condense(
    agent: Agent,
    fail: (reason: string, message: string) => RemoteError,
    signal: AbortSignal,
  ): Promise<readonly ContentBlock[]> {
    // `ctx.get` is the inject-free read: a deployment may mount no command
    // registry at all, and this route must not wait on one to exist.
    const commands = this.ctx.get('commands') as HandoffCommands | undefined
    if (commands === undefined) {
      throw fail('no-command-registry', 'This deployment has no command registry, so its history cannot be condensed.')
    }
    const execution = await commands.execute(agent, '/compact', [], signal)
    if (execution === undefined) {
      throw fail(
        'no-compaction-command',
        'This deployment registers no "/compact" command for this Session, so its history cannot be condensed.',
      )
    }
    if (execution.result.kind !== 'success') {
      // The command owns this prose and already speaks to a human, so it is
      // carried rather than reinterpreted.
      throw fail('compaction-refused', execution.result.text)
    }
    using condensed = await this.observeForHandoff(agent.id)
    const summary = newestSummary(condensed.events)
    if (summary === undefined || summary.length === 0) {
      throw fail('nothing-to-carry', 'This Session has no history to condense yet.')
    }
    return summary
  }

  /**
   * Reject empty content, then admit one prompt after Agent and attachment validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    if (!hasPromptContent(request.content)) {
      throw new RemoteError(
        'gateway/bad-request',
        'prompt content must include non-whitespace text or an attachment',
        {},
      )
    }
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true }
    const selection = this.agents.selectionFor(agent).current
    if (!routeServed(this.ctx, selection.provider)) {
      throw new RemoteError(
        'session/model-unavailable',
        `no adapter serves provider "${selection.provider}"; select a model for this session`,
        { provider: selection.provider, model: selection.model },
      )
    }
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        if (hasImage) {
          const current = this.agents.selectionFor(agent).current
          const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            throw new RemoteError(
              'session/attachment-invalid',
              `Model "${current.model}" does not support image input.`,
              { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            )
          }
        }
        const admission = resolvePromptFileReceipts(
          request.content,
          receiptId => this.ctx.fileUploads.resolve(agent, receiptId),
        )
        const content = await this.ctx.attachments.admitPromptContent(admission.content)
        const message: UserMessage = createUserMessage({ content, source })
        if (this.ctx.agents.get(agent.id) !== agent) {
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        binding.commit()
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    const events = await this.authorizedAttachmentEvents(request.sessionId)
    const ref = referencedImage(events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Authorize one attachment for download and open its exact bytes.
   *
   * A Session log reaches an attachment either as an uploaded verbatim file or
   * as an admitted image, and the two stores read differently, so the name and
   * media type travel back with the bytes instead of the caller assuming them.
   * The first chunk is pulled here rather than left to the response body: an
   * unreadable store then fails the request, instead of truncating a response
   * that already promised 200.
   * @param request - Session and attachment identities used for authorization.
   * @param signal - cancels the read while the response body is still streaming.
   * @returns the display name, declared media type, and exact byte stream.
   */
  async downloadAttachment(
    request: SessionAttachmentRequest,
    signal: AbortSignal,
  ): Promise<SessionAttachmentDownload> {
    const events = await this.authorizedAttachmentEvents(request.sessionId)
    const file = referencedFile(events, String(request.attachmentId))
    if (file !== undefined) {
      try {
        const iterator = this.ctx.attachments.readFileStream(file, signal)[Symbol.asyncIterator]()
        const first = await iterator.next()
        return { name: file.name, mediaType: undefined, length: file.bytes, bytes: reopened(first, iterator) }
      } catch (error) {
        throw attachmentReadFailure(error, 'Unable to read file attachment.')
      }
    }
    const image = referencedImage(events, String(request.attachmentId))
    if (image === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Attachment is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(image, signal)
      return {
        name: stored.ref.name ?? `image.${IMAGE_EXTENSIONS[stored.ref.mediaType]}`,
        mediaType: stored.ref.mediaType,
        length: stored.ref.bytes,
        bytes: oneChunk(stored.data),
      }
    } catch (error) {
      throw attachmentReadFailure(error, 'Unable to read image attachment.')
    }
  }

  /** Read the Session log an attachment download authorizes against. */
  private async authorizedAttachmentEvents(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    try {
      return (await this.readSessionState(sessionId)).events
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `attachment authorization unavailable for session "${sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    switch (request.action.kind) {
      case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      case 'remove': {
        agent.inbox.remove(request.itemId)
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      case 'steer':
        agent.inbox.remove(request.itemId)
        agent.steer(message)
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      return { id: attached.id, header: attached.header, events: attached.snapshotEvents() }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  stagedFile: (receiptId: FileUploadReceiptId) => FileAttachmentRef | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  const receiptIds = new Set<FileUploadReceiptId>()
  const resolved = content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = stagedFile(part.receiptId)
    if (attachment === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    receiptIds.add(part.receiptId)
    return { type: 'file', attachment }
  })
  return { content: resolved, receiptIds: [...receiptIds] }
}

function hasPromptRequest(agent: Agent, requestId: SessionRequestId): boolean {
  const matches = (message: UserMessage): boolean => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  }
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return agent.session.snapshotEvents().some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  })
}
function attachmentBlockIn(
  content: unknown,
  type: 'image' | 'file',
  match: (id: string) => boolean,
): ReferencedAttachment | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown; readonly content?: unknown }
    if (block.type === type && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ReferencedAttachment
      if (match(String(ref.attachmentId))) return ref
    }
    if (block.type === 'tool-result') {
      const nested = attachmentBlockIn(block.content, type, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function attachmentInEvent(
  event: SessionEvent,
  type: 'image' | 'file',
  match: (id: string) => boolean,
): ReferencedAttachment | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: readonly { readonly content?: unknown }[]
  }
  const direct = attachmentBlockIn(data.content, type, match)
  if (direct !== undefined) return direct
  const message = attachmentBlockIn(data.message?.content, type, match)
  if (message !== undefined) return message
  for (const inserted of data.inserted ?? []) {
    const found = attachmentBlockIn(inserted.content, type, match)
    if (found !== undefined) return found
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    for (const chunk of assistantStreamChunks(event.data.stream, 'block-end')) {
      const found = attachmentBlockIn([chunk.block], type, match)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * The reference a Session log reaches for one id, as the named block type.
 *
 * The two overloads are the narrowing: the walk is keyed by block type, which
 * a single signature over both kinds cannot turn into one narrowed return.
 */
function referencedAttachment(
  events: readonly SessionEvent[],
  type: 'image',
  attachmentId: string,
): ImageAttachmentRef | undefined
function referencedAttachment(
  events: readonly SessionEvent[],
  type: 'file',
  attachmentId: string,
): FileAttachmentRef | undefined
function referencedAttachment(
  events: readonly SessionEvent[],
  type: 'image' | 'file',
  attachmentId: string,
): ReferencedAttachment | undefined {
  for (const event of events) {
    const found = attachmentInEvent(event, type, id => id === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  return referencedAttachment(events, 'image', attachmentId)
}

function referencedFile(
  events: readonly SessionEvent[],
  attachmentId: string,
): FileAttachmentRef | undefined {
  return referencedAttachment(events, 'file', attachmentId)
}

/** Display extension per admitted image type; `jpeg` is the outlier. */
const IMAGE_EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** The durable reference an attachment-bearing block carries, whichever store holds it. */
type ReferencedAttachment = ImageAttachmentRef | FileAttachmentRef

/**
 * The newest condensation a Session log already recorded.
 *
 * A Session condensed and untouched since has nothing left to condense, so a
 * handoff carries what the last compaction produced rather than refusing. The
 * summary is log-only — the surface replacement is the `user/message` after it
 * — so this reads the declaration, not a surface node.
 * @param events - the source Session's complete log.
 * @returns the newest summary's content blocks, or undefined when there is none.
 */
function newestSummary(events: readonly SessionEvent[]): readonly ContentBlock[] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    // Read by name rather than by declared type: `compaction/summary` is
    // declared by the compaction package, and this controller deliberately
    // takes no build-time edge on a backend it may not have mounted.
    const event = events[index] as { readonly type?: string; readonly data?: { readonly summary?: readonly ContentBlock[] } } | undefined
    if (event?.type !== 'compaction/summary') continue
    const summary = event.data?.summary
    if (summary !== undefined && summary.length > 0) return summary
  }
  return undefined
}

/**
 * The opening message of a continued Session: what it is, then the history.
 * @param summary - the condensation carried over from the source Session.
 * @returns model-visible blocks for the continuation's one opening message.
 */
function carriedHistory(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    {
      type: 'text',
      text: 'This conversation continues an earlier one in the same workspace. Everything before this point is '
        + 'condensed into the summary below; the earlier conversation is archived and still readable.',
    },
    ...summary,
  ]
}

/**
 * Durable attribution for a continued Session's opening message.
 *
 * `plugin` is the source kind this Session format already classifies, and the
 * `notice` form is what makes the transcript show one collapsed line instead of
 * a wall of carried-over prose. A new kind would be a versioned-format change
 * for a display distinction, so the existing one carries it.
 * @returns the immutable message source for the carried history.
 */
function handoffSource(): MessageSource {
  return {
    kind: 'plugin',
    plugin: 'handoff',
    form: 'notice',
    summary: boundContextSummary('Continued from an earlier conversation; its condensed history follows.'),
  }
}

/**
 * The slice of the command seam a handoff calls.
 *
 * A slice rather than the service, and read through `ctx.get` at call time, so
 * a deployment that mounts no command registry is a runtime refusal instead of
 * a build-time dependency or a route that waits on one to exist.
 */
interface HandoffCommands {
  /**
   * Parse and execute one known command for an Agent without sending it to the
   * model, in the Agent's own scope.
   * @param agent - exact receiving Agent.
   * @param line - complete slash-command line.
   * @param submittedAttachments - staged attachments; empty for `/compact`.
   * @param signal - cancellation owned by the caller.
   * @returns the settled execution, or undefined when the name does not resolve.
   */
  execute(
    agent: Agent,
    line: string,
    submittedAttachments: readonly CommandSubmitAttachment[],
    signal: AbortSignal,
  ): Promise<CommandExecution | undefined>
}

/** The chunk already pulled, then the rest of the same iteration. */
async function* reopened(
  first: IteratorResult<Uint8Array>,
  rest: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (first.done !== true) yield first.value
  for (;;) {
    const next = await rest.next()
    if (next.done === true) return
    yield next.value
  }
}

/** One in-memory buffer as the single chunk of a byte stream. */
// oxlint-disable-next-line typescript/require-await -- the async protocol is what the store's read path shares
async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

/** Classify a store read failure without leaking a backend message into a business code. */
function attachmentReadFailure(error: unknown, fallback: string): Error {
  if (error instanceof AttachmentError) {
    return new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
  }
  // An already-classified failure keeps its own code; only the unknown ones need the fallback.
  if (error instanceof RemoteError) return error
  return new RemoteError('gateway/internal', fallback, {})
}

function routeServed(ctx: Context, provider: string): boolean {
  return ctx.llm.listProviders().some(entry => entry.id === provider)
}
