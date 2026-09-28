/**
 * The handoff operation against a scripted compaction backend.
 *
 * What is asserted is the contract a caller depends on: the continuation's
 * whole history is the condensation, its source is archived, and every way the
 * operation can refuse says which precondition failed rather than collapsing
 * into one failure. The fallbacks matter most — a Session already condensed
 * carries its newest recorded summary instead of refusing, and an archive that
 * fails does not throw away the continuation that was just built.
 *
 * The backend here lives in an ISOLATED scope and is reached only through
 * `/compact`, which is the deployment's actual shape: the web profile disables
 * the host-plane compaction row and each agent preset mounts its own inside
 * `isolate: { compaction: true }`. Nothing in this file provides a host-plane
 * `compaction` service, so a handoff that went back to a service lookup at the
 * controller's own plane would refuse instead of condensing.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController, ApiSessionNotFound } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

/** One scripted compaction: the summary it produces, or null for none. */
type Backend = (
  agent: Agent,
  signal: AbortSignal,
) => Promise<{ summary: readonly ContentBlock[] } | null>

interface HarnessOptions {
  /** What the scoped backend does when `/compact` runs it. */
  backend?: Backend
  /** Mount no command registry at all. */
  noCommands?: boolean
  /** A registry that does not resolve `/compact` for this Session. */
  unknownCommand?: boolean
  archiveSession?: (sessionId: SessionId) => Promise<void>
}

/**
 * Apply one condensation the way a backend does: declare the summary, then
 * replace the shadowed surface nodes with a checkpoint user message carrying
 * it. The last `keepTail` surface nodes stay unshadowed — that retained tail is
 * what compaction keeps verbatim, so it is what a handoff has to carry beside
 * the summary.
 */
function condenseSurface(session: Session, summary: readonly ContentBlock[], keepTail = 1): void {
  const nodes = session.surface.nodes
  const shadowed = nodes.slice(0, Math.max(0, nodes.length - keepTail))
  session.append('compaction/summary', {
    compactionId: 'c-1' as never,
    summary: [...summary],
    shadowedRange: {
      start: (shadowed[0] ?? nodes[0] ?? 0) as never,
      end: (shadowed[shadowed.length - 1] ?? nodes[0] ?? 0) as never,
    },
    shadowedSeqs: [...shadowed],
    shadowedTokenCount: 10,
    provider: 'fixture',
    model: 'fixture-model',
  })
  if (shadowed.length === 0) return
  session.append('user/message', createUserMessage({
    content: [...summary],
    // The backend-independent checkpoint marker, written structurally because
    // this spec mounts no compaction package.
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'c-1' } as never,
  }), {
    surfaceOp: {
      op: 'replace',
      startSeq: shadowed[0]!,
      endSeq: shadowed[shadowed.length - 1]!,
    },
    // The replacement has to name every node it deletes.
    sourceEventSeqs: [...shadowed],
  })
}

