/**
 * Save one Session file through the browser's own download machinery.
 *
 * The byte route is the same one the sidebar preview reads, so saving a file
 * needs no second authorization path and no bytes of this page's heap. Both an
 * absolute declaration and a workspace-relative one are addressable, because
 * the Session workspace root turns the second into the first; without a root
 * there is no URL to offer and the caller falls back to the sidebar preview.
 */
import { isAbsoluteWorkspacePath, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { basename, FILE_BYTES_PATH } from '../presented.ts'

/** The transport and origin a page builds same-origin URLs from. */
export interface DownloadPage {
  readonly protocol: string
  readonly origin: string
}

/**
 * Build the same-origin URL that makes the browser save one Session file.
 * @param page - the page's own transport and origin, so the URL stays same-origin.
 * @param cwd - Session workspace root, when known.
 * @param path - the file's absolute or workspace-relative path.
 * @returns the download URL, or undefined when no absolute path can be formed.
 */
export function fileDownloadUrl(page: DownloadPage, cwd: string | undefined, path: string): string | undefined {
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return undefined
  const absolute = resolveWorkspacePath(cwd, path)
  if (!isAbsoluteWorkspacePath(absolute)) return undefined
  // The name is a label for the saved file only; the route reads `path` alone.
  const query = new URLSearchParams({ path: absolute, download: '1', name: basename(path) })
  return `${page.origin}${FILE_BYTES_PATH}?${query.toString()}`
}

/**
 * Hand one URL to the browser's own download machinery.
 *
 * Clicking a real anchor keeps the bytes out of this page's heap, gives the
 * reader the browser's own progress and error surface, and — because the link
 * asks for a download — keeps a refused response from replacing the view. The
 * anchor is removed at once: the navigation it starts does not need it.
 * @param url - authenticated same-origin download URL.
 * @param name - filename hint for clients that ignore the response's disposition.
 */
export function saveFileFromUrl(url: string, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
