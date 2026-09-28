import { appendFile, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { contentDisposition, SessionMediaReferences } from '../src/media-references.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const DEFAULT_LIMIT = 20 * 1024 * 1024

/** Every Context a mount created, disposed once per test. */
const sharedContexts: Context[] = []

afterEach(async () => {
  await Promise.all(sharedContexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

/** One chunk sequence, so a test can prove the body streams instead of arriving whole. */
async function* chunks(...parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part
}

describe('SessionMediaReferences /api/file', () => {
  let root: string
  const contexts: Context[] = []

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-references-')))
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  async function mount(
    maxBytes = DEFAULT_LIMIT,
    downloadAttachment?: (request: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {
    const ctx = new Context()
    contexts.push(ctx)
    const handlers = new Map<string, (request: Request) => Promise<Response>>()
    const unregister = vi.fn(() => {})
    ctx.provide('connection', {
      fetch: {
        register: (registered: { path: string; fetch: (request: Request) => Promise<Response> }) => {
          handlers.set(registered.path, registered.fetch)
          return unregister
        },
      },
    } as never)
    ctx.provide('attachments', { imageLimits: { maxImageBytes: maxBytes } } as never)
    if (downloadAttachment !== undefined) ctx.provide('sessionController', { downloadAttachment } as never)
    await ctx.plugin(LocalFileSystem, { cwd: root }).await()
    await ctx.plugin(SessionMediaReferences).await()
    const raw = (url: string, init?: RequestInit) => {
      const handler = handlers.get(new URL(url).pathname)
      if (handler === undefined) throw new Error(`route not registered: ${new URL(url).pathname}`)
      return handler(new Request(url, init))
    }
    return {
      call: (path: string, init?: RequestInit) => raw(`http://127.0.0.1/api/file?path=${encodeURIComponent(path)}`, init),
      raw,
      fs: ctx.fs as LocalFileSystem,
      unregister,
      dispose: () => ctx.fiber.dispose(),
    }
  }

  it('serves the inclusive image cap and refuses larger images for GET, HEAD and Range', async () => {
    const route = await mount(PNG_BYTES.length)
    const path = join(root, 'bounded.png')
    await writeFile(path, PNG_BYTES)
    expect(await responseBytes(await route.call(path))).toEqual(PNG_BYTES)
    await appendFile(path, new Uint8Array(1))
    expect((await route.call(path)).status).toBe(413)
    expect((await route.call(path, { headers: { range: 'bytes=0-0' } })).status).toBe(413)
    const head = await route.call(path, { method: 'HEAD' })
    expect(head.status).toBe(413)
    expect(head.body).toBeNull()
  })

  it('rejects a sparse 1 GiB image before content I/O', async () => {
    const route = await mount()
    const inspect = vi.fn()
    route.fs.internals.inspectReadBytesAfterStat = inspect
    const path = join(root, 'huge.png')
    const handle = await open(path, 'w')
    try {
      await handle.truncate(1024 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    expect((await route.call(path)).status).toBe(413)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('uses the filesystem byte reader to reject post-stat image growth', async () => {
    const route = await mount(PNG_BYTES.length)
    const path = join(root, 'growing.png')
    await writeFile(path, PNG_BYTES)
    route.fs.internals.inspectReadBytesAfterStat = async () => {
      await appendFile(path, new Uint8Array(1))
    }
    expect((await route.call(path)).status).toBe(413)
  })

  it.each([
    ['png', 'image/png'], ['svg', 'image/svg+xml'], ['mp4', 'video/mp4'], ['mp3', 'audio/mpeg'],
    ['txt', 'text/plain'], ['html', 'text/html'], ['bin', 'application/octet-stream'], ['', 'application/octet-stream'],
  ])('serves .%s files with their MIME type and response protections', async (extension, mediaType) => {
    const route = await mount()
    const path = join(root, `file${extension === '' ? '' : `.${extension}`}`)
    await writeFile(path, PNG_BYTES)
    const response = await route.call(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mediaType)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(await responseBytes(response)).toEqual(PNG_BYTES)
  })

  it.each(['mp4', 'mp3', 'bin'])('applies the attachment byte cap to .%s files', async (extension) => {
    const route = await mount(PNG_BYTES.length)
    const path = join(root, `file.${extension}`)
    await writeFile(path, PNG_BYTES)
    expect(await responseBytes(await route.call(path))).toEqual(PNG_BYTES)
    await appendFile(path, new Uint8Array(1))
    expect((await route.call(path)).status).toBe(413)
    expect((await route.call(path, { method: 'HEAD' })).status).toBe(413)
  })

  it('ignores Range headers and returns complete bodies without advertising ranges', async () => {
    const route = await mount()
    const path = join(root, 'clip.mp4')
    await writeFile(path, PNG_BYTES)
    for (const range of ['bytes=0-3', 'bytes=-4', 'bytes=999-', 'bytes=abc', 'items=0-0', 'bytes=0-1,3-4']) {
      const response = await route.call(path, { headers: { range } })
      expect(response.status).toBe(200)
      expect(response.headers.get('accept-ranges')).toBeNull()
      expect(response.headers.get('content-range')).toBeNull()
      expect(await responseBytes(response)).toEqual(PNG_BYTES)
    }
  })

  it('answers HEAD without reading content and reports missing and non-regular files', async () => {
    const route = await mount()
    const path = join(root, 'image.png')
    await writeFile(path, PNG_BYTES)
    const read = vi.spyOn(route.fs, 'readBytes')
    const response = await route.call(path, { method: 'HEAD', headers: { range: 'bytes=0-3' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.body).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect((await route.call(join(root, 'missing'), { method: 'HEAD' })).status).toBe(404)
    expect((await route.call(root, { method: 'HEAD' })).status).toBe(403)
    vi.spyOn(route.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('v1') })
    expect((await route.call(path, { method: 'HEAD' })).headers.get('content-length')).toBeNull()
  })

  it('rejects malformed paths, absent files, and directories', async () => {
    const route = await mount()
    expect((await route.raw('http://127.0.0.1/api/file')).status).toBe(400)
    for (const path of ['', 'relative.png', '/a\0b.png']) {
      expect((await route.call(path)).status).toBe(400)
    }
    const head = await route.call('', { method: 'HEAD' })
    expect(head.status).toBe(400)
    expect(head.body).toBeNull()
    expect((await route.call(join(root, 'missing.png'))).status).toBe(404)
    await mkdir(join(root, 'frames.png'))
    expect((await route.call(join(root, 'frames.png'))).status).toBe(403)
  })

  it('reads files and symlink targets outside the default cwd without a workspace registry', async () => {
    const route = await mount()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-media-outside-'))
    try {
      const path = join(outside, 'image.png')
      await writeFile(path, PNG_BYTES)
      expect(await responseBytes(await route.call(path))).toEqual(PNG_BYTES)
      const link = join(root, 'linked.png')
      await symlink(path, link)
      expect(await responseBytes(await route.call(link))).toEqual(PNG_BYTES)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO before opening it', async () => {
    const route = await mount()
    const path = join(root, 'stream.png')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('mkfifo', [path])
    expect((await route.call(path)).status).toBe(403)
  })

  it('reads opaque remote targets through ctx.fs and preserves provider failures', async () => {
    const route = await mount()
    const target = { targetKey: FsTargetKey('opaque-remote-id'), displayPath: '/remote/photo.png' }
    vi.spyOn(route.fs, 'resolve').mockResolvedValue(target)
    const read = vi.spyOn(route.fs, 'readBytes').mockResolvedValue(PNG_BYTES)
    expect(await responseBytes(await route.call('/remote/photo.png'))).toEqual(PNG_BYTES)
    expect(read).toHaveBeenCalledWith(target, expect.any(AbortSignal), DEFAULT_LIMIT)
    for (const [code, status] of [
      ['FS_PERMISSION_DENIED', 403], ['FS_SANDBOX_DENIED', 403], ['FS_NOT_FOUND', 404],
      ['FS_NOT_REGULAR_FILE', 403], ['FS_TOO_LARGE', 413], ['FS_IO_ERROR', 500],
    ] as const) {
      read.mockRejectedValueOnce(new FsError('provider rejected read', code))
      expect((await route.call('/remote/photo.png')).status).toBe(status)
    }
    read.mockRejectedValueOnce(new Error('provider bug'))
    await expect(route.call('/remote/photo.png')).rejects.toThrow('provider bug')
  })

  it('serves an empty file and respects an aborted request', async () => {
    const route = await mount()
    const path = join(root, 'empty.png')
    await writeFile(path, '')
    const response = await route.call(path)
    expect(response.headers.get('content-length')).toBe('0')
    expect(await response.text()).toBe('')
    expect((await route.call(path, { signal: AbortSignal.abort() })).status).toBe(499)
  })

  it('adds an attachment disposition only when the request asks to download', async () => {
    const route = await mount()
    const path = join(root, 'report.csv')
    await writeFile(path, PNG_BYTES)
    expect((await route.call(path)).headers.get('content-disposition')).toBeNull()
    expect((await route.call(path)).headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    // The parameter's presence is the request; a bare `?download` is the hand-written spelling.
    for (const query of ['download=1', 'download=true', 'download=', 'download']) {
      const response = await route.raw(`http://127.0.0.1/api/file?path=${encodeURIComponent(path)}&${query}`)
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.csv"; filename*=UTF-8\'\'report.csv')
      // Saving is the one thing the display policy would otherwise have to allow.
      expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; allow-downloads")
      expect(await responseBytes(response)).toEqual(PNG_BYTES)
    }
    for (const query of ['download=0', 'download=false']) {
      expect((await route.raw(`http://127.0.0.1/api/file?path=${encodeURIComponent(path)}&${query}`))
        .headers.get('content-disposition')).toBeNull()
    }
    // A display request keeps its inline disposition even when a name is offered.
    expect((await route.raw(`http://127.0.0.1/api/file?path=${encodeURIComponent(path)}&name=x.bin`))
      .headers.get('content-disposition')).toBeNull()
  })

  it('lets an explicit download name replace the stored leaf without changing what is read', async () => {
    const route = await mount()
    const path = join(root, 'report.csv')
    await writeFile(path, PNG_BYTES)
    const response = await route.raw(
      `http://127.0.0.1/api/file?path=${encodeURIComponent(path)}&download=1&name=${encodeURIComponent('日本語 "quoted".csv')}`,
    )
    // Quotes are dropped rather than escaped, and the non-ASCII spelling rides in `filename*`.
    expect(response.headers.get('content-disposition'))
      .toBe("attachment; filename=\"___ quoted.csv\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%20quoted.csv")
    expect(await responseBytes(response)).toEqual(PNG_BYTES)
  })

  it('never lets a download name smuggle a header or a path', () => {
    expect(contentDisposition('a"b\r\nX-Evil: 1.txt'))
      .toBe("attachment; filename=\"abX-Evil: 1.txt\"; filename*=UTF-8''abX-Evil%3A%201.txt")
    expect(contentDisposition('/etc/passwd')).toBe("attachment; filename=\"passwd\"; filename*=UTF-8''passwd")
    expect(contentDisposition('...')).toBe("attachment; filename=\"...\"; filename*=UTF-8''...")
    expect(contentDisposition('')).toBe('attachment; filename="download"; filename*=UTF-8\'\'')
  })

  it('unregisters every route on disposal', async () => {
    const route = await mount()
    await route.dispose()
    expect(route.unregister).toHaveBeenCalledTimes(2)
  })
})

describe('SessionMediaReferences /api/attachment.download', () => {
  let root: string
  const contexts: Context[] = []

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-attachment-download-')))
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  it('requires both coordinates', async () => {
    const route = await mountDownload(async () => { throw new Error('must not be called') })
    expect((await route.raw('http://127.0.0.1/api/attachment.download')).status).toBe(400)
    expect((await route.raw('http://127.0.0.1/api/attachment.download?sessionId=s1')).status).toBe(400)
    expect((await route.raw('http://127.0.0.1/api/attachment.download?attachmentId=a1')).status).toBe(400)
    expect((await route.raw('http://127.0.0.1/api/attachment.download?sessionId=&attachmentId=a1')).status).toBe(400)
  })

  it('refuses every request while no Session owner is mounted', async () => {
    const route = await mountDownload(undefined, false)
    const response = await route.raw('http://127.0.0.1/api/attachment.download?sessionId=s1&attachmentId=a1')
    expect(response.status).toBe(503)
  })

  it('streams an uploaded file with its own name and length', async () => {
    const head = new Uint8Array([1, 2])
    const tail = new Uint8Array([3, 4, 5])
    const download = vi.fn(async () => ({
      name: 'quarterly notes.md',
      mediaType: undefined,
      length: head.length + tail.length,
      bytes: chunks(head, tail),
    }))
    const route = await mountDownload(download)
    const response = await route.raw('http://127.0.0.1/api/attachment.download?sessionId=s1&attachmentId=a1')
    expect(response.status).toBe(200)
    expect(await responseBytes(response)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(response.headers.get('content-type')).toBe('text/markdown')
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="quarterly notes.md"; filename*=UTF-8\'\'quarterly%20notes.md')
    expect(download).toHaveBeenCalledWith({ sessionId: 's1', attachmentId: 'a1' }, expect.any(AbortSignal))
  })

  it('prefers the store media type and answers HEAD without pulling bytes', async () => {
    const pulled = vi.fn()
    const download = vi.fn(async () => ({
      name: 'shot.png',
      mediaType: 'image/png',
      length: 4,
      bytes: (async function* () { pulled(); yield PNG_BYTES })(),
    }))
    const route = await mountDownload(download)
    const response = await route.raw('http://127.0.0.1/api/attachment.download?sessionId=s1&attachmentId=a1', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe('4')
    expect(pulled).not.toHaveBeenCalled()
  })

  it('answers an unreferenced attachment and an unknown Session as not found', async () => {
    const route = await mountDownload(async () => {
      throw new RemoteError('session/attachment-invalid', 'Attachment is not referenced by this session.', { reason: 'ATTACHMENT_NOT_REFERENCED' })
    })
    expect((await route.raw('http://127.0.0.1/api/attachment.download?sessionId=s1&attachmentId=a1')).status).toBe(404)
    const missing = await mountDownload(async () => {
      throw new RemoteError('session/not-found', 'no such session', { sessionId: SessionId('s1') })
    })
    const response = await missing.raw('http://127.0.0.1/api/attachment.download?sessionId=s1&attachmentId=a1')
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('session/not-found')
  })

  it('reports an unclassified store failure as a server failure', async () => {
    const route = await mountDownload(async () => { throw new Error('store exploded') })
    expect((await route.raw('http://127.0.0.1/api/attachment.download?sessionId=s1&attachmentId=a1')).status).toBe(500)
  })
})

async function mountDownload(
  downloadAttachment?: (request: unknown, signal: AbortSignal) => Promise<unknown>,
  provide = true,
): Promise<{ raw: (url: string, init?: RequestInit) => Promise<Response> }> {
  const ctx = new Context()
  sharedContexts.push(ctx)
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('connection', {
    fetch: {
      register: (registered: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        handlers.set(registered.path, registered.fetch)
        return () => {}
      },
    },
  } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: DEFAULT_LIMIT } } as never)
  if (provide) ctx.provide('sessionController', { downloadAttachment } as never)
  await ctx.plugin(LocalFileSystem, { cwd: tmpdir() }).await()
  await ctx.plugin(SessionMediaReferences).await()
  return {
    raw: (url, init) => {
      const handler = handlers.get(new URL(url).pathname)
      if (handler === undefined) throw new Error(`route not registered: ${new URL(url).pathname}`)
      return handler(new Request(url, init))
    },
  }
}
