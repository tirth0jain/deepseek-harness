/**
 * `BrightDataSearchProvider`: a `WebSearchProvider` backed by the Bright Data
 * Web Unlocker API (`POST /request`). One search spends one credit from the
 * free shared pool (5,000 requests/month across Web Unlocker, SERP API, Web
 * Scraper, Scraper Studio, and MCP). The provider fetches the DuckDuckGo HTML
 * result page through the unlocker zone and parses organic results locally.
 * @module @deepseek-ai/dsh-web-search-brightdata/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { BrightDataError, BrightDataUnlockerRequest, ParsedSearchHit } from './types.ts'

/** Stable id this provider registers under. */
export const BRIGHTDATA_PROVIDER_ID = 'brightdata'

/** Default Bright Data API endpoint; `/request` is the operation. */
export const BRIGHTDATA_DEFAULT_BASE_URL = 'https://api.brightdata.com'

/** Default zone. The free MCP provisioning creates `mcp_unlocker`. */
export const BRIGHTDATA_DEFAULT_ZONE = 'mcp_unlocker'

/** Search-engine result page fetched through the unlocker zone. */
export const BRIGHTDATA_SEARCH_URL = 'https://html.duckduckgo.com/html/'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface BrightDataSearchProviderOptions {
  /** Literal Bright Data API token; prefer {@link resolveApiKey} so no secret enters configuration files. */
  apiKey?: string
  /** Async credential resolution run per search; a literal {@link apiKey} wins over it. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Endpoint base; `/request` is appended. */
  baseURL: string
  /** Bright Data zone name sent as the request's `zone`. */
  zone: string
}

/**
 * Decode the HTML entities DuckDuckGo pages use. Numeric and hex character
 * references decode too; unknown named entities are left verbatim rather than
 * guessed (a wrong guess would fabricate snippet text).
 * @param text - Raw HTML fragment whose entities are decoded.
 * @returns The fragment with known entities replaced and unknown ones left as written.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, named: string) => NAMED_ENTITIES[named] ?? _match)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function safeFromCodePoint(codePoint: number): string {
  // Lone surrogates and out-of-range values must not throw (String.fromCodePoint
  // throws on them); the raw match stays in the text instead, which is honest.
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : `&#${codePoint};`
}

/** Strip markup tags and collapse the whitespace they leave behind. */
function stripTags(html: string): string {
  const text = html.replace(/<[^>]*>/g, ' ')
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
}

/**
 * Resolve one DuckDuckGo redirect href (`//duckduckgo.com/l/?uddg=<encoded>`)
 * to its destination. Non-redirect absolute http(s) hrefs pass through; any
 * other form returns `undefined` (relative or unsupported link).
 * @param href - One anchor's raw `href` attribute value.
 * @returns The absolute http(s) destination, or `undefined` when the link cannot be resolved.
 */
export function unwrapDdgUrl(href: string): string | undefined {
  let candidate = href.trim()
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  if (!URL.canParse(candidate)) return undefined
  const url = new URL(candidate)
  if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
    const target = url.searchParams.get('uddg')
    if (target === null || target.length === 0) return undefined
    // `uddg` is a full URL, URL-encoded once. Accept only http(s).
    return /^https?:\/\//i.test(target) ? target : undefined
  }
  return /^https?:$/i.test(url.protocol) ? url.href : undefined
}

/** Anchor-tag matcher over one page; capture 1 is attributes, capture 2 is inner HTML. */
const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/g

/** True when an anchor's attribute string carries the given DuckDuckGo result class. */
function hasClass(attributes: string, className: string): boolean {
  return new RegExp(`class="[^"]*\\b${className}\\b`).test(attributes)
}

/**
 * Parse the organic results of one DuckDuckGo HTML page. Each `result__a`
 * anchor opens one result; the first `result__snippet` anchor after it and
 * before the next `result__a` supplies that result's snippet. Results without
 * a resolvable destination URL are dropped — a source must carry a URL.
 *
 * @param html - the page body the unlocker returned.
 * @returns the parsed hits in page order.
 */
