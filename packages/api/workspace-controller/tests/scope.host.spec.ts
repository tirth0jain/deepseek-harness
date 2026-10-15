/**
 * Cross-account write gates.
 *
 * Every verb here takes an id rather than a path, and none of them carries an
 * account of its own: the Workspace registry is the only thing that knows whose
 * data a call is about. These cases hold that knowledge to the caller's scope,
 * through the same `callVisibility` chain the browser reaches.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyScope, type SessionScopeConfig } from '@deepseek-ai/dsh-session-scope'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import WorkspaceController from '../src/index.ts'
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
  } as never)

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
  await ctx.workspaceRegistry.get(punitWorkspace.workspace.workspaceId)?.attachSession(session.id)

  return { ctx, controller, root, punit, tirth, punitWorkspace, tirthWorkspace, session }
}

/**
 * The controller as one authenticated account reaches it: a Peer the scoping
 * service has been told about, carried on the call's own Context.
 */
function as(ctx: Context, identity: string): WorkspaceController {
  const peer = { id: 'peer' as PeerScope['id'], ctx: new Context() } as unknown as PeerScope
  ctx.sessionScope.remember(peer, identity)
  return ctx.extend({ invocation: { peer } }).get('workspaceController') as WorkspaceController
}

describe('Workspace mutations under a scoped caller', () => {
  it('reports another account\'s Workspace as missing and leaves it untouched', async () => {
    const { ctx, punitWorkspace, tirthWorkspace } = await harness()
    const foreign = tirthWorkspace.workspace.workspaceId
    const punit = as(ctx, PUNIT)

    await expect(punit.rename({ workspaceId: foreign, title: 'mine now' }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(punit.delete({ workspaceId: foreign }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(punit.insertBefore({ workspaceId: foreign }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(punit.insertBefore({
      workspaceId: punitWorkspace.workspace.workspaceId,
      beforeWorkspaceId: foreign,
    })).rejects.toMatchObject({ code: 'workspace/not-found' })

    expect(ctx.workspaceRegistry.get(foreign)?.title).toBe('tirth')
    expect(ctx.workspaceRegistry.get(punitWorkspace.workspace.workspaceId)?.title).toBe('punit')
  })

  it('still renames, reorders, and deletes the caller\'s own Workspace', async () => {
    const { ctx, punitWorkspace } = await harness()
    const own = punitWorkspace.workspace.workspaceId
    const punit = as(ctx, PUNIT)

    await expect(punit.rename({ workspaceId: own, title: 'site survey' }))
      .resolves.toMatchObject({ workspace: { workspaceId: own, title: 'site survey' } })
    // The sidebar only ever shows the caller's own Workspaces, so an anchor it
    // could offer is one of these; ordering needs no reach beyond that.
    await expect(punit.insertBefore({ workspaceId: own })).resolves.toBeDefined()
    await expect(punit.delete({ workspaceId: own })).resolves.toEqual({ deleted: true })
    expect(ctx.workspaceRegistry.get(own)).toBeUndefined()
  })

  it('lets two accounts title their own Workspaces the same thing', async () => {
    const { ctx, punitWorkspace, tirthWorkspace } = await harness()

    await expect(as(ctx, PUNIT).rename({ workspaceId: punitWorkspace.workspace.workspaceId, title: 'site' }))
      .resolves.toMatchObject({ workspace: { title: 'site' } })
    // A global conflict check would answer `workspace/name-conflict` here, and
    // in doing so tell this account that the other one exists.
    await expect(as(ctx, TIRTH).rename({ workspaceId: tirthWorkspace.workspace.workspaceId, title: 'site' }))
      .resolves.toMatchObject({ workspace: { title: 'site' } })
  })

  it('confines Session membership verbs to the accounting Workspace\'s owner', async () => {
    const { ctx, punitWorkspace, session } = await harness()
    const foreign = as(ctx, TIRTH)
    const own = as(ctx, PUNIT)

    await expect(foreign.archiveSession({ sessionId: session.id }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(foreign.pinSession({ sessionId: session.id }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(foreign.unarchiveSession({ sessionId: session.id }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(foreign.insertSessionBefore({
      workspaceId: punitWorkspace.workspace.workspaceId,
      sessionId: session.id,
    })).rejects.toMatchObject({ code: 'workspace/not-found' })
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])

    await expect(own.archiveSession({ sessionId: session.id })).resolves.toEqual({
      archivedSessionIds: [session.id],
    })
    await expect(own.unarchiveSession({ sessionId: session.id })).resolves.toEqual({
      archivedSessionIds: [],
    })
  })

  it('leaves an unconstrained caller reaching every account', async () => {
    const { ctx, controller, punitWorkspace, tirthWorkspace } = await harness()

    await expect(controller.rename({ workspaceId: tirthWorkspace.workspace.workspaceId, title: 'renamed' }))
      .resolves.toMatchObject({ workspace: { title: 'renamed' } })
    await expect(controller.delete({ workspaceId: punitWorkspace.workspace.workspaceId }))
      .resolves.toEqual({ deleted: true })
    expect(ctx.workspaceRegistry.get(tirthWorkspace.workspace.workspaceId)?.title).toBe('renamed')
  })

  it('answers a Workspace that does not exist at all the same way', async () => {
    const { ctx } = await harness()
    await expect(as(ctx, PUNIT).rename({ workspaceId: 'no-such-workspace' as WorkspaceId, title: 'x' }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
  })
})
