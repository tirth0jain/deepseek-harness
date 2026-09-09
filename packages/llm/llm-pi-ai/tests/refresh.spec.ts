import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeListedIntoConfigured, refreshProviderCatalog } from '../src/refresh.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

/** A stand-in provider answering one `GET /models` listing. */
async function listingServer(body: string): Promise<{ url: string; paths: string[]; headers: IncomingMessage['headers'][] }> {
  const paths: string[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push(request.headers)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers }
}

describe('mergeListedIntoConfigured', () => {
  it('keeps stored entries and appends listing additions with disclosed fields only', () => {
    const stored = [
      { id: 'old', name: 'Old Model', contextWindow: 100, maxTokens: 50, reasoningEfforts: { off: null, high: 'high' } as const },
      { id: 'stale', contextWindow: 9 },
    ]
    const listed = [
      { id: 'old', name: 'Old Model (renamed by gateway)', contextWindow: 200 },
      { id: 'fresh', name: 'Fresh Model', contextWindow: 300, maxTokens: 400 },
      { id: 'bare' },
    ]
    const merged = mergeListedIntoConfigured(stored, listed)
    // Stored order first; the listing only replaced the disclosed capacity,
    // never renamed the stored entry, and never touched its curated efforts.
    // 'stale' is retired and dropped. Additions carry ONLY disclosed fields —
    // no reasoning efforts are invented onto them.
    expect(merged).toEqual([
      { id: 'old', name: 'Old Model', contextWindow: 200, maxTokens: 50,
        reasoningEfforts: { off: null, high: 'high' } },
      // Listing order for additions; the listing's name and both disclosed
      // capacities, nothing more.
      { id: 'fresh', name: 'Fresh Model', contextWindow: 300, maxTokens: 400 },
      { id: 'bare' },
    ])
  })

  it('drops every stored model the listing no longer serves', () => {
    const current = [
      { id: 'a', contextWindow: 10 },
      { id: 'b', contextWindow: 20 },
      { id: 'c', contextWindow: 30 },
    ]
    expect(mergeListedIntoConfigured(current, [{ id: 'b' }])).toEqual([{ id: 'b', contextWindow: 20 }])
    expect(mergeListedIntoConfigured(current, [])).toEqual([])
  })

  it('adds no reasoningEfforts onto additions', () => {
    const merged = mergeListedIntoConfigured([], [{ id: 'a', name: 'A' }])
    expect(merged).toEqual([{ id: 'a', name: 'A' }])
  })

  it('stores nothing that the listing did not disclose onto an id-only addition', () => {
    const merged = mergeListedIntoConfigured([], [{ id: 'bare' }])
    expect(merged).toEqual([{ id: 'bare' }])
  })
})

