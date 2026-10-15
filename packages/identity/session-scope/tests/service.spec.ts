/**
 * The scoping service: peers to identities to visible paths.
 *
 * `scopeOfPeer` answering undefined is a deliberate third state, distinct from
 * "sees nothing". Connection admits in-process callers — the agent's own tools,
 * an uplink, the desktop host — as the operator Peer, which no resolver ever
 * remembers, and those must keep seeing everything. Only an identity the
 * deployment actually recognized gets constrained.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { assertVisibility, apply, callRoots, type SessionScopeConfig } from '../src/index.ts'

const ADMIN = 'main.pastrami903@passfwd.com'

const officeConfig: SessionScopeConfig = {
  header: 'x-auth-request-email',
  admin: [ADMIN],
  users: {
    'punit@rubysteels.com': '/root/punit',
    'Sunn@rubysteels.com': '/root/sunny',
  },
  provisionRoot: '/root',
  requireIdentity: false,
}

const mounted: Array<() => Promise<void>> = []
const scratch: string[] = []

afterEach(async () => {
  for (const dispose of mounted.splice(0)) await dispose()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function service(config: SessionScopeConfig = officeConfig) {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => { apply(pluginCtx, config) })
  await fiber.await()
  mounted.push(() => fiber.dispose())
  const scope = ctx.get('sessionScope')
  if (scope === undefined) throw new Error('sessionScope was not provided')
  return scope
}

/** A stand-in Peer: the service only ever uses its object identity. */
function peer(): PeerScope {
  return { id: 'peer' as PeerScope['id'], ctx: new Context() } as unknown as PeerScope
}

describe('session scope service', () => {
  it('leaves an unrecognized peer unconstrained', async () => {
    const scope = await service()
    const operator = peer()
    expect(scope.scopeOfPeer(operator)).toBeUndefined()
    expect(scope.mayAccess(operator, '/root/Ruby/private')).toBe(true)
    expect(scope.visiblePaths(operator, ['/root/Ruby', '/root/punit']))
      .toEqual(['/root/Ruby', '/root/punit'])
  })

  it('leaves every caller unconstrained when nothing is configured', async () => {
    const scope = await service({
      header: 'x-auth-request-email', admin: [], users: {}, provisionRoot: '', requireIdentity: false,
    })
    expect(scope.enabled).toBe(false)
    const punit = peer()
    scope.remember(punit, 'punit@rubysteels.com')
    expect(scope.mayAccess(punit, '/root/Ruby/private')).toBe(true)
  })

  it('constrains a recognized identity to its own root', async () => {
    const scope = await service()
    const punit = peer()
    scope.remember(punit, 'punit@rubysteels.com')
    expect(scope.mayAccess(punit, '/root/punit')).toBe(true)
    expect(scope.mayAccess(punit, '/root/punit/site-survey')).toBe(true)
    expect(scope.mayAccess(punit, '/root/Ruby')).toBe(false)
    expect(scope.visiblePaths(punit, ['/root/Ruby', '/root/punit', '/root/punit/x']))
      .toEqual(['/root/punit', '/root/punit/x'])
  })

  it('matches a configured user regardless of the case the proxy sent', async () => {
    const scope = await service()
    const sunny = peer()
    scope.remember(sunny, 'SUNN@rubysteels.com')
    expect(scope.mayAccess(sunny, '/root/sunny/notes')).toBe(true)
    expect(scope.mayAccess(sunny, '/root/punit')).toBe(false)
  })

  it('lets an administrator see every path', async () => {
    const scope = await service()
    const admin = peer()
    scope.remember(admin, ADMIN)
    expect(scope.scopeOfPeer(admin)?.admin).toBe(true)
    expect(scope.mayAccess(admin, '/root/punit')).toBe(true)
    expect(scope.mayAccess(admin, '/root/Ruby/deep')).toBe(true)
  })

  it('mints a root for a first-time identity and reports it visible', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-scope-'))
    scratch.push(home)
    const scope = await service({ ...officeConfig, provisionRoot: home, users: {} })

    const samay = peer()
    scope.remember(samay, 'samay@rubysteels.com')
    const root = join(home, 'samay')
    expect(scope.mayAccess(samay, join(root, 'first-project'))).toBe(true)
    expect(scope.mayAccess(samay, join(home, 'punit'))).toBe(false)

    expect(scope.ensureRoot('samay@rubysteels.com')).toBe(root)
    expect(statSync(root).isDirectory()).toBe(true)
  })

  it('never mints a root for an explicit or administrative identity', async () => {
    const scope = await service({ ...officeConfig, provisionRoot: '/root' })
    expect(scope.ensureRoot('punit@rubysteels.com')).toBeUndefined()
    expect(scope.ensureRoot(ADMIN)).toBeUndefined()
    expect(scope.ensureRoot('nobody@example.com')).toBe('/root/nobody')
  })

  it('folds a repeated header to its first member', async () => {
    const scope = await service()
    expect(scope.identityFromHeaders({ 'x-auth-request-email': 'Punit@Rubysteels.com, samay@rubysteels.com' }))
      .toBe('punit@rubysteels.com')
    expect(scope.identityFromHeaders(new Headers({ 'X-Auth-Request-Email': 'Sunny@Rubysteels.com' })))
      .toBe('sunny@rubysteels.com')
    expect(scope.identityFromHeaders({})).toBeUndefined()
  })

  it('reports whether an unidentified request must be refused', async () => {
    expect((await service()).requiresIdentity).toBe(false)
    expect((await service({ ...officeConfig, requireIdentity: true })).requiresIdentity).toBe(true)
  })
})

