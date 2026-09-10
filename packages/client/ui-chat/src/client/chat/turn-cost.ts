/**
 * Turn-level spend estimate: the fold between `deriveTurnTokenUsage`'s buckets
 * and the published rates the Host model catalog carries. A turn can bill more
 * than one route when the model changed mid-turn, and the buckets are not split
 * per route, so a mixed-route turn is priced only when every route it used is
 * the same one — otherwise no total is reported rather than one that prices the
 * whole turn at a single route's rate.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/chat/turn-cost
 */

import { estimateUsageCost, type TurnTokenUsage, type UsageRate } from '@deepseek-ai/dsh-token-meter/client'

/** Resolve one exact route's published rate, or undefined when the route is unpriced. */
export type TurnRateLookup = (provider: string, model: string) => UsageRate | undefined

/**
 * Estimate one completed turn's spend.
 * @param usage - the turn's provider-reported buckets, routes included.
 * @param rateOf - published-rate lookup for one exact route.
 * @returns USD for the turn, or undefined when no honest total exists.
 */
export function turnUsageCost(
  usage: TurnTokenUsage,
  rateOf: TurnRateLookup,
): number | undefined {
  const routes = usage.routes
  const route = routes?.[0]
  if (route === undefined || routes === undefined) return undefined
  // One rate must cover every billed attempt: a turn that switched routes (or
  // retried on another) reports buckets no single rate explains.
  for (const other of routes) {
    if (other.provider !== route.provider || other.model !== route.model) return undefined
  }
  const rate = rateOf(route.provider, route.model)
  if (rate === undefined) return undefined
  return estimateUsageCost({
    input: usage.uncachedInputTokens,
    output: usage.outputTokens,
    ...usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens },
    ...usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens },
  }, rate)
}
