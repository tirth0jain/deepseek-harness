import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatEventWindow,
  SessionFormatMigrationContext,
} from './types.ts'

/** Migration output context that expands compact runs into retained events. */
export class SessionFormatEventCollector implements SessionFormatMigrationContext {
  /** Events retained by this collector in source order. */
  readonly values: SessionFormatEvent[] = []
  /** Expanded events offered by the upstream stage, retained or not. */
  private offered = 0

  /**
   * @param window - expanded-event range to retain; absent retains every event.
   */
  constructor(private readonly window?: SessionFormatEventWindow) {}

  /**
   * Retain one settled event.
   * @param event - settled event emitted by the upstream stage.
   */
  emitEvent(event: SessionFormatEvent): void {
    const index = this.offered++
    if (this.retains(index)) this.values.push(event)
  }

  /**
   * Expand one compact run directly into retained events. A run lying wholly
   * outside the window is counted from its declared length and never expanded:
   * the point of a window is to not build what it does not keep, and a compact
   * run is exactly where a long log's bulk sits.
   * @param run - compact event run emitted by the upstream stage.
   */
  emitRun(run: SessionFormatEventRun): void {
    const start = this.offered
    if (this.window === undefined) {
      for (const event of run.expand()) {
        this.offered += 1
        this.values.push(event)
      }
      return
    }
    const end = start + run.eventCount
    if (end <= this.window.from || start >= this.window.from + this.window.length) {
      this.offered = end
      return
    }
    for (const event of run.expand()) {
      const index = this.offered
      this.offered += 1
      if (this.retains(index)) this.values.push(event)
    }
  }

  /**
   * Whether one expanded-event index falls inside the active window.
   * @param index - zero-based expanded event index.
   * @returns true when the event belongs in {@link values}.
   */
  private retains(index: number): boolean {
    if (this.window === undefined) return true
    return index >= this.window.from && index < this.window.from + this.window.length
  }
}
