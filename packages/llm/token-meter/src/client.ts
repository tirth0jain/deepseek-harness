/**
 * Client-namespace projection of token-meter's browser-safe contracts and folds.
 *
 * @module @deepseek-ai/dsh-token-meter/client
 */

export type * from './projection.ts'
export { deriveTurnTokenUsage } from './turn-usage.ts'
export type { TurnTokenUsage, TurnTokenUsageAttempt, TurnTokenUsageRoute } from './turn-usage.ts'
export { estimateUsageCost, sumUsageCosts } from './usage-cost.ts'
export type { CostUsage, UsageRate } from './usage-cost.ts'
export { bandRate, rateAt, rateBandAt } from './rate-schedule.ts'
export type { UsageRateBand, UsageRatePeak, UsageRateSchedule, UsageRateWindow } from './rate-schedule.ts'
