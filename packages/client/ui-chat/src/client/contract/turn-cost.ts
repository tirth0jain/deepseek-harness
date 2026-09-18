/**
 * Published-rate lookup named by the Chat slot contract.
 *
 * It lives in the contract domain because `contract/slots.ts` states it as part
 * of `ChatViewSlotProps`: a sibling domain may only reach shared API through
 * `contract/`, so the alias cannot stay beside the fold that consumes it.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/contract/turn-cost
 */

import type { UsageRateSchedule } from '@deepseek-ai/dsh-token-meter/client'

/** Resolve one exact route's published rate and peak band, or undefined when the route is unpriced. */
export type TurnRateLookup = (provider: string, model: string) => UsageRateSchedule | undefined
