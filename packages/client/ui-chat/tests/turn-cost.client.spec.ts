import { describe, expect, it } from 'vitest'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { turnUsageCost } from '../src/client/chat/turn-cost.ts'

const rate = { input: 0.22, output: 0.66, cacheRead: 0.007 }
const lookup = (provider: string, model: string) =>
  provider === 'commandcode' && model === 'deepseek/deepseek-v4-flash' ? rate : undefined

function usage(overrides: Partial<TurnTokenUsage> = {}): TurnTokenUsage {
  return {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    routes: [{ provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' }],
    ...overrides,
  }
}

describe('turnUsageCost', () => {
  it('prices one routed turn at its published rate', () => {
    expect(turnUsageCost(usage(), lookup)).toBeCloseTo(0.22 + 0.66, 10)
  })

  it('prices the cache buckets the turn reported', () => {
    expect(turnUsageCost(usage({ cacheReadTokens: 1_000_000 }), lookup))
      .toBeCloseTo(0.22 + 0.66 + 0.007, 10)
  })

  it('reports no amount when the buckets were split across routes', () => {
    expect(turnUsageCost(usage({
      routes: [
        { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' },
        { provider: 'commandcode', model: 'z-ai/glm-5.3-flash' },
      ],
    }), lookup)).toBeUndefined()
  })

  it('reports no amount for an unpriced route', () => {
    expect(turnUsageCost(usage({
      routes: [{ provider: 'commandcode', model: 'not-in-the-price-table' }],
    }), lookup)).toBeUndefined()
  })

  it('reports no amount when the turn recorded no route at all', () => {
    const { routes: _dropped, ...withoutRoutes } = usage()
    expect(turnUsageCost(withoutRoutes, lookup)).toBeUndefined()
    expect(turnUsageCost({ ...withoutRoutes, routes: [] }, lookup)).toBeUndefined()
  })

  it('refuses a rate that does not price a bucket the turn billed', () => {
    expect(turnUsageCost(usage({ cacheWriteTokens: 10 }), lookup)).toBeUndefined()
  })
})
