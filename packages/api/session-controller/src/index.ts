/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain, ReasoningEffortId, type MessageSource } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { canOpenNativePath, nativeFileManager, nativeFileApplications, openNativeFileApplication, openNativeAssociatedPath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { callVisibility, type PathVisibility } from '@deepseek-ai/dsh-session-scope'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService, principalOf, type TypertResourceResolveInput } from '@deepseek-ai/dsh-typert-protocol'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import {
  ApiSessionAgentController,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController, hasPromptContent } from './commands.ts'
import { ComposerDraftStore } from './composer-draft.ts'
import { SessionControlController } from './control.ts'
import { HistoryController } from './history/controller.ts'
import { StateController } from './state/controller.ts'
import { WebController } from './web/controller.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList } from './list.ts'
import { buildModelCatalog, hasProviderApiKey } from './catalog.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { SessionMediaReferences } from './media-references.ts'
import { ArchivedSessionGate } from './archived-session-gate.ts'
import { addressId } from './history.ts'
import type {
  ModelCatalog,
  SessionWorkspacePathApplication,
  SessionAddress,
  SessionAttachmentDownload,
  SessionAttachmentDownloadRequest,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionComposerDraftRequest,
  SessionComposerDraftValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionHandoffRequest,
  SessionHandoffValue,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionEventsPage, SessionPageRequest, SessionEventFrame, SessionObserveEventRequest,
  SessionProjectionFrame, SessionStateRequest, SessionState, SessionWaitRequest, SessionWaitValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionSetComposerDraftRequest,
  SessionProjectionsRequest,
  SessionProjectionsValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController
  }
}

/**
 * Extract the Session resource from an ID or a history address.
 *
 * Registers as the `session` kind default, so it applies to every Remote method of
 * every namespace: a top-level `sessionId` parameter, otherwise the first object
 * parameter carrying `sessionId` or an `address`. A new request type whose first
 * object parameter has an unrelated `address` field would be read as an address.
 * @param input - validated wire arguments and their ordered parameter descriptions.
 * @returns the named Session identity, otherwise the first object's Session identity or history address.
 * @throws Error when the request object supplies both sessionId and address.
 */
function resolveSessionResource({ args, parameters }: TypertResourceResolveInput): SessionId | undefined {
  const sessionParameter = parameters.find(parameter => parameter.name === 'sessionId' || parameter.wire === 'sessionId')
  if (sessionParameter !== undefined) return args[sessionParameter.wire] as SessionId | undefined
  for (const parameter of parameters) {
    const value = args[parameter.wire]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const request = value as { readonly sessionId?: SessionId; readonly address?: SessionAddress }
    const address = request.address
    if (request.sessionId !== undefined && address !== undefined) {
      throw new Error('Session resource request must not contain both sessionId and address')
    }
    return request.sessionId ?? (address === undefined ? undefined
      : address.kind === 'session' ? address.sessionId : address.childSessionId)
  }
  return undefined
}

/** Session Controller deployment policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
  /**
   * Activate a stored Session's Agent in the background when its history is
   * opened for reading. Defaults to `true`, the shipped behaviour.
   *
   * Activating early costs the Session's whole event graph for the life of the
   * process — a long conversation measures gigabytes — because nothing releases
   * an Agent once it exists, and it appends the pickup `session/end-seed` that
   * makes a merely-opened Session look freshly used. Set `false` to open a
   * Session read-only: every operation that needs an Agent (prompt, queue,
   * command, cancel) already resolves one on demand, so the Agent is then
   * created by the first real use rather than by the first look.
   */
  readonly promoteOnHistoryOpen?: boolean
  /** Positive integral milliseconds of list work before yielding between complete rows. */
  readonly listWorkSliceMs?: number
}

/** Deployment policy after schema defaults have been applied. */
type ResolvedConfig = Config & { readonly listWorkSliceMs: number }

/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native file-association query. */
  readonly fileApplications?: typeof nativeFileApplications
  /** Explicit registered-application handoff. */
  readonly openFileApplication?: typeof openNativeFileApplication
  /** Native file-manager handoff. */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean
}

