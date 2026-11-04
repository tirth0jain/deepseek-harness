// Browser-local memo that lets the decode-window tok/s reading survive a page
// reload. The session format persists no chunk timings, so a restored Turn
// cannot recompute the window; the turn tail records each live reading here
// under the turn's persisted end time and recalls it when the same browser
// reassembles the Turn from disk.

const MEMO_PREFIX = 'dsh.ui-chat.decode.'
/** Readings older than this are pruned on write; a reload is minutes away, not months. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

/** The slice of DOM storage the memo needs; injectable so tests need no window. */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

function memoKey(turn: number, endMs: number): string {
  return `${MEMO_PREFIX}${turn}:${endMs}`
}

function defaultStorage(): StorageLike | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/**
 * Record one turn's live decode-window rate under its turn-end key.
 * Failures (privacy modes, quota, missing window) are swallowed: the memo is a
 * reload convenience, never a correctness dependency. Each write also prunes
 * entries past the retention window.
 * @param turn - the turn number.
 * @param endMs - the persisted turn/end wall time, the key's stable half.
 * @param rate - decode-window tok/s observed live.
 * @param storage - injection seam for tests; defaults to `localStorage`.
 */
export function rememberDecodeRate(
  turn: number, endMs: number, rate: number,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (storage === undefined) return
  try {
    storage.setItem(memoKey(turn, endMs), String(rate))
    pruneDecodeMemo(storage)
  } catch { /* storage unavailable or full */ }
}

/**
 * Recall a turn's decode-window rate recorded by a previous page load.
 * @param turn - the turn number.
 * @param endMs - the persisted turn/end wall time.
 * @param storage - injection seam for tests; defaults to `localStorage`.
 * @returns the recorded rate, or undefined when absent, stale-pruned, or unparseable.
 */
export function recallDecodeRate(
  turn: number, endMs: number,
  storage: StorageLike | undefined = defaultStorage(),
): number | undefined {
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(memoKey(turn, endMs))
    if (raw === null) return undefined
    const rate = Number(raw)
    return Number.isFinite(rate) && rate > 0 ? rate : undefined
  } catch {
    return undefined
  }
}

/** Drop memo entries past the retention window; best-effort, never throws. */
function pruneDecodeMemo(storage: StorageLike): void {
  try {
    const cutoff = Date.now() - RETENTION_MS
    const stale: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || !key.startsWith(MEMO_PREFIX)) continue
      const endMs = Number(key.slice(MEMO_PREFIX.length).split(':')[1])
      if (!Number.isFinite(endMs) || endMs < cutoff) stale.push(key)
    }
    for (const key of stale) storage.removeItem(key)
  } catch { /* best effort */ }
}
