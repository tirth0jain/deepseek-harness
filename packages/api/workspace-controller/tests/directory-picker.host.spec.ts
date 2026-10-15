import { basename, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryEntry, DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { apply as applyScope } from '@deepseek-ai/dsh-session-scope'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryPickerController } from '../src/directory-picker.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A backend serving exactly the capability one case is about. */
class StubPicker extends DirectoryPicker {
  static capabilityStub: DirectoryPickerCapability = { kind: 'native', pick: async () => null }

  capability(): DirectoryPickerCapability {
    return StubPicker.capabilityStub
  }
}

const NATIVE_STUB: DirectoryPickerCapability = { kind: 'native', pick: async () => null }

const BROWSE_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async (path) => {
    if (path === '/denied') {
      throw new DirectoryPickerError('directory-unreadable', '/denied', 'cannot list /denied')
    }
    const target = path ?? '/home/user'
    return {
      path: target,
      home: '/home/user',
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [{ name: 'projects', path: `${target}/projects`, hidden: false }],
      truncated: false,
    }
  },
  createDirectory: async (path, name) => {
    if (name === 'taken') {
      throw new DirectoryPickerError('directory-exists', `${path}/${name}`, 'already exists')
    }
    if (name === 'unwritable') throw new Error('disk detached')
    if (name === 'gone') throw 'the volume vanished'
    return `${path}/${name}`
  },
}

async function harness(capability: DirectoryPickerCapability = NATIVE_STUB) {
  StubPicker.capabilityStub = capability
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(StubPicker).await()
  return new DirectoryPickerController(ctx)
}

/** The failure payload a refused wire verb carries. */
async function refused(call: Promise<unknown>): Promise<{ code: string; message: string; details: object }> {
  try {
    await call
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { code: failure.code, message: failure.message, details: failure.details }
  }
  throw new Error('the call was expected to be refused')
}

describe('directoryPicker pick Remote', () => {
  it('answers the selected path or the operator\'s cancellation', async () => {
    const selected = await harness({ kind: 'native', pick: async () => '/tmp/project' })
    expect(await selected.pick(new AbortController().signal)).toBe('/tmp/project')

    const cancelled = await harness(NATIVE_STUB)
    expect(await cancelled.pick(new AbortController().signal)).toBeNull()
  })

  it('reports an aborted chooser as cancelled and any other failure as internal', async () => {
    const picker = await harness({
      kind: 'native',
      pick: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = refused(picker.pick(abort.signal))
    abort.abort()
    expect((await pending).code).toBe('gateway/cancelled')

    const broken = await harness({ kind: 'native', pick: async () => { throw new Error('no chooser installed') } })
    const failure = await refused(broken.pick(new AbortController().signal))
    expect(failure.code).toBe('gateway/internal')
    expect(failure.message).toContain('no chooser installed')
  })

  it('refuses the native verb under a browse composition', async () => {
    const picker = await harness(BROWSE_STUB)
    const failure = await refused(picker.pick(new AbortController().signal))
    expect(failure.code).toBe('directory-picker/unavailable')
    expect(failure.message).toContain('needs the native capability')
    expect(failure.details).toEqual({ capability: 'browse' })
  })
})

describe('directoryPicker browse Remotes', () => {
  it('serves listings and creation, defaulting to the home directory', async () => {
    const picker = await harness(BROWSE_STUB)
    const signal = new AbortController().signal
    expect(await picker.list(undefined, signal)).toMatchObject({ path: '/home/user', home: '/home/user' })
    expect(await picker.list('/home/user/projects', signal))
      .toMatchObject({ path: '/home/user/projects' })
    expect(await picker.createDirectory('/home/user', 'fresh')).toBe('/home/user/fresh')
  })

  it('maps the seam\'s typed failures and folds unknown throws to internal', async () => {
    const picker = await harness(BROWSE_STUB)
    expect(await refused(picker.list('/denied', new AbortController().signal)))
      .toMatchObject({ code: 'directory-picker/unreadable', details: { path: '/denied' } })
    expect((await refused(picker.createDirectory('/home/user', 'taken'))).code).toBe('directory-picker/exists')
    expect((await refused(picker.createDirectory('/home/user', 'unwritable'))).code).toBe('gateway/internal')

    const thrown = await refused(picker.createDirectory('/home/user', 'gone'))
    expect(thrown).toMatchObject({ code: 'gateway/internal', message: 'the volume vanished' })
  })

  it('rejects invalid child names before capability dispatch', async () => {
    const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
    const picker = await harness({
      kind: 'browse',
      list: (path, signal) => BROWSE_STUB.list(path, signal),
      createDirectory,
    })

    for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await refused(picker.createDirectory('/home/user', name))
      expect(failure).toMatchObject({
        code: 'gateway/bad-request',
        message: 'invalid payload for host.createDirectory',
      })
      expect(Array.isArray(Reflect.get(failure.details, 'issues'))).toBe(true)
    }
    expect(createDirectory).not.toHaveBeenCalled()
  })

  it('reports an aborted listing as cancelled', async () => {
    const picker = await harness({
      kind: 'browse',
      list: (_path, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('scan aborted')) }, { once: true })
      }),
      createDirectory: async () => '/never',
    })
    const abort = new AbortController()
    const pending = refused(picker.list(undefined, abort.signal))
    abort.abort()
    expect((await pending).code).toBe('gateway/cancelled')
  })

  it('refuses the browse verbs under a native composition', async () => {
    const picker = await harness()
    expect(await refused(picker.list(undefined, new AbortController().signal)))
      .toMatchObject({ code: 'directory-picker/unavailable', details: { capability: 'native' } })
    expect(await refused(picker.createDirectory('/x', 'y')))
      .toMatchObject({ code: 'directory-picker/unavailable', details: { capability: 'native' } })
  })
})

