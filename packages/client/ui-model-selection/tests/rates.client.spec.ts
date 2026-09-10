import { describe, expect, it } from 'vitest'
import { formatRate } from '../src/client/rates.ts'

/** The English dictionary's wording for the cache-hit segment. */
const cacheHit = (price: string): string => `cache hit ${price}`

describe('formatRate', () => {
  it('keeps two decimals so a round rate still reads as a price', () => {
    expect(formatRate({ input: 0.15, output: 0.6 }, cacheHit)).toBe('$0.15 / $0.60')
    expect(formatRate({ input: 0.15, output: 0.5 }, cacheHit)).toBe('$0.15 / $0.50')
    expect(formatRate({ input: 2.5, output: 0.2 }, cacheHit)).toBe('$2.50 / $0.20')
  })

  it('keeps the sub-cent precision of a cheap route', () => {
    expect(formatRate({ input: 0.075, output: 0.25 }, cacheHit)).toBe('$0.075 / $0.25')
    expect(formatRate({ input: 0.003, output: 0.6 }, cacheHit)).toBe('$0.003 / $0.60')
  })

  it('drops the decimals of a whole number', () => {
    expect(formatRate({ input: 1, output: 15 }, cacheHit)).toBe('$1 / $15')
  })

  it('rounds beyond four decimals rather than printing float noise', () => {
    expect(formatRate({ input: 0.123456, output: 1.005 }, cacheHit)).toBe('$0.1235 / $1.005')
  })

  it('appends the cache-hit rate a route publishes', () => {
    expect(formatRate({ input: 0.15, output: 0.6, cacheRead: 0.003 }, cacheHit))
      .toBe('$0.15 / $0.60 · cache hit $0.003')
  })

  it('omits the cache-hit segment when the route publishes none, rather than printing $0.00', () => {
    // An absent bucket is "no published rate", not a free one - the same rule
    // the spending surfaces follow.
    expect(formatRate({ input: 0.15, output: 0.6 }, cacheHit)).toBe('$0.15 / $0.60')
    expect(formatRate({ input: 0.15, output: 0.6, cacheRead: 0 }, cacheHit)).toBe('$0.15 / $0.60')
  })
})
