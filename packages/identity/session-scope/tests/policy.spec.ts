/**
 * Ownership policy: the path-prefix rules that decide who sees which session.
 *
 * The sibling-prefix and `..` cases are the ones that matter. A bare
 * `startsWith` would hand `/root/punit2` to the owner of `/root/punit`, and an
 * unresolved `..` would let a crafted `cwd` climb out of its root entirely.
 */

import { describe, expect, it } from 'vitest'
import {
  isWithin,
  normalizeIdentity,
  normalizeRoot,
  resolveScope,
  scopeMayAccess,
  slugForIdentity,
  type ScopingConfig,
} from '../src/policy.ts'

const baseConfig: ScopingConfig = {
  header: 'x-auth-request-email',
  admin: [],
  users: {},
  requireIdentity: false,
}

describe('normalizeIdentity', () => {
  it('folds case and trims', () => {
    expect(normalizeIdentity('  Punit@Rubysteels.COM ')).toBe('punit@rubysteels.com')
  })

  it('keeps only the first member of a repeated header', () => {
    expect(normalizeIdentity('punit@rubysteels.com, samay@rubysteels.com'))
      .toBe('punit@rubysteels.com')
  })

  it('drops a trailing dot on the domain', () => {
    expect(normalizeIdentity('punit@rubysteels.com.')).toBe('punit@rubysteels.com')
  })

  it('answers undefined for absent or empty values', () => {
    expect(normalizeIdentity(undefined)).toBeUndefined()
    expect(normalizeIdentity('')).toBeUndefined()
    expect(normalizeIdentity('   ')).toBeUndefined()
    expect(normalizeIdentity(', samay@rubysteels.com')).toBeUndefined()
  })
})

describe('slugForIdentity', () => {
  it('uses the local part', () => {
    expect(slugForIdentity('punit@rubysteels.com')).toBe('punit')
  })

  it('collapses unsafe characters and never yields a traversal segment', () => {
    expect(slugForIdentity('../../etc@example.com')).toBe('etc')
    expect(slugForIdentity('..@example.com')).toBe('user')
    expect(slugForIdentity('.@example.com')).toBe('user')
  })

  it('never yields a dotfile', () => {
    expect(slugForIdentity('.hidden@example.com')).toBe('hidden')
  })

  it('falls back to a usable name when nothing survives', () => {
    expect(slugForIdentity('@example.com')).toBe('user')
  })
})

describe('normalizeRoot', () => {
  it('rejects relative roots', () => {
    expect(normalizeRoot('root/punit')).toBeUndefined()
    expect(normalizeRoot('')).toBeUndefined()
  })

  it('strips a trailing separator', () => {
    expect(normalizeRoot('/root/punit/')).toBe('/root/punit')
  })

  it('preserves the filesystem root', () => {
    expect(normalizeRoot('/')).toBe('/')
  })
})

describe('isWithin', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(isWithin('/root/punit', '/root/punit')).toBe(true)
    expect(isWithin('/root/punit', '/root/punit/site-survey')).toBe(true)
    expect(isWithin('/root/punit', '/root/punit/a/b/c')).toBe(true)
  })

  it('does not hand a sibling with a shared prefix to the wrong owner', () => {
    expect(isWithin('/root/punit', '/root/punit2')).toBe(false)
    expect(isWithin('/root/punit', '/root/punit-secrets')).toBe(false)
  })

  it('does not let a path climb out of its root', () => {
    expect(isWithin('/root/punit', '/root/punit/../ruby')).toBe(false)
    expect(isWithin('/root/punit', '/root/punit/a/../../ruby')).toBe(false)
  })

  it('rejects a relative candidate', () => {
    expect(isWithin('/root/punit', 'relative/path')).toBe(false)
  })

  it('treats the filesystem root as owning everything', () => {
    expect(isWithin('/', '/anything/at/all')).toBe(true)
  })
})

describe('resolveScope', () => {
  it('answers undefined when the deployment names nobody', () => {
    expect(resolveScope('punit@rubysteels.com', baseConfig)).toBeUndefined()
  })

  it('resolves an explicit user to their declared root', () => {
    const scope = resolveScope('punit@rubysteels.com', {
      ...baseConfig,
      users: { 'punit@rubysteels.com': '/root/punit' },
    })
    expect(scope).toEqual({ identity: 'punit@rubysteels.com', admin: false, roots: ['/root/punit'] })
  })

  it('matches a configured identity case-insensitively', () => {
    const scope = resolveScope('PUNIT@rubysteels.com', {
      ...baseConfig,
      users: { 'Punit@Rubysteels.com': '/root/punit' },
    })
    expect(scope?.roots).toEqual(['/root/punit'])
  })

  it('gives an administrator every path and no roots', () => {
    const scope = resolveScope('main.pastrami903@passfwd.com', {
      ...baseConfig,
      admin: ['main.pastrami903@passfwd.com'],
      users: { 'punit@rubysteels.com': '/root/punit' },
    })
    expect(scope?.admin).toBe(true)
    expect(scope?.roots).toEqual([])
    expect(scopeMayAccess(scope, '/root/ruby/anything')).toBe(true)
  })

  it('mints a root for a first-time identity under the provision parent', () => {
    const scope = resolveScope('samay@rubysteels.com', {
      ...baseConfig,
      autoProvision: { root: '/root' },
    })
    expect(scope?.provisionRoot).toBe('/root/samay')
    expect(scope?.roots).toEqual(['/root/samay'])
  })

  it('lets an explicit entry override minting', () => {
    const scope = resolveScope('samay@rubysteels.com', {
      ...baseConfig,
      users: { 'samay@rubysteels.com': '/srv/design' },
      autoProvision: { root: '/root' },
    })
    expect(scope?.provisionRoot).toBeUndefined()
    expect(scope?.roots).toEqual(['/srv/design'])
  })

  it('declines a relative declared root rather than guessing', () => {
    expect(resolveScope('punit@rubysteels.com', {
      ...baseConfig,
      users: { 'punit@rubysteels.com': 'root/punit' },
    })).toBeUndefined()
  })
})

describe('scopeMayAccess', () => {
  const punit = resolveScope('punit@rubysteels.com', {
    ...baseConfig,
    users: { 'punit@rubysteels.com': '/root/punit' },
  })

  it('constrains nobody when no policy resolved', () => {
    expect(scopeMayAccess(undefined, '/root/ruby/private')).toBe(true)
  })

  it('shows a user their own workspace and any workspace beneath it', () => {
    expect(scopeMayAccess(punit, '/root/punit')).toBe(true)
    expect(scopeMayAccess(punit, '/root/punit/site-survey')).toBe(true)
  })

  it('hides another user\'s workspace', () => {
    expect(scopeMayAccess(punit, '/root/ruby')).toBe(false)
    expect(scopeMayAccess(punit, '/root/punit2')).toBe(false)
  })
})
