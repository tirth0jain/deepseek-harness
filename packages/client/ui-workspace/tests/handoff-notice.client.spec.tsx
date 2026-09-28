// @vitest-environment jsdom
/**
 * A refused handoff has to be visible.
 *
 * The click is a background operation on a row that re-renders underneath it,
 * so the failure cannot live in the row: it is reported into a frame-wide seat
 * and stays there until dismissed. These tests drive the real client error
 * wrapper rather than a stand-in, because the classification is structural —
 * it reads the Remote failure the wrapper carries.
 */
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SessionHandoffError } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HandoffNotice } from '../src/client/HandoffNotice.tsx'
import { createHandoffFailures } from '../src/client/handoff-notice.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

type NoticeProps = Parameters<typeof HandoffNotice>[0]
const unusedHook = (): never => { throw new Error('The handoff notice consumes no global hook') }
const standard: Omit<NoticeProps, 'useHandoffFailures' | 'dismissHandoffFailure' | 't'> = {
  useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook, usePanelInfo: unusedHook,
  useWorkspaces: unusedHook, useResource: unusedHook,
}

/** The refusal the Host actually throws, through the wrapper the client throws. */
function refused(reason: string, message: string): SessionHandoffError {
  return new SessionHandoffError(
    new RemoteError('session/handoff-unavailable', message, { sessionId: 's-1' as SessionId, reason }),
    's-1' as SessionId,
  )
}

/** Render the notice over one store, the way the overlay seat does. */
function mount(): {
  store: ReturnType<typeof createHandoffFailures>
  view: ReturnType<typeof render>
  show: () => void
} {
  const store = createHandoffFailures()
  const props: NoticeProps = {
    ...standard,
    useHandoffFailures: selector => selector(store.failures.getSnapshot()),
    dismissHandoffFailure: (id) => { store.dismiss(id) },
    t: makeTranslate(en),
  }
  const view = render(<HandoffNotice {...props} />)
  return { store, view, show: () => { view.rerender(<HandoffNotice {...props} />) } }
}

it('says nothing until a handoff has refused', () => {
  const { view } = mount()
  expect(view.container.childElementCount).toBe(0)
})

it('names the precondition the Host refused on, and dismisses only that one', () => {
  const { store, view, show } = mount()
  store.report(refused('no-compaction-command', 'This deployment registers no "/compact" command for this Session.'))
  store.report(new Error('backend bug'))
  show()

  const alerts = view.getAllByRole('alert')
  expect(alerts).toHaveLength(2)
  // The refusal explains itself in the reader's language, and still carries the
  // Host's own message: the wire prose is the detail, not the explanation.
  expect(alerts[0]!.textContent).toContain(en['handoff.failed.unavailable'])
  expect(alerts[0]!.textContent).toContain('registers no "/compact" command')
  // A fault that named no class is not dressed up as one of the named ones.
  expect(alerts[1]!.textContent).toContain(en['handoff.failed.generic'])
  expect(alerts[1]!.textContent).toContain('backend bug')

  fireEvent.click(view.getAllByRole('button', { name: en['handoff.failed.dismiss'] })[0]!)
  const remaining = store.failures.getSnapshot()
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.message).toBe('backend bug')
})

it('keeps an empty chat distinct from a backend that refused', () => {
  const { store, view, show } = mount()
  store.report(refused('nothing-to-carry', 'This Session has no history to condense yet.'))
  show()
  expect(view.getByRole('alert').textContent).toContain(en['handoff.failed.empty'])

  // A refusal the command explained in its own words is the generic line plus
  // that explanation, never a class the Host did not name.
  store.report(refused('compaction-refused', 'Compaction is unavailable because the agent is not idle.'))
  show()
  const explained = view.getAllByRole('alert')[1]!
  expect(explained.textContent).toContain(en['handoff.failed.generic'])
  expect(explained.textContent).toContain('the agent is not idle')
})
