/**
 * The handoff operation against a scripted compaction backend.
 *
 * What is asserted is the contract a caller depends on: the continuation's
 * whole history is the condensation, its source is archived, and every way the
 * operation can refuse says which precondition failed rather than collapsing
 * into one failure. The two fallbacks matter most — a Session already condensed
 * carries its newest recorded summary instead of refusing, and an archive that
 * fails does not throw away the continuation that was just built.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

/** One scripted compaction backend: `compactNow` plus whatever it should do. */
function compactionStub(
  compactNow: (agent: unknown, signal: AbortSignal) => Promise<{ summary: readonly { type: 'text'; text: string }[] } | null>,
): { compactNow: ReturnType<typeof vi.fn> } {
  return { compactNow: vi.fn(compactNow) }
}

async function harness(options: {
  compaction?: unknown
  archiveSession?: (sessionId: SessionId) => Promise<void>
  /** A Session the process can read but has never resumed. */
  coldSession?: boolean
} = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (options.coldSession === true) {
    // Annotated, not inferred: a bare object literal widens the version literal.
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: sid('cold'), createdAt: 1, cwd: '/proj', isSeeded: false,
    }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, inheritedEventCount: 0, events: [] }),
    }) as never)
  }
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    archiveSession: options.archiveSession ?? (() => Promise.resolve()),
  } as never)
  if (options.compaction !== undefined) ctx.provide('compaction', options.compaction as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as unknown as Agent
      await createOptions.setup?.(ownerCtx, agent)
      await ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('handoff test sources are live')),
  })
  return ctx
}

/** One live Session with `turns` completed turns, registered as an Agent. */
async function liveAgent(ctx: Context, id: string, turns: number): Promise<Session> {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

function controller(ctx: Context): SessionCommandController {
  return new SessionCommandController(ctx, {
    composeAgent: () => Promise.resolve({ setup: () => {} }),
    presetForObservation: () => undefined,
  } as unknown as ApiSessionAgentController, '/default')
}

const signal = new AbortController().signal

/** Every message the continuation's surface derives, for content assertions. */
function derivedText(session: Session): string[] {
  return session.deriveMessages().flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('session handoff', () => {
  it('continues the source in a Session whose whole history is the condensation', async () => {
    const summary = [{ type: 'text' as const, text: 'the condensed history' }]
    const ctx = await harness({ compaction: compactionStub(() => Promise.resolve({ summary })) })
    const source = await liveAgent(ctx, 'source', 3)
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)

    expect(result.sessionId).toMatch(/^session-/)
    expect(result.archived).toBe(true)
    const continuation = ctx.sessions.get(result.sessionId)
    expect(continuation).toBeDefined()
    // The carried history is the only surface content: no prefix, no turns.
    expect(derivedText(continuation!)).toEqual([
      'This conversation continues an earlier one in the same workspace. Everything before this point is '
        + 'condensed into the summary below; the earlier conversation is archived and still readable.',
      'the condensed history',
    ])
    expect(continuation!.header.parentSession).toBe(source.id)
    expect(continuation!.header.cwd).toBe('/proj')
    expect(continuation!.inheritedEventCount).toBe(0)
    // The source keeps its own history: a handoff reads it, it does not move it.
    expect(source.deriveMessages().length).toBe(3)
    await ctx.fiber.dispose()
  })

  it('attributes the carried history to the plugin, not to the reader', async () => {
    const ctx = await harness({
      compaction: compactionStub(() => Promise.resolve({ summary: [{ type: 'text' as const, text: 'condensed' }] })),
    })
    const source = await liveAgent(ctx, 'source', 2)
    const { sessionId } = await controller(ctx).handoff({ sessionId: source.id }, signal)
    const opening = ctx.sessions.get(sessionId)!.snapshotEvents()
      .find((event: SessionEvent) => event.type === 'user/message')
    expect(opening?.type === 'user/message' && opening.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'handoff',
      form: 'notice',
    })
    await ctx.fiber.dispose()
  })

  it('carries the newest recorded summary when the backend has nothing left to condense', async () => {
    const ctx = await harness({ compaction: compactionStub(() => Promise.resolve(null)) })
    const source = await liveAgent(ctx, 'source', 2)
    source.append('compaction/summary', {
      compactionId: 'c-1' as never,
      summary: [{ type: 'text', text: 'an earlier condensation' }],
      shadowedRange: { start: 0 as never, end: 0 as never },
      shadowedSeqs: [0 as never],
      shadowedTokenCount: 10,
      provider: 'fixture',
      model: 'fixture-model',
    })
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)
    expect(derivedText(ctx.sessions.get(result.sessionId)!)).toContain('an earlier condensation')
    await ctx.fiber.dispose()
  })

  it.each([
    ['no-compaction-backend', {}],
    ['session-not-live', {
      compaction: compactionStub(() => Promise.resolve({ summary: [{ type: 'text' as const, text: 'x' }] })),
      coldSession: true,
    }],
  ] as const)('refuses with %s', async (reason, options) => {
    const ctx = await harness(options)
    await expect(controller(ctx).handoff({ sessionId: sid('cold') }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { sessionId: 'cold', reason },
    })
    await ctx.fiber.dispose()
  })

  it('reports a backend refusal by its own class and refuses an empty history', async () => {
    const busy = await harness({
      compaction: compactionStub(() => Promise.reject(Object.assign(new Error('agent is active'), { code: 'busy' }))),
    })
    const busySource = await liveAgent(busy, 'source', 1)
    await expect(controller(busy).handoff({ sessionId: busySource.id }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { reason: 'compaction-busy' },
    })
    await busy.fiber.dispose()

    const empty = await harness({ compaction: compactionStub(() => Promise.resolve({ summary: [] })) })
    const emptySource = await liveAgent(empty, 'source', 1)
    await expect(controller(empty).handoff({ sessionId: emptySource.id }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { reason: 'nothing-to-carry' },
    })
    await empty.fiber.dispose()
  })

  it('lets a genuine backend fault surface instead of classifying it', async () => {
    const ctx = await harness({
      compaction: compactionStub(() => Promise.reject(new Error('backend bug'))),
    })
    const source = await liveAgent(ctx, 'source', 1)
    await expect(controller(ctx).handoff({ sessionId: source.id }, signal)).rejects.toThrow('backend bug')
    await ctx.fiber.dispose()
  })

  it('keeps the continuation when archiving the source fails', async () => {
    const ctx = await harness({
      compaction: compactionStub(() => Promise.resolve({ summary: [{ type: 'text' as const, text: 'condensed' }] })),
      archiveSession: () => Promise.reject(new Error('registry offline')),
    })
    const source = await liveAgent(ctx, 'source', 1)
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)
    expect(result.archived).toBe(false)
    expect(ctx.sessions.get(result.sessionId)).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('maps an unknown source the way fork does', async () => {
    const ctx = await harness({ compaction: compactionStub(() => Promise.resolve(null)) })
    await expect(controller(ctx).handoff({ sessionId: sid('missing') }, signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await ctx.fiber.dispose()
  })
})
