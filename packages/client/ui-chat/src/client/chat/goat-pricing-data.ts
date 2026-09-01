/**
 * GOAT-plan model pricing table (commandcode.ai), USD per 1M tokens.
 *
 * This table mirrors the GOAT plan catalog published at
 * https://commandcode.ai/docs/plans/goat (and the structured model catalog
 * embedded in its page payload). Rates are per 1M tokens. Models with
 * `peak`/`off` carry time-of-day pricing: the `off` block is the default
 * rate and `peak` applies during the UTC windows listed in `windows`.
 *
 * New models are added upstream without notice; the built-in table is
 * refreshed whenever the live-fetch path in `goat-pricing.ts` succeeds.
 */

export interface GoatModelRate {
  /** Display name as published on commandcode.ai. */
  readonly name: string
  /** Uncached input price, USD per 1M tokens. */
  readonly in: number
  /** Output price, USD per 1M tokens. */
  readonly out: number
  /** Cache-read price, USD per 1M tokens. */
  readonly cache: number
  /** Cache-write price, USD per 1M tokens, when the model charges it. */
  readonly cw?: number
  /** Peak-hour rates, present only for time-of-day-priced models. */
  readonly peak?: { readonly in: number; readonly out: number; readonly cache: number }
  /** Off-peak (default) rates, present only for time-of-day-priced models. */
  readonly off?: { readonly in: number; readonly out: number; readonly cache: number }
  /** Human-readable peak windows, e.g. "01–04 & 06–10 UTC". */
  readonly windows?: string
}

