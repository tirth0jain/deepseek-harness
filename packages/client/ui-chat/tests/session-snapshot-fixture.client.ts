/**
 * Scripted Session snapshot for specs that mount a session-scope surface
 * directly. The composer dock's load control reads only `hasMore` from it, but
 * the framework hands the component the real `SessionSnapshotSelector`, so a
 * partial stand-in would need a cast; building the whole snapshot keeps the
 * spec honest about what the slot is given at runtime.
 */

import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'

const SID = 's1' as SessionId

/** One Session snapshot with every field stated; `hasMore` is the one under test. */
export function sessionSnapshotFixture(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SID,
    queue: [],
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open',
    openError: null,
    baseSeq: SessionSeq(0),
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

/** A `useSession` seat over a fixed snapshot; the dock's control only reads it. */
export function sessionSelector(overrides: Partial<SessionSnapshot> = {}) {
  const snap = sessionSnapshotFixture(overrides)
  return {
    getSnapshot: () => snap,
    subscribe: () => () => {},
  }
}
