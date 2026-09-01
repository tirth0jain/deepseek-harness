import { describe, expect, it } from 'vitest'
import {
  GOAT_MODEL_RATES, estimateTurnCost, estimateTurnCostForRoutes, estimateTurnCostUsd,
  formatUsd, isPeakHour, lookupModelId, mergeGoatRates, parseGoatPageModels,
  parsePeakWindows, resolveCurrentRates, type TurnCostInput,
} from '../src/client/chat/goat-pricing.ts'

const FLASH_INPUT: TurnCostInput = {
  uncachedInputTokens: 5_060,
  cacheReadTokens: 4_940,
  outputTokens: 5_800,
}

describe('GOAT pricing data table', () => {
  it('covers the user-facing deepseek models with peak data', () => {
    const flash = GOAT_MODEL_RATES['deepseek/deepseek-v4-flash']
    expect(flash).toBeDefined()
    expect(flash!.in).toBe(0.22)
    expect(flash!.out).toBe(0.66)
    expect(flash!.cache).toBe(0.007)
    expect(flash!.peak).toEqual({ in: 0.44, out: 1.32, cache: 0.014 })
    expect(flash!.off).toEqual({ in: 0.22, out: 0.66, cache: 0.007 })
    expect(flash!.windows).toContain('UTC')
  })

  it('treats free models as zero-cost', () => {
    expect(GOAT_MODEL_RATES['minimax/minimax-m3-free']).toMatchObject({ in: 0, out: 0, cache: 0 })
  })

  it('has 44 entries matching the GOAT plan scope', () => {
    expect(Object.keys(GOAT_MODEL_RATES)).toHaveLength(44)
  })
})

describe('peak window parsing', () => {
  it('parses the deepseek peak windows into two ranges', () => {
    const ranges = parsePeakWindows('01–04 & 06–10 UTC')
    expect(ranges).toEqual([{ start: 1, end: 4 }, { start: 6, end: 10 }])
  })

  it('returns null for unparseable or absent windows', () => {
    expect(parsePeakWindows(undefined)).toBeNull()
    expect(parsePeakWindows('peak time')).toBeNull()
    expect(parsePeakWindows('')).toBeNull()
  })

  it('rejects out-of-range hours', () => {
    expect(parsePeakWindows('25–26 UTC')).toBeNull()
    expect(parsePeakWindows('0–24 UTC')).toBeNull()
  })
})

describe('isPeakHour', () => {
  const ranges = [{ start: 1, end: 4 }, { start: 6, end: 10 }]

  it('flags hours inside any window inclusive', () => {
    expect(isPeakHour(1, ranges)).toBe(true)
    expect(isPeakHour(4, ranges)).toBe(true)
    expect(isPeakHour(6, ranges)).toBe(true)
    expect(isPeakHour(10, ranges)).toBe(true)
  })

  it('clears hours outside the windows', () => {
    expect(isPeakHour(0, ranges)).toBe(false)
    expect(isPeakHour(5, ranges)).toBe(false)
    expect(isPeakHour(11, ranges)).toBe(false)
    expect(isPeakHour(23, ranges)).toBe(false)
  })

  it('handles a window wrapping past midnight', () => {
    const wrap = [{ start: 22, end: 2 }]
    expect(isPeakHour(22, wrap)).toBe(true)
    expect(isPeakHour(23, wrap)).toBe(true)
    expect(isPeakHour(0, wrap)).toBe(true)
    expect(isPeakHour(2, wrap)).toBe(true)
    expect(isPeakHour(3, wrap)).toBe(false)
    expect(isPeakHour(12, wrap)).toBe(false)
  })
})

describe('resolveCurrentRates', () => {
  const flash = GOAT_MODEL_RATES['deepseek/deepseek-v4-flash']!

  it('selects peak rates during peak hours', () => {
    const { rates, tier, windows } = resolveCurrentRates(flash, 2)
    expect(tier).toBe('peak')
    expect(rates).toEqual({ in: 0.44, out: 1.32, cache: 0.014 })
    expect(windows).toContain('UTC')
  })

  it('selects off-peak rates outside peak hours', () => {
    const { rates, tier } = resolveCurrentRates(flash, 11)
    expect(tier).toBe('off-peak')
    expect(rates).toEqual({ in: 0.22, out: 0.66, cache: 0.007 })
  })

  it('uses the flat rate for non-time-of-day models', () => {
    const glm = GOAT_MODEL_RATES['z-ai/glm-5.3-flash']!
    const { rates, tier, windows } = resolveCurrentRates(glm, 3)
    expect(tier).toBe('off-peak')
    expect(rates).toEqual({ in: 0.15, out: 0.5, cache: 0.03 })
    expect(windows).toBeUndefined()
  })
})

