// Composer dock entries for one session: the activity and usage readings, and
// the load control that pages history back one Turn per press. Each is its own
// 'conversation.composer.dock' list entry, so a plugin can replace or add one
// pill by id. Compact keeps speed and cache hit as plain readings; Detailed
// adds counts, token totals, and click-open dialogs. Settled-node identity
// prevents stream-delta updates from rerendering the pills.

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconDatabaseOutlineRegular, IconDownloadOutlineRegular, IconGaugeOutlineRegular, IconLoadingOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSnapshotSelector } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
// Type-only: merges the turnOutline key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ChatViewSlotProps, PerformanceUsageInjected, StatsPillsInjected } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { assistantStepReading } from '../contract/turn-metrics.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './StatsPills.module.css'
import dialogCss from './stat-dialog.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ChatSnapshot['legacy']['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number, t: ChatViewSlotProps['t']): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  return formatCacheHitPercent(usage.cacheReadTokens, denominator)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

type Translate = ChatViewSlotProps['t']

/** Props shared by every composer stats pill: the conversation-snapshot selector plus the projection read seat. */
export interface StatPillProps extends InjectFace<PerformanceUsageInjected> {
  useChat: SnapshotSelectorHook<ChatSnapshot>
  useProjection: UseProjection
  /** The owning dock's locale seat. */
  t: Translate
}

/** Dock entry id carried as `data-composer-stat` on each pill. */
type StatId = 'activity' | 'usage'

interface PillContent {
  stat: StatId
  icon: ReactNode
  label: ReactNode
}

function exactCount(value: number, t: Translate): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

function joined(first: string, second: string | null): ReactNode {
  if (second === null) return first
  return (
    <>
      {first}
      <span className={css.sep} aria-hidden>·</span>
      {second}
    </>
  )
}

// Every figure rides the durable sessionStats projection, so paging and
// compaction cannot change any of them; an assembly without the unit falls
// back to the window-scoped fold wholesale (same field names), paid only
// while no projection value is served.
function useSessionStats(useChat: StatPillProps['useChat'], useProjection: UseProjection): WindowStats {
  const settledNodes = useChat(s => s.legacy.nodes)
  const projected = useProjection('sessionStats')
  return useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
}

function decodeSpeed(stats: WindowStats, t: Translate): string {
  return t('message.tokensPerSecond', {
    tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
  })
}

/** A static reading: used when the pill has no dialog rows or the mode is Compact. */
function PlainPill({ stat, icon, label }: PillContent) {
  return (
    <span className={css.anchor} data-composer-stat={stat}>
      <span className={css.pill}>
        {icon}
        <span className={css.label}>{label}</span>
      </span>
    </span>
  )
}

/**
 * A pill button opening its own portaled dialog. Each pill owns its open
 * state; useStatDialog closes it on Escape or an outside pointerdown or click,
 * so at most one dialog is open across the dock.
 */
