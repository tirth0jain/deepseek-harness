/**
 * Per-user session scoping for multi-user deployments.
 *
 * A reverse proxy that authenticates visitors can assert who each request
 * belongs to. This plugin reads that assertion, resolves it to the paths the
 * visitor owns, and exposes the answer to every layer that enumerates sessions
 * or workspaces — so one office's users share a harness without sharing a
 * session list.
 *
 * The identity rides on the Peer. Connection admits each request as a distinct
 * Peer per identity, and every Remote call already carries its Peer as
 * `this.ctx.invocation.peer`, so enforcement needs no new plumbing and streams
 * — which outlive any request-scoped context — stay attributed.
 *
 * Loading this plugin with no `admin`, no `users` and no `provisionRoot`
 * constrains nobody: `scopeOfPeer` answers undefined for every caller and the
 * harness behaves exactly as it does without the plugin.
 * @module @deepseek-ai/dsh-session-scope
 */

import { mkdirSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestIdentityResolver } from '@deepseek-ai/dsh-client-connection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  normalizeIdentity,
  normalizeRoot,
  resolveScope,
  scopeMayAccess,
  type ResolvedScope,
  type ScopingConfig,
} from './policy.ts'

export {
  isWithin,
  normalizeIdentity,
  normalizeRoot,
  resolveScope,
  scopeMayAccess,
  slugForIdentity,
  type AutoProvisionConfig,
  type ResolvedScope,
  type ScopingConfig,
} from './policy.ts'

/** Resolved plugin configuration. */
export interface SessionScopeConfig {
  /** Header carrying the authenticated identity, lowercased. */
  header: string
  /** Identities that see every session and workspace. */
  admin: string[]
  /** Explicit identity-to-root overrides. */
  users: Record<string, string>
  /** Parent directory minted roots are created under; empty disables minting. */
  provisionRoot: string
  /** Refuse admitted requests that carry no identity header. */
  requireIdentity: boolean
}

export const Config: z<SessionScopeConfig> = z.object({
  header: z.string().default('x-auth-request-email'),
  admin: z.array(String).default([]),
  users: z.dict(String).default({}),
  provisionRoot: z.string().default(''),
  requireIdentity: z.boolean().default(false),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-user session scoping policy, when the deployment configures one. */
    sessionScope: SessionScopeService
  }
}

/** Header bags a carrier may present: a Fetch `Headers`, or node's plain object. */
export type IdentityHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

/**
 * Answers whether one `cwd` is visible to the caller a predicate was built for.
 *
 * A session with no `cwd` is not visible to a constrained caller. Every web
 * session carries one — a workspace path, or the server's own directory — so
 * the only sessions this hides are ones belonging to no workspace at all,
 * which a scoped deployment has no reason to show.
 */
export type PathVisibility = (path: string | undefined) => boolean

/**
 * Build the path-visibility predicate for the Remote call running on `ctx`.
 *
 * Returns a predicate rather than the scope itself, so code that enumerates
 * sessions applies a caller's visibility without knowing how ownership is
 * configured. Must be called from inside a Remote method: `ctx.invocation` is
 * what carries the caller's Peer, and it reads undefined anywhere else.
 *
 * Undefined means unconstrained, which is not the same as a predicate that
 * answers true everywhere. Callers that suppress whole categories of data for
 * a scoped user — the registry-global archive and pin sets, for instance —
 * need to tell those apart.
 * @param ctx - the per-call plugin context inside a Remote method.
 * @returns predicate answering whether one `cwd` is visible to this caller, or
 *   undefined when this deployment does not constrain them.
 */
export function callVisibility(ctx: Context): PathVisibility | undefined {
  return peerVisibility(ctx, ctx.invocation?.peer)
}

/**
 * Build the path-visibility predicate for one Peer.
 *
 * The counterpart to {@link callVisibility} for entry points that are not
 * Remote calls — an exact Fetch route has no `invocation`, so it takes its Peer
 * from the carrier instead.
 * @param ctx - plugin context carrying the scoping service, if loaded.
 * @param peer - the Peer the request was admitted as.
 * @returns predicate answering whether one `cwd` is visible, or undefined when
 *   this deployment does not constrain that caller.
 */
export function peerVisibility(ctx: Context, peer: PeerScope | undefined): PathVisibility | undefined {
  const scope = ctx.get('sessionScope')?.scopeOfPeer(peer)
  if (scope === undefined || scope.admin) return undefined
  return path => path !== undefined && scopeMayAccess(scope, path)
}

