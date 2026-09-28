/** Browser wire client: Remote transport and connection generations. */
import type { Context } from '@deepseek-ai/cordis'
import {
  ConnectionController,
  type ConnectionRecoveryConfig,
  type ConnectionGeneration,
  type ConnectionGenerationSource,
  type ConnectionSinks,
  type ConnectionState,
} from './connection.ts'
import { createWebConnectionRpc, type RpcFetch, type RpcStreamOpen } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import { isTrustedAuthority } from '../api-request-trust.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
import { resolveConnectionConfig } from '../recovery-config.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A connection generation was established. Wire-derived caches must
     * repull; long-lived streams own their own resume and baseline lifecycle.
     * @mode emit
     */
    'connection/reset'(): void
  }
}

// ---- Browser-safe protocol and shared value re-exports ----
export type {
  MessageId,
  RpcRequest, RpcResponse, RpcResult,
  ClientRequest, ServerResponse, RpcMessage,
  SessionId, SessionEvent, ContentBlock, StreamChunk,
} from './api.ts'
export {
  RpcId,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type {
  ConnectionRecoveryConfig,
  ConnectionGeneration,
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionSinks,
  ConnectionState,
} from './connection.ts'
export type {
  ClientConnectionRpc, ConnectionRpcFailure, ConnectionRpcResult,
} from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/** Observable identity and Host facts for the active connection generation. */
export interface ConnectionGenerationState {
  /** Active generation, or undefined before readiness and while reconnecting. */
  getSnapshot(): ConnectionGeneration | undefined
  /** Subscribe to generation establishment, replacement, and loss. */
  subscribe(listener: () => void): () => void
}

/** Observable recovery lifecycle of the owned Connection loop. */
export interface ConnectionStateSource {
  /** Current state, or undefined before the first connection outcome. */
  getSnapshot(): ConnectionState | undefined
  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Physical carrier selected when the Connection service is installed. The
 * served web app omits it and gets HTTP + WebSocket; a shell that owns a
 * different transport (the worker preview's postMessage tunnel) provides both
 * halves instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /**
   * Already decoded logical RPC carrier. When present it replaces the HTTP
   * caller outright: no envelopes, no `fetch`, no `openStream` (an in-process
   * Host such as a test mock plugs in here).
   */
  rpc?: ClientConnectionRpc
  /** Transport for generic unary RPC channels (the Typert gateway); unused when `rpc` is present. */
  fetch?: RpcFetch
  /** Worker-local Gateway stream carrier; absent when the page uses the Gateway WebSocket or `rpc` is present. */
  openStream?: RpcStreamOpen
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
  /**
   * The transport owner declares the page owns the Host outright: the Host
   * runs inside a worker this page spawned, so no other party can reach it and
   * the loopback stand-in for "the operator's own machine" is vacuous.
   * `ctx.connection.isLoopback` then reports the privileged surface reachable
   * regardless of the page authority. Only a shell that assembles its own
   * transport can set this; served pages never carry the global at all.
   */
  ownsHost?: boolean
  /** HTTP origin of a shell-owned Host when its WebSocket uses a different page origin. */
  streamBaseUrl?: string
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
  __DSH_CONNECTION_RECOVERY__?: unknown
  /**
   * Non-loopback authorities the Host declares it serves, injected alongside
   * the recovery config. A global that is not an array declares nothing, which
   * keeps the page read-only rather than admitting an unjudged authority.
   */
  __DSH_TRUSTED_HOSTS__?: unknown
}

/**
 * Read the injected trusted-authority list. The global is Host-authored, but it
 * crosses a wire boundary this half does not own, so entries are judged one at
 * a time: a non-string or empty entry is dropped instead of throwing during
 * plugin apply, and a global that is not an array declares nothing. Dropping is
 * safe because no invalid entry can ever admit an authority — only a usable
 * string reaches the matcher.
 * @param global - the page global object to read from.
 * @returns the usable declared authorities, possibly empty.
 */
function readTrustedHosts(global: ClientTransportGlobal): readonly string[] {
  const value = global.__DSH_TRUSTED_HOSTS__
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/** Browser location fields used to classify loopback and declared authority. */
export interface ConnectionLocation {
  readonly hostname: string
  /**
   * Page authority including its port when one was written (`location.host`).
   * The `/api` fence judges the request `Host` header, which carries the port,
   * so a port-qualified declaration can only be matched when this is present;
   * omit it and only port-less declarations can match.
   */
  readonly host?: string
}

/** Instance-local inputs for installing a Connection service. */
export interface ConnectionInstallOptions {
  /** Explicit physical carrier; omit for the browser HTTP + WebSocket carrier. */
  readonly transport?: ClientTransportHooks
  /** Reconnect timing overrides; omitted fields use controller defaults. */
  readonly recovery?: ConnectionRecoveryConfig
  /** Page location; omit for a non-browser composition. */
  readonly location?: ConnectionLocation
  /**
   * Non-loopback authorities this deployment declared it serves, matching the
   * Host's `trustedHosts`. A page whose own authority is listed may persist the
   * Host settings document ({@link ConnectionHandle.canWriteSettings}); the
   * default declares nothing and leaves every non-loopback page read-only.
   */
  readonly trustedHosts?: readonly string[]
}

/**
 * The ctx.connection service API. API Gateway supplies generation readiness
 * and reset callbacks; Connection stays independent of downstream domain state.
 */
export interface ConnectionHandle {
  /**
   * Whether the privileged surface is reachable: the page authority is
   * loopback, the transport declares the page owns the Host
   * ({@link ClientTransportHooks.ownsHost}), or the context is not a browser.
   */
  readonly isLoopback: boolean
  /**
   * Whether this page may persist the Host settings document. True under
   * {@link isLoopback}, and also when the page authority is one the Host
   * declared in `trustedHosts` — the same list the `/api` fence enforces, so a
   * headless deployment reached only over the network can still edit its own
   * settings instead of being locked read-only.
   *
   * Deliberately narrower than {@link isLoopback}: affordances that act on the
   * Host machine itself (opening the settings document in a local editor) stay
   * loopback-only, because they are meaningless to a remote browser.
   */
  readonly canWriteSettings: boolean
  /** Current Remote event generation and the Host facts carried by its opening frame. */
  readonly generation: ConnectionGenerationState
  /** Current recovery lifecycle for connection-specific consumers. */
  readonly state: ConnectionStateSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect(): void
  /**
   * Register the sole source defining Host generations. The source reports
   * ready only after its incremental listeners are attached.
   * @param source - long-lived generation source owned by the push carrier.
   * @returns disposer withdrawing the source and stopping an active loop.
   */
  registerGenerationSource(source: ConnectionGenerationSource): () => void
  /**
   * Start the connect/reconnect loop with the consumer's state callbacks.
   * API Gateway owns the loop; a second call throws.
   * @param sinks - connection-state callbacks.
   * @param config - explicit timing overrides; omitted fields use Host bootstrap timing.
   * @returns lifecycle controls for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig): ConnectionLoop
}

/** Controls retained by the sole owner of a running connection loop. */
export interface ConnectionLoop {
  /** Stop the loop and withdraw its active generation. */
  stop(): void
}

interface ConnectionOwner {
  readonly token: object
  readonly source: ConnectionGenerationSource
  readonly controller: ConnectionController
  readonly stopNetworkWatch: () => void
}

interface BrowserNetworkTarget {
  readonly navigator?: { readonly onLine?: boolean }
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}

function watchBrowserNetwork(controller: ConnectionController): () => void {
  const browser = (globalThis as { readonly window?: BrowserNetworkTarget }).window
  const initiallyAvailable = browser?.navigator?.onLine
  if (browser === undefined || initiallyAvailable === undefined) return () => {}
  const online = (): void => { controller.setNetworkAvailable(true) }
  const offline = (): void => { controller.setNetworkAvailable(false) }
  controller.setNetworkAvailable(initiallyAvailable)
  browser.addEventListener('online', online)
  browser.addEventListener('offline', offline)
  return () => {
    browser.removeEventListener('online', online)
    browser.removeEventListener('offline', offline)
  }
}

/**
 * Whether the page's own authority is one the Host declared it serves.
 *
 * `location.host` is the page's authority — the same string a browser puts in
 * the request `Host` header, which is exactly what the `/api` fence judges, so
 * the two halves reach one verdict from one rule. A composition that supplies
 * only {@link ConnectionLocation.hostname} still matches a port-less
 * declaration; it cannot match a port-qualified one, which leaves the page
 * read-only rather than widening the grant.
 * @param pageLocation - the page location, or undefined outside a browser.
 * @param trustedHosts - authorities the Host declared for this deployment.
 * @returns true when the page authority matches a declared entry.
 */
function isTrustedPageAuthority(pageLocation: ConnectionLocation | undefined, trustedHosts: readonly string[]): boolean {
  if (pageLocation === undefined || trustedHosts.length === 0) return false
  const authority: unknown = pageLocation.host ?? pageLocation.hostname
  if (typeof authority !== 'string' || authority.length === 0) return false
  try {
    return isTrustedAuthority(new URL(`http://${authority}`), trustedHosts)
  } catch {
    // An unparsable authority cannot be matched against a declaration; the
    // closed reading keeps the page read-only rather than guessing.
    return false
  }
}

/**
 * Install one Context-owned Connection service from explicit composition inputs.
 * @param ctx - client Cordis context.
 * @param options - physical carrier, reconnect timing, page location, and declared authorities.
 */
export function installConnection(ctx: Context, options: ConnectionInstallOptions = {}): void {
  const pageLocation = options.location
  const transport = options.transport
  const recovery = options.recovery ?? {}
  const trustedHosts = options.trustedHosts ?? []
  const rpc = transport?.rpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream)
  let generationSource: ConnectionGenerationSource | undefined
  let owner: ConnectionOwner | undefined
  let generationId = 0
  let generation: ConnectionGeneration | undefined
  let state: ConnectionState | undefined
  const generationListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const publishGeneration = (next: ConnectionGeneration | undefined): void => {
    if (Object.is(generation, next)) return
    generation = next
    for (const listener of [...generationListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] generation listener threw:', error)
      }
    }
  }
  const publishState = (next: ConnectionState | undefined): void => {
    if (state === next) return
    state = next
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] state listener threw:', error)
      }
    }
  }
  const releaseOwner = (current: ConnectionOwner): void => {
    if (owner !== current) return
    owner = undefined
    current.stopNetworkWatch()
    current.controller.stop()
    publishGeneration(undefined)
    publishState(undefined)
  }
  const isLoopback = transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)
  const handle: ConnectionHandle = {
    isLoopback,
    canWriteSettings: isLoopback || isTrustedPageAuthority(pageLocation, trustedHosts),
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    rpc,
    reconnect() {
      owner?.controller.reconnect()
    },
    registerGenerationSource(source) {
      if (generationSource !== undefined) {
        throw new Error('connection: a generation source is already registered')
      }
      generationSource = source
      return () => {
        if (generationSource !== source) return
        generationSource = undefined
        const current = owner
        if (current?.source === source) releaseOwner(current)
      }
    },
    start(sinks, config) {
      if (owner !== undefined) throw new Error('connection: the stream loop is already owned by another consumer')
      const source = generationSource
      if (source === undefined) throw new Error('connection: no generation source is registered')
      const token = {}
      const ownsGeneration = (): boolean => owner?.token === token
      const controller = new ConnectionController(source, {
        ...sinks,
        onConnected: (host) => {
          const nextGeneration = { id: ++generationId, host }
          publishGeneration(nextGeneration)
          if (!ownsGeneration() || !Object.is(generation, nextGeneration)) return
          sinks.onConnected?.(host)
        },
        onStateChange: (state) => {
          if (state !== 'connected') {
            publishGeneration(undefined)
          }
          if (!ownsGeneration()) return
          publishState(state)
          sinks.onStateChange?.(state)
        },
      }, { ...recovery, ...config })
      const current = { token, source, controller, stopNetworkWatch: watchBrowserNetwork(controller) }
      owner = current
      controller.start()
      return {
        stop: () => { releaseOwner(current) },
      }
    },
  }
  ctx.provide('connection', handle)
}

/**
 * Client plugin body: read the page composition and install its Connection service.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: Context): void {
  const globals = globalThis as ClientTransportGlobal
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const transport = globals.__DSH_TRANSPORT__
  installConnection(ctx, {
    ...(transport === undefined ? {} : { transport }),
    recovery: resolveConnectionConfig(globals.__DSH_CONNECTION_RECOVERY__),
    ...(pageLocation === undefined ? {} : { location: pageLocation }),
    trustedHosts: readTrustedHosts(globals),
  })
}
