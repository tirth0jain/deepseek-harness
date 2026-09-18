// Latency/throughput folds shared by the settled turn footer and StatsPills.

import type {
  AssistantMessageNode, ConversationNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Latency and decode-throughput readings for one turn's footer. */
export interface TurnMetrics {
  /** First-step TTFT in ms; absent when that step carries no recorded timing. */
  ttftMs?: number
  /** Decode throughput over steps carrying both timing and provider usage. */
  tokensPerSecond?: number
}

/** One assistant step's derivable latency facts; null marks an unrecorded part. */
export interface StepReading {
  /** step/start → first token delta, in ms. */
  ttftMs: number | null
  /** First token delta → final message, in ms. */
  decodeMs: number | null
  /** step/start → final message, in ms: the step's whole LLM span. */
  llmMs: number | null
  /** Provider-reported completion tokens. */
  outputTokens: number | null
}

interface UsageLike {
  outputTokens?: number
}

type AssistantNode = AssistantMessageNode

function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (usage as UsageLike).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Read one assistant node's TTFT, decode wall time, whole LLM span, and output
 * tokens.
 * @param node - A settled assistant node.
 * @returns Per-part readings with `null` for unrecorded values.
 */
export function assistantStepReading(node: AssistantNode): StepReading {
  const timing = node.timing
  const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
    ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
    : null
  const decodeMs = timing !== undefined && timing.firstTokenTime !== null
    ? Math.max(0, timing.completedTime - timing.firstTokenTime)
    : null
  const llmMs = timing !== undefined && timing.stepStartTime !== null
    ? Math.max(0, timing.completedTime - timing.stepStartTime)
    : null
  return { ttftMs, decodeMs, llmMs, outputTokens: usageOutputTokens(node.usage) }
}

interface TurnFold {
  firstStep: number
  firstStepTtftMs: number | null
  llmMs: number
  outputTokens: number
  sampled: boolean
}

/**
 * Fold assistant nodes into per-turn footer metrics.
 *
 * TTFT is the turn's lowest-step request-dispatch-to-first-token reading, so
 * it is only meaningful when the turn's start is inside
 * the loaded window (the caller gates on `turnTimings`, which shares that
 * window). Throughput divides summed output tokens by the summed LLM span of
 * the steps that carry both.
 *
 * The span is used rather than the narrower first-token-to-final window
 * because only the span survives a reload: `firstTokenTime` is observed from
 * live stream deltas, and the session format persists no timing, so a
 * decode-window rate would disappear for every restored Turn. The span also
 * excludes the tool execution between steps, which is not generation time.
 * @param nodes - Snapshot nodes of the loaded window.
 * @returns Turn number → available metrics; turns with none are absent.
 */
export function deriveTurnMetrics(nodes: readonly ConversationNode[]): Map<number, TurnMetrics> {
  const folds = new Map<number, TurnFold>()
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const reading = assistantStepReading(node)
    let fold = folds.get(node.turn)
    if (fold === undefined) {
      fold = { firstStep: node.step, firstStepTtftMs: reading.ttftMs, llmMs: 0, outputTokens: 0, sampled: false }
      folds.set(node.turn, fold)
    } else if (node.step < fold.firstStep) {
      fold.firstStep = node.step
      fold.firstStepTtftMs = reading.ttftMs
    }
    if (reading.llmMs !== null && reading.outputTokens !== null) {
      fold.llmMs += reading.llmMs
      fold.outputTokens += reading.outputTokens
      fold.sampled = true
    }
  }
  const metrics = new Map<number, TurnMetrics>()
  for (const [turn, fold] of folds) {
    const entry: TurnMetrics = {}
    if (fold.firstStepTtftMs !== null) entry.ttftMs = fold.firstStepTtftMs
    // A step that generated nothing (a pure tool call) has no rate to report.
    if (fold.sampled && fold.llmMs > 0 && fold.outputTokens > 0) {
      entry.tokensPerSecond = fold.outputTokens / (fold.llmMs / 1000)
    }
    if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined) metrics.set(turn, entry)
  }
  return metrics
}