async function harness(options: HarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    archiveSession: options.archiveSession ?? (() => Promise.resolve()),
  } as never)

  // The preset scope. A backend mounted here is invisible from `ctx`, which is
  // the point: the controller's plane must not be where the backend is read.
  const preset = ctx.isolate('compaction')
  const backend = options.backend ?? (() => Promise.resolve(null))
  preset.provide('compaction', {
    compactNow: vi.fn(async (agent: Agent, signal: AbortSignal) => {
      const result = await backend(agent, signal)
      // A real backend records what it produced, which is where the handoff
      // reads the condensed conversation back from.
      if (result !== null) condenseSurface(agent.session, result.summary)
      return result
    }),
  } as never)

  if (options.noCommands !== true) {
    ctx.provide('commands', {
      // What `/compact` does, minus the parts this operation does not read:
      // resolve the command for the Agent, then run the backend that the
      // command's own scope — not the caller's — can see.
      execute: vi.fn(async (agent: Agent, line: string, _attachments: unknown, signal: AbortSignal) => {
        if (line !== '/compact' || options.unknownCommand === true) return undefined
        const scoped = preset.get('compaction') as { compactNow: Backend }
        try {
          const result = await scoped.compactNow(agent, signal)
          return {
            commandId: 'cmd-1' as never,
            result: result === null
              ? { kind: 'success', text: 'No compactable history yet.' }
              : { kind: 'success', text: `Compacted ${String(result.summary.length)} history items.` },
          }
        } catch (error: unknown) {
          // The shipped command turns its own expected refusals into prose and
          // lets everything else throw; so does this.
          if (error instanceof Error && 'code' in error) {
            return { commandId: 'cmd-1' as never, result: { kind: 'error', text: `Compaction refused: ${error.message}` } }
          }
          throw error
        }
      }),
    } as never)
  }

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
    // The real controller owns what it creates so a later archive can release
    // it; this stub only has to create it, which the registry already does.
    createOwned: async (options: CreateAgentOptions) => (await ctx.agents.create(options)).agent,
    // The real controller resumes a source that has no Agent yet. That
    // resolution has its own spec against the production class
    // (commands-handoff-promotion.host.spec.ts); here it only has to hand back
    // the Agent every test in this file registers up front.
    resolveObservedAgent: (observation: SessionObservation) => {
      const live = ctx.agents.get(observation.header.id)
      return Promise.resolve(live === undefined
        ? { error: new ApiSessionNotFound(`session "${observation.header.id}" not found`) }
        : { agent: live })
    },
  } as unknown as ApiSessionAgentController, '/default')
}

const signal = new AbortController().signal

/** One backend that condenses to `text`. */
const condensing = (text: string): Backend =>
  () => Promise.resolve({ summary: [{ type: 'text', text }] })

