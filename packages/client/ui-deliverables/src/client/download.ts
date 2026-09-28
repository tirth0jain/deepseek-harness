/**
 * Save one Session file through the browser's own download machinery.
 *
 * The byte route is the same one the sidebar preview reads, so saving a file
 * needs no second authorization path and no bytes of this page's heap. Both an
 * absolute declaration and a workspace-relative one are addressable, because
 * the Session workspace root turns the second into the first; without a root
 * there is no URL to offer and the card falls back to the sidebar preview.
 */
import { isAbsoluteWorkspacePath, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { FILE_BYTES_PATH } from '../presented.ts'
import { basename } from './turn-deliverables.ts'

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
