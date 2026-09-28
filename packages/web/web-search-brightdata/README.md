---
description: "The Bright Data-backed search provider for ctx.web: how deployments mount Web Unlocker search that reads DuckDuckGo result pages through Bright Data's free shared pool."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brightdata

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-brightdata`, the harness searches the web through a Bright Data Web Unlocker zone that fetches the DuckDuckGo HTML result page, getting citeable sources with titles and optional snippets. Choose it when a deployment holds a Bright Data API token and wants each search to spend one credit from Bright Data's free shared pool (5,000 requests/month). Results carry no generated `content`, no publication date, and no wire-level result count, so the service truncates to `maxResults` afterwards; a result whose destination does not resolve is dropped. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `brightdata` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: brightdata`.

### When to choose it

Choose this backend when a deployment holds a Bright Data API token and wants public web search whose cost comes from Bright Data's free shared pool (5,000 requests/month across Web Unlocker, SERP API, Web Scraper, Scraper Studio, and MCP). The provider opens no browser and calls no vendor search endpoint: it asks the Web Unlocker zone for the DuckDuckGo HTML result page and parses the organic results locally. Choose another backend when the deployment needs a generated answer, publication dates, or upstream search controls (`dsh-web-search-exa`, `dsh-web-search-perplexity`, `dsh-web-search-deepseek`). The provider is unavailable — and every search fails with a structured selection error — only when `baseURL` does not parse or `zone` is empty. A missing token leaves availability untouched, because the plugin always supplies a credential resolver; the search itself then fails as `WEB_PROVIDER_ERROR` naming `BRIGHTDATA_API_TOKEN`.

### Minimal configuration

Load the web service and the provider; the token resolves through `ctx.credentials` (whose local provider also reads the launch environment), or from the launch environment alone when that seam is absent, and every other setting has a default.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brightdata'
  config:
    apiKeyEnv: BRIGHTDATA_API_TOKEN
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Bright Data API token; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins |
| `apiKeyEnv` | `$BRIGHTDATA_API_TOKEN` | Credential reference resolved for each search; a bare variable name such as `BRIGHTDATA_API_TOKEN`, never a `$`-prefixed value |
| `baseURL` | `$BRIGHTDATA_BASE_URL`, else `https://api.brightdata.com` | Endpoint base; `/request` is appended. An unparseable value makes the provider unavailable |
| `zone` | `mcp_unlocker` | Bright Data zone name sent in the request; an empty value makes the provider unavailable |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brightdata) is the exhaustive source for every accepted field and its JSDoc. The entry above is the base layer of the provider's Settings section; a user layer over it reaches the next search, because the provider projects the section per call rather than capturing it at registration.

### What a search returns

Each parsed DuckDuckGo result maps to a `WebSearchSource`: `url` with the redirect wrapper resolved, `title`, and a `snippet` only when the page carried one; `publishedAt` is never set. `content` is always omitted, because the page carries no generated answer. The provider reports `truncated: false` — it sends no result-count control and returns whatever the page held — and the service enforces `maxResults` by truncating and flagging. A result whose destination URL does not resolve, or whose title is empty after tag stripping, is dropped, so fewer sources than requested can return.

### Failures and recovery

Failures throw `WebError` with a machine-routable code: caller cancellation is `WEB_ABORTED`, and provider or transport failures are `WEB_PROVIDER_ERROR`. A missing token fails with a message naming `BRIGHTDATA_API_TOKEN`, the credentials store, and the `apiKey`/`apiKeyEnv` fields; a non-2xx response uses Bright Data's own `error`/`error_code` text with its `details[].message` hints, or `Bright Data API error (HTTP <status>)` when the body is not JSON; a refused network request or redirect reports `Bright Data search request failed: <error>`; an unreadable body reports `Bright Data returned an unprocessable response body: <error>`. HTTP redirects are rejected before the `Location` target is contacted. The model-facing `web_search` tool surfaces this text under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Bright Data's Web Unlocker endpoint with three deliberate rules:

- **No browser and no vendor search API.** The unlocker returns the DuckDuckGo HTML page verbatim (`format: 'raw'`), so the provider parses the same markup a reader would see and never invents a generated answer.
- **One credit per search.** Every `/request` call draws on the free shared pool, and the request carries no result count or retrieval mode; `maxResults` stays a post-hoc seam bound rather than a cost control.
- **Unknown entities stay verbatim.** Numeric and hex character references decode, but an unrecognized named entity is kept as written — a wrong guess would fabricate snippet text.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential and endpoint resolution, settings section, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `BrightDataSearchProvider`: request dispatch, abort classification, DuckDuckGo parsing, result mapping |
| [`src/types.ts`](src/types.ts) | Bright Data wire types: `BrightDataUnlockerRequest`, `BrightDataError`, `ParsedSearchHit` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` posts `{ zone, url: "https://html.duckduckgo.com/html/?q=<encoded query>", format: 'raw' }` to `{baseURL}/request` with a bearer token, `redirect: 'error'`, and a `deepseek-harness` user agent. The returned page is parsed anchor by anchor: each `result__a` anchor opens one result, its `uddg` redirect wrapper resolves to the destination, and the first `result__snippet` anchor in that result's segment supplies the snippet. Results without a resolvable destination or a non-empty title are dropped. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brightdata) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded DuckDuckGo result URLs, titles, and optional snippets, or its exact `Bright Data search aborted`, `Bright Data search request failed: <error>`, and `Bright Data returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Availability ignores the token** — the plugin always supplies a credential resolver, so `available()` reports only a parseable endpoint and a non-empty zone; a tokenless deployment selects this provider and the search fails as `WEB_PROVIDER_ERROR` instead of `WEB_PROVIDER_UNAVAILABLE`.
- **Every search spends one credit, whatever it returns** — the free shared pool is drawn per `/request` call, including a call that parses no results, and `maxResults` truncates only afterwards.
- **Sources carry no generated answer and no publication date** — the parsed page supplies `url`, `title`, and sometimes `snippet`; a result whose destination does not resolve or whose title is empty is dropped.
- **`apiKeyEnv` takes a bare variable name** — the credential-reference grammar rejects a `$`-prefixed value with a `TypeError` before any search runs, so configure `BRIGHTDATA_API_TOKEN`, not `$BRIGHTDATA_API_TOKEN`.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
- **The default zone assumes Bright Data's free MCP provisioning** — `mcp_unlocker` is used unless `zone` names the deployment's own zone.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: provider-neutral search controls

Bright Data's SERP API, country and language targeting, and any result-count control stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

#### Open question: parser durability

The provider parses DuckDuckGo class names, so a markup change can silently reduce results. A recorded-page fixture would make that regression visible; no such fixture exists yet.

</details>
