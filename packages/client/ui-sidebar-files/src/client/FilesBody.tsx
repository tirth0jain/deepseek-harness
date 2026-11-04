/**
 * The `files` page: a file browser with no file chosen yet.
 *
 * Its header spans the page: the workspace root's path, the tree's reload and
 * the directory actions, in the order a preview's header ends with its own
 * reload and file actions. The pane's navigator fills the page below it and
 * stays shown, so the page draws no toggle; picking a file leaves this page as
 * it is and opens the file where the right Sidebar places it by default
 * (`FileNavigator`).
 */
import { useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconDownloadOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular, PathLabel, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilesInjected } from './face.ts'
import type {} from './FileNavigator.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { TreeEntry } from './FileTree.tsx'
import type {} from './locales.ts'
import type { createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The page's composed props: the tab it draws, its directory-actions seat, the pane records and the tree's face, and copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsRenderFactories
  & PropsStore<ReturnType<typeof createFilesStore>>
  & InjectFace<FilesInjected>
  & PropsLocale<'sidebarFiles'>

/**
 * Authenticated byte route owned by the Session Controller.
 *
 * Every path in the tree is absolute — the root comes from the Session's
 * workspace — so the route can read a row directly, with no session-relative
 * resolution to do here.
 */
const FILE_BYTES_PATH = '/api/file'

/**
 * Same-origin URL that saves one listed file.
 *
 * A page with no HTTP origin — an Electron `file://` shell — has no API to
 * address, so it gets no URL and the row shows no save control rather than a
 * broken one.
 * @param page - the page's own transport and origin.
 * @param path - the row's absolute path.
 * @param name - the filename to save under.
 * @returns the download URL, or undefined when the page cannot address the API.
 */
export function workspaceFileDownloadUrl(
  page: { readonly protocol: string; readonly origin: string },
  path: string,
  name: string,
): string | undefined {
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return undefined
  return `${page.origin}${FILE_BYTES_PATH}?${new URLSearchParams({ path, download: '1', name })}`
}

/**
 * The save control beside one file row: a same-origin download link. A
 * non-file row draws nothing, and a page that cannot address the API origin
 * draws no control rather than a broken one.
 * @param props - the row's entry and the tree's locale seat.
 * @returns the accessory, or null.
 */
export function FileSaveAccessory({ entry, t }: {
  entry: TreeEntry
  t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  if (entry.meta?.kind !== 'file') return null
  const href = workspaceFileDownloadUrl(window.location, entry.path, entry.name)
  if (href === undefined) return null
  const save = t('entry.download', { name: entry.name })
  return (
    <a className={css.save} href={href} download={entry.name}
      aria-label={save} title={save} data-files-download>
      <IconDownloadOutlineRegular size={14} />
    </a>
  )
}

/**
 * The `files` page body.
 * @param props - composed slot props.
 * @returns the header above the pane's navigator, or the workspace line.
 */
export function FilesBody(props: FilesBodyProps): ReactNode {
  const { useTabInfo, sessionId, useSessions, useStore, refresh, setAutoRefresh, renderSlot, renderFactorySlot, t, useContextMenu } = props
  const { tab, panel } = useTabInfo()
  const { getTriggerProps } = useContextMenu()
  const onOpen = useCallback((address: string): void => {
    if (panel.isFloating) tab.actions.openResource(address)
    else tab.actions.openResource(address, { paneId: panel.id })
  }, [tab.actions, panel.id, panel.isFloating])
  useEffect(
    () => tab.actions.bindCommands({ refresh: () => { refresh(panel.id) } }),
    [tab.actions, panel.id, refresh],
  )
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  // The setting belongs to a listed tree, so there is nothing to set before one.
  const autoRefresh = useStore((store) => {
    const tree = store.byPane[panel.id]?.tree
    return tree?.root === cwd ? tree?.autoRefresh : undefined
  })

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  const automatic = autoRefresh ?? true
  const navigator = renderFactorySlot('sidebar.files.navigator', { useTabInfo, page: true, onOpen })
  return (
    <div className={css.page} data-files-page>
      <div className={css.header}>
        <PathLabel path={cwd} className={css.path} data-files-path
          {...getTriggerProps({ kind: 'directory', value: { sessionId, path: cwd } })} />
        <span hidden>
          <button type="button" className={css.tool} aria-label={t('autoRefresh')}
            aria-pressed={automatic} disabled={autoRefresh === undefined} data-files-auto-refresh
            title={t(automatic ? 'autoRefresh.disable' : 'autoRefresh.enable')}
            onClick={() => { setAutoRefresh(panel.id, !automatic) }}>
            {automatic ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
          </button>
        </span>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            aria-keyshortcuts={tab.refreshShortcut?.aria}
            data-files-reload
            onClick={() => { refresh(panel.id) }}
          >
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        {renderSlot('sidebar.right.tab.files.actions', { absolutePath: cwd })}
      </div>
      <div className={css.content} data-files-content>{navigator}</div>
    </div>
  )
}
