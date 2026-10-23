/** Session-log download command and Host-owned streaming route. */

import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'
import { SESSION_LOG_EXPORT_PATH } from './routes.ts'

export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

export { SESSION_LOG_EXPORT_PATH } from './routes.ts'

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD')[]
      readonly requestBody: 'buffered'
      /** `peer` is the Peer the request was admitted as; a Fetch route has no `invocation`. */
      readonly fetch: (request: Request, peer: PeerScope) => Promise<Response>
    }): () => Promise<void>
  }
}

/** Answers whether one Session `cwd` belongs to the caller; undefined when nothing constrains them. */
type PathVisibility = (path: string | undefined) => boolean

/** The scoping service's surface this route reads, when the deployment loads it. */
interface SessionScopePeerLookup {
  scopeOfPeer(peer: PeerScope | undefined): { readonly admin: boolean } | undefined
  mayAccess(peer: PeerScope | undefined, path: string): boolean
}

/**
 * Resolve one Peer's path visibility through the deployment's scoping service.
 *
 * Read with `ctx.get` rather than imported: the plugin is optional, and a
 * separately-installed copy would answer for a distinct Peer map. Undefined
 * means this deployment constrains nobody, which is what tells the route to
 * skip the check rather than refuse everything.
 * @param ctx - Host context that may carry the scoping service.
 * @param peer - the Peer this request was admitted as.
 * @returns predicate answering whether one `cwd` is visible, or undefined.
 */
function peerVisibility(ctx: Context, peer: PeerScope | undefined): PathVisibility | undefined {
  const scope = ctx.get('sessionScope') as SessionScopePeerLookup | undefined
  const resolved = scope?.scopeOfPeer(peer)
  if (scope === undefined || resolved === undefined || resolved.admin) return undefined
  return path => path !== undefined && scope.mayAccess(peer, path)
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the Web-only `/export` command and authenticated ZIP download route.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-session-log-export'),
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request, peer) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
        peerVisibility(ctx, peer),
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
  maySee?: PathVisibility,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  if (maySee !== undefined) {
    // Descendants are not re-tested: a subagent Session is created with its
    // parent's working directory, so anything reachable from this root is
    // under the same root.
    const snapshots = await deps.sessionPersistence.list()
    const header = snapshots.find(entry => String(entry.header.id) === String(sessionId))?.header
    // Answered as absent rather than forbidden, so a refused id is
    // indistinguishable from one that never existed.
    if (header === undefined || !maySee(header.cwd)) {
      return new Response('session not found', { status: 404 })
    }
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      request.signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}