/**
 * Read the directory roots the caller of a Remote method owns.
 *
 * {@link callVisibility} answers yes/no about one path, which is all an
 * enumerator needs. An entry point that has to *choose* a path for a caller —
 * a picker deciding where to open — needs the roots themselves.
 * @param ctx - the per-call plugin context inside a Remote method.
 * @returns the caller's absolute roots, or undefined when this deployment does
 *   not constrain them.
 */
export function callRoots(ctx: Context): readonly string[] | undefined {
  return ctx.get('sessionScope')?.rootsOfPeer(ctx.invocation?.peer)
}

/** Wire details for a refusal to reach something outside the caller's own directories. */
export interface SessionScopeRefusalDetails {
  /** What was being reached, named for the operator reading the failure. */
  readonly target: string
  /** Absolute path that was refused, or undefined when the request named none. */
  readonly path: string | undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session-scope/forbidden': SessionScopeRefusalDetails
  }
}

/**
 * Refuse a path the caller does not own.
 *
 * Every id-addressed entry point funnels through this rather than through a
 * list filter, because a Session the caller cannot see in the sidebar is still
 * reachable by identity: `session.page`, `session.fork` and `session.export`
 * each take a raw Session id.
 * @param maySee - the caller's visibility, or undefined when unconstrained.
 * @param path - absolute path the operation would touch.
 * @param target - human-readable description of what was being reached.
 * @throws RemoteError when the caller is constrained and the path is not theirs.
 */
export function assertVisibility(
  maySee: PathVisibility | undefined,
  path: string | undefined,
  target: string,
): void {
  if (maySee === undefined || maySee(path)) return
  throw new RemoteError(
    'session-scope/forbidden',
    `${target} lies outside the directories this account owns`,
    { target, path },
  )
}

/** Whether any configured rule could ever constrain a caller. */
function isConfigured(config: SessionScopeConfig): boolean {
  return config.admin.length > 0
    || Object.keys(config.users).length > 0
    || normalizeRoot(config.provisionRoot) !== undefined
}

/**
 * Resolve proxy-asserted identities to the filesystem roots they own.
 *
 * One instance serves the whole process. It holds no per-request state beyond
 * the Peer-to-identity map Connection fills in as it admits requests.
 */
export class SessionScopeService extends Service implements RequestIdentityResolver {
  private readonly config: ScopingConfig
  private readonly configured: boolean
  /** Peer to identity. Weak so a retired Peer's entry dies with it. */
  private readonly peerIdentities = new WeakMap<PeerScope, string>()
  /** Identity to resolved scope, resolved once per identity. */
  private readonly scopes = new Map<string, ResolvedScope>()
  /** Provision roots already created, so mkdir runs once per identity. */
  private readonly created = new Set<string>()

  /**
   * @param ctx - owning plugin context.
   * @param config - resolved plugin configuration (schema defaults applied).
   */
  constructor(ctx: Context, config: SessionScopeConfig) {
    super(ctx, 'sessionScope')
    this.config = {
      header: config.header.toLowerCase(),
      admin: config.admin,
      users: config.users,
      requireIdentity: config.requireIdentity,
      ...(normalizeRoot(config.provisionRoot) === undefined
        ? {}
        : { autoProvision: { root: config.provisionRoot } }),
    }
    this.configured = isConfigured(config)
  }

  /** Whether this deployment constrains anyone at all. */
  get enabled(): boolean {
    return this.configured
  }

  /** Whether an admitted request without an identity header must be refused. */
  get requiresIdentity(): boolean {
    return this.config.requireIdentity
  }

  /** Header name this deployment reads, lowercased. */
  get headerName(): string {
    return this.config.header
  }

  /**
   * Read the asserted identity from one request's headers.
   * @param headers - node request headers or a Fetch `Headers` bag.
   * @returns the normalized identity, or undefined when the header is absent or empty.
   */
  identityFromHeaders(headers: IdentityHeaders): string | undefined {
    return normalizeIdentity(this.readHeader(headers))
  }

  /**
   * Record which identity a Peer was admitted as.
   * @param peer - Peer Connection minted for this identity.
   * @param identity - normalized identity the Peer speaks for.
   */
  remember(peer: PeerScope, identity: string): void {
    this.peerIdentities.set(peer, identity)
  }