function DialogPill({ stat, icon, label, ariaLabel, title, titleValue, children }: PillContent & {
  ariaLabel: string
  title: string
  titleValue?: string
  children: ReactNode
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.anchor} data-composer-stat={stat}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => { setOpen(!open) }}
      >
        {icon}
        <span className={css.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={title}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              {icon}
              {title}
            </span>
            {titleValue !== undefined && <span className={dialogCss.titleValue}>{titleValue}</span>}
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * Turn and step counts with whole-session speed, opening the time and speed
 * dialog; Compact keeps only the speed reading.
 */
export const ActivityPill = memo(function ActivityPill({ useChat, useProjection, usePerformanceUsage, t }: StatPillProps) {
  const mode = usePerformanceUsage(value => value)
  const stats = useSessionStats(useChat, useProjection)
  const speed = stats.decodeMs > 0 ? decodeSpeed(stats, t) : null
  const icon = <IconGaugeOutlineRegular />
  if (mode === 'compact') return speed === null ? null : <PlainPill stat="activity" icon={icon} label={speed} />
  if (stats.steps === 0) return null
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  const content: PillContent = { stat: 'activity', icon, label: joined(counts, speed) }
  // A window without one timed figure has no dialog rows to show, so the pill
  // stays a plain reading instead of a button opening an empty dialog.
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && speed === null) return <PlainPill {...content} />
  return (
    <DialogPill {...content} ariaLabel={speed === null ? counts : `${counts} · ${speed}`} title={t('stats.dialog.title')}>
      <dl className={dialogCss.details} data-session-stats-details>
        {stats.llmMs > 0 && (
          <>
            <dt>{t('stats.dialog.llmTime')}</dt>
            <dd>{formatDuration(stats.llmMs, t)}</dd>
          </>
        )}
        {stats.toolMs > 0 && (
          <>
            <dt>{t('stats.dialog.toolTime')}</dt>
            <dd>{formatDuration(stats.toolMs, t)}</dd>
          </>
        )}
        {stats.ttftSteps > 0 && (
          <>
            <dt>{t('stats.dialog.ttft')}</dt>
            <dd>{formatDuration(stats.ttftMs / stats.ttftSteps, t)}</dd>
          </>
        )}
        {speed !== null && (
          <>
            <dt>{t('stats.dialog.speed')}</dt>
            <dd>{speed}</dd>
          </>
        )}
      </dl>
    </DialogPill>
  )
})

/** Whole-log token total and cache hit; Compact keeps only the cache hit. */
export const UsagePill = memo(function UsagePill({ useProjection, usePerformanceUsage, t }: StatPillProps) {
  const mode = usePerformanceUsage(value => value)
  const usage = useProjection('tokenUsage')
  // Gated on actual token activity: a session whose steps all settled without
  // billing (e.g. every request failed) shows no usage pill.
  if (usage === undefined || (billedInputTokens(usage) === 0 && usage.outputTokens === 0)) return null
  const cacheHit = cacheHitPercent(usage)
  const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
  const icon = <IconDatabaseOutlineRegular />
  if (mode === 'compact') {
    return cacheHitText === null ? null : <PlainPill stat="usage" icon={icon} label={cacheHitText} />
  }
  // Same aggregate as the Turn pill's totalTokens: every prompt-side billing bucket plus output.
  const total = billedInputTokens(usage) + usage.outputTokens
  const totalText = t('message.turnUsage.count', { count: formatTokens(total, t) })
  return (
    <DialogPill
      stat="usage"
      icon={icon}
      label={joined(totalText, cacheHitText)}
      ariaLabel={cacheHitText === null ? totalText : `${totalText} · ${cacheHitText}`}
      title={t('stats.dialog.usageTitle')}
      titleValue={exactCount(total, t)}
    >
      {/* jscpd:ignore-start -- the session-total bucket rows deliberately mirror
          TurnUsagePanel's per-turn dl: same skin, different data contract (the
          buckets are always present here; per-turn fields are optional). A
          session that never wrote cache drops the row, as the per-turn panel
          drops its absent fields. */}
      <dl className={dialogCss.details} data-session-stats-usage>
        {cacheHit !== null && (
          <>
            <dt>{t('message.turnUsage.cacheHit')}</dt>
            <dd>{`${cacheHit}%`}</dd>
          </>
        )}
        <dt>{t('message.turnUsage.input')}</dt>
        <dd>{exactCount(usage.uncachedInputTokens, t)}</dd>
        <dt>{t('message.turnUsage.cacheRead')}</dt>
        <dd>{exactCount(usage.cacheReadTokens, t)}</dd>
        {usage.cacheWriteTokens !== 0 && (
          <>
            <dt>{t('message.turnUsage.cacheWrite')}</dt>
            <dd>{exactCount(usage.cacheWriteTokens, t)}</dd>
          </>
        )}
        <dt>{t('message.turnUsage.output')}</dt>
        <dd>{exactCount(usage.outputTokens, t)}</dd>
      </dl>
      {/* jscpd:ignore-end */}
    </DialogPill>
  )
})

