/**
 * The download route's own service lookup, against the real Session Controller.
 *
 * `SessionMediaReferences` is applied from inside the Session Controller's
 * constructor, so it cannot declare that owner as an injection without making
 * its own file route wait on the service still being built; it reads the owner
 * through `ctx.get` instead. A stub controller would prove nothing about that
 * lookup, so this mounts the production class and drives the handler the
 * connection registry actually received.
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createSessionTestController } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

/** Mount the production controller with the two services its routes need. */
async function mountRealController(): Promise<Map<string, (request: Request) => Promise<Response>>> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        handlers.set(route.path, route.fetch)
        return () => {}
      },
    },
  } as never)
  await ctx.plugin(LocalFileSystem, { cwd: '/tmp' })
  createSessionTestController(ctx, defaults)
  return handlers
}

describe('Session Controller download route wiring', () => {
  it('registers both byte routes and resolves its own Session owner from inside the plugin', async () => {
    const handlers = await mountRealController()
    expect([...handlers.keys()].sort()).toEqual(['/api/attachment.download', '/api/file'])
    const handler = handlers.get('/api/attachment.download')!
    // 404 for the Session, not 503 for the owner: the lookup resolved, and the
    // answer came from the controller's own authorization.
    const response = await handler(new Request(
      'http://127.0.0.1/api/attachment.download?sessionId=missing&attachmentId=att',
    ))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('session/not-found')
  })

  it('answers a real download through the same registration', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wiring-download-')))
    try {
      const path = join(root, 'report.csv')
      await writeFile(path, 'a,b\n1,2\n')
      const handlers = await mountRealController()
      const file = handlers.get('/api/file')!
      const download = await file(new Request(
        `http://127.0.0.1/api/file?path=${encodeURIComponent(path)}&download=1`,
      ))
      expect(download.status).toBe(200)
      expect(await download.text()).toBe('a,b\n1,2\n')
      expect(download.headers.get('content-disposition'))
        .toBe('attachment; filename="report.csv"; filename*=UTF-8\'\'report.csv')
      expect(download.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; allow-downloads")
      // The same path without the request stays a display read, policy included.
      const inline = await file(new Request(`http://127.0.0.1/api/file?path=${encodeURIComponent(path)}`))
      expect(inline.headers.get('content-disposition')).toBeNull()
      expect(inline.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
