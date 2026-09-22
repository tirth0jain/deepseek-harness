/**
 * Automatic model-catalog refresh for `llm-pi-ai` provider routes.
 *
 * A route with `autoRefresh` re-interrogates its own endpoint's model
 * listing — the same `GET {baseURL}/models` interrogation the configuration
 * surface's "fetch available models" action uses, with the same bounded read
 * and the same field spellings — and merges what the listing discloses into
 * the route's stored `models` list. The merge rules:
 *
 * - An already-listed model keeps every field the deployment wrote. A
 *   capacity the listing now discloses replaces the stored one; a capacity
 *   it does not disclose leaves the stored one alone.
 * - A model the listing no longer serves is **dropped from the stored
 *   list**: retirement is the gateway's call, and a refresh never
 *   resurrects a retired model. Only a listing that was actually read
 *   counts — an empty successful listing is refused as ambiguous rather
 *   than trusted, so a transient gateway hiccup cannot erase the stored
 *   catalog.
 * - A model the listing adds gets exactly the fields the listing discloses
 *   (id, display name, capacities) and nothing else — reasoning efforts are
 *   never auto-added, because no listing endpoint reports them; declare them
 *   per model on the Models page for the models that need them. A listing
 *   entry with an id alone stays an id alone, and resolution fills its
 *   remaining facts from the route's `defaultContextWindow`,
 *   `defaultMaxTokens`, and `defaultInput`.
 *
 * A route may additionally opt into an external metadata source, which fills
 * the facts a listing endpoint structurally cannot state — accepted
 * modalities, published rates, and (only when asked) reasoning efforts. That
 * source is a third party and is treated as a *fallback*, not an authority: it
 * fills a field the deployment left unstated and never overwrites one it
 * stated, so a deployment's own tariff or its narrowed modality claim survives
 * every refresh. Listing-disclosed capacities still win over a stored value,
 * as above; the external source never displaces either.
 *
 * The endpoint is the only truth about *membership* — never the installed
 * pi-ai catalog, and never the external source, which lists models this
 * gateway may not serve. The stored list is replaced only when the merge
 * actually changed it, so an unchanged listing costs one endpoint read and no
 * settings write.
 *
 * @module dsh-llm-pi-ai/refresh
 */

import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import type { PiAiModelProfile } from './config.ts'
import type { ModelsDevFacts } from './modelsdev.ts'

/**
 * Minimum interval between two automatic refreshes of the same route.
 *
 * Web page loads burst (a reload, then the SPA's own boot requests); the
 * listing is the same seconds apart, so refresh coalesces behind this gate
 * rather than re-interrogating the endpoint for every request in the burst.
 * Each site's page still refreshes the catalog at most this often; a reload
 * inside the interval is a no-op, and the route's next listed request is
 * re-interrogated from its own last start.
 */
export const AUTO_REFRESH_MIN_INTERVAL_MS = 30_000

/**
 * Fill the facts one stored entry left unstated from an external catalog.
 *
 * A stated field is never touched. The deployment's own tariff, its narrowed
 * modality claim, and the efforts it chose are intent, and a third-party
 * catalog disagreeing with intent does not win — which is also why this is
 * separate from the listing's capacity rule, where the endpoint describing
 * itself is authoritative. Capacities are filled here only because the listing
 * did not disclose them, which for a gateway that reports ids alone is the
 * whole point. The display name is included for the same reason: an entry
 * that names nothing shows its id, and the catalog's label is an improvement
 * that no stated field loses to.
 * @param target - the entry being built, mutated in place.
 * @param facts - what the external catalog discloses for this model id.
 */
function fillUnstated(target: PiAiModelProfile, facts: ModelsDevFacts): void {
  if (target.name === undefined && facts.name !== undefined) target.name = facts.name
  if (target.input === undefined && facts.input !== undefined) target.input = [...facts.input]
  if (target.cost === undefined && facts.cost !== undefined) target.cost = facts.cost
  if (target.reasoningEfforts === undefined && facts.reasoningEfforts !== undefined) {
    target.reasoningEfforts = facts.reasoningEfforts
  }
  if (target.contextWindow === undefined && facts.contextWindow !== undefined) {
    target.contextWindow = facts.contextWindow
  }
  if (target.maxTokens === undefined && facts.maxTokens !== undefined) target.maxTokens = facts.maxTokens
}

