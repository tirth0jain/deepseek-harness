// Latency/throughput folds shared by the settled turn footer and StatsPills.

import type {
  AssistantMessageNode, ConversationNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Latency and throughput readings for one turn's footer. */
export interface TurnMetrics {
  /** First-step TTFT in ms; absent when that step carries no recorded timing. */
  ttftMs?: number
  /** Throughput over steps carrying both an LLM span and provider usage. */
  tokensPerSecond?: number
  /**
   * Throughput over the decode window (first token → final message) of steps
   * that recorded one. The window rides `firstTokenTime`, which the client
   * observes from live stream deltas and reads back from the durable stream
   * record on restore, so reopened Turns keep the reading.
   */
  decodeTokensPerSecond?: number
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
  decodeMs: number
  decodeTokens: number
  decodeSampled: boolean
}

/**
 * Fold assistant nodes into per-turn footer metrics.
 *
 * TTFT is the turn's lowest-step request-dispatch-to-first-token reading, so
 * it is only meaningful when the turn's start is inside the loaded window (the
 * caller gates on `turnTimings`, which shares that window). Throughput divides
 * summed output tokens by the summed LLM span of the steps that carry both.
 *
 * The span is used rather than the narrower first-token-to-final window
 * The span is used rather than the narrower first-token-to-final window
 * because it excludes the tool execution between steps, which is not
 * generation time. The decode-window rate is folded alongside
 * (`decodeTokensPerSecond`) from the steps that carry a first-token time —
 * observed from live stream deltas, or read back from the durable stream
 * record when the Turn is restored.
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
      fold = {
        firstStep: node.step, firstStepTtftMs: reading.ttftMs,
        llmMs: 0, outputTokens: 0, sampled: false,
        decodeMs: 0, decodeTokens: 0, decodeSampled: false,
      }
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
    if (reading.decodeMs !== null && reading.decodeMs > 0 && reading.outputTokens !== null) {
      fold.decodeMs += reading.decodeMs
      fold.decodeTokens += reading.outputTokens
      fold.decodeSampled = true
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
    if (fold.decodeSampled && fold.decodeMs > 0 && fold.decodeTokens > 0) {
      entry.decodeTokensPerSecond = fold.decodeTokens / (fold.decodeMs / 1000)
    }
    if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined
      || entry.decodeTokensPerSecond !== undefined) metrics.set(turn, entry)
  }
  return metrics
}
