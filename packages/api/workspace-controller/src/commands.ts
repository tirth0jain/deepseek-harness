/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import { assertVisibility, type PathVisibility } from '@deepseek-ai/dsh-session-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest, maySee?: PathVisibility): Promise<WorkspaceCreateValue> {
    // Registering somebody else's directory would put its Sessions in this
    // caller's sidebar and theirs in this caller's reach.
    return this.enqueue(async () => {
      assertVisibility(maySee, request.path, 'the requested Workspace directory')
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   *
   * The conflict check is confined to the Workspaces this caller can see: a
   * title is only "in use" for somebody who could actually be looking at the
   * other one, and a global check would both leak other callers' titles and
   * stop two accounts naming their own directories the same thing.
   * @param request - Workspace identity and proposed title.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest, maySee?: PathVisibility): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireVisibleWorkspace(request.workspaceId, maySee)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title
          && (maySee === undefined || maySee(candidate.path)))) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest, maySee?: PathVisibility): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      // Checked before the removal: afterwards there is no path left to check,
      // and a caller who may not read a Workspace may not unregister it either.
      this.requireVisibleWorkspace(request.workspaceId, maySee)
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   *
   * The order is one list for the whole registry, so a caller may only move a
   * Workspace it owns and may only anchor against one it can see.
   * @param request - moved Workspace and optional anchor.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest, maySee?: PathVisibility): Promise<WorkspaceOrderValue> {
    this.requireVisibleWorkspace(request.workspaceId, maySee)
    if (request.beforeWorkspaceId !== undefined) {
      this.requireVisibleWorkspace(request.beforeWorkspaceId, maySee)
    }
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(
    request: WorkspaceInsertSessionBeforeRequest,
    maySee?: PathVisibility,
  ): Promise<WorkspaceValue> {
    const workspace = this.requireVisibleWorkspace(request.workspaceId, maySee)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   *
   * Archiving hides a Session from whoever can see it, so reaching another
   * account's Session here is a write to that account's sidebar.
   * @param request - Session identity to archive and whether to stop its work.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest, maySee?: PathVisibility): Promise<WorkspaceArchiveValue> {
    this.assertSessionVisible(request.sessionId, maySee)
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest, maySee?: PathVisibility): Promise<WorkspaceArchiveValue> {
    this.assertSessionVisible(request.sessionId, maySee)
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest, maySee?: PathVisibility): Promise<WorkspacePinValue> {
    this.assertSessionVisible(request.sessionId, maySee)
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest, maySee?: PathVisibility): Promise<WorkspacePinValue> {
    this.assertSessionVisible(request.sessionId, maySee)
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  /**
   * Resolve one Workspace the caller owns.
   *
   * A Workspace belonging to somebody else answers exactly as one that does
   * not exist: the caller cannot see it, so an id that names it is not a thing
   * this caller gets to learn about.
   * @param workspaceId - Workspace identity to resolve.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @returns the Workspace.
   * @throws RemoteError when the Workspace is unknown or is not the caller's.
   */
  private requireVisibleWorkspace(workspaceId: WorkspaceId, maySee?: PathVisibility): Workspace {
    const workspace = this.requireWorkspace(workspaceId)
    if (maySee !== undefined && !maySee(workspace.path)) throw workspaceNotFound(workspaceId)
    return workspace
  }

  /**
   * Refuse a Session the caller does not own.
   *
   * Ownership is read from the Workspace that accounts for the Session rather
   * than from its own header: the registry already holds the canonical path
   * that decided whether the caller could see the Session in the first place.
   * As with Workspaces, a Session that is not the caller's is reported missing.
   * @param sessionId - the Session being reached.
   * @param maySee - the caller's visibility, or undefined when unconstrained.
   * @throws RemoteError when the caller is constrained and the Session is not theirs.
   */
  private assertSessionVisible(sessionId: SessionId, maySee?: PathVisibility): void {
    if (maySee === undefined) return
    const owner = this.ctx.workspaceRegistry.list()
      .find(workspace => workspace.sessionIds.includes(sessionId))
    // No Workspace accounts for this id, so there is no path to judge it by:
    // the registry's own not-found arm answers the call either way.
    if (owner === undefined || maySee(owner.path)) return
    throw new RemoteError('session/not-found', `Session "${sessionId}" not found`, { sessionId })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
