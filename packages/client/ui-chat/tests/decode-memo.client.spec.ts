// The browser-local memo that carries decode-window rates across a reload.

import { describe, expect, it } from 'vitest'
import { recallDecodeRate, rememberDecodeRate } from '../src/client/conversation-nodes/decode-memo.ts'

/** Map-backed stand-in for DOM storage. */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    get length(): number { return map.size },
    getItem(key: string): string | null { return map.get(key) ?? null },
    setItem(key: string, value: string): void { map.set(key, String(value)) },
    removeItem(key: string): void { map.delete(key) },
    key(index: number): string | null { return [...map.keys()][index] ?? null },
  }
}

describe('decode memo', () => {
  it('round-trips a live reading by turn and end time', () => {
    const storage = fakeStorage()
    const endMs = Date.now()
    rememberDecodeRate(7, endMs, 332.5, storage)
    expect(recallDecodeRate(7, endMs, storage)).toBe(332.5)
    expect(recallDecodeRate(7, endMs + 1, storage)).toBeUndefined()
    expect(recallDecodeRate(8, endMs, storage)).toBeUndefined()
  })

  it('recalls nothing for corrupt, zero, or negative stored values', () => {
    const storage = fakeStorage()
    storage.setItem('dsh.ui-chat.decode.1:100', 'not-a-number')
    storage.setItem('dsh.ui-chat.decode.2:200', '0')
    storage.setItem('dsh.ui-chat.decode.3:300', '-40')
    expect(recallDecodeRate(1, 100, storage)).toBeUndefined()
    expect(recallDecodeRate(2, 200, storage)).toBeUndefined()
    expect(recallDecodeRate(3, 300, storage)).toBeUndefined()
  })

  it('tolerates missing storage and prunes entries past the retention window', () => {
    expect(recallDecodeRate(1, 1_000, undefined)).toBeUndefined()
    expect(() => rememberDecodeRate(1, 1_000, 40, undefined)).not.toThrow()
    const storage = fakeStorage()
    const monthOld = Date.now() - 31 * 24 * 60 * 60 * 1_000
    rememberDecodeRate(1, monthOld, 40, storage)
    rememberDecodeRate(2, Date.now(), 80, storage)
    expect(recallDecodeRate(1, monthOld, storage)).toBeUndefined()
    expect(recallDecodeRate(2, Date.now(), storage)).toBe(80)
    expect(storage.length).toBe(1)
  })
})
