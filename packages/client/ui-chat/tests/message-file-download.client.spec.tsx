// @vitest-environment jsdom
/**
 * An uploaded file in a sent message is reachable as a save, and inert when the
 * page cannot address the API.
 *
 * An upload lives in content-addressed storage with no path to read, so the
 * only way back to its bytes is the attachment route keyed by the Session that
 * references it. The card renders that as an ordinary anchor — the browser's own
 * download, not a fetch into this page's heap — and stays a plain span whenever
 * no URL can be built, which is what a local submission echo gets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { attachmentDownloadUrl } from '../src/client/chat/attachment-url.ts'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const attachment = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  name: 'quarterly notes.md',
  bytes: 4096,
}

/** One sent user message whose whole content is the uploaded file. */
function userFileNode(): ChatConversationViewNode & { readonly kind: 'user' } {
  return {
    key: 'fixture:user:7',
    kind: 'user',
    id: '7',
    target: 'chat',
    anchorSeq: 7,
    location: { kind: 'session' },
    visibility: 'visible',
    data: { seq: 7, time: 0, content: [{ type: 'file', attachment }] },
  } as unknown as ChatConversationViewNode & { readonly kind: 'user' }
}

function renderCard(url: string | undefined) {
  const props = {
    node: userFileNode(),
    t: makeTranslate(zh, commonZh),
    renderMessageImages: () => null,
    openFile: vi.fn(),
    openSkill: vi.fn(),
    attachmentDownloadUrl: () => url,
  } as unknown as ChatNodeViewProps<'user' | 'steering'>
  return render(<UserMessageNodeView {...props} />)
}

describe('uploaded file card', () => {
  it('saves the file under its own name when the page can address the bytes', () => {
    const url = '/api/attachment.download?sessionId=s-1&attachmentId=sha256%3Ab'
    const view = renderCard(url)
    const link = view.container.querySelector('[data-message-attachments] a')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe(url)
    expect(link?.getAttribute('download')).toBe('quarterly notes.md')
    expect(link?.getAttribute('aria-label')).toBe(zh['message.downloadFile'].replace('{name}', 'quarterly notes.md'))
    expect(link?.textContent).toContain('quarterly notes.md')
  })

  it('stays an inert card when no URL can be built', () => {
    const view = renderCard(undefined)
    expect(view.container.querySelector('[data-message-attachments] a')).toBeNull()
    expect(view.container.querySelector('[data-message-attachments]')?.textContent)
      .toContain('quarterly notes.md')
  })
})

describe('attachment download URL', () => {
  const page = { protocol: 'https:', origin: 'https://host.example' }

  it('addresses one Session attachment on the page origin', () => {
    const url = attachmentDownloadUrl(page, 's-1', 'sha256:abc')
    expect(url?.startsWith('https://host.example/api/attachment.download?')).toBe(true)
    expect(Object.fromEntries(new URL(url!).searchParams))
      .toEqual({ sessionId: 's-1', attachmentId: 'sha256:abc' })
  })

  it.each(['file:', 'chrome-extension:', ''])('builds nothing for a %s page', (protocol) => {
    expect(attachmentDownloadUrl({ ...page, protocol }, 's-1', 'sha256:abc')).toBeUndefined()
  })
})
