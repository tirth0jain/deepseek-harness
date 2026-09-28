/**
 * Wire types for the Bright Data Web Unlocker request endpoint and the search
 * engine pages the provider parses. Deliberately narrow: only the fields this
 * provider consumes are declared, so upstream additions never break decoding.
 * @module @deepseek-ai/dsh-web-search-brightdata/types
 */

/**
 * Body of `POST /request`. `format: 'raw'` returns the target page body
 * verbatim; the provider parses the search-engine HTML itself.
 */
export interface BrightDataUnlockerRequest {
  /** Bright Data zone name (the free MCP provisioning uses `mcp_unlocker`). */
  zone: string
  /** Absolute URL of the target page (the search-engine result page). */
  url: string
  /** Response format; the provider always asks for `raw`. */
  format: 'raw'
}

/**
 * Error envelope the Web Unlocker endpoint returns with a non-2xx status (and
 * for some in-band failures). `details[]` carries per-field validation errors.
 */
export interface BrightDataError {
  error?: string
  error_code?: string
  details?: readonly {
    message?: string
    path?: string
  }[]
}

/** One parsed organic result of the search-engine page. */
export interface ParsedSearchHit {
  /** Absolute destination URL (redirect wrappers resolved). */
  url: string
  /** Result heading text, entities decoded, tags stripped. */
  title: string
  /** Result snippet text, entities decoded, tags stripped. */
  snippet?: string
}
