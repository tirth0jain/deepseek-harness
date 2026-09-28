/**
 * External model-metadata enrichment from the public models.dev catalog.
 *
 * A model listing endpoint reports which ids it serves and, at best, their
 * capacities. It never reports prices, and a gateway that omits capacities
 * reports nothing but ids — `deepseek-v4-flash` from one such endpoint is the
 * whole row. Those withheld facts are exactly the ones a spend estimate and a
 * vision gate need, and no interrogation of the endpoint can recover them.
 *
 * models.dev is a public, community-maintained catalog that publishes them per
 * provider and model: accepted input modalities, context and output limits,
 * published rates, and the reasoning efforts a model offers. A route names it
 * with `enrichFrom` and the automatic refresh fills the facts its own listing
 * could not state.
 *
 * The catalog is a **third party**, and is treated as one: it is consulted only
 * to fill facts the deployment did not state, never to overwrite a stated one
 * (a deployment's own tariff and its own modality claims win), a fetch failure
 * is never fatal, and nothing here is consulted unless a route opts in. The
 * catalog document is large and changes slowly, so it is fetched at most once
 * per {@link MODELS_DEV_CACHE_TTL_MS} per process and shared by every route.
 *
 * @module dsh-llm-pi-ai/modelsdev
 */

import { MODALITIES, THINKING_LEVELS } from './catalog.ts'
import type { PiAiModelCost, PiAiModality, PiAiReasoningEfforts } from './catalog.ts'

/** The public catalog document; one JSON object keyed by provider id. */
export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json'

/**
 * How long one fetched catalog document is reused before it is fetched again.
 *
 * The document is several megabytes and its contents change on the order of
 * releases, not requests, while the refresh that reads it rides every web page
 * load. Six hours keeps a deployment current without re-downloading the whole
 * catalog for a page reload.
 */
export const MODELS_DEV_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Bound on the catalog document read. The published document is a few
 * megabytes; the bound exists so a wrong URL answering with something enormous
 * cannot be buffered into memory, not to fit the real document.
 */
export const MODELS_DEV_MAX_BYTES = 64 * 1024 * 1024

/** Request timeout for one catalog fetch. */
export const MODELS_DEV_TIMEOUT_MS = 30_000

/**
 * Facts one external catalog discloses about one model.
 *
 * Every field is optional and independently meaningful: the catalog describes
 * many models incompletely, and an absent field means "not disclosed", which
 * is never the same answer as a disclosed zero.
 */
export interface ModelsDevFacts {
  /** Human-readable model name. */
  readonly name?: string
  /** Maximum combined request and response context in tokens. */
  readonly contextWindow?: number
  /** Maximum output tokens. */
  readonly maxTokens?: number
  /** Accepted request modalities, already narrowed to the harness's set. */
  readonly input?: readonly PiAiModality[]
  /** Published list price, USD per million tokens. */
  readonly cost?: PiAiModelCost
  /** Reasoning efforts the model offers, in the harness's level vocabulary. */
  readonly reasoningEfforts?: PiAiReasoningEfforts
}

/**
 * One parsed catalog: facts keyed by provider id, then by model id.
 *
 * Keyed exactly as the document spells them. A route whose own key differs
 * from the catalog's provider id names the catalog's id in
 * `modelsDevProvider`; nothing here guesses at an alias.
 */
export type ModelsDevCatalog = ReadonlyMap<string, ReadonlyMap<string, ModelsDevFacts>>

/** One model's raw catalog row, as far as this module reads it. */
interface RawModel {
  name?: unknown
  limit?: { context?: unknown; output?: unknown }
  modalities?: { input?: unknown }
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown }
  reasoning_options?: unknown
}

/** One provider's raw catalog row. */
interface RawProvider {
  models?: unknown
}

/**
 * A finite, non-negative number, or `undefined` for anything else.
 *
 * Zero is kept: a free model's published rate is zero, which is a disclosure,
 * and must stay distinguishable from a catalog that says nothing.
 * @param value - the raw catalog value.
 * @returns the number when the value is a usable measurement.
 */
