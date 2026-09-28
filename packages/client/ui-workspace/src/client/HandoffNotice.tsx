/** A refused handoff stays readable after the row it was clicked from re-renders. */

import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the 'shell.overlay' declaration (a list slot) this renders in.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HandoffFailure } from './handoff-notice.ts'
import type { WorkspaceKey } from './locales.ts'
import css from './HandoffNotice.module.css'

/** The store owns the failures; this seat only shows and dismisses them. */
export interface HandoffNoticeInjected {
  readonly hooks: { readonly handoffFailures: HostObservable<readonly HandoffFailure[]> }
  /** @param id - the failure to dismiss. */
  readonly dismissHandoffFailure: (id: number) => void
}

/**
 * Which copy explains one refusal. A reason the Host did not name falls back to
 * the generic line, which still carries the Host's own message underneath.
 * @param reason - the Host's precondition token, when it named one.
 * @returns the dictionary key explaining it.
 */
function messageKey(reason: string | undefined): WorkspaceKey {
  if (reason === 'nothing-to-carry') return 'handoff.failed.empty'
  if (reason === 'no-command-registry' || reason === 'no-compaction-command') return 'handoff.failed.unavailable'
  return 'handoff.failed.generic'
}

/**
 * Render refused handoffs as a dismissable alert stack.
 * @param props - root overlay hooks, dismissal and localized copy.
 * @returns the stack, empty when no handoff has refused.
 */
export function HandoffNotice({
  useHandoffFailures, dismissHandoffFailure, t,
}: PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'> & InjectFace<HandoffNoticeInjected>): ReactNode {
  const failures = useHandoffFailures(value => value)
  if (failures.length === 0) return null
  return <div className={css.stack}>{failures.map(failure => (
    <div key={failure.id} className={css.notice} role="alert">
      <span className={css.text}>
        <span>{t(messageKey(failure.reason))}</span>
        <span className={css.detail}>{failure.message}</span>
      </span>
      <button type="button" onClick={() => { dismissHandoffFailure(failure.id) }}>
        {t('handoff.failed.dismiss')}
      </button>
    </div>
  ))}</div>
}
