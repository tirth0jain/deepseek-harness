import { describe, expect, it } from 'vitest'
import { estimateUsageCost, sumUsageCosts } from '../src/usage-cost.ts'

describe('estimateUsageCost', () => {
  const rate = { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.5 }

  it('prices every bucket at its per-million rate', () => {
    expect(estimateUsageCost({
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    }, rate)).toBeCloseTo(0.22 + 0.66 + 0.007 + 0.5, 10)
  })

  it('scales sub-million counts instead of rounding them away', () => {
    expect(estimateUsageCost({ input: 1_000, output: 2_000 }, rate)).toBeCloseTo(0.00022 + 0.00132, 10)
  })

  it('skips buckets that carry no tokens', () => {
    // cacheWrite has no published rate here; a zero count never reads it.
    expect(estimateUsageCost({ input: 1_000_000 }, { input: 1, output: 2 })).toBe(1)
  })

  it('refuses a total that would bill a carrying bucket at nothing', () => {
    expect(estimateUsageCost({ cacheRead: 5_000 }, { input: 1, output: 2 })).toBeUndefined()
  })

  it('reports no estimate for an empty reading', () => {
    expect(estimateUsageCost({}, rate)).toBeUndefined()
    expect(estimateUsageCost({ input: 0, output: 0 }, rate)).toBeUndefined()
  })
})

describe('sumUsageCosts', () => {
  it('adds the estimates it has and skips the ones it does not', () => {
    expect(sumUsageCosts([1.5, undefined, 0.25])).toBeCloseTo(1.75, 10)
  })

  it('reports nothing when no reading was priced', () => {
    expect(sumUsageCosts([undefined, undefined])).toBeUndefined()
    expect(sumUsageCosts([])).toBeUndefined()
  })
})
