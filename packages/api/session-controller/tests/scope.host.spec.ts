/**
 * The id-addressed Session verbs under a scoped caller.
 *
 * Listing and paging were always scoped; these verbs take a raw Session id and
 * were not, so one account could retitle, prompt, fork, cancel, or read the
 * attachments of another account's Session. Each case calls the verb as the
 * wrong account and expects the Session to be reported missing.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { apply as applyScope, type SessionScopeConfig } from '@deepseek-ai/dsh-session-scope'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import SessionController from '../src/index.ts'
import type {
  SessionPromptRequest,
  SessionUpdateQueueRequest,
} from '../src/types.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const PUNIT = 'punit@rubysteels.com'
const TIRTH = 'tirth@rubysteels.com'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The controller over two accounts' directories, with one live Session in Punit's. */
async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-session-scope-')))
  tempDirs.push(root)
  const punit = join(root, 'punit')
  const tirth = join(root, 'tirth')
  mkdirSync(punit, { recursive: true })
  mkdirSync(tirth, { recursive: true })

  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([]),
  }) as never)

  const config: SessionScopeConfig = {
    header: 'x-auth-request-email',
    admin: [],
    users: { [PUNIT]: punit, [TIRTH]: tirth },
    provisionRoot: '',
    requireIdentity: true,
  }
  await ctx.plugin((pluginCtx) => { applyScope(pluginCtx, config) }).await()

  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: root,
  })
  const id = SessionId('punit-session')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: punit,
    isSeeded: false,
  }
  const session = ctx.sessions.create(id, { meta: header })
  return { ctx, controller, root, session, id }
}

/** The controller as one authenticated account reaches it. */
function as(ctx: Context, identity: string): SessionController {
  const peer = { id: 'peer' as PeerScope['id'], ctx: new Context() } as unknown as PeerScope
  ;(ctx.get('sessionScope') as { remember(peer: PeerScope, identity: string): void }).remember(peer, identity)
  return ctx.extend({ invocation: { peer } }).get('sessionController') as SessionController
}

describe('SessionController under a scoped caller', () => {
  it('reports another account\'s Session as missing for every id-addressed verb', async () => {
    const { ctx, id } = await harness()
    const tirth = as(ctx, TIRTH)
    const signal = new AbortController().signal
    // The gate runs before the request body is read, so the fields a verb would
    // need beyond its Session id are only ever a cast in these cases.
    const wrong = { sessionId: id } as unknown as SessionPromptRequest & SessionUpdateQueueRequest

    await expect(tirth.rename({ sessionId: id, title: 'mine now' }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.prompt(wrong, signal)).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.fork({ sessionId: id })).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.handoff({ sessionId: id }, signal)).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.cancel({ sessionId: id })).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.updateQueue(wrong)).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.attachment({ sessionId: id, attachmentId: 'a1' as never }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(tirth.projections({ sessionId: id }, signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
    // The refused rename left the Session where it was.
    expect(ctx.sessions.get(id)?.header.cwd).toMatch(/punit$/)
  })

  it('leaves the owner reaching their own Session', async () => {
    const { ctx, id } = await harness()
    const punit = as(ctx, PUNIT)
    await expect(punit.projections({ sessionId: id }, new AbortController().signal))
      .resolves.toMatchObject({ kind: 'sequenced' })
    await expect(punit.composerDraft({ sessionId: id })).resolves.toEqual({ text: '' })
  })

  it('leaves an unconstrained caller reaching every Session', async () => {
    const { controller, id } = await harness()
    await expect(controller.projections({ sessionId: id }, new AbortController().signal))
      .resolves.toMatchObject({ kind: 'sequenced' })
  })
})
