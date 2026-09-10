import { describe, expect, it } from 'vitest'
import type { TurnTokenUsage, TurnTokenUsageAttempt } from '@deepseek-ai/dsh-token-meter/client'
import { turnCostEstimate } from '../src/client/chat/turn-cost.ts'

/** DeepSeek's published peak band: every rate doubles, Mon-Fri, in two UTC windows. */
const PEAK = {
  multiplier: 2,
  windows: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' },
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' },
  ],
}
const FLASH = { input: 0.15, output: 0.6, cacheRead: 0.003, peak: PEAK }
const GLM = { input: 0.15, output: 0.5, cacheRead: 0.03 }

const lookup = (provider: string, model: string) => {
  if (provider !== 'commandcode') return undefined
  if (model === 'deepseek/deepseek-v4-flash') return FLASH
  if (model === 'z-ai/glm-5.3-flash') return GLM
  return undefined
}

/** Thursday 2026-09-10, 05:00 UTC: inside neither Flash peak window. */
const OFF_PEAK = Date.parse('2026-09-10T05:00:00Z')
/** The same Thursday, 02:00 UTC: inside the 01:00-04:00 window. */
const PEAK_AT = Date.parse('2026-09-10T02:00:00Z')

function attempt(overrides: Partial<TurnTokenUsageAttempt> = {}): TurnTokenUsageAttempt {
  return {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    route: { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' },
    at: OFF_PEAK,
    ...overrides,
  }
}

function usage(attempts: readonly TurnTokenUsageAttempt[] = [attempt()]): TurnTokenUsage {
  return {
    uncachedInputTokens: attempts.reduce((total, entry) => total + entry.uncachedInputTokens, 0),
    outputTokens: attempts.reduce((total, entry) => total + entry.outputTokens, 0),
    totalTokens: attempts.reduce(
      (total, entry) => total + entry.uncachedInputTokens + entry.outputTokens,
      0,
    ),
    attempts,
  }
}

describe('turnCostEstimate', () => {
  it('prices one routed attempt at its published base rate', () => {
    const estimate = turnCostEstimate(usage(), lookup)
    expect(estimate?.amount).toBeCloseTo(0.15 + 0.6, 10)
    expect(estimate?.bands).toEqual(['base'])
  })

  it('prices the cache buckets the attempt reported', () => {
    const estimate = turnCostEstimate(
      usage([attempt({ cacheReadTokens: 1_000_000 })]),
      lookup,
    )
    expect(estimate?.amount).toBeCloseTo(0.15 + 0.6 + 0.003, 10)
  })

  it('prices an attempt inside a peak window at the peak band', () => {
    const estimate = turnCostEstimate(usage([attempt({ at: PEAK_AT })]), lookup)
    expect(estimate?.amount).toBeCloseTo(0.3 + 1.2, 10)
    expect(estimate?.bands).toEqual(['peak'])
  })

  it('prices a Turn that straddled a peak boundary at both its bands', () => {
    const estimate = turnCostEstimate(usage([
      attempt({ at: PEAK_AT, uncachedInputTokens: 1_000_000, outputTokens: 0 }),
      attempt({ at: OFF_PEAK, uncachedInputTokens: 1_000_000, outputTokens: 0 }),
    ]), lookup)
    // 1M input at the peak band plus 1M at the base band.
    expect(estimate?.amount).toBeCloseTo(0.3 + 0.15, 10)
    expect(estimate?.bands).toEqual(['peak', 'base'])
  })

  it('names no band for a route whose tariff never moves', () => {
    // GLM has one flat rate: pricing it is unaffected, but calling that rate
    // "off-peak" would report a distinction the route never published.
    const estimate = turnCostEstimate(usage([
      attempt({ uncachedInputTokens: 1_000_000, outputTokens: 0, route: { provider: 'commandcode', model: 'z-ai/glm-5.3-flash' } }),
    ]), lookup)
    expect(estimate?.amount).toBeCloseTo(0.15, 10)
    expect(estimate?.bands).toEqual([])
  })

  it('prices each attempt at its own route when the model changed mid-Turn', () => {
    const estimate = turnCostEstimate(usage([
      attempt({ uncachedInputTokens: 1_000_000, outputTokens: 0 }),
      attempt({
        uncachedInputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        route: { provider: 'commandcode', model: 'z-ai/glm-5.3-flash' },
      }),
    ]), lookup)
    expect(estimate?.amount).toBeCloseTo(0.15 + 0.15 + 0.03, 10)
    // Only the banded route contributes a band, and it billed at base.
    expect(estimate?.bands).toEqual(['base'])
  })

  it('reports no amount when any attempt billed an unpriced route', () => {
    expect(turnCostEstimate(usage([
      attempt(),
      attempt({ route: { provider: 'commandcode', model: 'not-in-the-price-table' } }),
    ]), lookup)).toBeUndefined()
  })

  it('reports no amount when an attempt recorded no route at all', () => {
    const { route: _dropped, ...unrouted } = attempt()
    expect(turnCostEstimate(usage([unrouted]), lookup)).toBeUndefined()
  })

  it('reports no amount when the Turn carries no per-attempt record', () => {
    const { attempts: _dropped, ...aggregate } = usage()
    expect(turnCostEstimate(aggregate, lookup)).toBeUndefined()
    expect(turnCostEstimate(usage([]), lookup)).toBeUndefined()
  })

  it('refuses a rate that does not price a bucket the attempt billed', () => {
    expect(turnCostEstimate(usage([attempt({ cacheWriteTokens: 10 })]), lookup)).toBeUndefined()
  })
})
