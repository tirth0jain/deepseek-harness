/**
 * Admission attribution: one Peer per identity.
 *
 * The point of minting a Peer per identity rather than carrying identity in
 * request-scoped storage is that every Remote call already receives its Peer,
 * and streams keep theirs for the life of the socket. These tests pin the two
 * properties enforcement depends on: the same identity always resolves to the
 * same Peer, and two identities never share one.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { BrowserAuth } from '../src/browser-auth.ts'
import type { RequestIdentityResolver } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

const LOOPBACK = { host: '127.0.0.1' } as const

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    // Browser authentication is off in this deployment; the fence still runs.
    new HostConnectionService(pluginCtx, [], { isAuthenticated: () => true } as unknown as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

interface RecordingResolver extends RequestIdentityResolver {
  readonly remembered: Array<{ peer: PeerScope; identity: string }>
}

/** Stand-in for the deployment policy: reads one header, records what it is told. */
function identityResolver(requiresIdentity = false): RecordingResolver {
  const remembered: Array<{ peer: PeerScope; identity: string }> = []
  return {
    remembered,
    requiresIdentity,
    identityFromHeaders(headers) {
      const raw = typeof (headers as Headers).get === 'function'
        ? (headers as Headers).get('x-auth-request-email')
        : (headers as Readonly<Record<string, string | readonly string[] | undefined>>)['x-auth-request-email']
      const value = typeof raw === 'string' ? raw : raw?.[0]
      return value === undefined || value.trim() === '' ? undefined : value.trim().toLowerCase()
    },
    remember(peer, identity) {
      remembered.push({ peer, identity })
    },
  }
}

describe('request identity admission', () => {
  it('admits every request as the operator when no resolver is installed', async () => {
    const { connection, dispose } = await mounted()
    const first = connection.admit({ headers: { ...LOOPBACK } })
    const second = connection.admit({ headers: { ...LOOPBACK } })
    expect('peer' in first && first.peer).toBe(connection.operator)
    expect('peer' in second && second.peer).toBe(connection.operator)
    await dispose()
  })

  it('mints one Peer per identity and reuses it across requests', async () => {
    const { connection, dispose } = await mounted()
    const resolver = identityResolver()
    connection.setIdentityResolver(resolver)

    const punit = connection.admit({ headers: { ...LOOPBACK, 'x-auth-request-email': 'punit@rubysteels.com' } })
    const punitAgain = connection.admit({ headers: { ...LOOPBACK, 'x-auth-request-email': 'Punit@Rubysteels.com' } })
    const sunny = connection.admit({ headers: { ...LOOPBACK, 'x-auth-request-email': 'sunny@rubysteels.com' } })

    expect('peer' in punit && 'peer' in sunny).toBe(true)
    if (!('peer' in punit) || !('peer' in punitAgain) || !('peer' in sunny)) throw new Error('expected admission')
    expect(punit.peer).toBe(punitAgain.peer)
    expect(punit.peer).not.toBe(sunny.peer)
    // Never the operator: an identified request must not speak for the Peer
    // that sees everything.
    expect(punit.peer).not.toBe(connection.operator)
    expect(sunny.peer).not.toBe(connection.operator)
    await dispose()
  })

  it('tells the resolver which identity each minted Peer speaks for', async () => {
    const { connection, dispose } = await mounted()
    const resolver = identityResolver()
    connection.setIdentityResolver(resolver)

    const admitted = connection.admit({ headers: { ...LOOPBACK, 'x-auth-request-email': 'ajit@rubysteels.com' } })
    if (!('peer' in admitted)) throw new Error('expected admission')
    expect(resolver.remembered).toEqual([
      { peer: admitted.peer, identity: 'ajit@rubysteels.com' },
    ])
    expect(resolver.remembered[0]?.peer).toBe(admitted.peer)
    await dispose()
  })

  it('refuses an unidentified request when the deployment demands an identity', async () => {
    const { connection, dispose } = await mounted()
    connection.setIdentityResolver(identityResolver(true))
    expect(connection.admit({ headers: { ...LOOPBACK } })).toEqual({ rejection: 403 })
    await dispose()
  })

  it('falls back to the operator when an identity is merely optional', async () => {
    const { connection, dispose } = await mounted()
    connection.setIdentityResolver(identityResolver(false))
    const admitted = connection.admit({ headers: { ...LOOPBACK } })
    expect('peer' in admitted && admitted.peer).toBe(connection.operator)
    await dispose()
  })

  it('stops attributing once the resolver is withdrawn', async () => {
    const { connection, dispose } = await mounted()
    const restore = connection.setIdentityResolver(identityResolver())
    const admitted = connection.admit({ headers: { ...LOOPBACK, 'x-auth-request-email': 'punit@rubysteels.com' } })
    expect('peer' in admitted && admitted.peer !== connection.operator).toBe(true)
    restore()
    const after = connection.admit({ headers: { ...LOOPBACK, 'x-auth-request-email': 'punit@rubysteels.com' } })
    expect('peer' in after && after.peer).toBe(connection.operator)
    await dispose()
  })

  it('fences a hostile request before attribution', async () => {
    const { connection, dispose } = await mounted()
    const resolver = identityResolver()
    connection.setIdentityResolver(resolver)
    // A non-loopback authority is not declared, so the fence refuses it and
    // the resolver is never consulted.
    const admitted = connection.admit({
      headers: { host: 'evil.example', 'x-auth-request-email': 'punit@rubysteels.com' },
    })
    expect('rejection' in admitted && admitted.rejection).toBe(403)
    expect(resolver.remembered).toEqual([])
    await dispose()
  })

  it('hands the admitted Peer to the shared-channel interceptor, not the operator', async () => {
    // Regression: the interceptor used to capture the operator Peer when it was
    // registered, so `admit()` computed a per-identity Peer that every Remote
    // call then discarded. Scoping looked wired and enforced nothing.
    const { connection, dispose } = await mounted()
    const seen: PeerScope[] = []
    connection.rpc.intercept('/api', () => true, async (_endpoint, _payload, _signal, peer) => {
      seen.push(peer)
      return { ok: true, value: null }
    })
    connection.setIdentityResolver(identityResolver())
    const admitted = connection.admit({
      headers: { ...LOOPBACK, 'x-auth-request-email': 'punit@rubysteels.com' },
    })
    if (!('peer' in admitted)) throw new Error('expected admission')

    const handler = connection.createSharedFetchHandler('/api', admitted.peer)
    const response = await handler.fetch(new Request('http://127.0.0.1/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
    }))

    expect(response.status).toBe(200)
    expect(seen).toEqual([admitted.peer])
    expect(seen[0]).not.toBe(connection.operator)
    await dispose()
  })

  it('hands the admitted Peer to an exact Fetch route', async () => {
    // A Fetch route is not a Remote call, so the Peer parameter is the only way
    // it can learn who is calling — session.export depends on it.
    const { connection, dispose } = await mounted()
    const seen: PeerScope[] = []
    connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request, peer) => {
        seen.push(peer)
        return Promise.resolve(Response.json({ ok: true, url: request.url }))
      },
    })
    connection.setIdentityResolver(identityResolver())
    const admitted = connection.admit({
      headers: { ...LOOPBACK, 'x-auth-request-email': 'punit@rubysteels.com' },
    })
    if (!('peer' in admitted)) throw new Error('expected admission')

    const handler = connection.createSharedFetchHandler('/api', admitted.peer)
    const response = await handler.fetch(new Request('http://127.0.0.1/api/session.export?sessionId=session-1'))

    expect(response.status).toBe(200)
    expect(seen).toEqual([admitted.peer])
    await dispose()
  })
})
