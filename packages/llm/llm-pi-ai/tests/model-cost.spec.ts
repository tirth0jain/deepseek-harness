import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'

/** One hand-declared gateway route carrying a single model entry. */
const gateway = (model: Record<string, unknown>): Record<string, LlmPiAi.PiAiProviderProfile> => ({
  'acme-gateway': {
    api: 'openai-completions',
    baseURL: 'https://acme.test',
    models: [{ id: 'm', ...model }],
  },
})

async function resolved(providers: Record<string, LlmPiAi.PiAiProviderProfile>) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers })
  return ctx.llm
}

describe('declared model rates', () => {
  it('reports the rate a deployment states for a gateway model', async () => {
    const llm = await resolved(gateway({
      cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
    }))
    await expect(llm.resolveModelInfo('acme-gateway', 'm')).resolves.toMatchObject({
      cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
    })
  })

  it('reads the installed catalog rate for a catalog model', async () => {
    const llm = await resolved({ 'opencode-go': { apiKeyEnv: 'PI_TEST_KEY' } })
    const info = await llm.resolveModelInfo('opencode-go', 'deepseek-v4-flash')
    expect(info.cost).toMatchObject({ input: 0.22, output: 0.66, cacheRead: 0.007 })
  })

  it('reports no rate for an unpriced gateway model rather than zeros', async () => {
    const llm = await resolved(gateway({}))
    const info = await llm.resolveModelInfo('acme-gateway', 'm')
    expect(info.cost).toBeUndefined()
  })

  it('refuses a rate that states only half the priced pair', () => {
    expect(() => resolveProfiles(gateway({ cost: { input: 0.22 } }))).toThrow(/cost needs both input and output/)
    expect(() => resolveProfiles(gateway({ cost: { output: 0.66 } }))).toThrow(/cost needs both input and output/)
  })

  it('accepts a rate that states the pair and no cache prices', () => {
    expect(() => resolveProfiles(gateway({ cost: { input: 0.1, output: 0.2 } }))).not.toThrow()
  })

  it('treats an empty cost block as no rate stated', () => {
    expect(() => resolveProfiles(gateway({ cost: {} }))).not.toThrow()
  })
})