function measure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * One non-empty string, or `undefined`.
 * @param value - the raw catalog value.
 * @returns the string when it is a usable label.
 */
function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Accepted modalities from a catalog row, narrowed to the harness's own set.
 *
 * A catalog naming a modality this build cannot carry (a document or audio
 * input) contributes nothing rather than an unusable entry, and a row whose
 * inputs all fall outside the set yields no claim at all — absent, not empty,
 * because an empty list would read as "accepts nothing".
 * @param value - the raw `modalities.input` value.
 * @returns the recognized modalities, or `undefined` when none are recognized.
 */
function modalities(value: unknown): readonly PiAiModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const known = new Set<string>(MODALITIES)
  const kept = value.filter((entry): entry is PiAiModality => typeof entry === 'string' && known.has(entry))
  return kept.length === 0 ? undefined : kept
}

/**
 * Published rates from a catalog row.
 *
 * The catalog spells cache fields with underscores; the harness spells them in
 * camel case, and the rename happens here so no other layer knows both.
 * @param value - the raw `cost` value.
 * @returns the rates when the row discloses at least one.
 */
function cost(value: RawModel['cost']): PiAiModelCost | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const input = measure(value.input)
  const output = measure(value.output)
  const cacheRead = measure(value.cache_read)
  const cacheWrite = measure(value.cache_write)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined
  }
  return {
    ...input === undefined ? {} : { input },
    ...output === undefined ? {} : { output },
    ...cacheRead === undefined ? {} : { cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWrite },
  }
}

/**
 * Reasoning efforts from a catalog row's `reasoning_options`.
 *
 * The catalog states a `toggle` option when thinking can be turned off, and an
 * `effort` option listing the levels it accepts. The levels are already the
 * harness's own vocabulary, so each is carried across under its own name; an
 * unrecognized level is dropped rather than renamed into one it is not. A
 * `toggle` becomes `off: null` — "supported, send nothing" — which is how the
 * harness spells not-thinking.
 *
 * This is only reached for a route that opted in with `enrichReasoning`, since
 * declaring a model's efforts is otherwise the deployment's call.
 * @param value - the raw `reasoning_options` value.
 * @returns the efforts when the row discloses any, else `undefined`.
 */
function reasoningEfforts(value: unknown): PiAiReasoningEfforts | undefined {
  if (!Array.isArray(value)) return undefined
  const levels = new Set<string>(THINKING_LEVELS)
  const efforts: PiAiReasoningEfforts = {}
  let any = false
  for (const option of value) {
    if (option === null || typeof option !== 'object') continue
    const { type, values } = option as { type?: unknown; values?: unknown }
    if (type === 'toggle') {
      efforts.off = null
      any = true
      continue
    }
    if (type !== 'effort' || !Array.isArray(values)) continue
    for (const entry of values) {
      if (typeof entry !== 'string' || !levels.has(entry)) continue
      efforts[entry as keyof PiAiReasoningEfforts] = entry
      any = true
    }
  }
  return any ? efforts : undefined
}

/**
 * One catalog row's facts, or `undefined` when the row discloses nothing.
 * @param raw - the raw model row.
 * @param enrichReasoning - whether reasoning efforts are taken as well.
 * @returns the facts, or `undefined` when the row is empty.
 */
function factsOf(raw: RawModel, enrichReasoning: boolean): ModelsDevFacts | undefined {
  const name = label(raw.name)
  const contextWindow = measure(raw.limit?.context)
  const maxTokens = measure(raw.limit?.output)
  const input = modalities(raw.modalities?.input)
  const price = cost(raw.cost)
  const efforts = enrichReasoning ? reasoningEfforts(raw.reasoning_options) : undefined
  if (name === undefined && contextWindow === undefined && maxTokens === undefined
    && input === undefined && price === undefined && efforts === undefined) {
    return undefined
  }
  return {
    ...name === undefined ? {} : { name },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { input },
    ...price === undefined ? {} : { cost: price },
    ...efforts === undefined ? {} : { reasoningEfforts: efforts },
  }
}

