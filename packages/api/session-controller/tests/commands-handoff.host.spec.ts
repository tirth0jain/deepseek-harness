/**
 * A handoff continuation is seeded through its Agent, never written straight to
 * the surface.
 *
 * The Agent loop writes the system prompt at the first step, so a recap
 * appended to the surface at creation time would precede the head. V4 requires
 * that head to be the surface's first node, and a V3 artifact in that shape can
 * never be migrated — which is how one continuation became unreadable.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

function controllerAgents(overrides: Partial<ApiSessionAgentController> = {}): ApiSessionAgentController {
  const stub: Partial<ApiSessionAgentController> = {
    // Not part of the handoff path; a call here would mean the test drifted.
    ensureSession: () => Promise.reject(new Error('ensureSession is not used by a handoff')),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
    presetForSession: () => undefined,
    presetForObservation: () => undefined,
    ...overrides,
  }
  return stub as ApiSessionAgentController
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

describe('Session handoff seeding', () => {
  it('queues the condensed history on the continuation Agent rather than its surface', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', {
      list: () => [],
      get: () => undefined,
      archiveSession: () => Promise.resolve(),
    } as never)
    // `/compact` is what condenses the source; this path reads only its result.
    ctx.provide('commands', {
      execute: () => Promise.resolve({ result: { kind: 'success', text: '' } }),
    } as never)

    const source = ctx.sessions.create(SessionId('handoff-source'), { meta: { cwd: '/work' } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'earlier work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const sourceAgent = {
      id: source.id,
      session: { deriveMessages: () => source.deriveMessages() },
    } as Partial<Agent> as Agent

    const inject = vi.fn()
    const createOwned = vi.fn(async (options: CreateAgentOptions) => {
      ctx.sessions.create(options.sessionId, options.meta === undefined ? {} : { meta: options.meta })
      return { id: options.sessionId, inject } as Partial<Agent> as Agent
    })
    const controller = new SessionCommandController(ctx, controllerAgents({
      resolveObservedAgent: () => Promise.resolve({ agent: sourceAgent }),
      createOwned,
    }), '/default')

    const result = await controller.handoff({ sessionId: source.id }, new AbortController().signal)

    // Queued on the Agent's inbox, which the loop drains at the first step —
    // behind the system prompt the same step writes.
    expect(inject).toHaveBeenCalledTimes(1)
    const recap = inject.mock.calls[0]?.[0] as UserMessage
    expect(recap.source).toMatchObject({ kind: 'handoff' })
    expect(recap.content.some(block => block.type === 'text' && block.text.includes('earlier work'))).toBe(true)

    // The regression: reaching the surface here is what made the artifact
    // unmigratable, because the system prompt only arrives at the first step.
    const continuation = ctx.sessions.get(result.sessionId)
    expect(continuation?.deriveMessages().some(message => message.source?.kind === 'handoff')).toBe(false)
    await ctx.fiber.dispose()
  })
})
