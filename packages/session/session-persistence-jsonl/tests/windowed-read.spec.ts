/**
 * Bounded reads: `SessionHandle.read(offset, length)` must retain only the range
 * it was asked for.
 *
 * The seam contract already promised that an offset at or past the end returns
 * an empty list, which only means something if the read is bounded — decoding an
 * entire log in order to slice it satisfies the letter and not the point. These
 * tests pin the retention behaviour, the validation that has to survive it, and
 * the handoff-memo isolation that stops a window from masquerading as a log.
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath, sessionDir, toHeaderLine } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const OPEN_TURNS = 12
const UNIT = oneTurnLog()
const LOG_LENGTH = OPEN_TURNS * UNIT.length

/**
 * A long, well-formed log: the one-turn fixture repeated with rescoped turn
 * numbers and contiguous sequences, so a window is always a strict subset.
 * @param turns - number of turns to emit.
 * @returns the complete event list.
 */
function longLog(turns = OPEN_TURNS): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 0; turn < turns; turn++) {
    for (const event of UNIT) {
      const data = event.type === 'turn/start' || event.type === 'turn/end'
        || event.type === 'step/start' || event.type === 'step/end'
        ? { ...(event.data as Record<string, unknown>), turn: turn + 1 }
        : event.data
      events.push({ ...event, seq: SessionSeq(events.length), data } as SessionEvent)
    }
  }
  return events
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map(dispose => dispose()))
})

/** Mount one JSONL backend over a fresh temporary root. */
async function mount(compression: 'none' | 'zstd'): Promise<{ persistence: SessionPersistence; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-window-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression })
  disposers.push(async () => {
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { persistence: ctx.sessionPersistence, root }
}

/** Create one durable generation through the supported write path. */
async function seed(persistence: SessionPersistence, header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

for (const compression of ['none', 'zstd'] as const) {
  describe(`bounded JSONL reads (${compression})`, () => {
    it('retains exactly the requested window', async () => {
      const { persistence } = await mount(compression)
      const header = meta(`window-${compression}`, '/work')
      const events = longLog()
      await seed(persistence, header, events)
      const handle = await persistence.open(header.id, 'read')
      try {
        const window = await handle.read(10, 5)
        expect(window.events).toEqual(events.slice(10, 15))
        expect(window.eventState).toBe('shared-frozen')
        // The retained events are the log's own positions, not a re-based copy.
        expect(window.events.map(event => Number(event.seq))).toEqual([10, 11, 12, 13, 14])
        const single = await handle.read(LOG_LENGTH - 1, 1)
        expect(single.events).toEqual(events.slice(LOG_LENGTH - 1))
      } finally {
        await handle.close()
      }
    })

    it('returns an empty list at or past the end without widening the read', async () => {
      const { persistence } = await mount(compression)
      const header = meta(`window-end-${compression}`, '/work')
      await seed(persistence, header, longLog())
      const handle = await persistence.open(header.id, 'read')
      try {
        expect((await handle.read(LOG_LENGTH, 5)).events).toEqual([])
        expect((await handle.read(LOG_LENGTH + 100, 5)).events).toEqual([])
        expect((await handle.read(2, 0)).events).toEqual([])
      } finally {
        await handle.close()
      }
    })

    it('returns the complete log for an unbounded read', async () => {
      const { persistence } = await mount(compression)
      const header = meta(`window-all-${compression}`, '/work')
      const events = longLog()
      await seed(persistence, header, events)
      const handle = await persistence.open(header.id, 'read')
      try {
        const read = await handle.read()
        expect(read.events).toEqual(events)
        expect(read.events).toHaveLength(LOG_LENGTH)
      } finally {
        await handle.close()
      }
    })

    it('never serves a retained window to a later full read', async () => {
      const { persistence } = await mount(compression)
      const header = meta(`window-memo-${compression}`, '/work')
      const events = longLog()
      await seed(persistence, header, events)
      const handle = await persistence.open(header.id, 'read')
      try {
        // A window first, so a memo keyed only by session id would be poisoned
        // with a five-event list and the full read below would return it.
        expect((await handle.read(4, 5)).events).toHaveLength(5)
        expect((await handle.read()).events).toHaveLength(LOG_LENGTH)
        expect((await handle.read(0, LOG_LENGTH)).events).toHaveLength(LOG_LENGTH)
      } finally {
        await handle.close()
      }
    })

    it('does not false-trip the shrink check when windowing after a full read', async () => {
      const { persistence } = await mount(compression)
      const header = meta(`window-shrink-${compression}`, '/work')
      await seed(persistence, header, longLog())
      const handle = await persistence.open(header.id, 'read')
      try {
        expect((await handle.read()).events).toHaveLength(LOG_LENGTH)
        // The observed length is the complete log's, which a window reports
        // from its own count rather than from what it retained.
        expect((await handle.read(2, 3)).events).toHaveLength(3)
        expect((await handle.read(LOG_LENGTH - 2, 9)).events).toHaveLength(2)
      } finally {
        await handle.close()
      }
    })

    it('still validates a damaged row that lies outside the retained window', async () => {
      const { persistence, root } = await mount('none')
      const header = meta(`window-damage-${compression}`, '/work')
      await mkdir(sessionDir(root, header.cwd, header.id), { recursive: true })
      const lines = [JSON.stringify(toHeaderLine(header))]
      for (let seq = 0; seq < 30; seq++) {
        lines.push(seq === 3
          // A type this build does not know and that is not marked ignorable:
          // the storage contract must refuse the log, window or no window.
          ? JSON.stringify({ type: 'future/unknown-event', seq, time: seq, data: {} })
          : JSON.stringify({ type: 'turn/start', seq, time: seq, data: { turn: 1 } }))
      }
      await writeFile(logPath(root, header.cwd, header.id, 'none'), `${lines.join('\n')}\n`)
      // The refusal may land at open or at the read; what matters is that a
      // damaged row at seq 3 is never quietly skipped because the caller only
      // asked for seq 20 onward.
      await expect((async () => {
        const handle = await persistence.open(header.id, 'read')
        try {
          await handle.read(20, 5)
        } finally {
          await handle.close()
        }
      })()).rejects.toThrow(/unknown to this harness/)
    })
  })
}