/**
 * The slice of the persistence seam an archive release calls.
 *
 * Declared here rather than imported as the service so this controller keeps
 * working in a deployment that mounts no persistence at all; `ctx.get` is what
 * resolves it at call time.
 */
interface ArchivedLogRelease {
  /**
   * Drop any decoded log retained for one Session.
   * @param sessionId - the Session whose retained decode should be dropped.
   */
  release(sessionId: SessionId): void
}

/** Host service backing the generated `ctx.remote.session` namespace. */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'fileUploads',
    'fs',
    'llm',
    'remoteAccess',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'typertGateway',
    'workspaceRegistry',
  ]

  static Config: z<Config, ResolvedConfig> = z.object({
    nativeOpen: z.boolean(),
    promoteOnHistoryOpen: z.boolean().default(true),
    listWorkSliceMs: z.natural().min(1).default(16),
  })

  private historyController!: HistoryController
  private stateController!: StateController
  private webController!: WebController

  private agents!: ApiSessionAgentController
  private commands!: SessionCommandController
  private composerDrafts!: ComposerDraftStore
  private controlState!: SessionControlController
  private listState!: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly fileApplications: typeof nativeFileApplications
  private readonly openFileApplication: typeof openNativeFileApplication
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly listWorkSliceMs: number
  private readonly promoteOnHistoryOpen: boolean
  private readonly promotions = new Set<Promise<void>>()

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener and list-scheduling deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    const resolved = SessionController.Config(config)
    this.listWorkSliceMs = resolved.listWorkSliceMs
    this.promoteOnHistoryOpen = resolved.promoteOnHistoryOpen ?? true
    this.fileApplications = internals.fileApplications ?? nativeFileApplications
    this.openFileApplication = internals.openFileApplication ?? openNativeFileApplication
    this.openPath = internals.openPath ?? openNativeAssociatedPath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    ctx.typert.resources.register('session', { resolve: resolveSessionResource })
    this.agents = new ApiSessionAgentController(ctx)
    this.agents.initialize()
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd())
    this.composerDrafts = new ComposerDraftStore(ctx)
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      return result.agent
    }), 'session-controller: file-upload Agent resolver')
    this.controlState = new SessionControlController(ctx)
    // Archiving is the act of putting a Session away, so it is where this
    // process gives back what that Session costs it: the Agent this controller
    // made live for it, and the parsed cold graph a read retained. Nothing here
    // is a refusal — an Agent someone else owns, one that is not idle, and an
    // observation an active lease holds are all left alone, because the point
    // is to stop paying for a Session nobody is using.
    ctx.on('workspace/session-archived', (sessionId: SessionId) => {
      void this.releaseArchived(sessionId).catch((error: unknown) => {
        this.ctx.logger.warn(`archiving "${sessionId}" released nothing: ${String(error)}`)
      })
    })
    // Registered before history so reverse-order teardown closes every
    // follower before waiting for already-admitted promotions.
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions])
    }, 'session-controller.promotions')
    this.historyController = new HistoryController(ctx)
    this.stateController = new StateController(ctx, this.historyController)
    this.webController = new WebController(
      ctx,
      this.historyController,
      // Upstream asks for activation per follow; a deployment that opens
      // Sessions read-only drops that lease instead of resuming an Agent.
      this.promoteOnHistoryOpen === false
        ? (observation) => { observation[Symbol.dispose]() }
        : (observation) => { this.promote(observation) },
    )
    this.listState = new ApiSessionList(ctx, this.listWorkSliceMs)
    await this.listState.initialize()
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionSkillCatalog)
    // An archived Session, or a subagent descendant of one, runs no model step
    // until it is restored; what it still runs is stopped by the owners that
    // answer the Workspace registry's archive-admission events.
    ctx.plugin(ArchivedSessionGate)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
    const publishAgentAvailability = ({ agent }: { agent: Agent }): undefined => {
      if (ctx.sessions.get(agent.id) === agent.session) {
        ctx.emit('api-session/added', this.listState.summaryFor(agent.session))
      }
    }
    ctx.on('agent/created', publishAgentAvailability)
    ctx.on('agent/disposed', publishAgentAvailability)
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })
  }

  /**
   * Give back what one archived Session costs this process.
   *
   * Three layers can each be holding the same Session, and each is asked in
   * turn: the Agent this controller made live, the parsed event graph the
   * observation cache retained for a Session that was only read, and any
   * decoded log the persistence backend memoized. Every step is best-effort
   * and idempotent — a Session that was never read or never resumed simply has
   * nothing at one or more of them, and reading or resuming it again
   * reconstructs whatever was dropped.
   * @param sessionId - the Session that was just archived.
   */
  private async releaseArchived(sessionId: SessionId): Promise<void> {
    // Read state first, Agent last: the Agent's disposal is asynchronous, and
    // dropping the retained graph before it means a caller that observes the
    // Agent gone can rely on the read state being gone too. It also keeps the
    // window where a concurrent read could re-cache the graph ahead of the
    // disposal rather than behind it.
    const releasedObservation = this.ctx.sessionQuery.releaseSession(sessionId)
    // Read through `ctx.get`: persistence is optional for this controller, so
    // it cannot be a declared injection without making every route wait on a
    // service a deployment may not mount.
    const persistence = this.ctx.get('sessionPersistence') as ArchivedLogRelease | undefined
    persistence?.release(sessionId)
    const releasedAgent = await this.agents.releaseAgent(sessionId)
    const released = [
      ...releasedAgent ? ['live Agent'] : [],
      ...releasedObservation ? ['retained read state'] : [],
    ]
    if (released.length > 0) {
      this.ctx.logger.info(`archiving "${sessionId}" released its ${released.join(' and ')}`)
    }
  }

  /**
   * Request background activation through the existing Session Agent controller.
   * @param observation - owned lease disposed by the background task; callers retain their own lease separately.
   */
  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.add(task)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * Read all visible Session rows without resuming an Agent.
   * @param _request - reserved empty list request.
   * @param signal - cancellation for persistence reads and summary generation.
   * @returns visible Session summaries ordered by activity.
   */
  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    const items = await this.listState.list(signal, callVisibility(this.ctx))
    return { items: items.filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })) }
  }

  /**
   * Search visible Session content without resuming an Agent. A non-owner
   * receives only the hits whose Session `allows()` admits; `hasMore`
   * describes the bounded result before that filtering.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  @Remote('search')
  async search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    const result = await this.listState.search(request.query, signal, callVisibility(this.ctx))
    return { ...result, items: result.items.filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })) }
  }

  /**
   * Create one ordinary Session for a new conversation, reusing the named blank Session while it is reusable.
   * @param request - optional blank Session to reuse, location, and Agent preset.
   * @returns the created or reused Session identity and its preset when configured.
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.commands.create(request, callVisibility(this.ctx))
  }

  /**
   * Select one Session-local model after explicitly resuming the Session; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.commands.selectModel(request)
  }

  /**
   * Select the first available account model after login when no provider API key is configured.
   * @returns after saving the first available model or retaining the existing default.
   */
  @Remote
  async initializeDefaultModel(): Promise<void> {
    const provider = 'deepseek-account'
    if (await hasProviderApiKey(this.ctx)) return
    const catalog = await buildModelCatalog(this.ctx)
    const model = catalog.groups.find(group => group.id === provider)?.models[0]
    if (model === undefined) throw new RemoteError('session/provider-models-unavailable',
      `provider "${provider}" has no available models`, { provider })
    const selection = { provider, model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning.defaultEffort) },
    }
    await this.ctx.agentDefaultModel.saveSelection(selection)
  }

  /**
   * Describe every currently routable model for Host-generation selectors.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> {
    return buildModelCatalog(this.ctx)
  }

  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop(): { name: string; available: boolean; fileManager: 'finder' | 'explorer' | 'directory' | null } {
    const fileManager = nativeFileManager()
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager }
  }

  /**
   * Verify one path through the composed filesystem and open it on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws RemoteError when the request is invalid, has no verified Host mapping, is cancelled, or the opener fails.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      if (request.action === 'reveal') await this.revealPath(path, signal)
      else if (request.application !== undefined) await this.openFileApplication(path, request.application, signal)
      else await this.openPath(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError(
        'gateway/internal',
        'path open failed',
        {},
        { cause: error },
      )
    }
  }

  /**
   * Query current file handlers on the serving desktop without activating an Agent.
   * @param request - file path in Host filesystem syntax.
   * @param signal - caller lifetime, propagated to filesystem and desktop queries.
   * @returns OS application names, icons, and default selection; empty when desktop opening is unavailable.
   * @throws RemoteError when the path is invalid, the query is cancelled, or native discovery fails.
   */
  @Remote('workspacePathApplications')
  async workspacePathApplications(
    request: { readonly path: string }, signal: AbortSignal,
  ): Promise<readonly SessionWorkspacePathApplication[]> {
    if (!this.canOpenPath()) return []
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      return await this.fileApplications(path, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'application query was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'file application query failed', {}, { cause: error })
    }
  }

  private async verifyDesktopPath(path: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'A non-empty file path is required', {})
    signal.throwIfAborted()
    const hostPath = resolve(path)
    const { fs } = this.ctx
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) {
      throw new RemoteError('gateway/bad-request', 'Path has no verified Host path', {})
    }
    signal.throwIfAborted()
    return hostPath
  }

  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  @Remote('rename')
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.commands.rename(request)
  }

  /**
   * Fork one cold-readable exact event prefix into a new Session. An omitted
   * boundary selects the latest completed-turn prefix; an open cut receives
   * synthetic fork closers.
   * @param request - source Session, optional exact inclusive event boundary, and migration preflight choice.
   * @returns the new Session identity.
   */
  @Remote('fork')
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    if (request.allowMigration === false && this.ctx.sessions.get(request.sessionId) === undefined) {
      const stored = await this.ctx.get('sessionPersistence')?.stat(request.sessionId)
      if (stored?.formatStatus === 'migration-required' && this.ctx.sessions.get(request.sessionId) === undefined) {
        throw new RemoteError('session/migration-required', 'Open the source Session to complete migration before forking', {
          sessionId: request.sessionId,
        })
      }
    }
    return this.commands.fork(request)
  }

  /**
   * Continue one Session in a new one holding only its condensed history, and
   * archive the source.
   * @param request - the Session to continue elsewhere.
   * @param signal - cancels the summarization, not the Session it produces.
   * @returns the new Session identity and whether its source was archived.
   */
  @Remote('handoff')
  async handoff(request: SessionHandoffRequest, signal: AbortSignal): Promise<SessionHandoffValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.commands.handoff(request, signal)
  }

  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  @Remote('prompt')
  async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    if (!hasPromptContent(request.content)) {
      throw new RemoteError('gateway/bad-request', 'prompt content must include non-whitespace text or an attachment', {})
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
    // The caller is recorded only when it is not the owner, so owner messages keep their exact source.
    const principal = principalOf(this.ctx.invocation)
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      ...(principal === undefined ? {} : { principal }),
    }
    return this.commands.prompt(request, source)
  }

  /**
   * Read one image from the attachment store after gateway authorization.
   * @param request - image reference and gateway permission scope; Session existence is not checked.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  @Remote('attachment')
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.commands.attachment(request)
  }

  /**
   * Open one attachment proven reachable from the addressed Session log, for
   * the authenticated byte route to stream back to the browser. Not a Remote:
   * its value carries live bytes, which only the in-process route can consume.
   * @param request - Session and attachment identities used for authorization.
   * @param signal - cancels the read while the response body is still streaming.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the display name, media type, and exact byte stream.
   */
  async downloadAttachment(
    request: SessionAttachmentDownloadRequest,
    signal: AbortSignal,
    maySee?: PathVisibility,
  ): Promise<SessionAttachmentDownload> {
    await this.assertSessionVisible(request.sessionId, maySee)
    return this.commands.downloadAttachment(request, signal)
  }

  /**
   * Mutate one still-pending queue occurrence, resuming a cold Agent first.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  @Remote('updateQueue')
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.commands.updateQueue(request)
  }

  /**
   * Read the composer draft one Session last stored. A draft is reader input,
   * not Session history: it never enters the log, and it survives a restart in
   * its own storage domain so an unsent prompt is not lost with the process.
   * @param request - Session whose draft is read.
   * @returns the stored draft text, empty when nothing is stored.
   */
  @Remote('composerDraft')
  async composerDraft(request: SessionComposerDraftRequest): Promise<SessionComposerDraftValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return { text: await this.composerDrafts.read(request.sessionId) }
  }

  /**
   * Store the composer draft of one Session. Writing an empty draft clears the
   * record, so a sent prompt leaves nothing behind.
   * @param request - Session and its complete draft text.
   * @returns completion after durability, or after a logged no-op when the
   *   deployment mounts no storage.
   */
  @Remote('setComposerDraft')
  async setComposerDraft(request: SessionSetComposerDraftRequest): Promise<void> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    await this.composerDrafts.write(request.sessionId, request.text)
  }

  /**
   * Refuse one Session the caller does not own.
   *
   * An attached Session answers from memory, which is the path every legitimate
   * call takes — a draft is only ever saved for a Session the caller has open,
   * and autosave runs on every keystroke. Only an id naming some other Session
   * pays for the persisted-header lookup, and none of those are the caller's.
   * @param sessionId - the Session being reached.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @throws RemoteError when the caller is constrained and the Session is not theirs.
   */
  private async assertSessionVisible(
    sessionId: SessionId,
    maySee: PathVisibility | undefined,
  ): Promise<void> {
    if (maySee === undefined) return
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) {
      this.refuseInvisibleSession(sessionId, live.header.cwd, maySee)
      return
    }
    let cwd: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      cwd = observation.header.cwd
    } catch (error: unknown) {
      // A Session that is not there keeps answering exactly as it did before
      // scoping: the command that follows owns that refusal.
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return
      throw error
    }
    this.refuseInvisibleSession(sessionId, cwd, maySee)
  }

  /**
   * Refuse one Session the caller does not own, given a cwd already in hand.
   *
   * Reported missing rather than forbidden: a Session belonging to somebody
   * else is not a thing this caller gets to learn about. Paths answer
   * `session-scope/forbidden`; ids answer as if they were never there.
   * @param sessionId - the Session being reached.
   * @param cwd - the Session's own directory, or undefined when unknown.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @throws RemoteError when the caller is constrained and the Session is not theirs.
   */
  private refuseInvisibleSession(
    sessionId: SessionId,
    cwd: string | undefined,
    maySee: PathVisibility | undefined,
  ): void {
    if (maySee === undefined || (cwd !== undefined && maySee(cwd))) return
    throw new RemoteError('session/not-found', `Session ${JSON.stringify(sessionId)} not found`, { sessionId })
  }

  /**
   * Refuse an unread stream before it yields anything.
   *
   * The stream controllers are async generators, so constructing one starts no
   * work; awaiting the visibility check here keeps a refused subscription from
   * delivering even a readiness frame to the wrong caller.
   * @param ready - visibility check already in flight.
   * @param frames - the stream to deliver once the caller is admitted.
   * @returns the admitted stream's frames.
   */
  private async *guard<T>(ready: Promise<void>, frames: AsyncIterable<T>): AsyncIterable<T> {
    await ready
    yield* frames
  }

  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  @Remote('cancel')
  async cancel(request: SessionCancelRequest): Promise<SessionCancelValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.commands.cancel(request)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @deprecated Use `events`; this entry point remains for existing Web callers.
   * @param request - durable address, optional fixed cut, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page with its inclusive cursor; an omitted `throughSeq` selects the observed log end.
   */
  @Remote('page')
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage> {
    await this.assertSessionVisible(addressId(request.address), callVisibility(this.ctx))
    return this.historyController.events(request, signal)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, optional fixed cut, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page with its inclusive cursor.
   */
  @Remote
  async events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage> {
    await this.assertSessionVisible(addressId(request.address), callVisibility(this.ctx))
    return this.historyController.events(request, signal)
  }

  /**
   * Subscribe to Session events without reading a snapshot.
   * @param request - Session address.
   * @param signal - subscription cancellation.
   * @returns readiness and subsequent events, without a snapshot.
   */
  @Remote({ mode: 'stream' })
  observeEvent(request: SessionObserveEventRequest, signal: AbortSignal): AsyncIterable<SessionEventFrame> {
    return this.guard(
      this.assertSessionVisible(addressId(request.address), callVisibility(this.ctx)),
      this.historyController.observeEvent(request, signal),
    )
  }

  /**
   * Subscribe to sparse Session projection changes.
   * @param request - target Session.
   * @param signal - subscription cancellation.
   * @returns readiness and sparse projection changes.
   */
  @Remote({ mode: 'stream' })
  observeProjections(request: SessionProjectionsRequest, signal: AbortSignal): AsyncIterable<SessionProjectionFrame> {
    return this.guard(
      this.assertSessionVisible(request.sessionId, callVisibility(this.ctx)),
      this.historyController.observeProjections(request, signal),
    )
  }

  /**
   * Read passive Session state.
   * @param request - target Session.
   * @param signal - read cancellation.
   * @returns current passive state.
   */
  @Remote
  async state(request: SessionStateRequest, signal: AbortSignal): Promise<SessionState> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.stateController.state(request, signal)
  }

  /**
   * Subscribe to complete Session state replacements.
   * @param request - target Session.
   * @param signal - subscription cancellation.
   * @returns complete passive state replacements.
   */
  @Remote({ mode: 'stream' })
  observeState(request: SessionStateRequest, signal: AbortSignal): AsyncIterable<SessionState> {
    return this.guard(
      this.assertSessionVisible(request.sessionId, callVisibility(this.ctx)),
      this.stateController.observeState(request, signal),
    )
  }

  /**
   * Wait for Session quiescence or pending input with bounded assistant output.
   * @param request - Session, wait bounds and output window.
   * @param signal - caller cancellation.
   * @returns stopping state and bounded assistant output.
   */
  @Remote
  async wait(request: SessionWaitRequest, signal: AbortSignal): Promise<SessionWaitValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.stateController.wait(request, signal)
  }

  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free durable event
   *   frames and optional cursorless assistant-stream frames.
   */
  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.guard(
      this.assertSessionVisible(addressId(request.address), callVisibility(this.ctx)),
      this.webController.follow(request, signal),
    )
  }

  /**
   * Read exact projections, returning cached hints only when migration is required.
   * @param request - Session whose current values are required.
   * @param signal - cancellation for the Session read.
   * @returns a sequenced baseline, cached hints when migration is deferred, or null when absent.
   */
  @Remote('projections')
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    await this.assertSessionVisible(request.sessionId, callVisibility(this.ctx))
    return this.historyController.projections(request, signal)
  }

  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const maySee = callVisibility(this.ctx)
    const visible = (sessionId: SessionId): boolean => {
      if (!this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId })) return false
      if (maySee === undefined) return true
      const session = this.ctx.sessions.get(sessionId)
      return session !== undefined && maySee(session.header.cwd)
    }
    for await (const frame of this.controlState.control(signal)) {
      switch (frame.type) {
        case 'baseline': {
          const projections = Object.fromEntries(Object.entries(frame.value.projections)
            .filter(([sessionId]) => visible(sessionId as SessionId)))
          yield { type: 'baseline', value: { ...frame.value, projections } }
          break
        }
        case 'projection':
          if (visible(frame.sessionId)) yield frame
          break
        /* v8 ignore next -- closed control-frame union. */
        default:
          assertNever(frame)
      }
    }
  }
}

export default SessionController
