/**
 * Archiving gives back what a Session costs this process.
 *
 * The registry flag is only a flag: a Session's Agent and the parsed graph a
 * read retained belong to other layers, and this is the half that hands them
 * back. Three rules decide it, and each has a test here — release what this
 * controller made live, leave an Agent someone else owns, and leave a running
 * Agent alone, because stopping a loop mid-turn discards work instead of
 * freeing idle memory.
 *
 * The production controller is mounted rather than stubbed: the ownership
 * being asserted is its own bookkeeping of the handles create and resume hand
 * back, which a stub would replace with the answer.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

/** One Session on disk that this process has never resumed. */
const COLD: SessionHeader = {
  version: SESSION_FORMAT_VERSION, id: sid('cold'), createdAt: 1, cwd: '/proj', isSeeded: false,
}

interface Mounted {
  readonly ctx: Context
  readonly controller: ReturnType<typeof createSessionTestController>
  /** The Agent the factory resumed, so a test can change its status. */
  readonly resumed: Agent[]
  readonly disposed: ReturnType<typeof vi.fn>
  /** Cold-log loads, so a dropped retained graph can be told from a reused one. */
  readonly inspects: ReturnType<typeof vi.fn>
}

async function mount(): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const inspects = vi.fn(() => Promise.resolve({ meta: COLD, inheritedEventCount: 0, events: [] }))
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([COLD]),
    inspect: inspects,
  }) as never)
  ctx.provide('workspaceRegistry', { list: () => [], archiveSession: () => Promise.resolve() } as never)

  const resumed: Agent[] = []
  const disposed = vi.fn()
  const materialize = async (
    ownerCtx: Context,
    id: SessionId,
    meta: unknown,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> => {
    const session: Session = ctx.sessions.create(id, meta === undefined ? {} : { meta: meta as never })
    const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as unknown as Agent
    await setup?.(ownerCtx, agent)
    // The registry's own disposer, so disposal really unregisters: a handle
    // that only resolves would let a release look successful while the Agent
    // stayed live.
    const unregister = ctx.agents.register(agent)
    return {
      agent,
      dispose: async () => {
        disposed(agent.id)
        await unregister()
      },
    }
  }
  ctx.agents.setFactory({
    createAgent: async (ownerCtx, options) =>
      await materialize(ownerCtx, options.sessionId, options.meta, options.setup),
    resume: async (ownerCtx: Context, options: ResumeAgentOptions) => {
      const handle = await materialize(ownerCtx, options.resumeSessionId, { cwd: '/proj' }, options.setup)
      resumed.push(handle.agent)
      return handle
    },
  })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/proj',
    promoteOnHistoryOpen: false,
  })
  return { ctx, controller, resumed, disposed, inspects }
}

describe('releasing an archived Session', () => {
  it('disposes the Agent this controller resumed, and the read state a look retained', async () => {
    const { ctx, controller, disposed, inspects } = await mount()
    const found = await controller.resolveAgent(sid('cold'))
    expect('agent' in found).toBe(true)
    expect(ctx.agents.get(sid('cold'))).toBeDefined()
    // Resolving prepared the cold log, which is the other half of what an
    // archived Session costs.
    expect(inspects).toHaveBeenCalledTimes(1)

    ctx.emit('workspace/session-archived', sid('cold'))

    await vi.waitFor(() => {
      // Asserted as a boolean: a live Agent holds a cordis Context, and
      // letting vitest print one throws from inside its own formatter.
      expect(ctx.agents.get(sid('cold')) === undefined).toBe(true)
    })
    expect(disposed).toHaveBeenCalledWith('cold')
    // Nothing retained is left to release. Had the archive given back only the
    // Agent, this probe would have found the parsed graph and returned true.
    expect(ctx.sessionQuery.releaseSession(sid('cold'))).toBe(false)
  })

  it('leaves a running Agent to finish what it is doing', async () => {
    const { ctx, controller, resumed, disposed } = await mount()
    await controller.resolveAgent(sid('cold'))
    // The Agent is live and mid-turn: archiving the row must not kill the turn.
    Object.assign(resumed[0]!, { status: 'running' })

    ctx.emit('workspace/session-archived', sid('cold'))
    await Promise.resolve()

    expect(disposed).not.toHaveBeenCalled()
    expect(ctx.agents.get(sid('cold'))).toBeDefined()
  })

  it('leaves an Agent this controller did not make live', async () => {
    const { ctx, disposed } = await mount()
    const session = ctx.sessions.create(sid('cold'), { meta: { cwd: '/proj' } })
    await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)

    ctx.emit('workspace/session-archived', sid('cold'))
    await Promise.resolve()

    // Ownership is the whole question: this one belongs to whoever made it.
    expect(disposed).not.toHaveBeenCalled()
    expect(ctx.agents.get(sid('cold'))).toBeDefined()
  })
})
