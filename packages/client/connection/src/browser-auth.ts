/**
 * Browser-session authentication for the Host Connection carrier.
 *
 * This fork ships with browser-session authentication fully disabled: there is
 * no launch token, no persistent cookie, and no 401 gate. `authenticatedUrl`
 * is the identity, `authorizeIndex` always admits the frontend index, and
 * `isAuthenticated` always reports an authenticated browser, so every surface
 * is reachable over the network once the Host/Origin fence passes. The
 * Host/Origin fence (`api-request-trust.ts`) is DNS-rebinding and cross-site
 * defense, not an authentication layer, and remains in force.
 * @module @deepseek-ai/dsh-client-connection/browser-auth
 */

import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

/** No-op browser-session authenticator (authentication disabled). */
export class BrowserAuth {
  private constructor() {}

  /** Create the shared no-op authenticator.
   * @returns the resolved no-op authenticator.
   */
  static create(): Promise<BrowserAuth> {
    return Promise.resolve(new BrowserAuth())
  }

  /** Return the base URL unchanged: no launch token is minted.
   * @param baseUrl - clean canonical browser origin.
   * @returns the same URL, accepted by {@link authorizeIndex} for index serving.
   */
  authenticatedUrl(baseUrl: string): string {
    return baseUrl
  }

  /** Always admit the frontend index: no token redirect or 401.
   * @param _request - root or configured-index HTTP request (unused).
   * @param _response - response owned when the result is false (unused).
   * @returns true, always.
   */
  authorizeIndex(_request: ConnectionIndexRequest, _response: ConnectionIndexResponse): boolean {
    return true
  }

  /** Every browser is considered authenticated: no session cookie is checked.
   * @param _request - request headers (unused).
   * @returns true, always.
   */
  isAuthenticated(_request: ConnectionTrustRequest): boolean {
    return true
  }
}
