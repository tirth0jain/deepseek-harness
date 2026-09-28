/**
 * Rate bands: which of a route's two published bands one moment prices in.
 *
 * A tariff that raises its rate inside recurring windows publishes the base
 * rate plus the rule, never a per-day table, so the only question an estimate
 * has to answer is whether the moment it is pricing falls inside a window.
 * Answering it here — once, for every surface that shows spend — is what keeps
 * the transcript and the Trajectory ledger from disagreeing about the same
 * request.
 *
 * Every failure is closed: a window this module cannot place on the clock
 * never opens, so a malformed rule prices at the base rate rather than
 * inventing a raised one. The host refuses such rules where they are written
 * (see `declaredPeak` in `dsh-llm-pi-ai`); this is the second line of that
 * defense, not the first.
 *
 * @module @deepseek-ai/dsh-token-meter/rate-schedule
 */

import type { UsageRate } from './usage-cost.ts'

/** Which of a schedule's two bands one moment prices in. */
export type UsageRateBand = 'base' | 'peak'

/** One recurring window a rate moves to its peak band inside, in UTC. */
export interface UsageRateWindow {
  /** Weekday names the window opens on, lowercase three-letter (`mon`…`sun`). */
  readonly days: readonly string[]
  /** Window start, `HH:MM` UTC, inclusive. */
  readonly start: string
  /** Window end, `HH:MM` UTC, exclusive. */
  readonly end: string
}

/** The band a rate moves to inside recurring windows. */
export interface UsageRatePeak {
  /** Factor every base rate is multiplied by while a window is open. */
  readonly multiplier: number
  /** Windows the peak band is in force in. */
  readonly windows: readonly UsageRateWindow[]
}

/** A published rate and, when its tariff has one, the band that rate moves to. */
export interface UsageRateSchedule extends UsageRate {
  /** Second band; absent means every moment prices at the base rate. */
  readonly peak?: UsageRatePeak
}

/** `getUTCDay()` order, so a date's weekday indexes straight into it. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** `HH:MM`, 24-hour UTC; the only clock spelling a rate window may use. */
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/**
 * Minutes after UTC midnight one `HH:MM` names.
 * @param value - clock spelling to read.
 * @returns minutes, or undefined when the value is not a clock time.
 */
function clockMinutes(value: string): number | undefined {
  if (!CLOCK.test(value)) return undefined
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}

/**
 * Whether one moment falls inside one window.
 * @param window - the window rule.
 * @param at - epoch ms to place.
 * @returns true only when the weekday matches and the time is inside the bounds.
 */
function windowOpen(window: UsageRateWindow, at: number): boolean {
  const date = new Date(at)
  const day = WEEKDAYS[date.getUTCDay()]
  if (day === undefined || !window.days.includes(day)) return false
  const start = clockMinutes(window.start)
  const end = clockMinutes(window.end)
  // A window that cannot be placed, or that ends before it starts, opens
  // nowhere: it is refused where it is written, and pricing it as always-open
  // would multiply every estimate by a factor nobody could see.
  if (start === undefined || end === undefined || start >= end) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return minutes >= start && minutes < end
}

/**
 * Which band a schedule prices in at one instant.
 * @param schedule - the route's published rate and its optional peak band.
 * @param at - epoch ms of the moment being priced.
 * @returns `'peak'` inside a window, `'base'` at every other moment.
 */
export function rateBandAt(schedule: UsageRateSchedule, at: number): UsageRateBand {
  const peak = schedule.peak
  if (peak === undefined) return 'base'
  return peak.windows.some(window => windowOpen(window, at)) ? 'peak' : 'base'
}

/**
 * One schedule's rate in one named band.
 * @param schedule - the route's published rate and its optional peak band.
 * @param band - band to read, as {@link rateBandAt} reported it.
 * @returns a detached rate with every stated bucket scaled for that band.
 */
export function bandRate(schedule: UsageRateSchedule, band: UsageRateBand): UsageRate {
  const factor = band === 'peak' ? (schedule.peak?.multiplier ?? 1) : 1
  return {
    input: schedule.input * factor,
    output: schedule.output * factor,
    ...schedule.cacheRead === undefined ? {} : { cacheRead: schedule.cacheRead * factor },
    ...schedule.cacheWrite === undefined ? {} : { cacheWrite: schedule.cacheWrite * factor },
  }
}

/**
 * The rate in force at one instant: the base band, or the same band scaled by
 * the stated factor while a window is open.
 * @param schedule - the route's published rate and its optional peak band.
 * @param at - epoch ms of the moment being priced.
 * @returns a detached rate with every stated bucket in force at `at`.
 */
export function rateAt(schedule: UsageRateSchedule, at: number): UsageRate {
  return bandRate(schedule, rateBandAt(schedule, at))
}
