/**
 * Handoff refusals that outlive the click that caused them.
 *
 * A handoff can refuse — no compaction backend, a busy Agent, nothing worth
 * condensing, a backend fault — and each of those leaves the source Session
 * untouched, so the only thing the clicker needs is to be told which one it
 * was. Reporting that through the row that was clicked would lose it the
 * moment the list re-renders, so the failure is held here and rendered by a
 * frame-wide seat instead. Silence is the one outcome a caller cannot act on.
 *
 * @module @deepseek-ai/dsh-client-ui-workspace/client/handoff-notice
 */

import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One handoff refusal, classified for display. */
export interface HandoffFailure {
  /** Stable identity for dismissal. */
  readonly id: number
  /**
   * The Host-named precondition token (`no-compaction-command`,
   * `compaction-refused`, …), absent when the failure carried no class at all.
   */
  readonly reason?: string
  /** The Host's own message; wire prose passes through untranslated by policy. */
  readonly message: string
}

/** Reporting face the workspace wiring holds. */
export interface HandoffFailures {
  /** Current failures, oldest first. */
  readonly failures: SnapshotStore<readonly HandoffFailure[]>
  /** @param error - whatever the handoff rejected with. */
  report(error: unknown): void
  /** @param id - the failure to drop. */
  dismiss(id: number): void
}

/**
 * The Remote failure a thrown client error carries, when it carries one. The
 * client's own error classes are not imported for this: a failure that names
 * its Host class is recognized by the class it names, not by the wrapper the
 * caller happened to receive it in.
 */
function rpcFailureOf(error: unknown): RemoteFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const carried = (error as { rpcError?: unknown }).rpcError
  if (typeof carried !== 'object' || carried === null || !('code' in carried)) return undefined
  return carried as RemoteFailure
}

/**
 * Classify one failed handoff.
 * @param error - whatever the handoff rejected with.
 * @returns the Host's reason token when it named one, and its message.
 */
export function handoffFailureOf(error: unknown): Omit<HandoffFailure, 'id'> {
  const failure = rpcFailureOf(error)
  if (failure?.code === 'session/handoff-unavailable') {
    return { reason: failure.details.reason, message: failure.message }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

/**
 * Create the frame-wide handoff failure store.
 * @returns the store, its observable failures, and the reporting face.
 */
export function createHandoffFailures(): HandoffFailures {
  const failures = createSnapshotStore<readonly HandoffFailure[]>([])
  let nextId = 0
  return {
    failures,
    report: (error) => {
      failures.set([...failures.getSnapshot(), { id: nextId++, ...handoffFailureOf(error) }])
    },
    dismiss: (id) => {
      failures.set(failures.getSnapshot().filter(failure => failure.id !== id))
    },
  }
}
