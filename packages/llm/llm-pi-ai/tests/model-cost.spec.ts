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

  it('carries a declared peak band beside the base rate', async () => {
    const llm = await resolved(gateway({
      cost: {
        input: 0.15,
        output: 0.6,
        cacheRead: 0.003,
        peak: {
          multiplier: 2,
          windows: [
            { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' },
            { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' },
          ],
        },
      },
    }))
    await expect(llm.resolveModelInfo('acme-gateway', 'm')).resolves.toMatchObject({
      cost: {
        input: 0.15,
        output: 0.6,
        cacheRead: 0.003,
        peak: {
          multiplier: 2,
          windows: [
            { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' },
            { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' },
          ],
        },
      },
    })
  })

  it('applies a declared band onto the installed catalog rate', async () => {
    // The tariff's windows belong to the route, not to whoever published the
    // number: a catalog-priced model may still move inside them.
    const llm = await resolved({
      'opencode-go': {
        apiKeyEnv: 'PI_TEST_KEY',
        modelOverrides: {
          'deepseek-v4-flash': {
            cost: { peak: { multiplier: 2, windows: [{ days: ['sat'], start: '00:00', end: '23:59' }] } },
          },
        },
      },
    })
    const info = await llm.resolveModelInfo('opencode-go', 'deepseek-v4-flash')
    expect(info.cost).toMatchObject({
      input: 0.22,
      output: 0.66,
      peak: { multiplier: 2, windows: [{ days: ['sat'], start: '00:00', end: '23:59' }] },
    })
  })

  it('treats an empty peak block as no band declared', () => {
    expect(() => resolveProfiles(gateway({
      cost: { input: 0.1, output: 0.2, peak: {} },
    }))).not.toThrow()
  })

  it('refuses a band with no multiplier', () => {
    expect(() => resolveProfiles(gateway({
      cost: { input: 0.1, output: 0.2, peak: { windows: [{ days: ['mon'], start: '01:00', end: '04:00' }] } },
    }))).toThrow(/cost peak needs a positive multiplier/)
  })

  it.each([
    [0, /needs a positive multiplier/],
    [-1, /needs a positive multiplier/],
  ])('refuses a multiplier of %s', (multiplier, message) => {
    expect(() => resolveProfiles(gateway({
      cost: { input: 0.1, output: 0.2, peak: { multiplier, windows: [{ days: ['mon'], start: '01:00', end: '04:00' }] } },
    }))).toThrow(message)
  })

  it('refuses a band that opens nowhere', () => {
    expect(() => resolveProfiles(gateway({
      cost: { input: 0.1, output: 0.2, peak: { multiplier: 2, windows: [] } },
    }))).toThrow(/needs at least one window/)
  })

  it.each([
    [{ days: ['mon'], start: '1:00', end: '04:00' }, /HH:MM in UTC/],
    [{ days: ['mon'], start: '01:00', end: '24:00' }, /HH:MM in UTC/],
    [{ days: ['mon'], start: '04:00', end: '01:00' }, /does not end after it starts/],
    [{ days: ['mon'], start: '01:00', end: '01:00' }, /does not end after it starts/],
    [{ days: ['monday'], start: '01:00', end: '04:00' }, /names "monday", not a weekday/],
    [{ days: [], start: '01:00', end: '04:00' }, /needs at least one weekday/],
  ])('refuses a window it cannot place: %j', (window, message) => {
    expect(() => resolveProfiles(gateway({
      cost: { input: 0.1, output: 0.2, peak: { multiplier: 2, windows: [window] } },
    }))).toThrow(message)
  })

  it('keeps the base rate when a band is declared over an unpriced model', async () => {
    const llm = await resolved(gateway({
      cost: { peak: { multiplier: 2, windows: [{ days: ['mon'], start: '01:00', end: '04:00' }] } },
    }))
    // A window onto a rate nobody published is no tariff, so the model keeps
    // reporting no cost at all rather than a band around zeros.
    const info = await llm.resolveModelInfo('acme-gateway', 'm')
    expect(info.cost).toBeUndefined()
  })
})
