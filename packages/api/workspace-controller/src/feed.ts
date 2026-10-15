/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { PathVisibility } from '@deepseek-ai/dsh-session-scope'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState,
  workspaceRecord,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Owns Workspace domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private knownIds: Set<string>
  private order: readonly string[]
  private archived: readonly string[]
  private pinned: readonly string[]

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    const baseline = ctx.workspaceRegistry.list()
    this.knownIds = new Set(baseline.map(workspace => String(workspace.id)))
    this.order = baseline.map(workspace => String(workspace.id))
    this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    this.pinned = ctx.workspaceRegistry.pinnedSessionIds.map(String)
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @param maySee - the caller's Workspace-path visibility, or undefined when
   *   this deployment does not scope Workspaces to users.
   * @returns all visible Workspaces plus archived and pinned Session identities.
   */
  baseline(maySee?: PathVisibility): WorkspaceBaseline {
    const items = this.ctx.workspaceRegistry.list()
      .filter(workspace => maySee === undefined || maySee(workspace.path))
      .map(workspaceView)
    return {
      items,
      // Archive and pin are registry-global sets: knowing which Sessions
      // elsewhere are archived is somebody else's business, so a scoped caller
      // gets neither rather than a filtered guess.
      archivedSessionIds: maySee === undefined ? [...this.ctx.workspaceRegistry.archivedSessionIds] : [],
      pinnedSessionIds: maySee === undefined ? [...this.ctx.workspaceRegistry.pinnedSessionIds] : [],
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @param maySee - the caller's Workspace-path visibility, or undefined when
   *   this deployment does not scope Workspaces to users.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal, maySee?: PathVisibility): AsyncIterable<WorkspaceFollowFrame> {
    signal.throwIfAborted()
    const baseline = this.baseline(maySee)
    const follower = new WorkspaceFollower(maySee, baseline.items.map(item => String(item.workspaceId)))
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: baseline }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace') return
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceDomainState.parse(change.value)
      const nextOrder = state.workspaceIds.map(String)
      const orderChanged = !sameStrings(this.order, nextOrder)
      for (const id of state.workspaceIds) {
        if (this.knownIds.has(id)) continue
        const workspace = this.ctx.workspaceRegistry.get(id)
        if (workspace === undefined) {
          throw new Error(`committed Workspace registry references missing Workspace "${id}"`)
        }
        this.knownIds.add(id)
        this.publish({ type: 'upsert', workspace: workspaceView(workspace) })
      }
      this.order = nextOrder
      if (orderChanged) this.publish({ type: 'order', workspaceIds: [...state.workspaceIds] })
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(this.archived, nextArchived)) {
        this.archived = nextArchived
        this.publish({ type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(this.pinned, nextPinned)) {
        this.pinned = nextPinned
        this.publish({ type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      if (!this.knownIds.delete(change.key)) return
      this.publish({ type: 'remove', workspaceId: WorkspaceId(change.key) })
      return
    }
    if (!this.knownIds.has(change.key)) return
    this.publish({
      type: 'upsert',
      workspace: changedWorkspaceView(change.key, change.value),
    })
  }

  private publish(frame: Exclude<WorkspaceFollowFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFollowFrame>()
  private readonly visible: Set<string>
  private waiting: (() => void) | undefined
  private closed = false

  /**
   * @param maySee - the caller's Workspace-path visibility, or undefined when unconstrained.
   * @param initial - Workspace identities this caller's baseline already carried.
   */
  constructor(
    private readonly maySee?: PathVisibility,
    initial: readonly string[] = [],
  ) {
    this.visible = new Set(initial)
  }

  push(frame: WorkspaceFollowFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    const admitted = this.admit(frame)
    if (admitted === undefined) return
    this.frames.pushBack(admitted)
    this.waiting?.()
  }

  /**
   * Apply this follower's visibility to one increment.
   *
   * An order frame carries identities only, so it is narrowed to the Workspaces
   * this follower was actually shown rather than re-tested against a path it
   * does not have. Archive and pin frames are withheld outright: both sets are
   * registry-global, and the baseline already tells a scoped caller they are empty.
   * @param frame - the frame about to be published.
   * @returns the frame this follower may receive, or undefined to withhold it.
   */
  private admit(frame: WorkspaceFollowFrame): WorkspaceFollowFrame | undefined {
    if (this.maySee === undefined || frame.type === 'baseline') return frame
    switch (frame.type) {
      case 'upsert': {
        const workspaceId = String(frame.workspace.workspaceId)
        const allowed = this.maySee(frame.workspace.path)
        if (allowed) this.visible.add(workspaceId)
        else this.visible.delete(workspaceId)
        return allowed ? frame : undefined
      }
      case 'remove':
        this.visible.delete(String(frame.workspaceId))
        return frame
      case 'order':
        return {
          type: 'order',
          workspaceIds: frame.workspaceIds.filter(id => this.visible.has(String(id))),
        }
      case 'archived':
      case 'pinned':
        return undefined
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