/** Every message the continuation's surface derives, for content assertions. */
function derivedText(session: Session): string[] {
  return session.deriveMessages().flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('session handoff', () => {
  it('carries the condensed conversation, summary and retained tail alike', async () => {
    const ctx = await harness({ backend: condensing('the condensed history') })
    const source = await liveAgent(ctx, 'source', 3)
    // The deployment shape this operation has to survive: the backend is not
    // reachable from the controller's own plane.
    expect(ctx.get('compaction')).toBeUndefined()
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)

    expect(result.sessionId).toMatch(/^session-/)
    expect(result.archived).toBe(true)
    const continuation = ctx.sessions.get(result.sessionId)
    expect(continuation).toBeDefined()
    // The carried history is the only surface content: no prefix, no turns.
    expect(derivedText(continuation!)).toEqual([
      'This conversation continues an earlier one in the same workspace. The history below is that '
        + 'conversation condensed: an earlier summary, then the most recent turns kept verbatim. The earlier '
        + 'conversation is archived and still readable.',
      'Condensed history: the condensed history',
      // The tail the backend deliberately left unshadowed. Carrying the summary
      // declaration alone would have dropped this — the most recent turn, which
      // is the one a continuation is continued from.
      'User: prompt 3',
    ])
    expect(continuation!.header.parentSession).toBe(source.id)
    expect(continuation!.header.cwd).toBe('/proj')
    expect(continuation!.inheritedEventCount).toBe(0)
    // The source keeps its own history: a handoff reads it, it does not move
    // it. Only the *derived* view is condensed, and that is what was carried.
    expect(source.deriveMessages().length).toBe(2)
    expect(source.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'user').length).toBe(3)
    await ctx.fiber.dispose()
  })

  it('labels the summary as the condensation, not as something the reader said', async () => {
    const ctx = await harness({ backend: condensing('the condensed history') })
    const source = await liveAgent(ctx, 'source', 2)
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)
    const carried = derivedText(ctx.sessions.get(result.sessionId)!)
    expect(carried).toContain('Condensed history: the condensed history')
    expect(carried.some(line => line.startsWith('User: the condensed history'))).toBe(false)
    await ctx.fiber.dispose()
  })

  it('condenses through the human command rather than a service lookup', async () => {
    const ctx = await harness({ backend: condensing('condensed') })
    const source = await liveAgent(ctx, 'source', 1)
    await controller(ctx).handoff({ sessionId: source.id }, signal)
    const commands = ctx.get('commands') as unknown as { execute: ReturnType<typeof vi.fn> }
    expect(commands.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: source.id }), '/compact', [], signal)
    await ctx.fiber.dispose()
  })

  it('attributes the carried history to the plugin, not to the reader', async () => {
    const ctx = await harness({ backend: condensing('condensed') })
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

  it('carries what an earlier condensation left when there is nothing new to condense', async () => {
    const ctx = await harness({ backend: () => Promise.resolve(null) })
    const source = await liveAgent(ctx, 'source', 2)
    // A Session condensed and untouched since: the backend has nothing left
    // before the tail it retains, so the handoff carries the earlier
    // condensation rather than refusing.
    condenseSurface(source, [{ type: 'text', text: 'an earlier condensation' }])
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)
    const carried = derivedText(ctx.sessions.get(result.sessionId)!)
    expect(carried).toContain('Condensed history: an earlier condensation')
    await ctx.fiber.dispose()
  })

  it('refuses when no command registry is mounted', async () => {
    const ctx = await harness({ noCommands: true })
    const source = await liveAgent(ctx, 'source', 1)
    await expect(controller(ctx).handoff({ sessionId: source.id }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { reason: 'no-command-registry' },
    })
    await ctx.fiber.dispose()
  })

  it('refuses when this Session has no /compact command', async () => {
    const ctx = await harness({ unknownCommand: true })
    const source = await liveAgent(ctx, 'source', 1)
    await expect(controller(ctx).handoff({ sessionId: source.id }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { reason: 'no-compaction-command' },
    })
    await ctx.fiber.dispose()
  })

  it('carries the command own explanation of a refusal', async () => {
    const busy = await harness({
      backend: () => Promise.reject(Object.assign(new Error('agent is active'), { code: 'busy' })),
    })
    const busySource = await liveAgent(busy, 'source', 1)
    await expect(controller(busy).handoff({ sessionId: busySource.id }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { reason: 'compaction-refused' },
      message: 'Compaction refused: agent is active',
    })
    await busy.fiber.dispose()
  })

  it('refuses a Session that has no history at all', async () => {
    // Nothing to condense AND nothing retained: the only case where a handoff
    // has nothing to carry. An empty summary is not it — the retained tail is
    // still history, and carrying it is the point.
    const ctx = await harness({ backend: () => Promise.resolve({ summary: [] }) })
    const empty = await liveAgent(ctx, 'empty', 0)
    await expect(controller(ctx).handoff({ sessionId: empty.id }, signal)).rejects.toMatchObject({
      code: 'session/handoff-unavailable',
      details: { reason: 'nothing-to-carry' },
    })
    await ctx.fiber.dispose()
  })

  it('lets a genuine backend fault surface instead of classifying it', async () => {
    const ctx = await harness({ backend: () => Promise.reject(new Error('backend bug')) })
    const source = await liveAgent(ctx, 'source', 1)
    await expect(controller(ctx).handoff({ sessionId: source.id }, signal)).rejects.toThrow('backend bug')
    await ctx.fiber.dispose()
  })

  it('keeps the continuation when archiving the source fails', async () => {
    const ctx = await harness({
      backend: condensing('condensed'),
      archiveSession: () => Promise.reject(new Error('registry offline')),
    })
    const source = await liveAgent(ctx, 'source', 1)
    const result = await controller(ctx).handoff({ sessionId: source.id }, signal)
    expect(result.archived).toBe(false)
    expect(ctx.sessions.get(result.sessionId)).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('maps an unknown source the way fork does', async () => {
    const ctx = await harness()
    await expect(controller(ctx).handoff({ sessionId: sid('missing') }, signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await ctx.fiber.dispose()
  })
})
