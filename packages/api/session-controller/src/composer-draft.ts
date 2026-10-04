/**
 * Durable per-Session composer drafts: the input a reader has typed but not
 * sent.
 *
 * A draft is not Session history. It reaches no model, so it never enters the
 * log; it lives in its own storage domain beside the Session projection cache.
 * Persisting it is what lets an unsent prompt survive a harness restart, which
 * a browser-local draft cannot.
 *
 * Every operation is fail-soft. A composition that mounts no storage, or a
 * medium that refuses a write, leaves the draft in the browser where it
 * started: a draft that cannot be archived never fails the composer.
 * @module @deepseek-ai/dsh-api-session-controller/composer-draft
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Longest draft text one record keeps. The cap bounds what one pathological
 * paste can cost the medium; text beyond it is dropped from the stored copy
 * while the browser keeps the complete draft, which stays authoritative for
 * display.
 */
export const COMPOSER_DRAFT_MAX_CHARS = 100_000

/** One Session's stored draft. */
export const composerDraftRecord = z.object({
  text: z.string().max(COMPOSER_DRAFT_MAX_CHARS),
  updatedAt: z.number().int().nonnegative(),
})

/** One stored draft record, inferred from {@link composerDraftRecord}. */
export type ComposerDraftRecord = z.infer<typeof composerDraftRecord>

/**
 * The composer-draft domain spec. The `per-record` layout keeps one document
 * per Session, so a debounced keystroke write rewrites one Session's draft
 * rather than the whole unit. Records are disposable: one that fails the schema
 * is moved aside instead of costing the boot, and a lost draft is the same
 * draft the browser still holds.
 */
export const composerDraftDomainSpec = defineDomain({
  name: 'composer_drafts',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { drafts: domainTable<SessionId, ComposerDraftRecord>(composerDraftRecord) },
})

/**
 * Read and write one Session's durable composer draft.
 *
 * The domain opens on first use, not at construction: a deployment that mounts
 * no storage keeps working, and the open cost is paid by the first composer
 * that actually has a draft to archive.
 */
export class ComposerDraftStore {
  private table?: KvTable<SessionId, ComposerDraftRecord>
  private opening?: Promise<KvTable<SessionId, ComposerDraftRecord> | undefined>

  /**
   * @param ctx - host context; the storage facility is resolved at call time
   *   because a composition may mount none.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * The draft table, opening the domain once.
   * @returns the table, or `undefined` when no storage form is mounted.
   */
  private async open(): Promise<KvTable<SessionId, ComposerDraftRecord> | undefined> {
    if (this.table !== undefined) return this.table
    this.opening ??= this.openDomain()
    return this.opening
  }

  private async openDomain(): Promise<KvTable<SessionId, ComposerDraftRecord> | undefined> {
    const storageDomain = this.ctx.get('storageDomain')
    if (storageDomain === undefined) return undefined
    const domain = await storageDomain.open(composerDraftDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'session-controller: composer-draft domain close')
    this.table = domain.table('drafts')
    return this.table
  }

  /**
   * The stored draft for one Session.
   * @param sessionId - the Session whose draft is read.
   * @returns the stored text, or `''` when nothing is stored or no storage is mounted.
   */
  async read(sessionId: SessionId): Promise<string> {
    try {
      return (await this.open())?.get(sessionId)?.text ?? ''
    } catch (error: unknown) {
      this.warn(`read for "${sessionId}" failed`, error)
      return ''
    }
  }

  /**
   * Store one Session's draft. An empty draft deletes the record, so a sent
   * prompt leaves nothing behind.
   * @param sessionId - the Session whose draft is written.
   * @param text - the complete draft text.
   * @returns completion after durability, or after a logged no-op when no storage is mounted.
   */
  async write(sessionId: SessionId, text: string): Promise<void> {
    try {
      const table = await this.open()
      if (table === undefined) return
      if (text === '') {
        await table.delete(sessionId)
        return
      }
      await table.put(sessionId, { text: text.slice(0, COMPOSER_DRAFT_MAX_CHARS), updatedAt: Date.now() })
    } catch (error: unknown) {
      this.warn(`write for "${sessionId}" failed`, error)
    }
  }

  private warn(operation: string, error: unknown): void {
    this.ctx.logger.warn(`composer draft ${operation}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
