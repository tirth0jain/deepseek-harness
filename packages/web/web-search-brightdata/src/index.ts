/**
 * Bright Data-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service. One search spends one credit
 * of Bright Data's free shared pool (5,000 requests/month); no other Bright
 * Data product is used.
 *
 * The provider follows the `web-search-deepseek` credential pattern: a literal
 * key from the section wins, otherwise the credential reference (default
 * `$BRIGHTDATA_API_TOKEN`) resolves through the credentials service with the
 * launch environment as fallback.
 * @module @deepseek-ai/dsh-web-search-brightdata
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import {
  BrightDataSearchProvider,
  BRIGHTDATA_DEFAULT_BASE_URL,
  BRIGHTDATA_DEFAULT_ZONE,
} from './provider.ts'
import type { BrightDataSearchProviderOptions } from './provider.ts'

export {
  BRIGHTDATA_DEFAULT_BASE_URL,
  BRIGHTDATA_DEFAULT_ZONE,
  BRIGHTDATA_PROVIDER_ID,
  BRIGHTDATA_SEARCH_URL,
  BrightDataSearchProvider,
} from './provider.ts'
export type { BrightDataSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brightdata'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'BRIGHTDATA_API_TOKEN'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Bright Data API token; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `$BRIGHTDATA_API_TOKEN`. */
  apiKeyEnv?: string
  /** Web Unlocker endpoint base; `/request` is appended. */
  baseURL?: string
  /** Bright Data zone name. Defaults to the free MCP provisioning's `mcp_unlocker`. */
  zone?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  zone: z.string().default(BRIGHTDATA_DEFAULT_ZONE),
})

/** Environment variable naming this provider's endpoint. */
const BRIGHTDATA_BASE_URL_ENV = 'BRIGHTDATA_BASE_URL'

/** Settings namespace carrying this provider's endpoint and key reference. */
export const WEB_SEARCH_BRIGHTDATA_SETTINGS_NAMESPACE = 'web-search-brightdata'

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): BrightDataSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(BRIGHTDATA_BASE_URL_ENV)?.value
      ?? BRIGHTDATA_DEFAULT_BASE_URL,
    zone: config.zone ?? BRIGHTDATA_DEFAULT_ZONE,
  }
}

/** Register the Bright Data search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_SEARCH_BRIGHTDATA_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // The registration carries no resolved value: the provider projects the
      // section per search, so a committed change needs no re-registration.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new BrightDataSearchProvider(() => resolveOptions(ctx, current())))
}
