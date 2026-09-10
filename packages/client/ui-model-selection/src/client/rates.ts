/**
 * Rate rendering for the model entries, shared by the /model popup rows and
 * the composer seat's menu so one route is always spelled the same way in both.
 */

/**
 * Format one model's published rate as `$in / $out` per million tokens, with
 * the cache-hit rate appended when the route publishes one.
 *
 * The cache-hit rate earns its place in the cell rather than behind a tooltip:
 * on a long agent conversation most prompt tokens are cache reads, so it is the
 * rate that actually drives the bill — a route twice the price per fresh token
 * can be cheaper per turn once its cache rate is read. A route that publishes
 * none (or charges nothing separately for cache reads) shows only the pair
 * rather than a `$0.00` no reader should multiply against.
 * @param cost - the catalog entry's published rate, in USD per million tokens.
 * @param cacheHit - renders the localized cache-hit segment around a price.
 * @returns the compact rate cell, e.g. `$0.15 / $0.60 · cache hit $0.003`.
 */
export function formatRate(
  cost: { input: number; output: number; cacheRead?: number | undefined },
  cacheHit: (price: string) => string,
): string {
  const pair = `$${trimPrice(cost.input)} / $${trimPrice(cost.output)}`
  const cacheRead = cost.cacheRead
  if (cacheRead === undefined || cacheRead <= 0) return pair
  return `${pair} · ${cacheHit(`$${trimPrice(cacheRead)}`)}`
}

/**
 * Trim a price for display: trailing zeros past two decimals are dropped, so
 * sub-cent rates keep their precision, and a whole number reads as one rather
 * than as `1.00`. Exactly two decimals are kept otherwise, so `0.60` stays a
 * price instead of collapsing to `0.6`.
 */
function trimPrice(value: number): string {
  const fixed = String(Number(value.toFixed(4)))
  if (!fixed.includes('.')) return fixed
  const [whole, fraction = ''] = fixed.split('.')
  return fraction.length >= 2 ? fixed : `${whole}.${fraction.padEnd(2, '0')}`
}