/** The ancestry chain the real backend reports: every level from the root down. */
function ancestry(path: string): DirectoryEntry[] {
  const chain: DirectoryEntry[] = []
  let current = path
  for (;;) {
    const parent = dirname(current)
    chain.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return chain
    current = parent
  }
}

/** A browse backend that reports real ancestry, so crumb confinement is visible. */
const ANCESTRY_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async (path) => {
    const target = path ?? '/home/user'
    return {
      path: target,
      home: '/home/user',
      crumbs: ancestry(target),
      entries: [{ name: 'projects', path: `${target}/projects`, hidden: false }],
      truncated: false,
    }
  },
  createDirectory: async (path, name) => `${path}/${name}`,
}

describe('directoryPicker browse Remotes under a scoped caller', () => {
  const PUNIT = 'punit@rubysteels.com'

  /** The picker as one authenticated account reaches it, over its own root. */
  async function scoped() {
    await harness(ANCESTRY_STUB)
    const ctx = roots.at(-1)
    if (ctx === undefined) throw new Error('harness mounted no context')
    await ctx.plugin((pluginCtx) => {
      applyScope(pluginCtx, {
        header: 'x-auth-request-email',
        admin: [],
        users: { [PUNIT]: '/home/user' },
        provisionRoot: '',
        requireIdentity: true,
      })
    }).await()
    const peer = { id: 'peer' as PeerScope['id'], ctx: new Context() } as unknown as PeerScope
    ctx.sessionScope.remember(peer, PUNIT)
    return ctx.extend({ invocation: { peer } }).get('directoryPickerController') as DirectoryPickerController
  }

  it('opens the browser at the caller\'s own root instead of the shared home', async () => {
    const picker = await scoped()
    const listing = await picker.list(undefined, new AbortController().signal)
    expect(listing).toMatchObject({
      path: '/home/user',
      entries: [{ path: '/home/user/projects' }],
    })
  })

  it('refuses a level outside the caller\'s roots without scanning it', async () => {
    const picker = await scoped()
    const failure = await refused(picker.list('/home/other', new AbortController().signal))
    expect(failure.code).toBe('session-scope/forbidden')
    expect(failure.details).toMatchObject({ path: '/home/other' })
    expect(await refused(picker.list('/home/user2', new AbortController().signal)))
      .toMatchObject({ code: 'session-scope/forbidden' })
  })

  it('cuts the reported ancestry at the caller\'s root', async () => {
    const picker = await scoped()
    const root = await picker.list('/home/user', new AbortController().signal)
    expect(root.crumbs.map(crumb => crumb.path)).toEqual(['/home/user'])

    const deeper = await picker.list('/home/user/projects', new AbortController().signal)
    expect(deeper.crumbs.map(crumb => crumb.path)).toEqual(['/home/user', '/home/user/projects'])
  })

  it('refuses creating a directory outside the caller\'s roots', async () => {
    const picker = await scoped()
    expect(await refused(picker.createDirectory('/home/other', 'mine')))
      .toMatchObject({ code: 'session-scope/forbidden', details: { path: '/home/other/mine' } })
    expect(await refused(picker.createDirectory('/home', 'other')))
      .toMatchObject({ code: 'session-scope/forbidden', details: { path: '/home/other' } })
    expect(await picker.createDirectory('/home/user', 'site-a')).toBe('/home/user/site-a')
  })

  it('leaves an unconstrained caller with the whole host', async () => {
    const picker = await harness(ANCESTRY_STUB)
    const signal = new AbortController().signal
    expect((await picker.list('/home/other', signal)).path).toBe('/home/other')
    expect((await picker.list(undefined, signal)).path).toBe('/home/user')
    expect((await picker.list('/home/user', signal)).crumbs.map(crumb => crumb.path))
      .toEqual(['/', '/home', '/home/user'])
    expect(await picker.createDirectory('/home/other', 'mine')).toBe('/home/other/mine')
  })
})
