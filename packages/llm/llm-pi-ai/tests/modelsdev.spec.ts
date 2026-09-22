import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadModelsDevCatalog,
  MODELS_DEV_CACHE_TTL_MS,
  parseModelsDevCatalog,
  resetModelsDevCache,
} from '../src/modelsdev.ts'

afterEach(() => {
  resetModelsDevCache()
  vi.unstubAllGlobals()
})

/**
 * One provider's catalog document in the published shape, carrying a single
 * row copied from the real `opencode-go` document for `deepseek-v4.1-flash`.
 */
function document(models: Record<string, unknown>): unknown {
  return { 'opencode-go': { id: 'opencode-go', name: 'OpenCode Go', models } }
}

describe('parseModelsDevCatalog', () => {
  it('reads the capacities, modalities and rates a gateway cannot state', () => {
    const catalog = parseModelsDevCatalog(document({
      'deepseek-v4.1-flash': {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 384000 },
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
    }))
    expect(catalog.get('opencode-go')?.get('deepseek-v4.1-flash')).toEqual({
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['text', 'image'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
    })
  })

  it('narrows modalities to the ones this build can carry, and claims none when none survive', () => {
    const catalog = parseModelsDevCatalog(document({
      mixed: { modalities: { input: ['text', 'pdf', 'audio'] } },
      alien: { modalities: { input: ['pdf', 'audio'] } },
      malformed: { modalities: { input: 'text' } },
    }))
    const rows = catalog.get('opencode-go')
    expect(rows?.get('mixed')?.input).toEqual(['text'])
    // Nothing recognized is "no claim", never an empty list that would read
    // as a model accepting nothing.
    expect(rows?.get('alien')).toBeUndefined()
    expect(rows?.get('malformed')).toBeUndefined()
  })

  it('keeps a published zero, which is a disclosure, apart from an absent one', () => {
    const catalog = parseModelsDevCatalog(document({
      free: { cost: { input: 0, output: 0 } },
      unpriced: { cost: { input: 'free' } },
    }))
    const rows = catalog.get('opencode-go')
    expect(rows?.get('free')?.cost).toEqual({ input: 0, output: 0 })
    expect(rows?.get('unpriced')).toBeUndefined()
  })

  it('takes reasoning efforts only when asked, mapping toggle to off and levels by name', () => {
    const row = {
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max', 'ludicrous'] },
      ],
    }
    expect(parseModelsDevCatalog(document({ m: row })).get('opencode-go')?.get('m')?.reasoningEfforts)
      .toBeUndefined()
    expect(parseModelsDevCatalog(document({ m: row }), { enrichReasoning: true })
      .get('opencode-go')?.get('m')?.reasoningEfforts)
      // The unrecognized level is dropped rather than renamed into one it is not.
      .toEqual({ off: null, low: 'low', high: 'high', max: 'max' })
  })

  it('yields an empty catalog rather than throwing on a reshaped document', () => {
    for (const body of [null, 42, 'nope', [], { p: { models: [] } }, { p: { models: null } }]) {
      expect(parseModelsDevCatalog(body).size).toBe(0)
    }
  })

  it('omits a row that discloses nothing', () => {
    const catalog = parseModelsDevCatalog(document({ bare: { id: 'bare' }, named: { name: 'Named' } }))
    const rows = catalog.get('opencode-go')
    expect(rows?.has('bare')).toBe(false)
    expect(rows?.get('named')).toEqual({ name: 'Named' })
  })
})

describe('loadModelsDevCatalog', () => {
  it('fetches once and reuses the document inside the TTL', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(document({ m: { limit: { context: 10 } } })),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const first = await loadModelsDevCatalog()
    const second = await loadModelsDevCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first?.get('opencode-go')?.get('m')?.contextWindow).toBe(10)
    expect(second).toBe(first)
  })

  it('refetches once the TTL has elapsed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(document({ m: {} })),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const at = 1_000_000
    await loadModelsDevCatalog({ now: at })
    await loadModelsDevCatalog({ now: at + MODELS_DEV_CACHE_TTL_MS - 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await loadModelsDevCatalog({ now: at + MODELS_DEV_CACHE_TTL_MS })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('contains a failure as undefined and does not cache it', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadModelsDevCatalog()).toBeUndefined()
    expect(await loadModelsDevCatalog()).toBeUndefined()
    // A failure is never cached, so the next load tries again rather than
    // serving the failure for the whole TTL.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a non-OK response as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    expect(await loadModelsDevCatalog()).toBeUndefined()
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(document({ m: {} })),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([loadModelsDevCatalog(), loadModelsDevCatalog()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })
})