  /**
   * Resolve the scope of the Peer behind a Remote call.
   * @param peer - Peer from `this.ctx.invocation.peer`, or undefined outside a Remote call.
   * @returns the caller's scope, or undefined when no policy constrains this caller.
   */
  scopeOfPeer(peer: PeerScope | undefined): ResolvedScope | undefined {
    if (peer === undefined) return undefined
    const identity = this.peerIdentities.get(peer)
    if (identity === undefined) return undefined
    return this.scopeFor(identity)
  }

  /**
   * The identity one Peer was admitted as.
   * @param peer - Peer taken from the carrier or `this.ctx.invocation.peer`.
   * @returns the normalized identity, or undefined when this Peer was not admitted as one.
   */
  identityOfPeer(peer: PeerScope | undefined): string | undefined {
    return peer === undefined ? undefined : this.peerIdentities.get(peer)
  }

  /**
   * Resolve one identity's scope, memoized.
   * @param identity - normalized identity.
   * @returns the scope, or undefined when the deployment has no policy for it.
   */
  scopeFor(identity: string | undefined): ResolvedScope | undefined {
    if (identity === undefined || !this.configured) return undefined
    const cached = this.scopes.get(identity)
    if (cached !== undefined) return cached
    const resolved = resolveScope(identity, this.config)
    if (resolved !== undefined) this.scopes.set(identity, resolved)
    return resolved
  }

  /**
   * The directory roots the Peer behind a Remote call owns.
   * @param peer - Peer from `this.ctx.invocation.peer`.
   * @returns the roots this caller may reach, or undefined when nothing
   *   constrains them — an administrator, or a deployment that names nobody.
   */
  rootsOfPeer(peer: PeerScope | undefined): readonly string[] | undefined {
    const scope = this.scopeOfPeer(peer)
    if (scope === undefined || scope.admin) return undefined
    return scope.roots
  }

  /**
   * Decide whether the Peer behind a Remote call may see one path.
   * @param peer - Peer from `this.ctx.invocation.peer`.
   * @param path - absolute `cwd` of a session or workspace.
   * @returns true when the path is visible to this caller.
   */
  mayAccess(peer: PeerScope | undefined, path: string): boolean {
    return scopeMayAccess(this.scopeOfPeer(peer), path)
  }

  /**
   * Keep only the paths the Peer behind a Remote call may see.
   * @param peer - Peer from `this.ctx.invocation.peer`.
   * @param paths - candidate absolute paths.
   * @returns the visible subset, in input order.
   */
  visiblePaths(peer: PeerScope | undefined, paths: readonly string[]): string[] {
    const scope = this.scopeOfPeer(peer)
    if (scope === undefined || scope.admin) return [...paths]
    return paths.filter(path => scopeMayAccess(scope, path))
  }

  /**
   * Create the root minted for a first-time identity, once.
   *
   * Only an identity whose scope carries a `provisionRoot` is minted; an
   * explicit or administrative identity already has somewhere to work.
   * @param identity - normalized identity.
   * @returns the created (or already existing) root, or undefined when nothing is minted.
   */
  ensureRoot(identity: string | undefined): string | undefined {
    const scope = this.scopeFor(identity)
    const root = scope?.provisionRoot
    if (root === undefined) return undefined
    if (!this.created.has(root)) {
      mkdirSync(root, { recursive: true })
      this.created.add(root)
    }
    return root
  }

  /**
   * Read one header from either carrier shape.
   * @param headers - node request headers or a Fetch `Headers` bag.
   * @returns the raw value, or undefined when absent.
   */
  private readHeader(headers: IdentityHeaders): string | undefined {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(this.config.header) ?? undefined
    }
    const bag = headers as Readonly<Record<string, string | readonly string[] | undefined>>
    const value = bag[this.config.header]
    if (value === undefined) return undefined
    return typeof value === 'string' ? value : value[0]
  }
}

/**
 * Provide per-user session scoping.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: SessionScopeConfig): void {
  const resolved: SessionScopeConfig = {
    header: config?.header ?? 'x-auth-request-email',
    admin: config?.admin ?? [],
    users: config?.users ?? {},
    provisionRoot: config?.provisionRoot ?? '',
    requireIdentity: config?.requireIdentity ?? false,
  }
  const scope = new SessionScopeService(ctx, resolved)
  // Connection owns admission and knows nothing about users, so the policy is
  // handed to it rather than imported by it: every admitted request then speaks
  // for its own identity's Peer.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.setIdentityResolver(scope),
      'session-scope: request identity resolver',
    )
  })
}
