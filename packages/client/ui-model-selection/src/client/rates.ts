/**
 * Rate rendering for the model entries, shared by the /model popup rows and
 * the composer seat's menu so one route is always spelled the same way in both.
 */

/**
 * Format one model's published rate as `$in / $out` per million tokens. Cache
 * prices stay out of the cell: they are what makes a cached conversation
 * cheap, not what a reader compares routes by, and the spending surfaces
 * report actual cache spend where it lands.
 * @param cost - the catalog entry's published rate, in USD per million tokens.
 * @returns the compact rate cell, e.g. `$0.15 / $0.60`.
 */
export function formatRate(cost: { input: number; output: number }): string {
  return `$${trimPrice(cost.input)} / $${trimPrice(cost.output)}`
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
