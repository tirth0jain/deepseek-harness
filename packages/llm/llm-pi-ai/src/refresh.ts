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
 * The endpoint is the only truth consulted — never the installed pi-ai
 * catalog. The stored list is replaced only when the merge actually changed
 * it, so an unchanged listing costs one endpoint read and no settings write.
 *
 * @module dsh-llm-pi-ai/refresh
 */

import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import type { PiAiModelProfile } from './config.ts'

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
 * Merge one endpoint listing into the route's stored model list.
 *
 * Stored entries keep their order and every field the deployment wrote; the
 * listing can only replace a stored capacity with one it discloses. A stored
 * model the listing no longer serves is dropped — retirement is the
 * gateway's call, and the listing is the only truth consulted. New models
 * are appended in listing order with exactly the fields the listing
 * discloses; reasoning efforts are never invented onto them, since no
 * listing endpoint reports per-model efforts. The result is the exact list a
 * refresh stores — nothing else reshapes it, so equality between the result
 * and the stored list is what makes a refresh a no-op.
 * @param current - the route's stored model entries, in stored order.
 * @param listed - the endpoint's current listing, in endpoint order.
 * @returns the merged list, stored shape (no resolved defaults added).
 */
export function mergeListedIntoConfigured(
  current: readonly PiAiModelProfile[],
  listed: readonly LlmDiscoveredModel[],
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
  const models = mergeListedIntoConfigured(request.currentModels, listed)
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
