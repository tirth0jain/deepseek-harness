/**
 * A handoff whose source the process has only read.
 *
 * `promoteOnHistoryOpen: false` is a deliberate deployment policy: looking at a
 * Session must not be what makes its Agent live, and the Agent is resolved by
 * the first operation that genuinely needs one. A handoff is such an operation,
 * so it resolves the source rather than requiring the act of opening it to have
 * done so — requiring a live Agent refuses on exactly the deployments whose
 * Sessions are large enough to need condensing.
 *
 * This mounts the production Session Controller because the resolution being
 * asserted is the controller's own; a stub would only prove the call was made.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

const signal = new AbortController().signal

/** One Session on disk that this process has never resumed. */
const COLD: SessionHeader = {
  version: SESSION_FORMAT_VERSION, id: sid('cold'), createdAt: 1, cwd: '/proj', isSeeded: false,
}

interface Mounted {
  readonly ctx: Context
  readonly controller: ReturnType<typeof createSessionTestController>
  /** Every factory resume, so a promotion can be told from a refusal. */
  readonly resume: ReturnType<typeof vi.fn>
  readonly compactNow: ReturnType<typeof vi.fn>
  readonly archived: ReturnType<typeof vi.fn>
}

/** Mount the production controller with history opening deliberately non-promoting. */
async function mount(): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([COLD]),
    inspect: () => Promise.resolve({ meta: COLD, inheritedEventCount: 0, events: [] }),
  }) as never)
  const archived = vi.fn(() => Promise.resolve())
  ctx.provide('workspaceRegistry', { list: () => [], archiveSession: archived } as never)
  const compactNow = vi.fn(() => Promise.resolve({
    summary: [{ type: 'text' as const, text: 'the condensed history' }],
  }))
  ctx.provide('compaction', { compactNow } as never)
  // Both factory halves materialize a Session the way the real loop does, so a
  // resumed source is a Session this process can genuinely then compact.
  const materialize = async (
    ownerCtx: Context,
    id: SessionId,
    meta: unknown,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> => {
    const session: Session = ctx.sessions.create(id, meta === undefined ? {} : { meta: meta as never })
    const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as unknown as Agent
    await setup?.(ownerCtx, agent)
    await ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  const resume = vi.fn(async (ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> =>
    await materialize(ownerCtx, options.resumeSessionId, { cwd: '/proj' }, options.setup))
  ctx.agents.setFactory({
    createAgent: async (ownerCtx, options) =>
      await materialize(ownerCtx, options.sessionId, options.meta, options.setup),
    resume,
  })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/proj',
    promoteOnHistoryOpen: false,
  })
  return { ctx, controller, resume, compactNow, archived }
}

describe('session handoff from a Session this process has only read', () => {
  it('resumes the source and condenses it instead of refusing it', async () => {
    const { controller, resume, compactNow, archived } = await mount()
    const result = await controller.handoff({ sessionId: sid('cold') }, signal)

    // The promotion is what makes the operation possible, and the compaction
    // runs against the Agent it produced rather than a stub of one.
    expect(resume).toHaveBeenCalledTimes(1)
    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toMatch(/^session-/)
    expect(result.archived).toBe(true)
    expect(archived).toHaveBeenCalledWith(sid('cold'))
  })

  it('carries the condensation into a Session whose whole history it is', async () => {
    const { ctx, controller } = await mount()
    const result = await controller.handoff({ sessionId: sid('cold') }, signal)
    const continuation = ctx.sessions.get(result.sessionId)
    expect(continuation).toBeDefined()
    expect(continuation!.deriveMessages().flatMap(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
      .toContain('the condensed history')
  })

  it('leaves a source that is already live to whoever is using it', async () => {
    const { ctx, controller, resume } = await mount()
    const session = ctx.sessions.create(sid('cold'), { meta: { cwd: '/proj' } })
    await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)

    const result = await controller.handoff({ sessionId: sid('cold') }, signal)
    // Resolution found the live Agent: an operation must not resume — or later
    // release — an Agent that was already someone else's.
    expect(resume).not.toHaveBeenCalled()
    expect(result.archived).toBe(true)
  })
})