/**
 * Parse a fetched catalog document.
 *
 * A document that is not the expected shape yields an empty catalog rather
 * than throwing: this is a third-party document consumed on a page load, and
 * a reshaped or truncated reply must leave the stored configuration alone, not
 * fail the refresh that read it. Rows disclosing nothing are omitted.
 * @param body - the parsed JSON document.
 * @param options - whether reasoning efforts are taken.
 * @returns facts keyed by provider id, then model id.
 */
export function parseModelsDevCatalog(
  body: unknown,
  options: { enrichReasoning?: boolean } = {},
): ModelsDevCatalog {
  const enrichReasoning = options.enrichReasoning === true
  const catalog = new Map<string, ReadonlyMap<string, ModelsDevFacts>>()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return catalog
  for (const [providerId, rawProvider] of Object.entries(body as Record<string, RawProvider>)) {
    const models = rawProvider?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    const rows = new Map<string, ModelsDevFacts>()
    for (const [modelId, rawModel] of Object.entries(models as Record<string, RawModel>)) {
      if (rawModel === null || typeof rawModel !== 'object' || Array.isArray(rawModel)) continue
      const facts = factsOf(rawModel, enrichReasoning)
      if (facts !== undefined) rows.set(modelId, facts)
    }
    if (rows.size > 0) catalog.set(providerId, rows)
  }
  return catalog
}

/**
 * Read a response body under a byte bound.
 * @param response - the response to read.
 * @returns the decoded text.
 * @throws Error when the body exceeds the bound or cannot be read.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MODELS_DEV_MAX_BYTES) {
    throw new Error(`catalog document declares ${String(declared)} bytes, over the ${String(MODELS_DEV_MAX_BYTES)} bound`)
  }
  const body = response.body
  if (body === null) return await response.text()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MODELS_DEV_MAX_BYTES) {
        throw new Error(`catalog document exceeded the ${String(MODELS_DEV_MAX_BYTES)} byte bound`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** One cached catalog and the instant it was fetched. */
let cache: { at: number; catalog: ModelsDevCatalog } | undefined

/** The in-flight fetch, so concurrent routes share one request. */
let inFlight: Promise<ModelsDevCatalog | undefined> | undefined

/**
 * Fetch and parse the catalog, reusing the cached document while it is fresh.
 *
 * Failures are contained and reported as `undefined`: enrichment is an
 * optional improvement to a refresh that must still complete, so an
 * unreachable or reshaped catalog leaves the stored configuration untouched
 * instead of failing the page load that triggered it. A failed fetch is not
 * cached, so the next page load tries again rather than serving the failure
 * for the whole TTL.
 * @param options - whether reasoning efforts are taken, and cancellation.
 * @returns the catalog, or `undefined` when it could not be read.
 */
export async function loadModelsDevCatalog(
  options: { enrichReasoning?: boolean; signal?: AbortSignal; now?: number } = {},
): Promise<ModelsDevCatalog | undefined> {
  const now = options.now ?? Date.now()
  if (cache !== undefined && now - cache.at < MODELS_DEV_CACHE_TTL_MS) return cache.catalog
  inFlight ??= (async () => {
    try {
      const timeout = AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS)
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
      const response = await fetch(MODELS_DEV_CATALOG_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) return undefined
      const catalog = parseModelsDevCatalog(JSON.parse(await readBounded(response)), options)
      cache = { at: now, catalog }
      return catalog
    } catch {
      return undefined
    } finally {
      inFlight = undefined
    }
  })()
  return await inFlight
}

/**
 * Drop the cached catalog, so the next load fetches it again.
 *
 * Exported for tests and for a deployment that wants a forced re-read; the
 * automatic path never needs it.
 */
export function resetModelsDevCache(): void {
  cache = undefined
}
