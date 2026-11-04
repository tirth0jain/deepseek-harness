/** Structured Session actions over the workspace owner's existing callbacks. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { MenuContribution, ContextMenuTargetMap } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {
  ArchiveSessionInjected, ForkSessionInjected, HandoffSessionInjected, PinSessionInjected, RenameSessionInjected, SessionIdInjected,
} from '../contract/slots.ts'

type Actions = Omit<PinSessionInjected & ArchiveSessionInjected, 'hooks'>
  & ForkSessionInjected & RenameSessionInjected & SessionIdInjected & HandoffSessionInjected

/**
 * Register built-in actions while retaining the legacy Slot for external components.
 * @param ctx - workspace plugin context owning menus, access, membership, and locale.
 * @param actions - shared row and dialog callbacks; execution always uses the captured Session.
 */
export function registerSessionMenus(ctx: Context, actions: Actions): void {
  const t = ctx.locale.bind('workspace')
  const register = (
    id: string,
    order: number,
    endpoints: readonly RemoteEndpoint[],
    resolve: MenuContribution<'session'>['resolve'],
  ): void => {
    ctx.effect(() => ctx.contextMenus.register({
      id: `session.${id}`, target: 'session', order,
      observe: ({ sessionId }) => [
        ctx.workspaces.list, ctx.locale,
        ...endpoints.map(action => ctx.remoteAccess.source('session', sessionId, action)),
      ],
      resolve,
    }), `ui-workspace: ${id} menu`)
  }
  const allowed = (target: ContextMenuTargetMap['session'], action: RemoteEndpoint): boolean =>
    ctx.remoteAccess.source('session', target.sessionId, action).getSnapshot()
  const archived = (target: ContextMenuTargetMap['session']): boolean =>
    ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(target.sessionId)
  register('pin', 100, ['workspace/pinSession', 'workspace/unpinSession'], (target) => {
    const pinned = ctx.workspaces.list.getSnapshot().pinnedSessionIds.includes(target.sessionId)
    if (archived(target) || !allowed(target, pinned ? 'workspace/unpinSession' : 'workspace/pinSession')) return []
    return [{
      id: 'pin', label: t(pinned ? 'menu.unpinSession' : 'menu.pinSession'), icon: { key: pinned ? 'workspace.unpin' : 'workspace.pin' },
      run: () => { (pinned ? actions.unpinSession : actions.pinSession)(target.sessionId) },
    }]
  })
  register('rename', 200, ['session/rename'], target => allowed(target, 'session/rename') ? [{
    id: 'rename', label: t('rename'), icon: { key: 'workspace.rename' }, commandId: 'session.rename' as ShortcutCommandId,
    run: () => { actions.requestSessionRename(target.sessionId, target.displayTitle) },
  }] : [])
  register('fork', 300, ['session/fork'], target => allowed(target, 'session/fork') ? [{
    id: 'fork', label: t('menu.fork'), icon: { key: 'workspace.fork' }, commandId: 'session.fork' as ShortcutCommandId,
    run: () => { actions.forkSession(target.sessionId) },
  }] : [])
  // The one row that changes what the process holds rather than what the list
  // shows: a continuation's whole history is its condensation, so the click
  // condenses the source, opens the continuation, and archives the source. It
  // sits between fork and copy-ID, where a reader looks for "the conversation
  // continues" rather than "the conversation goes away". A running Session
  // offers the row disabled: the compaction backend only runs for an idle
  // Agent, so a live click would fail after the fact. The running fact rides
  // the sessions list store, so it joins `observe` alongside the access gate.
  const sessionList = (ctx.get('sessions') as ISessions).list
  ctx.effect(() => ctx.contextMenus.register({
    id: 'session.handoff', target: 'session', order: 350,
    observe: ({ sessionId }) => [
      ctx.workspaces.list, ctx.locale, sessionList,
      ctx.remoteAccess.source('session', sessionId, 'session/handoff'),
    ],
    resolve: (target) => {
      if (!allowed(target, 'session/handoff')) return []
      const running = sessionList.getSnapshot().byId[target.sessionId]?.running ?? false
      return [{
        id: 'handoff', label: t('menu.handoff'), icon: { key: 'workspace.handoff' }, disabled: running,
        run: () => { actions.handoffSession(target.sessionId) },
      }]
    },
  }), 'ui-workspace: handoff menu')
  register('id', 450, [], target => [{
    id: 'copy', label: t('menu.sessionId'), icon: { key: 'workspace.copy' }, separatorBefore: true,
    run: () => actions.copySessionId(target.sessionId),
  }])
  register('archive', 600, ['workspace/archiveSession', 'workspace/unarchiveSession'], (target) => {
    const restoring = archived(target)
    if (!allowed(target, restoring ? 'workspace/unarchiveSession' : 'workspace/archiveSession')) return []
    return [{
      id: 'archive', label: t(restoring ? 'menu.unarchiveSession' : 'menu.archiveSession'),
      icon: { key: restoring ? 'workspace.unarchive' : 'workspace.archive' }, separatorBefore: true, afterContent: true,
      ...restoring ? {} : { commandId: 'session.archive' as ShortcutCommandId },
      run: () => { (restoring ? actions.unarchiveSession : actions.archiveSession)(target.sessionId) },
    }]
  })
}