describe('rootsOfPeer and callRoots', () => {
  it('names the directories one constrained peer owns', async () => {
    const scope = await service()
    const punit = peer()
    scope.remember(punit, 'Punit@Rubysteels.com')
    expect(scope.rootsOfPeer(punit)).toEqual(['/root/punit'])
  })

  it('answers undefined for every peer nothing constrains', async () => {
    const scope = await service()
    const admin = peer()
    const stranger = peer()
    const minted = peer()
    scope.remember(admin, ADMIN)
    scope.remember(minted, 'newcomer@rubysteels.com')

    expect(scope.rootsOfPeer(admin)).toBeUndefined()
    expect(scope.rootsOfPeer(stranger)).toBeUndefined()
    // A minted root is a root before it exists on disk, so a first-time
    // identity can be handed one without waiting for a mkdir.
    expect(scope.rootsOfPeer(minted)).toEqual(['/root/newcomer'])
  })

  it('answers undefined outside a Remote call', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((pluginCtx) => { apply(pluginCtx, officeConfig) })
    await fiber.await()
    mounted.push(() => fiber.dispose())
    expect(ctx.get('sessionScope')).toBeDefined()
    expect(callRoots(ctx)).toBeUndefined()
  })

  it('reads the roots of the peer a Remote call was admitted as', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((pluginCtx) => { apply(pluginCtx, officeConfig) })
    await fiber.await()
    mounted.push(() => fiber.dispose())
    const punit = peer()
    ctx.get('sessionScope')?.remember(punit, 'punit@rubysteels.com')
    expect(callRoots(ctx.extend({ invocation: { peer: punit } }))).toEqual(['/root/punit'])
  })
})

describe('assertVisibility', () => {
  const punit = (path: string | undefined): boolean =>
    path !== undefined && (path === '/root/punit' || path.startsWith('/root/punit/'))

  it('lets an unconstrained caller anywhere', () => {
    expect(() => assertVisibility(undefined, '/root/Ruby', 'the directory')).not.toThrow()
    expect(() => assertVisibility(undefined, undefined, 'the directory')).not.toThrow()
  })

  it('lets a caller into their own directory and anything beneath it', () => {
    expect(() => assertVisibility(punit, '/root/punit', 'the directory')).not.toThrow()
    expect(() => assertVisibility(punit, '/root/punit/site-survey', 'the directory')).not.toThrow()
  })

  it('refuses another account\'s directory', () => {
    expect(() => assertVisibility(punit, '/root/Ruby', 'the working directory'))
      .toThrowError(/outside the directories this account owns/)
  })

  it('refuses a sibling that merely shares a prefix', () => {
    expect(() => assertVisibility(punit, '/root/punit2', 'the directory')).toThrow()
  })

  it('refuses a path the request never named', () => {
    // Defaulting to the server's own directory would otherwise adopt whatever
    // process.cwd() happens to be.
    expect(() => assertVisibility(punit, undefined, 'the directory')).toThrow()
  })

  it('names the refused path on the wire', () => {
    try {
      assertVisibility(punit, '/root/Ruby', 'the working directory')
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'session-scope/forbidden',
        details: { target: 'the working directory', path: '/root/Ruby' },
      })
    }
  })
})
