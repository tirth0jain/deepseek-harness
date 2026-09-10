/**
 * Turn-level spend estimate: the fold between `deriveTurnTokenUsage`'s billed
 * attempts and the published rates the Host model catalog carries.
 *
 * Every attempt is priced at the route that served it and at the band its own
 * settle instant falls in, then the amounts are summed. That is what makes a
 * Turn which switched models mid-way, or ran across a tariff's peak boundary,
 * report what its requests actually billed instead of nothing: the aggregate
 * buckets name no single rate, but the per-attempt split does.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/chat/turn-cost
 */

import {
  bandRate,
  estimateUsageCost,
  rateBandAt,
  type TurnTokenUsage,
  type UsageRateBand,
  type UsageRateSchedule,
} from '@deepseek-ai/dsh-token-meter/client'

/** Resolve one exact route's published rate and peak band, or undefined when the route is unpriced. */
export type TurnRateLookup = (provider: string, model: string) => UsageRateSchedule | undefined

/** One Turn's estimated spend and the bands it was billed in. */
export interface TurnCostEstimate {
  /** Estimated USD for the whole Turn. */
  readonly amount: number
  /**
   * Bands the priced attempts billed in, in first-seen order — one entry for a
   * Turn that stayed in one band, both when its requests straddled a boundary.
   *
   * Empty when no attempt's route publishes a peak band: a flat tariff has no
   * band to name, and calling its one rate "off-peak" would state a distinction
   * the route never made.
   */
  readonly bands: readonly UsageRateBand[]
}

/**
 * Estimate one completed Turn's spend.
 * @param usage - the Turn's provider-reported attempts, routes and instants included.
 * @param rateOf - published-rate lookup for one exact route.
 * @returns USD and the bands it billed in, or undefined when no honest total exists.
 */
export function turnCostEstimate(
  usage: TurnTokenUsage,
  rateOf: TurnRateLookup,
): TurnCostEstimate | undefined {
  const attempts = usage.attempts
  if (attempts === undefined || attempts.length === 0) return undefined
  let amount = 0
  const bands: UsageRateBand[] = []
  for (const attempt of attempts) {
    const route = attempt.route
    // No total explains a bill whose requests cannot be attributed: an
    // unpriced or unrecorded route would make the sum price some attempts at
    // nothing while still looking like the Turn's cost.
    if (route === undefined) return undefined
    const schedule = rateOf(route.provider, route.model)
    if (schedule === undefined) return undefined
    const band = rateBandAt(schedule, attempt.at)
    const cost = estimateUsageCost({
      input: attempt.uncachedInputTokens,
      output: attempt.outputTokens,
      ...attempt.cacheReadTokens === undefined ? {} : { cacheRead: attempt.cacheReadTokens },
      ...attempt.cacheWriteTokens === undefined ? {} : { cacheWrite: attempt.cacheWriteTokens },
    }, bandRate(schedule, band))
    if (cost === undefined) return undefined
    amount += cost
    // Only a tariff that publishes a band has one worth naming.
    if (schedule.peak !== undefined && !bands.includes(band)) bands.push(band)
  }
  return { amount, bands }
}