/** GOAT-plan model rates keyed by the Command Code provider model id. */
export const GOAT_MODEL_RATES: Readonly<Record<string, GoatModelRate>> = {
  'poolside/laguna-s-2.1-free': { name: 'Laguna S 2.1', in: 0, out: 0, cache: 0 },
  'minimax/minimax-m3-free': { name: 'MiniMax M3', in: 0, out: 0, cache: 0 },
  'minimax/minimax-m2.7-free': { name: 'MiniMax M2.7', in: 0, out: 0, cache: 0 },
  'tencent/hy4-preview': { name: 'Tencent Hy4 Preview', in: 0.834, out: 2.501, cache: 0.042 },
  'tencent/hy3-paid': { name: 'Tencent Hy3', in: 0.14, out: 0.58, cache: 0.035 },
  'moonshotai/Kimi-K3': { name: 'Kimi K3', in: 3, out: 15, cache: 0.3 },
  'moonshotai/Kimi-K2.7-Code': { name: 'Kimi K2.7 Code', in: 0.95, out: 4, cache: 0.19 },
  'moonshotai/Kimi-K2.7-Code-Highspeed': { name: 'Kimi K2.7 Code HighSpeed', in: 1.9, out: 8, cache: 0.38 },
  'moonshotai/Kimi-K2.6': { name: 'Kimi K2.6', in: 0.95, out: 4, cache: 0.16 },
  'moonshotai/Kimi-K2.5': { name: 'Kimi K2.5', in: 0.6, out: 3, cache: 0.1 },
  'z-ai/glm-5.3-flash': { name: 'GLM-5.3 Flash', in: 0.15, out: 0.5, cache: 0.03 },
  'zai-org/GLM-5.3': { name: 'GLM-5.3', in: 1.4, out: 4.4, cache: 0.26 },
  'zai-org/GLM-5.2': { name: 'GLM-5.2', in: 1.4, out: 4.4, cache: 0.26 },
  'zai-org/GLM-5.2-Fast': { name: 'GLM-5.2 Fast', in: 3, out: 10.25, cache: 0.5 },
  'zai-org/GLM-5.1': { name: 'GLM-5.1', in: 1.4, out: 4.4, cache: 0.26 },
  'zai-org/GLM-5': { name: 'GLM-5', in: 1, out: 3.2, cache: 0.2 },
  'MiniMaxAI/MiniMax-M3': { name: 'MiniMax M3', in: 0.3, out: 1.2, cache: 0.06 },
  'MiniMaxAI/MiniMax-M2.7': { name: 'MiniMax M2.7', in: 0.3, out: 1.2, cache: 0.06 },
  'MiniMaxAI/MiniMax-M2.5': { name: 'MiniMax M2.5', in: 0.3, out: 1.2, cache: 0.03 },
  'deepseek/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro (latest)', in: 0.66, out: 1.98, cache: 0.022,
    peak: { in: 1.32, out: 3.96, cache: 0.044 },
    off: { in: 0.66, out: 1.98, cache: 0.022 },
    windows: '01–04 & 06–10 UTC',
  },
  'deepseek/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash (latest)', in: 0.22, out: 0.66, cache: 0.007,
    peak: { in: 0.44, out: 1.32, cache: 0.014 },
    off: { in: 0.22, out: 0.66, cache: 0.007 },
    windows: '01–04 & 06–10 UTC',
  },
  'deepseek/deepseek-v4-flash-vision-exp': {
    name: 'DeepSeek V4 Flash Vision (exp)', in: 0.22, out: 0.66, cache: 0.007,
    peak: { in: 0.44, out: 1.32, cache: 0.014 },
    off: { in: 0.22, out: 0.66, cache: 0.007 },
    windows: '01–04 & 06–10 UTC',
  },
  'Qwen/Qwen3.8-Max': { name: 'Qwen 3.8 Max', in: 2, out: 6, cache: 0.25, cw: 2.5 },
  'Qwen/Qwen3.8-27B': { name: 'Qwen 3.8 27B', in: 0.4, out: 3, cache: 0.04 },
  'Qwen/Qwen3.6-Max-Preview': { name: 'Qwen 3.6 Max Preview', in: 1.3, out: 7.8, cache: 0.26, cw: 1.63 },
  'Qwen/Qwen3.6-Plus': { name: 'Qwen 3.6 Plus', in: 0.5, out: 3, cache: 0.1 },
  'Qwen/Qwen3.7-Max': { name: 'Qwen 3.7 Max', in: 2.5, out: 7.5, cache: 0.5, cw: 3.13 },
  'Qwen/Qwen3.7-Plus': { name: 'Qwen 3.7 Plus', in: 0.4, out: 1.6, cache: 0.08, cw: 0.5 },
  'Qwen/Qwen3.8-Flash': { name: 'Qwen 3.8 Flash', in: 0.16, out: 0.47, cache: 0.016 },
  'Qwen/Qwen3.7-Flash': { name: 'Qwen 3.7 Flash', in: 0.03, out: 0.13, cache: 0.006, cw: 0.038 },
  'stepfun/Step-3.7-Flash': { name: 'Step 3.7 Flash', in: 0.2, out: 1.15, cache: 0.04 },
  'stepfun/Step-3.5-Flash': { name: 'Step 3.5 Flash', in: 0.1, out: 0.3, cache: 0.02 },
  'xiaomi/mimo-v2.5-pro': { name: 'MiMo V2.5 Pro', in: 0.435, out: 0.87, cache: 0.0036 },
  'xiaomi/mimo-v2.5': { name: 'MiMo V2.5', in: 0.14, out: 0.28, cache: 0.0028 },
  'nvidia/nemotron-3-ultra-550b-a55b': { name: 'Nemotron 3 Ultra', in: 0.6, out: 2.4, cache: 0.12 },
  'gpt-5.6-sol': { name: 'GPT-5.6 Sol', in: 5, out: 30, cache: 0.5, cw: 6.25 },
  'gpt-5.6-luna': { name: 'GPT-5.6 Luna', in: 0.2, out: 1.2, cache: 0.02, cw: 0.25 },
  'google/gemini-3.7-flash': { name: 'Gemini 3.7 Flash', in: 1.5, out: 7.5, cache: 0.15, cw: 0.08334 },
  'meta/muse-spark-1.2': { name: 'Muse Spark 1.2', in: 1.25, out: 4.25, cache: 0.15 },
  'meta/muse-spark-1.2-contributor': { name: 'Muse Spark 1.2 Contributor', in: 0.1, out: 0.2, cache: 0.002 },
  'xai/grok-4.6': { name: 'Grok 4.6', in: 2, out: 6, cache: 0.5 },
  'xai/grok-4.5': { name: 'Grok 4.5', in: 2, out: 6, cache: 0.5 },
  'thinkingmachines/inkling': { name: 'Inkling', in: 1, out: 4.05, cache: 0.17 },
  'thinkingmachines/inkling-small': { name: 'Inkling Small', in: 0.5, out: 1.2, cache: 0.1 },
}
