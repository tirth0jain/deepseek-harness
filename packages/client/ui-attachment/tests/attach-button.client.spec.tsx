// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AttachButton, type AttachButtonProps } from '../src/client/AttachButton.tsx'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: string): string => {
  const messages: Record<string, string> = {
    'input.attach': '添加图片',
  }
  return messages[key] ?? key
}) as AttachButtonProps['t']

function props(overrides: Partial<Pick<AttachButtonProps, 'locked' | 'addImages'>> = {}): AttachButtonProps {
  return {
    locked: false,
    addImages: () => null,
    t,
    ...overrides,
  } as unknown as AttachButtonProps
}

describe('AttachButton', () => {
  it('opens the file picker on click and forwards picked images to addImages', () => {
    const addImages = vi.fn(() => null)
    const view = render(<AttachButton {...props({ addImages })} />)
    const button = view.getByRole('button', { name: '添加图片' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.getAttribute('accept')).toContain('image/png')
    expect(input.hasAttribute('multiple')).toBe(true)

    const inputClick = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(button)
    expect(inputClick).toHaveBeenCalledTimes(1)

    const picked = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [picked], configurable: true })
    fireEvent.change(input)
    expect(addImages).toHaveBeenCalledWith([picked])
    // The input resets so re-picking the same file re-fires.
    expect(input.value).toBe('')
    inputClick.mockRestore()
  })

  it('disables the button when locked', () => {
    const view = render(<AttachButton {...props({ locked: true })} />)
    expect(view.getByRole('button', { name: '添加图片' }).getAttribute('disabled')).not.toBeNull()
  })

  it('does not open the picker while disabled', () => {
    const view = render(<AttachButton {...props({ locked: true })} />)
    const button = view.getByRole('button', { name: '添加图片' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const inputClick = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(button)
    expect(inputClick).not.toHaveBeenCalled()
    inputClick.mockRestore()
  })

  it('ignores an empty file-picker change', () => {
    const addImages = vi.fn(() => null)
    render(<AttachButton {...props({ addImages })} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [], configurable: true })
    fireEvent.change(input)
    expect(addImages).not.toHaveBeenCalled()
  })
})
