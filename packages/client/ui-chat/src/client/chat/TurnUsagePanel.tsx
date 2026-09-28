/** Completed-Turn token usage action and its accounting details dialog. */

import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTokenUsage } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import type { TurnCostEstimate } from './turn-cost.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './TurnUsagePanel.module.css'
import dialogCss from './stat-dialog.module.css'

export interface TurnUsagePanelProps {
  usage: TurnTokenUsage
  /**
   * Estimated spend at the rate each of the Turn's attempts billed in USD, and
   * the bands those attempts fell in; undefined when a route is unpriced or
   * unrecorded, in which case no amount is rendered at all.
   */
  cost?: TurnCostEstimate | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

function formatCompactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatTokens(value, t) })
}

function formatExactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/**
 * Format an estimated amount in USD. Six decimals because a single turn's
 * spend is routinely under a cent, and a rate is per million tokens: rounding
 * to cents would print $0.00 for the turns a reader is inspecting.
 * @param value - estimated USD.
 * @returns the amount, marked as an estimate by the caller's own label.
 */
function formatCost(value: number): string {
  return `$${value.toFixed(6)}`
}

/**
 * Name the bands a Turn's estimate was billed in. A Turn whose requests
 * straddled a tariff's boundary says so rather than picking one band's name
 * for an amount that is partly the other's.
 * @param bands - bands the priced attempts fell in.
 * @param t - owning view's locale seat.
 * @returns the band note, or undefined when no band was recorded.
 */
function formatCostBand(
  bands: TurnCostEstimate['bands'],
  t: ChatViewSlotProps['t'],
): string | undefined {
  const peak = bands.includes('peak')
  const base = bands.includes('base')
  if (peak && base) return t('message.turnUsage.costBand.mixed')
  if (peak) return t('message.turnUsage.costBand.peak')
  if (base) return t('message.turnUsage.costBand.base')
  return undefined
}

/**
 * Turn-usage IconActions pill with a click-open Turn-usage details dialog.
 * @param props - Turn usage buckets and locale seat.
 * @returns The trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnUsagePanel({ usage, cost, t }: TurnUsagePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()

  const cacheHit = usage.cacheReadTokens === undefined
    ? null
    : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)
  const total = formatCompactCount(usage.totalTokens, t)
  const routes = usage.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''
  const costBand = cost === undefined ? undefined : formatCostBand(cost.bands, t)

  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconDatabaseOutlineRegular />
        <span className={css.label}>{t('message.turnUsage.consumed', { total })}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('message.turnUsage.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconDatabaseOutlineRegular />
              {t('message.turnUsage.title')}
            </span>
            <span className={dialogCss.titleValue}>{formatExactCount(usage.totalTokens, t)}</span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-turn-usage-details>
            {routes !== '' && (
              <>
                <dt>{t('message.turnUsage.model')}</dt>
                <dd className={dialogCss.route}>{routes}</dd>
              </>
            )}
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{`${cacheHit}%`}</dd>
              </>
            )}
            {cost !== undefined && (
              <>
                <dt>{t('message.turnUsage.cost')}</dt>
                <dd className={dialogCss.route}>
                  {formatCost(cost.amount)}
                  {costBand !== undefined && (
                    <span className={dialogCss.reasoning}>{costBand}</span>
                  )}
                </dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{formatExactCount(usage.uncachedInputTokens, t)}</dd>
            {usage.cacheReadTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheRead')}</dt>
                <dd>{formatExactCount(usage.cacheReadTokens, t)}</dd>
              </>
            )}
            {usage.cacheWriteTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheWrite')}</dt>
                <dd>{formatExactCount(usage.cacheWriteTokens, t)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>
              {formatExactCount(usage.outputTokens, t)}
              {usage.reasoningTokens !== undefined && (
                <span className={dialogCss.reasoning}>
                  {t('message.turnUsage.reasoning', { tokens: formatExactCount(usage.reasoningTokens, t) })}
                </span>
              )}
            </dd>
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}
