/**
 * Authenticated GET/HEAD file and attachment byte reads: `/api/file` serves a
 * composed-filesystem path and `/api/attachment.download` serves bytes the
 * Session log references. Paths and MIME types do not restrict access; the
 * connection service authenticates requests before these handlers.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { basename, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import mime from 'mime-types'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/**
 * The policy a download response carries: the display policy, plus permission
 * to save.
 *
 * `allow-downloads` states that the sandbox flags do not stand in the way of
 * the save this response asks for. A browser that creates no document for an
 * attachment never consults it; one that does needs exactly this. Naming it
 * costs nothing and removes the question.
 */
const DOWNLOAD_CSP = `${BASE_HEADERS['Content-Security-Policy']}; allow-downloads`

/**
 * Whether an `/api/file` request asks for a download rather than a display.
 *
 * The value is not a switch: the parameter's presence is the request, so a
 * hand-written `?download` works, and only the explicit negative spellings
 * `0` and `false` opt back out. Absence is what leaves a response inline.
 * @param value - the raw `download` query value, or null when absent.
 * @returns whether the response should carry an attachment disposition.
 */
function wantsDownload(value: string | null): boolean {
  return value !== null && value !== '0' && value !== 'false'
}

/**
 * One attachment disposition value for a download.
 *
 * The leaf name is used verbatim after control characters, quotes, and
 * backslashes are dropped, and a UTF-8 spelling rides alongside the ASCII
 * fallback so a non-ASCII name survives a client that reads only `filename*`.
 * @param name - display filename, already free of path information.
 * @returns the `Content-Disposition` header value.
 */
export function contentDisposition(name: string): string {
  const leaf = basename(name).replace(/[\u0000-\u001f\u007f"\\]/gu, '').slice(0, 200)
  const ascii = leaf.replace(/[^\u0020-\u007e]/gu, '_') || 'download'
  const encoded = encodeURIComponent(leaf).replace(/['()*]/gu, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** The response a refused byte request answers with: no body for HEAD, the reason otherwise. */
function refuse(request: Request, status: number, text: string): Response {
  return new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
}

/**
 * One store byte stream as a `Response` body.
 *
 * `ReadableStream.from` is not in this project's stream types, and pulling by
 * hand also means the store's own backpressure is what paces the socket: the
 * body is only asked for the next chunk once the previous one has drained.
 * @param bytes - exact bytes in order, as the attachment store yields them.
 * @returns the body to hand to a `Response`.
 */
function byteStream(bytes: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = bytes[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(): Promise<void> {
      await iterator.return?.()
    },
  })
}

async function serveFile(request: Request, fs: FileSystem, maxBytes: number): Promise<Response> {
  const fail = (status: number, text: string): Response => refuse(request, status, text)
  const query = new URL(request.url).searchParams
  const path = query.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  // An explicit `name` overrides only the saved filename, never the path read.
  const override = query.get('name')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
    }
    if (wantsDownload(query.get('download'))) {
      headers['Content-Disposition'] = contentDisposition(
        override === null || override === '' ? target.displayPath : override,
      )
      headers['Content-Security-Policy'] = DOWNLOAD_CSP
    }
    if (request.method === 'HEAD') {
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        if (info.size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(info.size)
      }
      return new Response(null, { headers })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * Stream one uploaded file or admitted image back to the browser as a download.
 *
 * The Session log is the authorization: an attachment the addressed Session
 * never referenced is not readable here, which is what keeps opaque storage ids
 * from being a capability. Bytes stream straight from the store, so a large
 * upload never lands in this process's heap on the way out.
 *
 * The Session owner is read through `ctx.get` rather than declared as an
 * injection because this contribution is applied from inside that owner's own
 * constructor: requiring it here would make the file route above wait on the
 * service that is still being built.
 * @param request - the authenticated request carrying `sessionId` and `attachmentId`.
 * @param ctx - Host context carrying the Session owner.
 * @returns the byte response, or the refusal to answer with.
 */
async function serveAttachment(request: Request, ctx: Context): Promise<Response> {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const attachmentId = query.get('attachmentId')
  if (sessionId === null || sessionId === '' || attachmentId === null || attachmentId === '') {
    return refuse(request, 400, 'sessionId and attachmentId are required')
  }
  const controller = ctx.get('sessionController')
  if (controller === undefined) return refuse(request, 503, 'attachment reads are unavailable')
  try {
    const download = await controller.downloadAttachment(
      // Query strings are the boundary: the ids arrive as opaque text.
      {
        sessionId: brandString<SessionId>(sessionId),
        attachmentId: brandString<AttachmentIdType>(attachmentId),
      },
      request.signal,
    )
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': download.mediaType ?? (mime.lookup(download.name) || 'application/octet-stream'),
      'Content-Length': String(download.length),
      'Content-Disposition': contentDisposition(download.name),
      'Content-Security-Policy': DOWNLOAD_CSP,
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    return new Response(byteStream(download.bytes), { headers })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    const code = remoteErrorOf(error)?.code
    return refuse(request, code === 'session/not-found' || code === 'session/attachment-invalid' ? 404 : 500, code ?? 'unavailable')
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy, and
 * the Session owner authorizes attachments against a Session log.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, maxBytes),
    }), 'session-controller: /api/file')
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/attachment.download',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveAttachment(request, ctx),
    }), 'session-controller: /api/attachment.download')
  },
}