/** Props of the composer dock's load control: the pager seat plus its own action. */
export interface LoadTurnPillProps extends InjectFace<PerformanceUsageInjected>, StatsPillsInjected {
  useProjection: UseProjection
  /** Session lifecycle state: the pager's remaining-history flag and window base gate the control. */
  useSession: SessionSnapshotSelector
  /** The owning dock's locale seat. */
  t: Translate
}

/**
 * Composer dock control that pages history back one Turn per press. Detailed
 * mode only, matching the readings it sits beside: compact mode renders plain
 * figures and no controls.
 * @param props - projection and session read seats, the paging action, and the locale seat.
 * @returns the load control, or null when no earlier Turn is reachable.
 */
export const LoadTurnPill = memo(function LoadTurnPill({
  useProjection, useSession, loadThrough, usePerformanceUsage, t,
}: LoadTurnPillProps) {
  const mode = usePerformanceUsage(value => value)
  // Whole-log outline: names every Turn of the session whether or not the
  // paged window holds it, which is what makes an unheld Turn detectable here.
  const outline = useProjection('turnOutline')
  const hasMore = useSession(s => s.hasMore)
  // The window's oldest EVENT, which is what tells a Turn held whole from one
  // the window enters midway. The head NODE's anchor cannot: a Turn's
  // `turn/start` precedes its first visible node, so that node's anchor sits
  // after the Turn's own seq whether or not the window covers the Turn's start.
  const baseSeq = useSession(s => s.baseSeq)
  // The Turn whose load is in flight, by number: a control that re-targets
  // mid-flight must not leave a stale busy flag behind.
  const [loadingTurn, setLoadingTurn] = useState<number | null>(null)
  // Which Turn a press brings in, walking history back one Turn per press:
  // the Turn the window's head sits inside when it started midway through one
  // (that Turn's aggregate is unknown until it is whole), otherwise the Turn
  // immediately before the window's first. `hasMore` is loadThrough's own
  // precondition, and without it the control could never discharge.
  const pendingTurn = useMemo(() => {
    if (outline === undefined || outline.length === 0 || !hasMore) return undefined
    // Newest first, so the first entry at or before the head is the Turn the
    // head sits in.
    let head = -1
    for (let index = outline.length - 1; index >= 0; index -= 1) {
      const entry = outline[index]
      if (entry !== undefined && entry.seq <= baseSeq) {
        head = index
        break
      }
    }
    // The head precedes every known Turn: the window already starts before
    // this session's first Turn, so no press can add one.
    const entry = head < 0 ? undefined : outline[head]
    if (entry === undefined) return undefined
    // Midway through the head Turn: finish that one before reaching past it.
    if (entry.seq < baseSeq) return entry
    // The window begins exactly at the head Turn's start, so that Turn is
    // whole; the next one back is what the window does not hold.
    return head === 0 ? undefined : outline[head - 1]
  }, [outline, hasMore, baseSeq])
  const loadTurn = useCallback((seq: SessionSeq, turn: number): void => {
    setLoadingTurn(turn)
    void loadThrough(seq)
      // The pager surfaces its own failure; this control only needs to settle.
      .catch(() => { /* keep the button available for a retry */ })
      .finally(() => { setLoadingTurn(null) })
  }, [loadThrough])
  if (mode === 'compact' || pendingTurn === undefined) return null
  const busy = loadingTurn === pendingTurn.turn
  return (
    <span className={css.anchor} data-composer-stat="loadTurn">
      <button
        type="button"
        className={css.pill}
        disabled={busy}
        aria-busy={busy ? 'true' : undefined}
        aria-label={t('chat.loadTurn.aria', { turn: pendingTurn.turn })}
        onClick={() => { loadTurn(pendingTurn.seq, pendingTurn.turn) }}
      >
        {busy ? <IconLoadingOutlineRegular /> : <IconDownloadOutlineRegular />}
        <span className={css.label}>
          {busy ? t('chat.loadTurn.busy', { turn: pendingTurn.turn }) : t('chat.loadTurn', { turn: pendingTurn.turn })}
        </span>
      </button>
    </span>
  )
})