describe('estimateTurnCostUsd', () => {
  it('computes the flash off-peak cost from exact buckets', () => {
    const cost = estimateTurnCostUsd(FLASH_INPUT, { in: 0.22, out: 0.66, cache: 0.007 })
    // 5060*0.22/1M + 4940*0.007/1M + 5800*0.66/1M
    const expected = 5060 * 0.22 / 1e6 + 4940 * 0.007 / 1e6 + 5800 * 0.66 / 1e6
    expect(cost).toBeCloseTo(expected, 10)
  })

  it('includes cache-write at the cw rate when present', () => {
    const cost = estimateTurnCostUsd(
      { ...FLASH_INPUT, cacheWriteTokens: 1_000 },
      { in: 0.22, out: 0.66, cache: 0.007, cw: 0.5 },
    )
    const expected = 5060 * 0.22 / 1e6 + 4940 * 0.007 / 1e6 + 5800 * 0.66 / 1e6 + 1000 * 0.5 / 1e6
    expect(cost).toBeCloseTo(expected, 10)
  })
})

describe('lookupModelId', () => {
  it('matches a bare full id in model', () => {
    expect(lookupModelId(GOAT_MODEL_RATES, { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' }))
      .toBe('deepseek/deepseek-v4-flash')
  })

  it('matches provider/model join', () => {
    expect(lookupModelId(GOAT_MODEL_RATES, { provider: 'deepseek', model: 'deepseek-v4-flash' }))
      .toBe('deepseek/deepseek-v4-flash')
  })

  it('returns undefined for unknown models and empty model', () => {
    expect(lookupModelId(GOAT_MODEL_RATES, { provider: 'deepseek', model: 'does-not-exist' }))
      .toBeUndefined()
    expect(lookupModelId(GOAT_MODEL_RATES, { provider: 'deepseek', model: '' }))
      .toBeUndefined()
  })
})

describe('estimateTurnCost / estimateTurnCostForRoutes', () => {
  it('picks peak pricing during the deepseek peak window', () => {
    const atPeak = new Date('2026-08-20T02:30:00Z')
    const estimate = estimateTurnCost(GOAT_MODEL_RATES, 'deepseek/deepseek-v4-flash', FLASH_INPUT, atPeak)
    expect(estimate).not.toBeNull()
    expect(estimate!.tier).toBe('peak')
    const expected = 5060 * 0.44 / 1e6 + 4940 * 0.014 / 1e6 + 5800 * 1.32 / 1e6
    expect(estimate!.usd).toBeCloseTo(expected, 10)
  })

  it('uses off-peak pricing outside the peak window', () => {
    const offPeak = new Date('2026-08-20T12:30:00Z')
    const estimate = estimateTurnCost(GOAT_MODEL_RATES, 'deepseek/deepseek-v4-flash', FLASH_INPUT, offPeak)
    expect(estimate!.tier).toBe('off-peak')
    const expected = 5060 * 0.22 / 1e6 + 4940 * 0.007 / 1e6 + 5800 * 0.66 / 1e6
    expect(estimate!.usd).toBeCloseTo(expected, 10)
  })

  it('returns null for unknown model ids', () => {
    expect(estimateTurnCost(GOAT_MODEL_RATES, 'unknown/model', FLASH_INPUT)).toBeNull()
  })

  it('routes through provider/model to the table', () => {
    const estimate = estimateTurnCostForRoutes(
      GOAT_MODEL_RATES,
      [{ provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' }],
      FLASH_INPUT,
      new Date('2026-08-20T12:30:00Z'),
    )
    expect(estimate!.usd).toBeCloseTo(
      5060 * 0.22 / 1e6 + 4940 * 0.007 / 1e6 + 5800 * 0.66 / 1e6,
      10,
    )
  })

  it('returns null without routes or with mixed routes', () => {
    expect(estimateTurnCostForRoutes(GOAT_MODEL_RATES, undefined, FLASH_INPUT)).toBeNull()
    expect(estimateTurnCostForRoutes(GOAT_MODEL_RATES, [], FLASH_INPUT)).toBeNull()
    expect(estimateTurnCostForRoutes(GOAT_MODEL_RATES, [
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
    ], FLASH_INPUT)).toBeNull()
  })

  it('returns null when any route is unknown', () => {
    expect(estimateTurnCostForRoutes(GOAT_MODEL_RATES, [
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'deepseek', model: 'nope' },
    ], FLASH_INPUT)).toBeNull()
  })
})

describe('formatUsd', () => {
  it('formats sub-cent, cent, and dollar magnitudes', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0.123)).toBe('$0.123')
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(12.345)).toBe('$12.35')
  })
})

