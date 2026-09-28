/**
 * The handoff action: one `sidebar.workspaces.session.menu.item` row.
 *
 * The one row action that changes what the process holds rather than what the
 * list shows: a continuation's whole history is its condensation, so the click
 * condenses the source, opens the continuation, and archives the source. The
 * source is condensed through its own compaction backend, which only runs for
 * an idle Agent — so a running Session offers the row disabled rather than
 * letting the click fail after the fact.
 */
import { IconCompactOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HandoffSessionInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Menu row (order 350, between fork and archive): continue the Session in a
 * condensed new one. The running fact is read the way the row's own state dot
 * reads it: the live UI status first, then the list summary's fallback.
 * @param props - owner share, menu open state, the standard status hooks, and the handoff share.
 * @returns the row.
 */
export function HandoffSessionMenuItem({
  sessionId, useMenuOpenState, useSessionStatus, useSessions, handoffSession, t,
}: SessionMenuItemProps<HandoffSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const statusRunning = useSessionStatus(statuses => statuses.get(sessionId)?.running)
  const listRunning = useSessions(list => list.byId[sessionId]?.running ?? false)
  const running = statusRunning ?? listRunning
  return (
    <MenuItemButton
      icon={<IconCompactOutlineRegular />}
      disabled={running}
      onSelect={() => {
        setMenuOpen(false)
        handoffSession(sessionId)
      }}
    >
      {t('menu.handoff')}
    </MenuItemButton>
  )
}
