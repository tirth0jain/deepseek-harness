/**
 * Debounced Host persistence of one Session's composer draft.
 *
 * The browser store already keeps the draft locally; this writes the same text
 * to the Host so an unsent prompt outlives the process that served it. Writes
 * are debounced per Session and never awaited by the composer: a refused write
 * leaves the browser copy authoritative, and the next keystroke tries again.
 * @module @deepseek-ai/dsh-client-ui-conversation/client/draft-sync
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'

/** Quiet period after the last keystroke before one Session's draft is written. */
export const DRAFT_SYNC_DEBOUNCE_MS = 500

/** One Session's queued write. */
interface PendingWrite {
  readonly session: SessionFace
  readonly text: string
  readonly timer: ReturnType<typeof setTimeout>
}

/** Debounced, fail-soft Host writes of composer drafts. */
export class ComposerDraftSync {
  private readonly pending = new Map<SessionId, PendingWrite>()

  /**
   * @param debounceMs - quiet period before a scheduled write lands.
   */
  constructor(private readonly debounceMs: number = DRAFT_SYNC_DEBOUNCE_MS) {}

  /**
   * Queue one Session's draft for a Host write, replacing any write still
   * inside its quiet period.
   * @param session - the Session whose draft changed.
   * @param text - the complete current draft text.
   */
  schedule(session: SessionFace, text: string): void {
    const existing = this.pending.get(session.sessionId)
    if (existing !== undefined) clearTimeout(existing.timer)
    const timer = setTimeout(() => { this.flush(session.sessionId) }, this.debounceMs)
    this.pending.set(session.sessionId, { session, text, timer })
  }

  /**
   * Write one Session's queued draft immediately.
   * @param sessionId - the Session whose queued write is flushed.
   */
  flush(sessionId: SessionId): void {
    const write = this.pending.get(sessionId)
    if (write === undefined) return
    this.pending.delete(sessionId)
    clearTimeout(write.timer)
    void write.session.setComposerDraft(write.text).catch(() => {
      /* Fail-soft: the browser copy is authoritative when the Host refuses a write. */
    })
  }

  /** Drop every queued write; the browser copies stay authoritative. */
  dispose(): void {
    for (const write of this.pending.values()) clearTimeout(write.timer)
    this.pending.clear()
  }
}
