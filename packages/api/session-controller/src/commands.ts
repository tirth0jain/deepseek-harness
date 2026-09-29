/** Session commands whose activation policy is explicit at each Remote method. */

import { modelAvailable } from './catalog.ts'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandExecution, CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart, FileAttachmentRef, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import {
  ReasoningEffortId, assistantStreamChunks, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
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
  SessionPromptRequest,
  HandoffMessageSource,
  SessionHandoffRequest,
  SessionHandoffValue,
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

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
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
   * Validate and install one Session-local model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        await this.requireModel(request)
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
        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        })
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
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
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
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    const seed = buildForkSeed(source.events, boundary)
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
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
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
    const conversation = await this.condense(agent, fail, signal)
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
      // Created through the controller rather than the registry directly, so
      // the continuation is owned like any other Agent the API layer makes
      // live: archiving it later gives it back instead of leaving it resident
      // for the life of the process.
      await this.agents.createOwned({
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
      content: carriedHistory(conversation),
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
   * the condensed conversation.
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
   * What comes back is the source's own derived history, not the summary
   * declaration. Compaction replaces the shadowed nodes with a checkpoint
   * message and deliberately keeps a recent tail verbatim (`retainRatio`
   * defaults to 0.16 of the context window), so the summary alone is a strictly
   * smaller thing than the condensed conversation: carrying it would drop the
   * most recent turns, which are the ones a continuation is continued from.
   * `deriveMessages` is that condensed view by construction — a `replace`
   * surface op deletes the shadowed nodes from the derivation.
   *
   * @param agent - live Agent whose history is condensed.
   * @param fail - refusal constructor for this operation's own error class.
   * @param signal - cancels the compaction, not the Session it reads.
   * @returns the condensed conversation, oldest first.
   * @throws {RemoteError} `session/handoff-unavailable` naming the precondition.
   */
  private async condense(
    agent: Agent,
    fail: (reason: string, message: string) => RemoteError,
    signal: AbortSignal,
  ): Promise<readonly Message[]> {
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
    const conversation = agent.session.deriveMessages()
    // A Session with only a system prompt has nothing to continue from. A
    // command that found nothing to compact is not this case: the retained
    // history it left behind is what gets carried.
    if (conversation.every(message => message.role === 'system')) {
      throw fail('nothing-to-carry', 'This Session has no history to condense yet.')
    }
    return conversation
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

  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
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
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
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
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new RemoteError('session/writer-held', error.message, { sessionId })
    }
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
  match: (ref: ReferencedAttachment) => boolean,
): ReferencedAttachment | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown }
    if (block.type === type && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ReferencedAttachment
      if (match(ref)) return ref
    }
  }
  return undefined
}

/** Read only first-party declared content fields; unknown event payloads stay opaque. */
function attachmentInEvent(
  event: SessionEvent,
  type: 'image' | 'file',
  match: (ref: ReferencedAttachment) => boolean,
): ReferencedAttachment | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly summary?: unknown
    readonly rawOutput?: unknown
  }
  // First-party event payloads can be present without their producer plugin mounted.
  const eventType: string = event.type
  switch (eventType) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      return attachmentBlockIn(data.content, type, match)
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      return attachmentBlockIn(data.message?.content, type, match)
    case 'agent/inbox/spliced': {
      const messages = data.inserted
      if (!Array.isArray(messages)) return undefined
      for (const message of messages as readonly unknown[]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        const found = attachmentBlockIn((message as { readonly content?: unknown }).content, type, match)
        if (found !== undefined) return found
      }
      return undefined
    }
    case 'compaction/summary':
      return attachmentBlockIn(data.summary, type, match) ?? attachmentBlockIn(data.rawOutput, type, match)
    case 'assistant/message': {
      const found = attachmentBlockIn(data.message?.content, type, match)
      if (found !== undefined) return found
      break
    }
    case 'assistant/attempt': break
    default: return undefined
  }
  const assistant = event as SessionEvent<'assistant/message' | 'assistant/attempt'>
  for (const chunk of assistantStreamChunks(assistant.data.stream, 'block-end')) {
    const found = attachmentBlockIn([chunk.block], type, match)
    if (found !== undefined) return found
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
    const found = attachmentInEvent(event, type, ref => String(ref.attachmentId) === attachmentId)
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


/**
 * Who one carried message is attributed to in the opening recap.
 *
 * A compaction checkpoint IS the condensed history rather than something the
 * reader said, so labelling it as the reader would misattribute the whole
 * summary. The marker is the backend-independent one every compaction backend
 * uses for its replacement user message; this controller deliberately takes no
 * build-time edge on the compaction package, so it is read structurally, the
 * same way `HandoffCommands` slices the command service.
 * @param message - one message of the source's condensed conversation.
 * @returns the label opening its carried text.
 */
function speakerOf(message: Message): string {
  const source = message.source as { readonly kind?: unknown }
  if (source.kind === 'compact-checkpoint') return 'Condensed history'
  return message.role === 'user' ? 'User' : 'Assistant'
}

/**
 * The opening message of a continued Session: what it is, then the history.
 *
 * Text blocks only. A carried recap is not a transcript: tool calls and their
 * results are plumbing whose useful output the condensation already keeps, and
 * replaying raw tool traffic into a single message would cost the continuation
 * far more context than it restores.
 * @param conversation - the source's condensed conversation, oldest first.
 * @returns model-visible blocks for the continuation's one opening message.
 */
function carriedHistory(conversation: readonly Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [
    {
      type: 'text',
      text: 'This conversation continues an earlier one in the same workspace. The history below is that '
        + 'conversation condensed: an earlier summary, then the most recent turns kept verbatim. The earlier '
        + 'conversation is archived and still readable.',
    },
  ]
  for (const message of conversation) {
    if (message.role === 'system') continue
    const text = message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n\n')
    if (text.trim().length === 0) continue
    blocks.push({ type: 'text', text: `${speakerOf(message)}: ${text}` })
  }
  return blocks
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
function handoffSource(): HandoffMessageSource {
  return Object.freeze({
    kind: 'handoff',
    summary: boundContextSummary('Continued from an earlier conversation; its condensed history follows.'),
  })
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
