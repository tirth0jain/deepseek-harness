/**
 * GOAT-plan cost estimation for the Turn-usage dialog.
 *
 * Given a turn's exact token buckets and the provider/model route that
 * produced them, estimate the USD cost using Command Code GOAT-plan rates
 * (per 1M tokens). Models with time-of-day pricing switch to their peak
 * rates during the published UTC peak windows, and the estimate reports
 * which tier applied.
 */

import { GOAT_MODEL_RATES, type GoatModelRate } from './goat-pricing-data.ts'

export { GOAT_MODEL_RATES } from './goat-pricing-data.ts'
export type { GoatModelRate } from './goat-pricing-data.ts'

/** USD cost of one token at a per-1M-token rate. */
const PER_MILLION = 1_000_000

export interface ModelCostRate {
  /** Uncached input, USD per 1M tokens. */
  readonly in: number
  /** Output, USD per 1M tokens. */
  readonly out: number
  /** Cache-read, USD per 1M tokens. */
  readonly cache: number
  /** Cache-write, USD per 1M tokens; absent when the model doesn't charge it. */
  readonly cw?: number
}

/** Whether a cost estimate was computed at peak or off-peak rates. */
export type CostTier = 'peak' | 'off-peak'

export interface TurnCostEstimate {
  /** USD cost of the turn's billed tokens. */
  readonly usd: number
  /** Which rate tier produced the estimate. */
  readonly tier: CostTier
  /** Display text of the peak windows, when the model is time-of-day priced. */
  readonly windows?: string
  /** Whether the estimate used live-fetched pricing. */
  readonly live: boolean
}

/** A parsed peak-window range, inclusive, in UTC hours. */
interface UtcRange {
  readonly start: number
  readonly end: number
}

const PEAK_WINDOW_RE = /(\d{1,2})–(\d{1,2})/g

/**
 * Parse the published peak windows text ("01–04 & 06–10 UTC") into UTC hour
 * ranges. The end hour is inclusive; a window crossing midnight (e.g. 22–02)
 * wraps around.
 * @param windows - published windows text, e.g. "01–04 & 06–10 UTC".
 * @returns inclusive UTC hour ranges, or null when unparseable.
 */
export function parsePeakWindows(windows: string | undefined): UtcRange[] | null {
  if (windows === undefined) return null
  const ranges: UtcRange[] = []
  for (const match of windows.matchAll(PEAK_WINDOW_RE)) {
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || start > 23 || end < 0 || end > 23) {
      return null
    }
    ranges.push({ start, end })
  }
  return ranges.length === 0 ? null : ranges
}

/**
 * Whether a UTC hour falls inside any parsed peak window. A window whose end
 * is smaller than its start wraps past midnight (22–02 covers 22, 23, 0, 1, 2).
 * @param hour - UTC hour 0–23.
 * @param ranges - parsed peak windows.
 * @returns whether the hour is peak.
 */
export function isPeakHour(hour: number, ranges: UtcRange[]): boolean {
  return ranges.some(({ start, end }) => (
    start <= end
      ? hour >= start && hour <= end
      : hour >= start || hour <= end
  ))
}

/**
 * Resolve the rates that apply right now for a model, honoring time-of-day
 * peak pricing.
 * @param rate - model rate table entry.
 * @param utcHour - current UTC hour (0–23).
 * @returns the applicable rates plus the tier and windows.
 */
export function resolveCurrentRates(
  rate: GoatModelRate,
  utcHour: number,
): { readonly rates: ModelCostRate; readonly tier: CostTier; readonly windows: string | undefined } {
  if (rate.peak !== undefined && rate.off !== undefined) {
    const ranges = parsePeakWindows(rate.windows)
    if (ranges !== null && isPeakHour(utcHour, ranges)) {
      return {
        rates: { in: rate.peak.in, out: rate.peak.out, cache: rate.peak.cache, ...rate.cw === undefined ? {} : { cw: rate.cw } },
        tier: 'peak',
        windows: rate.windows,
      }
    }
    return {
      rates: { in: rate.off.in, out: rate.off.out, cache: rate.off.cache, ...rate.cw === undefined ? {} : { cw: rate.cw } },
      tier: 'off-peak',
      windows: rate.windows,
    }
  }
  return {
    rates: { in: rate.in, out: rate.out, cache: rate.cache, ...rate.cw === undefined ? {} : { cw: rate.cw } },
    tier: 'off-peak',
    windows: undefined,
  }
}

/** Buckets that make up a billed turn, in exact tokens. */
export interface TurnCostInput {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens: number
}

/**
 * Estimate the USD cost of one turn at the given rates.
 * @param input - exact token buckets.
 * @param rates - per-1M-token rates.
 * @returns USD cost, or 0 when no bucket is present.
 */
