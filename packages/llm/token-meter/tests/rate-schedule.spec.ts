import { describe, expect, it } from 'vitest'
import { bandRate, rateAt, rateBandAt } from '../src/rate-schedule.ts'

/** DeepSeek's published peak band: every rate doubles, Mon-Fri, in two UTC windows. */
const PEAK = {
  multiplier: 2,
  windows: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' },
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' },
  ],
}
const FLASH = { input: 0.15, output: 0.6, cacheRead: 0.003, peak: PEAK }

/** Thursday 2026-09-10; every instant below is stated in UTC on that date. */
const at = (iso: string): number => Date.parse(iso)

describe('rateBandAt', () => {
  it('reads a schedule with no peak band as always base', () => {
    expect(rateBandAt({ input: 1, output: 1 }, at('2026-09-10T02:00:00Z'))).toBe('base')
  })

  it.each([
    '2026-09-10T01:00:00Z',
    '2026-09-10T03:59:59Z',
    '2026-09-10T06:00:00Z',
    '2026-09-10T09:59:59Z',
  ])('opens the peak band inside a window at %s', (iso) => {
    expect(rateBandAt(FLASH, at(iso))).toBe('peak')
  })

  it.each([
    '2026-09-10T00:59:59Z',
    '2026-09-10T04:00:00Z',
    '2026-09-10T05:59:59Z',
    '2026-09-10T10:00:00Z',
    '2026-09-10T23:00:00Z',
  ])('keeps the base band outside every window at %s', (iso) => {
    expect(rateBandAt(FLASH, at(iso))).toBe('base')
  })

  it('carries no peak band on the weekend, at the same clock times', () => {
    // Saturday and Sunday, both inside the weekday 01:00-04:00 and 06:00-10:00 windows.
    expect(rateBandAt(FLASH, at('2026-09-12T02:00:00Z'))).toBe('base')
    expect(rateBandAt(FLASH, at('2026-09-12T07:00:00Z'))).toBe('base')
    expect(rateBandAt(FLASH, at('2026-09-13T02:00:00Z'))).toBe('base')
    expect(rateBandAt(FLASH, at('2026-09-13T07:00:00Z'))).toBe('base')
    // Monday at the same clock time is inside the window again.
    expect(rateBandAt(FLASH, at('2026-09-14T02:00:00Z'))).toBe('peak')
  })

  it('honors a window that names only other weekdays', () => {
    const weekend = { input: 1, output: 1, peak: { multiplier: 2, windows: [{ days: ['sat'], start: '00:00', end: '23:59' }] } }
    expect(rateBandAt(weekend, at('2026-09-12T12:00:00Z'))).toBe('peak')
    expect(rateBandAt(weekend, at('2026-09-10T12:00:00Z'))).toBe('base')
  })

  it.each([
    { days: ['thu'], start: '1:00', end: '04:00' },
    { days: ['thu'], start: '01:00', end: '25:00' },
    { days: ['thu'], start: '04:00', end: '01:00' },
    { days: ['thu'], start: '01:00', end: '01:00' },
    { days: ['thursday'], start: '01:00', end: '04:00' },
    { days: [], start: '01:00', end: '04:00' },
  ])('fails closed on a window it cannot place: %j', (window) => {
    expect(rateBandAt({ input: 1, output: 1, peak: { multiplier: 2, windows: [window] } }, at('2026-09-10T02:00:00Z')))
      .toBe('base')
  })

  it('reads an instant it cannot place as base', () => {
    expect(rateBandAt(FLASH, Number.NaN)).toBe('base')
  })
})

describe('rateAt', () => {
  it('returns the base rate unchanged outside a window', () => {
    expect(rateAt(FLASH, at('2026-09-10T05:00:00Z')))
      .toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 })
  })

  it('scales every stated bucket by the multiplier inside a window', () => {
    expect(rateAt(FLASH, at('2026-09-10T02:00:00Z')))
      .toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006 })
  })

  it('keeps an absent bucket absent in both bands', () => {
    expect(rateAt({ input: 1, output: 2, peak: { multiplier: 3, windows: [{ days: ['thu'], start: '00:00', end: '23:59' }] } }, at('2026-09-10T02:00:00Z')))
      .toEqual({ input: 3, output: 6 })
  })
})

describe('bandRate', () => {
  it('reads either band without consulting the clock', () => {
    expect(bandRate(FLASH, 'base')).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 })
    expect(bandRate(FLASH, 'peak')).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006 })
  })

  it('reads a named peak band as base when the schedule states none', () => {
    expect(bandRate({ input: 1, output: 2 }, 'peak')).toEqual({ input: 1, output: 2 })
  })
})
