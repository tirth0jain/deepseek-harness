/**
 * ComposerDraftStore behavior: one Session's draft round-trips through the
 * storage domain, an empty write clears the record, drafts stay apart per
 * Session, the stored copy is bounded, a stored draft survives the process that
 * wrote it, and a deployment that mounts no storage degrades to no durability
 * instead of failing the composer.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { COMPOSER_DRAFT_MAX_CHARS, ComposerDraftStore } from '../src/composer-draft.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

const sessionId = SessionId('session-composer-draft')

/**
 * One host context and store. The storage stack mounts under `root`, or not at
 * all when the caller asks for a deployment without storage.
 * @param storage - whether to mount the storage hub, json backend, and domain form.
 * @param root - reuse a medium root instead of a fresh temporary directory.
 * @returns the context, the medium root, and the store under test.
 */
async function harness(storage = true, root?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  if (!storage) return { ctx, root: undefined, store: new ComposerDraftStore(ctx) }
  const medium = root ?? await mkdtemp(join(tmpdir(), 'dsh-composer-draft-'))
  if (root === undefined) roots.push(medium)
  await ctx.plugin(Storage)
  await ctx.plugin(
    { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root: medium },
  )
  await ctx.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
  return { ctx, root: medium, store: new ComposerDraftStore(ctx) }
}

describe('ComposerDraftStore', () => {
  it('round-trips one Session draft and clears it with an empty write', async () => {
    const { store } = await harness()
    expect(await store.read(sessionId)).toBe('')
    await store.write(sessionId, 'half-written prompt')
    expect(await store.read(sessionId)).toBe('half-written prompt')
    await store.write(sessionId, '')
    expect(await store.read(sessionId)).toBe('')
  })

  it('keeps one Session draft out of another', async () => {
    const { store } = await harness()
    const other = SessionId('session-composer-draft-other')
    await store.write(sessionId, 'first')
    await store.write(other, 'second')
    expect(await store.read(sessionId)).toBe('first')
    expect(await store.read(other)).toBe('second')
  })

  it('survives the process that wrote it', async () => {
    const first = await harness()
    await first.store.write(sessionId, 'unsent prompt')
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    const second = await harness(true, first.root)
    expect(await second.store.read(sessionId)).toBe('unsent prompt')
  })

  it('bounds the stored copy of one pathological paste', async () => {
    const { store } = await harness()
    await store.write(sessionId, 'x'.repeat(COMPOSER_DRAFT_MAX_CHARS + 10))
    expect(await store.read(sessionId)).toHaveLength(COMPOSER_DRAFT_MAX_CHARS)
  })

  it('stores nothing, and fails nothing, without a storage form', async () => {
    const { store } = await harness(false)
    await expect(store.write(sessionId, 'unsent prompt')).resolves.toBeUndefined()
    expect(await store.read(sessionId)).toBe('')
  })
})