describe('parseGoatPageModels / mergeGoatRates', () => {
  const PAGE = '<script>self.__next_f.push([1,"12:[\\"$\\",\\"$L40\\",null,{\\"models\\":[{\\"slug\\":\\"deepseek-v4-flash\\",\\"id\\":\\"deepseek/deepseek-v4-flash\\",\\"name\\":\\"DeepSeek V4 Flash (latest)\\",\\"vendor\\":\\"DeepSeek\\",\\"category\\":\\"opensource\\",\\"blurb\\":\\"fast hybrid-attention reasoning\\",\\"contextWindow\\":1000000,\\"reasoning\\":true,\\"vision\\":false,\\"inputCost\\":0.22,\\"outputCost\\":0.66,\\"cacheReadCost\\":0.007,\\"cacheWriteCost\\":\\"$undefined\\",\\"blendedCostPerMTok\\":0.33,\\"agentLoopInputPerMTok\\":0.0709,\\"minPlanName\\":\\"Go\\",\\"tiers\\":[{\\"rates\\":{\\"input\\":0.22,\\"output\\":0.66,\\"cacheRead\\":0.007}}],\\"deal\\":\\"$undefined\\",\\"scheduledChange\\":\\"$undefined\\",\\"timeOfDay\\":{\\"effective\\":\\"2026-08-16T16:00:00Z\\",\\"peak\\":{\\"input\\":0.44,\\"output\\":1.32,\\"cacheRead\\":0.014},\\"offPeak\\":{\\"input\\":0.22,\\"output\\":0.66,\\"cacheRead\\":0.007},\\"peakHoursPerDay\\":7,\\"offPeakHoursPerDay\\":17,\\"windows\\":\\"01–04 \u0026 06–10 UTC\\",\\"tip\\":\\"Rates shown are off-peak\\"},\\"caps\\":{\\"text\\":true,\\"vision\\":false,\\"reasoning\\":true},\\"intelligenceIndex\\":51.8,\\"codingIndex\\":69.1,\\"outputTokensPerSec\\":129,\\"latencyTier\\":\\"balanced\\",\\"releaseDate\\":\\"2026-07-31\\",\\"launchedAt\\":\\"2026-07-31\\"},{\\"slug\\":\\"glm-5-3-flash\\",\\"id\\":\\"z-ai/glm-5.3-flash\\",\\"name\\":\\"GLM-5.3 Flash\\",\\"vendor\\":\\"Z AI\\",\\"category\\":\\"opensource\\",\\"blurb\\":\\"fast, affordable GLM coding with 1M context\\",\\"contextWindow\\":1048576,\\"reasoning\\":true,\\"vision\\":true,\\"inputCost\\":0.15,\\"outputCost\\":0.5,\\"cacheReadCost\\":0.03,\\"cacheWriteCost\\":\\"$undefined\\",\\"blendedCostPerMTok\\":0.2375,\\"agentLoopInputPerMTok\\":0.066,\\"minPlanName\\":\\"Go\\",\\"tiers\\":[{\\"rates\\":{\\"input\\":0.15,\\"output\\":0.5,\\"cacheRead\\":0.03}}],\\"deal\\":\\"$undefined\\",\\"scheduledChange\\":\\"$undefined\\",\\"timeOfDay\\":\\"$undefined\\",\\"caps\\":{\\"text\\":true,\\"vision\\":true,\\"reasoning\\":true},\\"intelligenceIndex\\":57.5,\\"codingIndex\\":71.5,\\"outputTokensPerSec\\":41.8,\\"latencyTier\\":\\"deliberate\\",\\"releaseDate\\":\\"2026-08-26\\",\\"launchedAt\\":\\"2026-08-26\\"}],\\"planScope\\":{\\"label\\":\\"GOAT plan\\",\\"modelIds\\":[\\"deepseek/deepseek-v4-flash\\",\\"z-ai/glm-5.3-flash\\"]}}]\\n"])</script>'

  it('parses the embedded flight payload into GOAT-scoped rates', () => {
    const parsed = parseGoatPageModels(PAGE)
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!)).toHaveLength(2)
    const flash = parsed!['deepseek/deepseek-v4-flash']!
    expect(flash).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      in: 0.22,
      out: 0.66,
      cache: 0.007,
    })
    expect(flash.peak).toEqual({ in: 0.44, out: 1.32, cache: 0.014 })
    expect(flash.windows).toContain('UTC')
  })

  it('returns null when no flight payload carries models', () => {
    expect(parseGoatPageModels('<html><body>no payload</body></html>')).toBeNull()
    expect(parseGoatPageModels('')).toBeNull()
  })

  it('merges live rates over the built-in table, preserving the name', () => {
    const parsed = parseGoatPageModels(PAGE)!
    const merged = mergeGoatRates(parsed)
    expect(merged['deepseek/deepseek-v4-flash']).toMatchObject({
      name: 'DeepSeek V4 Flash (latest)',
      in: 0.22,
      out: 0.66,
      cache: 0.007,
      peak: { in: 0.44, out: 1.32, cache: 0.014 },
    })
    // untouched model keeps its built-in rates
    expect(merged['zai-org/GLM-5.3']).toBe(GOAT_MODEL_RATES['zai-org/GLM-5.3'])
  })
})
