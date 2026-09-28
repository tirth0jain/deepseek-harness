/**
 * Usage-to-spend fold shared by every surface that shows a price beside a
 * token count. A published rate is a list price per million tokens, so this is
 * an estimate of what the tokens would cost at that rate — never a billing
 * record, and never a substitute for the provider's own invoice.
 *
 * @module @deepseek-ai/dsh-token-meter/usage-cost
 */

/** Token buckets an estimate multiplies; every bucket a route can report. */
export interface CostUsage {
  /** Uncached prompt tokens. */
  readonly input?: number
  /** Prompt tokens served from the provider's prompt cache. */
  readonly cacheRead?: number
  /** Prompt tokens written to the provider's prompt cache. */
  readonly cacheWrite?: number
  /** Generated tokens, reasoning included. */
  readonly output?: number
}

/** One route's published list price, USD per million tokens. */
export interface UsageRate {
  /** Uncached prompt tokens. */
  readonly input: number
  /** Generated tokens. */
  readonly output: number
  /** Prompt tokens served from cache; absent means the route publishes no such rate. */
  readonly cacheRead?: number
  /** Prompt tokens written to cache; absent means the route publishes no such rate. */
  readonly cacheWrite?: number
}

/** Buckets an estimate reads, paired with the rate field that prices each. */
const PRICED_BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const

/**
 * Estimate one usage reading's spend at one published rate.
 *
 * A bucket carrying tokens that the rate does not price yields no estimate at
 * all: reporting a total that silently billed that bucket at nothing would
 * understate spend exactly where the answer matters. Rate fields are per
 * million tokens, so the sum is scaled once at the end.
 *
 * @param usage - token buckets reported for one request, turn, or session.
 * @param rate - the exact route's published rate.
 * @returns USD for the reading, or undefined when no honest total exists.
 */
export function estimateUsageCost(
  usage: CostUsage,
  rate: UsageRate,
): number | undefined {
  let total = 0
  let priced = false
  for (const bucket of PRICED_BUCKETS) {
    const tokens = usage[bucket] ?? 0
    if (tokens === 0) continue
    const price = rate[bucket]
    if (price === undefined) return undefined
    total += tokens * price
    priced = true
  }
  return priced ? total / 1_000_000 : undefined
}

/**
 * Sum estimated spend across readings, skipping readings no rate can price.
 * Used by surfaces folding several requests into one session total, where one
 * unpriced request must not void the requests that are priced.
 * @param costs - per-reading estimates, in any order.
 * @returns total USD, or undefined when not one reading was priced.
 */
export function sumUsageCosts(costs: Iterable<number | undefined>): number | undefined {
  let total = 0
  let priced = false
  for (const cost of costs) {
    if (cost === undefined) continue
    total += cost
    priced = true
  }
  return priced ? total : undefined
}