export function estimateTurnCostUsd(input: TurnCostInput, rates: ModelCostRate): number {
  const uncached = input.uncachedInputTokens * rates.in / PER_MILLION
  const cacheRead = (input.cacheReadTokens ?? 0) * rates.cache / PER_MILLION
  const cacheWrite = (input.cacheWriteTokens ?? 0) * (rates.cw ?? 0) / PER_MILLION
  const output = input.outputTokens * rates.out / PER_MILLION
  return uncached + cacheRead + cacheWrite + output
}

/** A provider/model route that contributed a billed attempt. */
export interface CostRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve the pricing-table key for a provider/model route. The table is
 * keyed by Command Code model ids ("deepseek/deepseek-v4-flash"); routes may
 * carry the id in `model`, in `provider + "/" + model`, or as a bare basename
 * ("deepseek-v4-flash") that is unambiguous across the table.
 * @param rates - the active pricing table.
 * @param route - provider/model route.
 * @returns the table key, or undefined when no unique match exists.
 */
export function lookupModelId(
  rates: Readonly<Record<string, GoatModelRate>>,
  route: CostRoute,
): string | undefined {
  const { provider, model } = route
  if (model.length === 0) return undefined
  if (rates[model] !== undefined) return model
  const joined = `${provider}/${model}`
  if (rates[joined] !== undefined) return joined
  const basename = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  if (basename !== model) {
    let match: string | undefined
    for (const key of Object.keys(rates)) {
      const candidate = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
      if (candidate === basename) {
        if (match !== undefined) return undefined
        match = key
      }
    }
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Compute the current cost estimate for a turn using a model id.
 * @param rates - the active pricing table.
 * @param modelId - pricing-table key, e.g. "deepseek/deepseek-v4-flash".
 * @param input - exact token buckets.
 * @param now - the reference time (defaults to now; injectable for tests).
 * @returns the estimate, or null when the model has no known rates.
 */
export function estimateTurnCost(
  rates: Readonly<Record<string, GoatModelRate>>,
  modelId: string,
  input: TurnCostInput,
  now: Date = new Date(),
): TurnCostEstimate | null {
  const rate = rates[modelId]
  if (rate === undefined) return null
  const { rates: current, tier, windows } = resolveCurrentRates(rate, now.getUTCHours())
  return {
    usd: estimateTurnCostUsd(input, current),
    tier,
    ...windows === undefined ? {} : { windows },
    live: false,
  }
}

/**
 * Estimate cost for a turn given its routes. Every route must resolve to the
 * same pricing entry — token buckets are turn-aggregate, so a mixed-route
 * turn cannot be attributed and returns null (matching the panel's rule of
 * omitting unavailable facts).
 * @param rates - the active pricing table.
 * @param routes - provider/model routes that billed the turn.
 * @param input - exact token buckets.
 * @param now - the reference time (injectable for tests).
 * @returns the estimate, or null when routes are missing or mixed/unknown.
 */
export function estimateTurnCostForRoutes(
  rates: Readonly<Record<string, GoatModelRate>>,
  routes: readonly CostRoute[] | undefined,
  input: TurnCostInput,
  now: Date = new Date(),
): TurnCostEstimate | null {
  if (routes === undefined || routes.length === 0) return null
  const ids = routes.map(route => lookupModelId(rates, route))
  if (ids.some(id => id === undefined)) return null
  const first = ids[0]
  if (first === undefined || ids.some(id => id !== first)) return null
  return estimateTurnCost(rates, first, input, now)
}

/** Format a USD cost for display, e.g. "$0.0042" / "$1.23". */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Live pricing refresh
// ---------------------------------------------------------------------------

/** A pricing row parsed from the live GOAT plan page. */
interface LiveGoatModel {
  readonly id: string
  readonly in: number
  readonly out: number
  readonly cache: number
  cw?: number
  peak?: { readonly in: number; readonly out: number; readonly cache: number }
  off?: { readonly in: number; readonly out: number; readonly cache: number }
  windows?: string
}

/**
 * Parse the GOAT plan page's embedded model catalog (the Next.js flight
 * payload chunk holding `{"models":[...],"planScope":{...}}`). Returns only
 * the models listed in the GOAT plan scope, or null when the payload cannot
 * be found or decoded.
 * @param html - the raw page HTML.
 * @returns normalized GOAT model rates keyed by model id.
 */
export function parseGoatPageModels(html: string): Readonly<Record<string, LiveGoatModel>> | null {
  // The models array lives in one flight chunk: 12:["$","$L40",null,{"models":[...],"planScope":{...}}]
  // Chunks are pushed as self.__next_f.push([1,"<json-string>"]) where the
  // payload is a JSON-encoded string. Decode each chunk body and look for the
  // one that contains the models array.
  const chunks = html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)
  for (const match of chunks) {
    let flight: string
    try {
      const decoded: unknown = JSON.parse(`"${match[1]}"`)
      if (typeof decoded !== 'string') continue
      flight = decoded
    } catch {
      continue
    }
    const colon = flight.indexOf(':')
    if (colon < 0) continue
    let body: unknown
    try {
      body = JSON.parse(flight.slice(colon + 1))
    } catch {
      continue
    }
    if (!Array.isArray(body) || body.length < 4) continue
    const payload: unknown = body[3]
    if (payload === null || typeof payload !== 'object') continue
    const models = (payload as { models?: unknown }).models
    const planScope = (payload as { planScope?: unknown }).planScope
    if (!Array.isArray(models) || models.length === 0) continue
    const scopedIds = planScope !== null && typeof planScope === 'object'
      && Array.isArray((planScope as { modelIds?: unknown }).modelIds)
      ? new Set((planScope as { modelIds: string[] }).modelIds)
      : null

    const out: Record<string, LiveGoatModel> = {}
    for (const raw of models) {
      if (raw === null || typeof raw !== 'object') continue
      const model = raw as Record<string, unknown>
      const id = model.id
      if (typeof id !== 'string') continue
      if (scopedIds !== null && !scopedIds.has(id)) continue
      const input = model.inputCost
      const output = model.outputCost
      const cache = model.cacheReadCost
      if (typeof input !== 'number' || typeof output !== 'number' || typeof cache !== 'number') continue
      const cw = model.cacheWriteCost
      const entry: LiveGoatModel = {
        id, in: input, out: output, cache,
        ...typeof cw === 'number' ? { cw } : {},
      }
      const timeOfDay = model.timeOfDay
      if (timeOfDay !== null && typeof timeOfDay === 'object') {
        const tod = timeOfDay as Record<string, unknown>
        const peak = tod.peak as Record<string, unknown> | undefined
        const off = tod.offPeak as Record<string, unknown> | undefined
        if (peak !== undefined && off !== undefined
          && typeof peak.input === 'number' && typeof peak.output === 'number'
          && typeof peak.cacheRead === 'number'
          && typeof off.input === 'number' && typeof off.output === 'number'
          && typeof off.cacheRead === 'number') {
          entry.peak = { in: peak.input, out: peak.output, cache: peak.cacheRead }
          entry.off = { in: off.input, out: off.output, cache: off.cacheRead }
          if (typeof tod.windows === 'string') entry.windows = tod.windows
        }
      }
      out[id] = entry
    }
    return Object.keys(out).length === 0 ? null : out
  }
  return null
}

/** GOAT plan page URL, CORS-open (access-control-allow-origin: *). */
export const GOAT_PRICING_URL = 'https://commandcode.ai/docs/plans/goat'

/**
 * Merge live-fetched rates into the built-in table. Returns a new map;
 * the built-in table is untouched. Entries missing from the live payload
 * keep their built-in rates.
 * @param live - parsed live rates keyed by model id.
 * @returns merged rate map.
 */
export function mergeGoatRates(
  live: Readonly<Record<string, LiveGoatModel>>,
): Readonly<Record<string, GoatModelRate>> {
  const merged: Record<string, GoatModelRate> = { ...GOAT_MODEL_RATES }
  for (const [id, entry] of Object.entries(live)) {
    const rate: GoatModelRate = {
      name: GOAT_MODEL_RATES[id]?.name ?? id,
      in: entry.in,
      out: entry.out,
      cache: entry.cache,
      ...entry.cw === undefined ? {} : { cw: entry.cw },
      ...entry.peak === undefined || entry.off === undefined ? {} : {
        peak: { in: entry.peak.in, out: entry.peak.out, cache: entry.peak.cache },
        off: { in: entry.off.in, out: entry.off.out, cache: entry.off.cache },
        ...entry.windows === undefined
          ? GOAT_MODEL_RATES[id]?.windows === undefined ? {} : { windows: GOAT_MODEL_RATES[id].windows }
          : { windows: entry.windows },
      },
    }
    merged[id] = rate
  }
  return merged
}

/** How long a live pricing fetch is considered fresh (6 hours). */
export const PRICING_TTL_MS = 6 * 60 * 60 * 1000

interface PricingState {
  readonly rates: Readonly<Record<string, GoatModelRate>>
  readonly fetchedAt: number
}

let pricingState: PricingState | undefined

/**
 * Get the current pricing table, refreshing from commandcode.ai when the
 * cached copy is stale. The fetch is best-effort: any failure keeps the
 * built-in table.
 * @param fetchImpl - fetch implementation (injectable for tests).
 * @returns the current pricing table.
 */
export async function currentGoatRates(
  fetchImpl: (input: string) => Promise<{ ok: boolean; text(): Promise<string> }>
    = globalThis.fetch,
): Promise<Readonly<Record<string, GoatModelRate>>> {
  const now = Date.now()
  if (pricingState !== undefined && now - pricingState.fetchedAt < PRICING_TTL_MS) {
    return pricingState.rates
  }
  try {
    const response = await fetchImpl(GOAT_PRICING_URL)
    if (!response.ok) return GOAT_MODEL_RATES
    const html = await response.text()
    const parsed = parseGoatPageModels(html)
    if (parsed === null) return GOAT_MODEL_RATES
    const rates = mergeGoatRates(parsed)
    pricingState = { rates, fetchedAt: now }
    return rates
  } catch {
    return GOAT_MODEL_RATES
  }
}
