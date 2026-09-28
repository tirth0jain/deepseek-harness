/**
 * Same-origin URL for one admitted attachment's bytes.
 *
 * An uploaded file lives in content-addressed storage with no path to address,
 * so its identity plus the Session that references it is the whole request. A
 * page reached over anything but HTTP(S) — an Electron `file://` shell — has no
 * API origin to address, and gets no URL rather than a broken one.
 */

/** Authenticated raw-byte download route owned by the Session Controller. */
export const ATTACHMENT_DOWNLOAD_PATH = '/api/attachment.download'

/** The transport and origin a page builds same-origin URLs from. */
export interface DownloadPage {
  readonly protocol: string
  readonly origin: string
}

/**
 * Build the URL that saves one attachment of a Session.
 * @param page - the page's own transport and origin, so the URL stays same-origin.
 * @param sessionId - the Session whose log authorizes the read.
 * @param attachmentId - the durable attachment identity.
 * @returns the download URL, or undefined when the page cannot address the API.
 */
export function attachmentDownloadUrl(
  page: DownloadPage,
  sessionId: string,
  attachmentId: string,
): string | undefined {
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return undefined
  return `${page.origin}${ATTACHMENT_DOWNLOAD_PATH}?${new URLSearchParams({ sessionId, attachmentId })}`
}
