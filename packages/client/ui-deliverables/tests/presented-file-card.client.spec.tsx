// @vitest-environment jsdom
/** Explicit file actions preserve their destination, availability, and independent failure state. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PresentedFileCard } from '../src/client/PresentedFileCard.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const props = () => ({
  cwd: undefined,
  file: { path: 'out/report.pdf', description: 'Final report', seq: 4, index: 1 },
  host: { name: 'remote-desktop', available: true, fileManager: 'finder' as const },
  phase: undefined,
  onPreview: vi.fn(),
  actions: <button type="button">Native file action</button>,
  t: makeTranslate(en),
})
it('localizes reveal failures and accurately reports a directory-only action', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase="revealError" t={makeTranslate(zh)} />)
  expect(view.getByText(zh['presented.revealError'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(en['presented.directoryOpened'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" />)
  expect(view.getByText(en['presented.revealed'])).toBeTruthy()
})


it('shows the basename while retaining the full location for hover and actions', () => {
  const p = props()
  const path = '/work/reports/result.pdf'
  const view = render(<PresentedFileCard {...p} cwd="/work" file={{ ...p.file, path }} />)
  expect(view.getByTitle(path)).toBeTruthy()
  expect(view.getByText('result.pdf')).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} cwd="/work" />)
  expect(view.getByTitle('/work/out/report.pdf')).toBeTruthy()
  expect(view.getByText('report.pdf')).toBeTruthy()
})

it.each([
  ['Quarterly summary (.pdf)', 'Quarterly summary'],
  ['季度总结（PDF）', '季度总结'],
] as const)('omits a trailing parenthesized file suffix from %s', (description, expected) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} file={{ ...p.file, description }} />)
  expect(view.getByText(expected)).toBeTruthy()
  expect(view.queryByText(description)).toBeNull()
})


it.each([en, zh])('distinguishes directory-only progress and errors in each locale', (dictionary) => {
  const p = { ...props(), t: makeTranslate(dictionary) }
  const view = render(<PresentedFileCard {...p} phase="revealing" />)
  expect(view.getByText(dictionary['presented.revealing'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealing" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryOpening'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealError" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryError'])).toBeTruthy()
})


it('renders the supplied action independently from the card preview', () => {
  const p = props()
  const native = vi.fn()
  const view = render(<PresentedFileCard {...p} actions={<button type="button" onClick={native}>Native file action</button>} />)
  fireEvent.click(view.getByRole('button', { name: 'Native file action' }))
  expect(native).toHaveBeenCalledOnce()
  expect(p.onPreview).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Preview out/report.pdf in sidebar' }))
  expect(p.onPreview).toHaveBeenCalledOnce()
})

it('offers a save beside the native actions even when the Host has no desktop', () => {
  const p = props()
  // The contributed native control is what a Host without a desktop withholds;
  // the save link is the card's own and must survive that.
  const view = render(<PresentedFileCard {...p} cwd="/work" host={null} actions={null} />)
  const save = view.getByRole('link', { name: en['presented.download'] })
  const url = new URL(save.getAttribute('href')!, window.location.origin)
  expect(url.origin).toBe(window.location.origin)
  expect(url.pathname).toBe('/api/file')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    path: '/work/out/report.pdf', download: '1', name: 'report.pdf',
  })
  expect(save.getAttribute('download')).toBe('report.pdf')
})

it('offers no save when the workspace root cannot make the declaration absolute', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} />)
  expect(view.queryByRole('link', { name: en['presented.download'] })).toBeNull()
  // The rest of the card is untouched by the missing address.
  expect(view.getByRole('button', { name: 'Native file action' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Preview out/report.pdf in sidebar' })).toBeTruthy()
})

it('localizes the save link', () => {
  const p = { ...props(), cwd: '/work', t: makeTranslate(zh) }
  const view = render(<PresentedFileCard {...p} />)
  expect(view.getByRole('link', { name: zh['presented.download'] })).toBeTruthy()
})