export function parseDuckDuckGo(html: string): readonly ParsedSearchHit[] {
  const anchors = [...html.matchAll(ANCHOR_PATTERN)]
  const results = anchors.filter(anchor => hasClass(anchor[1] ?? '', 'result__a'))
  const hits: ParsedSearchHit[] = []
  for (const [index, anchor] of results.entries()) {
    const href = /href="([^"]*)"/.exec(anchor[1] ?? '')?.[1]
    if (href === undefined) continue
    const url = unwrapDdgUrl(href)
    if (url === undefined) continue
    const title = stripTags(anchor[2] ?? '')
    if (title.length === 0) continue
    const nextIndex = index + 1 < results.length
      ? (results[index + 1]?.index ?? html.length)
      : html.length
    const segment = html.slice((anchor.index ?? 0) + anchor[0].length, nextIndex)
    const snippetMatch = ANCHOR_SEGMENT_SNIPPET_PATTERN.exec(segment)
    const snippet = snippetMatch === null ? undefined : stripTags(snippetMatch[1] ?? '')
    hits.push({ url, title, ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}) })
  }
  return hits
}

/** Snippet matcher scoped to one result's segment. */
const ANCHOR_SEGMENT_SNIPPET_PATTERN = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^>]*>([\s\S]*?)<\/a>/

/**
 * Map parsed hits to normalized sources. The web service owns the final
 * `maxResults` truncation, so this provider reports `truncated: false`.
 * @param hits - Parsed result anchors in page order.
 * @returns The portable search result, carrying only the fields a hit supplied.
 */
export function mapParsedHits(hits: readonly ParsedSearchHit[]): WebSearchResult {
  const sources: WebSearchSource[] = hits.map(hit => ({
    url: hit.url,
    title: hit.title,
    ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}),
  }))
  // The DuckDuckGo page returns no generated answer, so `content` is omitted.
  return { sources, truncated: false }
}

/** The Bright Data-backed search provider; non-2xx unlocker responses fail as `WEB_PROVIDER_ERROR`. */
export class BrightDataSearchProvider implements WebSearchProvider {
  readonly id = BRIGHTDATA_PROVIDER_ID

  constructor(private readonly resolveOptions: () => BrightDataSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && options.zone.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = options.apiKey !== undefined && options.apiKey.length > 0
      ? options.apiKey
      : await options.resolveApiKey?.()
    if (apiKey === undefined || apiKey.length === 0) {
      throw brightDataFailure('no Bright Data API token is available: set BRIGHTDATA_API_TOKEN in the '
        + "launch environment (or the harness credentials store), or configure web-search-brightdata's "
        + 'apiKey/apiKeyEnv', undefined)
    }
    const body: BrightDataUnlockerRequest = {
      zone: options.zone,
      url: `${BRIGHTDATA_SEARCH_URL}?q=${encodeURIComponent(request.query)}`,
      format: 'raw',
    }
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/request`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'text/html, application/json;q=0.5',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Bright Data search aborted', 'WEB_ABORTED', { cause: error })
      throw brightDataFailure(`Bright Data search request failed: ${String(error)}`, error)
    }

    if (!response.ok) {
      const status = response.status
      let message = `Bright Data API error (HTTP ${status})`
      try {
        const parsed = await response.json() as BrightDataError
        const detail = parsed.error ?? parsed.error_code
        if (detail !== undefined && detail.length > 0) {
          const hint = parsed.details
            ?.map(entry => entry.message).filter((entry): entry is string => entry !== undefined)
            .join('; ')
          message = hint !== undefined && hint.length > 0 ? `${detail} (${hint})` : detail
        }
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Bright Data search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw brightDataFailure(message, undefined)
    }

    try {
      const html = await response.text()
      return mapParsedHits(parseDuckDuckGo(html))
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Bright Data search aborted', 'WEB_ABORTED', { cause: error })
      throw brightDataFailure(`Bright Data returned an unprocessable response body: ${String(error)}`, error)
    }
  }
}

/** Build the provider failure error, with a security note when an endpoint was overridden. */
function brightDataFailure(message: string, cause: unknown): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