describe('refreshProviderCatalog', () => {
  it('interrogates the endpoint, stores the merged catalog once, and reports the change', async () => {
    const server = await listingServer(JSON.stringify({
      data: [
        { id: 'acme-large', name: 'Acme Large', context_length: 65_536 },
        { id: 'acme-small' },
      ],
    }))
    const persist = vi.fn(async () => {})
    const request = {
      provider: 'acme-gateway',
      baseURL: server.url,
      currentModels: [],
      persist,
    }
    const first = await refreshProviderCatalog(request)
    expect(first.changed).toBe(true)
    expect(first.added).toEqual(['acme-large', 'acme-small'])
    expect(first.updated).toEqual([])
    expect(first.models).toEqual([
      { id: 'acme-large', name: 'Acme Large', contextWindow: 65_536 },
      { id: 'acme-small' },
    ])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith(first.models)

    // The same stored list against the same listing is a no-op: the endpoint
    // is consulted again (a refresh re-checks), but nothing is stored twice.
    const second = await refreshProviderCatalog({ ...request, currentModels: [...first.models] })
    expect(second.changed).toBe(false)
    expect(second.added).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.kept).toEqual(['acme-large', 'acme-small'])
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('replaces only fields the listing discloses and reports the updated ids', async () => {
    const server = await listingServer(JSON.stringify({
      data: [{ id: 'acme-large', name: 'Fresh Gateway Name', context_length: 1_048_576, max_output_tokens: 384_000 }],
    }))
    const stored = [{
      id: 'acme-large',
      name: 'Acme Large (curated)',
      contextWindow: 65_536,
      maxTokens: 32_768,
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } as const,
    }]
    const persist = vi.fn(async () => {})
    const outcome = await refreshProviderCatalog({
      provider: 'acme-gateway',
      baseURL: server.url,
      currentModels: stored,
      persist,
    })
    expect(outcome.changed).toBe(true)
    expect(outcome.updated).toEqual(['acme-large'])
    expect(outcome.models).toEqual([{
      id: 'acme-large',
      name: 'Acme Large (curated)',
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
    }])
  })

  it('sends the stored route credential and headers on the listing request', async () => {
    const server = await listingServer(JSON.stringify({ data: [{ id: 'a' }] }))
    const outcome = await refreshProviderCatalog({
      provider: 'acme-gateway',
      baseURL: server.url,
      currentModels: [],
      storedProfile: () => ({
        headers: { 'x-route-token': 'route-header' },
        resolveApiKey: async () => 'stored-key',
      }),
      persist: async () => {},
    })
    expect(outcome.changed).toBe(true)
    expect(server.paths).toEqual(['/models'])
    expect(server.headers[0]?.authorization).toBe('Bearer stored-key')
    expect(server.headers[0]?.['x-route-token']).toBe('route-header')
  })

  it('interrogates the endpoint even for a route the installed catalog describes', async () => {
    // 'opencode-go' is an installed pi-ai catalog route: draft discovery
    // answers it from the catalog without a network call. A catalog refresh
    // must read the endpoint's own listing instead — the catalog's rows are
    // neither the endpoint's truth nor a superset of it — so the stored list
    // below is the endpoint's, not pi-ai's.
    const server = await listingServer(JSON.stringify({ data: [{ id: 'endpoint-only' }] }))
    const persist = vi.fn(async () => {})
    const outcome = await refreshProviderCatalog({
      provider: 'opencode-go',
      baseURL: server.url,
      currentModels: [],
      persist,
    })
    expect(outcome.models).toEqual([{ id: 'endpoint-only' }])
    expect(persist).toHaveBeenCalledWith([{ id: 'endpoint-only' }])
    expect(server.paths).toEqual(['/models'])
  })

  it('keeps stored reasoning efforts and adds none to new models', async () => {
    const server = await listingServer(JSON.stringify({ data: [{ id: 'new' }, { id: 'old' }] }))
    const stored = [{ id: 'old', reasoningEfforts: { off: null, high: 'ultra' } as const }]
    const outcome = await refreshProviderCatalog({
      provider: 'acme-gateway',
      baseURL: server.url,
      currentModels: stored,
      persist: async () => {},
    })
    expect(outcome.models).toEqual([
      { id: 'old', reasoningEfforts: { off: null, high: 'ultra' } },
      // The refresh never invents efforts for a model the endpoint only lists.
      { id: 'new' },
    ])
  })

  it('reports and persists models the gateway retired', async () => {
    const server = await listingServer(JSON.stringify({ data: [{ id: 'live' }] }))
    const persist = vi.fn(async () => {})
    const outcome = await refreshProviderCatalog({
      provider: 'acme-gateway',
      baseURL: server.url,
      currentModels: [{ id: 'live' }, { id: 'retired', contextWindow: 5 }],
      persist,
    })
    expect(outcome.changed).toBe(true)
    expect(outcome.removed).toEqual(['retired'])
    expect(outcome.kept).toEqual(['live'])
    expect(outcome.models).toEqual([{ id: 'live' }])
    expect(persist).toHaveBeenCalledWith([{ id: 'live' }])
  })

  it('refuses an empty listing and leaves the stored catalog untouched', async () => {
    const server = await listingServer(JSON.stringify({ data: [] }))
    const persist = vi.fn(async () => {})
    const stored = [{ id: 'keep-me', contextWindow: 5 }]
    const outcome = await refreshProviderCatalog({
      provider: 'acme-gateway',
      baseURL: server.url,
      currentModels: stored,
      persist,
    })
    expect(outcome.empty).toBe(true)
    expect(outcome.changed).toBe(false)
    expect(outcome.removed).toEqual([])
    expect(outcome.models).toEqual(stored)
    expect(persist).not.toHaveBeenCalled()
  })
})
