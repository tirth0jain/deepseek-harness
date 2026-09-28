/**
 * Windowed restore: a bounded read retains part of a decode and nothing else.
 *
 * The window exists so one page of a long Session costs the page instead of the
 * whole event graph, which means retention — not decoding — is what it bounds.
 * These tests pin that the collector keeps exactly the requested range, counts
 * every event it was offered, and never expands a compact run that lies wholly
 * outside the window (the case where a long log's bulk actually sits).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '../src/context.ts'
import type { SessionFormatEvent, SessionFormatEventRun } from '../src/types.ts'

/** One synthetic event carrying its own index, so retention is legible. */
function event(index: number): SessionFormatEvent {
  return { type: 'test', seq: index } as unknown as SessionFormatEvent
}

/** A compact run that records whether anything actually expanded it. */
function run(start: number, count: number, expanded: { count: number }): SessionFormatEventRun {
  return {
    runType: 'test-run',
    firstSeq: start,
    eventCount: count,
    *expand(): Iterable<SessionFormatEvent> {
      for (let index = start; index < start + count; index++) {
        expanded.count += 1
        yield event(index)
      }
    },
  }
}

describe('windowed SessionFormatEventCollector', () => {
  it('retains every event when no window is given', () => {
    const collector = new SessionFormatEventCollector()
    for (let index = 0; index < 5; index++) collector.emitEvent(event(index))
    expect(collector.values).toHaveLength(5)
    expect(collector.values.map(value => value.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('retains only the requested range of emitted events', () => {
    const collector = new SessionFormatEventCollector({ from: 2, length: 3 })
    for (let index = 0; index < 8; index++) collector.emitEvent(event(index))
    expect(collector.values.map(value => value.seq)).toEqual([2, 3, 4])
  })

  it('retains nothing when the window starts past the end', () => {
    const collector = new SessionFormatEventCollector({ from: 10, length: 4 })
    for (let index = 0; index < 8; index++) collector.emitEvent(event(index))
    expect(collector.values).toEqual([])
  })

  it('keeps a zero-length window empty', () => {
    const collector = new SessionFormatEventCollector({ from: 3, length: 0 })
    for (let index = 0; index < 8; index++) collector.emitEvent(event(index))
    expect(collector.values).toEqual([])
  })

  it('never expands a compact run lying wholly outside the window', () => {
    const expanded = { count: 0 }
    const collector = new SessionFormatEventCollector({ from: 100, length: 2 })
    collector.emitRun(run(0, 50, expanded))
    collector.emitRun(run(50, 50, expanded))
    expect(expanded.count).toBe(0)
    expect(collector.values).toEqual([])
    // The skipped runs still advance the position, so the window below lands on
    // the right events rather than being offset by what was never expanded.
    collector.emitRun(run(100, 4, expanded))
    expect(collector.values.map(value => value.seq)).toEqual([100, 101])
    expect(expanded.count).toBe(4)
  })

  it('expands only the overlapping run when the window straddles one', () => {
    const expanded = { count: 0 }
    const collector = new SessionFormatEventCollector({ from: 48, length: 4 })
    collector.emitRun(run(0, 50, expanded))
    expect(expanded.count).toBe(50)
    expect(collector.values.map(value => value.seq)).toEqual([48, 49])
    collector.emitRun(run(50, 10, expanded))
    expect(collector.values.map(value => value.seq)).toEqual([48, 49, 50, 51])
  })

  it('mixes emitted events and runs on one positional index', () => {
    const expanded = { count: 0 }
    const collector = new SessionFormatEventCollector({ from: 2, length: 2 })
    collector.emitEvent(event(0))
    collector.emitEvent(event(1))
    collector.emitRun(run(2, 5, expanded))
    collector.emitEvent(event(7))
    expect(collector.values.map(value => value.seq)).toEqual([2, 3])
  })
})
