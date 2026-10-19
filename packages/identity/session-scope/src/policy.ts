/**
 * Pure ownership policy for per-user session scoping.
 *
 * A deployment declares, per authenticated identity, the filesystem root that
 * identity owns. Every session and workspace carries a `cwd`, and a user may
 * see exactly those whose `cwd` lies at or beneath one of their roots. Because
 * ownership is a path prefix rather than a single directory, one user may own
 * any number of workspaces: `/root/punit` and everything under it, so
 * `/root/punit/site-survey` belongs to the same owner.
 *
 * Nothing here touches the filesystem or Cordis; callers resolve and cache.
 * @module @deepseek-ai/dsh-session-scope/src/policy
 */

import { isAbsolute, join, normalize, sep } from 'node:path'

/** Identity a deployment treats as an administrator: one that sees every path. */
export interface ScopingConfig {
  /**
   * Header the authenticating proxy injects, lowercased. The default suits
   * `oauth2-proxy --set-xauthrequest` behind Caddy's `forward_auth`.
   */
  header: string
  /** Identities that see every session and workspace. Compared case-insensitively. */
  admin: readonly string[]
  /** Explicit identity-to-root overrides, keyed by identity. */
  users: Readonly<Record<string, string>>
  /**
   * Mint a root for an identity that has no entry in {@link users}. Relative
   * to nothing: `root` must be absolute, and the directory is
   * `<root>/<slug of the identity's local part>`.
   */
  autoProvision?: AutoProvisionConfig
  /**
   * Refuse an admitted request that carries no identity header. Default false:
   * an unidentified request falls back to the shared operator Peer, which sees
   * everything — correct for single-user deployments, wrong for multi-user ones.
   */
  requireIdentity: boolean
}

/** Root minting for identities that first appear at request time. */
export interface AutoProvisionConfig {
  /** Absolute parent directory every provisioned root is created under. */
  root: string
}

/** One resolved identity: who it is and what it may see. */
export interface ResolvedScope {
  readonly identity: string
  /** True when this identity sees every path regardless of {@link roots}. */
  readonly admin: boolean
  /** Absolute, normalized roots this identity owns. Empty for an admin. */
  readonly roots: readonly string[]
  /**
   * Root to create on first use, when {@link ScopingConfig.autoProvision} is
   * configured and this identity has no explicit entry.
   */
  readonly provisionRoot?: string
}

/**
 * Fold one raw header value into a comparable identity.
 *
 * Proxies may repeat a header, so a comma-joined list is truncated to its
 * first member. Case is folded because mail domains and Pocket ID logins are
 * case-insensitive in practice, and a trailing dot on the domain is dropped.
 * @param raw - header value as received, or undefined when absent.
 * @returns the folded identity, or undefined when nothing usable was sent.
 */
export function normalizeIdentity(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const first = raw.split(',', 1)[0] ?? ''
  const trimmed = first.trim().toLowerCase()
  if (trimmed === '') return undefined
  const withoutTrailingDot = trimmed.replace(/\.$/, '')
  return withoutTrailingDot === '' ? undefined : withoutTrailingDot
}

/**
 * Derive a filesystem-safe directory name from an identity.
 *
 * The local part before `@` is preferred, so `punit@rubysteels.com` becomes
 * `punit`. Characters outside `[a-z0-9._-]` collapse to `-`, leading dots and
 * dashes are dropped so the result can never be `.`, `..`, or a hidden
 * directory, and the whole thing is truncated to keep paths bounded.
 * @param identity - normalized identity.
 * @returns a non-empty directory name built only from safe characters.
 */
export function slugForIdentity(identity: string): string {
  const localPart = identity.includes('@') ? identity.slice(0, identity.indexOf('@')) : identity
  const slug = localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 64)
  return slug === '' ? 'user' : slug
}

/**
 * Normalize a declared root for comparison.
 * @param root - absolute path as configured.
 * @returns the path without a trailing separator, or undefined when not absolute.
 */
export function normalizeRoot(root: string): string | undefined {
  if (!isAbsolute(root)) return undefined
  const normalized = normalize(root)
  if (normalized === sep) return sep
  return normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized
}

/**
 * Test whether one path lies at or beneath a root.
 *
 * The separator guard is the whole point: a bare `startsWith` would place
 * `/root/punit2` inside `/root/punit`. `..` segments are resolved first, so a
 * crafted `cwd` cannot climb out of its root.
 * @param root - normalized absolute root.
 * @param candidate - absolute path to test.
 * @returns true when `candidate` is the root itself or lives under it.
 */
export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRoot(root)
  const normalizedCandidate = normalizeRoot(candidate)
  if (normalizedRoot === undefined || normalizedCandidate === undefined) return false
  if (normalizedRoot === sep) return true
  if (normalizedCandidate === normalizedRoot) return true
  return normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

/**
 * Resolve one identity against the deployment's policy.
 *
 * An explicit {@link ScopingConfig.users} entry wins. Otherwise an
 * administrator sees everything, and any other identity with
 * {@link ScopingConfig.autoProvision} configured gets a root named after it —
 * created only when something first needs it.
 * @param identity - normalized identity.
 * @param config - resolved scoping configuration.
 * @returns the identity's scope, or undefined when the deployment has no policy for it.
 */
export function resolveScope(identity: string, config: ScopingConfig): ResolvedScope | undefined {
  const key = normalizeIdentity(identity)
  if (key === undefined) return undefined
  const admin = config.admin.some(candidate => normalizeIdentity(candidate) === key)
  const explicit = findEntry(config.users, key)
  if (explicit !== undefined) {
    const root = normalizeRoot(explicit)
    if (root === undefined) return undefined
    return { identity: key, admin, roots: [root] }
  }
  if (admin) return { identity: key, admin: true, roots: [] }
  const provision = config.autoProvision
  if (provision === undefined) return undefined
  const parent = normalizeRoot(provision.root)
  if (parent === undefined) return undefined
  const provisionRoot = join(parent, slugForIdentity(key))
  // The minted root is a root before it exists on disk: a first-time user must
  // be able to see the directory the moment they create it, and the mkdir is
  // what makes it real.
  return { identity: key, admin: false, roots: [provisionRoot], provisionRoot }
}

/**
 * Case-insensitive lookup over the configured identity map.
 * @param users - configured map.
 * @param identity - normalized identity to find.
 * @returns the configured root, or undefined when absent.
 */
function findEntry(users: Readonly<Record<string, string>>, identity: string): string | undefined {
  for (const [configured, root] of Object.entries(users)) {
    if (normalizeIdentity(configured) === identity) return root
  }
  return undefined
}

/**
 * Decide whether a resolved scope may see one path.
 *
 * An unresolved scope (no policy for this identity) and an admin scope both
 * answer true: the first because a deployment that names nobody constrains
 * nobody, the second because seeing everything is what an administrator is for.
 * @param scope - resolved scope, or undefined when the identity has no policy.
 * @param path - absolute `cwd` of a session or workspace.
 * @returns true when the path is visible to this scope.
 */
export function scopeMayAccess(scope: ResolvedScope | undefined, path: string): boolean {
  if (scope === undefined || scope.admin) return true
  return scope.roots.some(root => isWithin(root, path))
}
