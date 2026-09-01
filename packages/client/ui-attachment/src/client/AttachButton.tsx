import { useCallback, useRef, type ChangeEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarInjected } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconPaperclipOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AttachButton.module.css'

/** The composer-bar file-intake operation this control consumes. */
export interface AttachButtonInjected {
  addImages: NonNullable<ComposerBarInjected['addImages']>
}

/** Full props of the composer tool-row attach control. */
export type AttachButtonProps =
  PropsRuntime<'conversation.input.left'> & InjectFace<AttachButtonInjected> & PropsLocale<'conversation'>

/**
 * Paperclip attach control for the composer tool row. Clicking it opens a
 * multi-image file picker that feeds the same intake path as a document drop
 * (`addImages(files)` from the composer-bar inject), so validation, limits,
 * and the preview rail stay identical. Disabled exactly when the composer
 * refuses interaction (`locked`) or no intake capability is mounted.
 */
export function AttachButton({ locked, addImages, t }: AttachButtonProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const openFilePicker = useCallback(() => {
    if (locked) return
    fileInputRef.current?.click()
  }, [locked])

  const onFilesPicked = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files === null || files.length === 0) return
    addImages([...files])
    // Reset the input so picking the same file again re-fires the change.
    event.target.value = ''
  }, [addImages])

  return (
    <span className={css.root}>
      <Tooltip label={t('input.attach')} side="top" delayMs={500}>
        <button
          type="button"
          className={css.attach}
          aria-label={t('input.attach')}
          disabled={locked}
          onClick={openFilePicker}
        >
          <IconPaperclipOutline16 />
        </button>
      </Tooltip>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        tabIndex={-1}
        aria-hidden
        className={css.fileInput}
        onChange={onFilesPicked}
      />
    </span>
  )
}
