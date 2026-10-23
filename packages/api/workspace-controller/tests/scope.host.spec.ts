/**
 * Cross-account write gates and the Workspace feed under a scoped caller.
 *
 * Every verb here takes an id rather than a path, and none of them carries an
 * account of its own: the Workspace registry is the only thing that knows whose
 * data a call is about. These cases hold that knowledge to the caller's scope,
 * through the same `callVisibility` chain the browser reaches.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyScope, type SessionScopeConfig } from '@deepseek-ai/dsh-session-scope'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { PeerId, PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController from '../src/index.ts'
import type { WorkspaceFollowFrame } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const PUNIT = 'punit@rubysteels.com'
const TIRTH = 'tirth@rubysteels.com'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Mount the controller over two accounts' directories, with Session scoping
 * loaded exactly as the deployment loads it.
 */
async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-scope-')))
  tempDirs.push(root)
  const punit = join(root, 'punit')
  const tirth = join(root, 'tirth')
  mkdirSync(punit, { recursive: true })
  mkdirSync(tirth, { recursive: true })

  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  new RemoteAccessService(ctx)

  const config: SessionScopeConfig = {
    header: 'x-auth-request-email',
    admin: [],
    users: { [PUNIT]: punit, [TIRTH]: tirth },
    provisionRoot: '',
    requireIdentity: true,
  }
  await ctx.plugin((pluginCtx) => { applyScope(pluginCtx, config) }).await()

  const controller = new WorkspaceController(ctx, { documentsDirectory: root })
  const punitWorkspace = await controller.create({ path: punit })
  const tirthWorkspace = await controller.create({ path: tirth })
  const session = ctx.sessions.create(SessionId('punit-session'), { meta: { cwd: punit } })
  await ctx.workspaceRegistry.get(punitWorkspace.workspace.workspaceId)
    ?.attachSession(session.id)

  return { ctx, controller, root, punit, tirth, punitWorkspace, tirthWorkspace, session }
}

/** The controller as one authenticated account reaches it. */
function as(ctx: Context, identity: string): Context {
  const peer = { id: 'scope-peer' as PeerId, ctx, principal: { kind: 'owner' } } as unknown as PeerScope
  ;(ctx.get('sessionScope') as { remember(peer: PeerScope, identity: string): void }).remember(peer, identity)
  const invocation = {
    request: { namespace: 'workspace', method: 'call', args: {} },
    service: 'workspaceController',
    peer,
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }),
  } as unknown as RemoteInvocation
  return ctx.extend({ invocation })
}

async function nextFrame(iterator: AsyncIterator<WorkspaceFollowFrame>): Promise<WorkspaceFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Workspace stream ended before the expected frame')
  return next.value
}

describe('WorkspaceController under a scoped caller', () => {
  it('shows only the caller\'s own Workspace and Sessions in the feed', async () => {
    const { ctx, punitWorkspace, session } = await harness()
    const punit = as(ctx, PUNIT)
    const abort = new AbortController()
    const iterator = punit.workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await nextFrame(iterator)
      expect(frame.type).toBe('baseline')
      if (frame.type !== 'baseline') return
      expect(frame.value.items.map(item => item.workspaceId)).toEqual([punitWorkspace.workspace.workspaceId])
      expect(frame.value.items[0]?.sessionIds).toEqual([session.id])
      // The registry-global sets are withheld rather than filtered.
      expect(frame.value.archivedSessionIds).toEqual([])
      expect(frame.value.pinnedSessionIds).toEqual([])
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('refuses to register a directory outside the caller\'s own roots', async () => {
    const { ctx, tirth } = await harness()
    await expect(as(ctx, PUNIT).workspaceController.create({ path: tirth }))
      .rejects.toMatchObject({ code: 'session-scope/forbidden' })
  })

  it('reports another account\'s Workspace as missing for every id-addressed verb', async () => {
    const { ctx, punitWorkspace, tirthWorkspace } = await harness()
    const punit = as(ctx, PUNIT)
    const tirthId = tirthWorkspace.workspace.workspaceId

    await expect(punit.workspaceController.rename({ workspaceId: tirthId, title: 'mine now' }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(punit.workspaceController.delete({ workspaceId: tirthId }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(punit.workspaceController.insertBefore({ workspaceId: tirthId }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(punit.workspaceController.insertBefore({
      workspaceId: punitWorkspace.workspace.workspaceId,
      beforeWorkspaceId: tirthId,
    })).rejects.toMatchObject({ code: 'workspace/not-found' })
    // The refused delete left the other account's Workspace registered.
    expect(ctx.workspaceRegistry.get(tirthId)?.title).not.toBe('mine now')
  })

  it('reports another account\'s Session as missing for archive and pin', async () => {
    const { ctx, tirthWorkspace, tirth } = await harness()
    const tirthSession = ctx.sessions.create(SessionId('tirth-session'), { meta: { cwd: tirth } })
    await ctx.workspaceRegistry.get(tirthWorkspace.workspace.workspaceId)
      ?.attachSession(tirthSession.id)
    const punit = as(ctx, PUNIT)

    await expect(punit.workspaceController.archiveSession({ sessionId: tirthSession.id }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(punit.workspaceController.pinSession({ sessionId: tirthSession.id }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
  })

  it('leaves the owner reaching their own Workspace and Session', async () => {
    const { ctx, punitWorkspace, session } = await harness()
    const punit = as(ctx, PUNIT)
    await expect(punit.workspaceController.rename({
      workspaceId: punitWorkspace.workspace.workspaceId,
      title: 'my work',
    })).resolves.toMatchObject({ workspace: { title: 'my work' } })
    await expect(punit.workspaceController.pinSession({ sessionId: session.id }))
      .resolves.toMatchObject({ pinnedSessionIds: [session.id] })
  })

  it('leaves an unconstrained caller reaching every Workspace', async () => {
    const { controller, punitWorkspace, tirthWorkspace } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      const frame = await nextFrame(iterator)
      expect(frame.type).toBe('baseline')
      if (frame.type !== 'baseline') return
      expect(frame.value.items.map(item => item.workspaceId).sort()).toEqual([
        punitWorkspace.workspace.workspaceId,
        tirthWorkspace.workspace.workspaceId,
      ].sort())
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })
})