/**
 * Merge one endpoint listing into the route's stored model list.
 *
 * Stored entries keep their order and every field the deployment wrote; the
 * listing can only replace a stored capacity with one it discloses. A stored
 * model the listing no longer serves is dropped — retirement is the
 * gateway's call, and the listing is the only truth about membership. New
 * models are appended in listing order with exactly the fields the listing
 * discloses; reasoning efforts are never invented onto them, since no
 * listing endpoint reports per-model efforts. The result is the exact list a
 * refresh stores — nothing else reshapes it, so equality between the result
 * and the stored list is what makes a refresh a no-op.
 *
 * An `enrichment` map adds the facts the listing structurally cannot state,
 * under the fill-only-when-unstated rule: the listing's own disclosures and
 * every stored field outrank it.
 * @param current - the route's stored model entries, in stored order.
 * @param listed - the endpoint's current listing, in endpoint order.
 * @param enrichment - facts an external catalog discloses, keyed by model id.
 * @returns the merged list, stored shape (no resolved defaults added).
 */
export function mergeListedIntoConfigured(
  current: readonly PiAiModelProfile[],
  listed: readonly LlmDiscoveredModel[],
  enrichment?: ReadonlyMap<string, ModelsDevFacts>,
): PiAiModelProfile[] {
  const listedById = new Map(listed.map(model => [model.id, model]))
  const merged: PiAiModelProfile[] = []
  const mergedIds = new Set<string>()
  // Stored order first, so a merge that changes nothing but capacities keeps
  // the file stable and a merge that adds models puts them after what the
  // deployment already curated.
  for (const entry of current) {
    // A stored model the listing no longer carries is retired; only the
    // listing's own ids survive the merge.
    const disclosed = listedById.get(entry.id)
    if (disclosed === undefined) continue
    const next: PiAiModelProfile = { ...entry }
    if (disclosed.contextWindow !== undefined && disclosed.contextWindow !== entry.contextWindow) {
      next.contextWindow = disclosed.contextWindow
    }
    if (disclosed.maxTokens !== undefined && disclosed.maxTokens !== entry.maxTokens) {
      next.maxTokens = disclosed.maxTokens
    }
    // The listing's own modality disclosure fills a stored entry that states
    // none. It is applied before the external catalog so a fact the endpoint
    // itself disclosed is never sourced from a third party.
    if (next.input === undefined && disclosed.inputModalities !== undefined && disclosed.inputModalities.length > 0) {
      next.input = [...disclosed.inputModalities]
    }
    const facts = enrichment?.get(entry.id)
    if (facts !== undefined) fillUnstated(next, facts)
    merged.push(next)
    mergedIds.add(entry.id)
  }
  // The listing's own order for what it adds. The stored entry wins naming
  // for a model that already exists, so a display-name change on an existing
  // id is kept as the deployment wrote it.
  for (const model of listed) {
    if (mergedIds.has(model.id)) continue
    const entry: PiAiModelProfile = { id: model.id }
    if (model.name !== undefined && model.name !== model.id) entry.name = model.name
    if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
    if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens
    if (model.inputModalities !== undefined && model.inputModalities.length > 0) {
      entry.input = [...model.inputModalities]
    }
    const facts = enrichment?.get(model.id)
    if (facts !== undefined) {
      // A listing entry that is an id alone names nothing, so the catalog's
      // label is used; a listing that named the model keeps its own.
      fillUnstated(entry, facts)
    }
    merged.push(entry)
    mergedIds.add(model.id)
  }
  return merged
}

/** One automatic refresh of one provider route. */
export interface ProviderCatalogRefreshRequest {
  /** Provider route key, for diagnostics. */
  provider: string
  /** Wire protocol; absent asks the listing as OpenAI Chat Completions, like discovery. */
  api?: string
  /** Endpoint whose model listing is interrogated. */
  baseURL: string
  /** The route's currently stored model entries. */
  currentModels: readonly PiAiModelProfile[]
  /** Host-owned headers and credential resolution, when the route has any. */
  storedProfile?: () => StoredModelDiscoveryProfile | undefined
  /**
   * Facts an external catalog discloses for this route, keyed by model id.
   *
   * Absent when the route did not opt in or the catalog could not be read, so
   * a refresh never depends on it. The endpoint remains the only source of
   * membership either way: a model the catalog lists but the endpoint does not
   * serve is never added.
   */
  enrichment?: ReadonlyMap<string, ModelsDevFacts>
  /** Store the merged list; called exactly when the merge changed it. */
  persist: (models: readonly PiAiModelProfile[]) => Promise<void>
}

/** What one automatic refresh did. */
export interface ProviderCatalogRefreshOutcome {
  /** Whether the stored list changed (and `persist` was called). */
  changed: boolean
  /**
   * Whether the endpoint answered with an empty listing, which is refused as
   * ambiguous: nothing was merged, nothing was stored, and the stored list
   * survives unchanged. A gateway that retired every model is indistinguishable
   * from one that failed to enumerate, so only the caller decides what "no
   * models at all" means for its route.
   */
  empty: boolean
  /** Model ids the listing added to the stored list. */
  added: readonly string[]
  /** Model ids whose stored fields the listing's disclosures replaced. */
  updated: readonly string[]
  /** Model ids the listing no longer serves and the merge therefore dropped. */
  removed: readonly string[]
  /** Model ids present before and after, unchanged. */
  kept: readonly string[]
  /** The merged list, whether or not it was stored. */
  models: readonly PiAiModelProfile[]
}

/**
 * Refresh one provider route's stored catalog from its endpoint.
 *
 * Interrogates the endpoint exactly like discovery, merges the listing into
 * the currently stored entries, and stores the result only when it changed.
 * An empty listing is refused before the merge — retirement of *every* model
 * is indistinguishable from a gateway failure to enumerate, so the stored
 * list survives unchanged and the outcome reports `empty`. Nothing here is
 * throttled or scheduled — the caller decides when a refresh is due — and
 * every failure is thrown for the caller to contain, so a refresh can never
 * take a page load down with it.
 * @param request - route facts, stored list, and the persist call.
 * @returns what the refresh did.
 */
export async function refreshProviderCatalog(
  request: ProviderCatalogRefreshRequest,
): Promise<ProviderCatalogRefreshOutcome> {
  // The provider key is deliberately NOT forwarded: discovery answers a named
  // provider from the installed pi-ai catalog when it ships one, and a refresh
  // must read the endpoint's own listing — the catalog's rows are neither the
  // endpoint's truth nor a superset of it. The route's stored credential and
  // headers still reach the request through the stored profile, which is
  // keyed by the route independent of the discovery request.
  const listed = await discoverModels(
    { baseURL: request.baseURL, ...request.api === undefined ? {} : { api: request.api } },
    request.storedProfile,
  )
  if (listed.length === 0) {
    return {
      changed: false,
      empty: true,
      added: [],
      updated: [],
      removed: [],
      kept: request.currentModels.map(model => model.id),
      models: [...request.currentModels],
    }
  }
  const models = mergeListedIntoConfigured(request.currentModels, listed, request.enrichment)
  const currentById = new Map(request.currentModels.map(model => [model.id, model]))
  const mergedIds = new Set(models.map(model => model.id))
  const added: string[] = []
  const updated: string[] = []
  const removed: string[] = []
  const kept: string[] = []
  for (const model of models) {
    const before = currentById.get(model.id)
    if (before === undefined) {
      added.push(model.id)
    } else if (deepEqualJson(before, model)) {
      kept.push(model.id)
    } else {
      updated.push(model.id)
    }
  }
  for (const stored of request.currentModels) {
    if (!mergedIds.has(stored.id)) removed.push(stored.id)
  }
  // A refreshed route that lost nothing still re-checks its listing; an
  // unchanged result is exactly what makes the write a no-op.
  const changed = !deepEqualJson(models, request.currentModels)
  if (changed) await request.persist(models)
  return { changed, empty: false, added, updated, removed, kept, models }
}
