/** Browser attachment plugin: fills conversation's composer and message-image slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { ComposerBarInjected, ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachButton } from './AttachButton.tsx'
import { ComposerAttachments } from './ComposerAttachments.tsx'
import { MessageImages } from './MessageImages.tsx'

/** The conversation service face this plugin consumes (structural; the value
 * class lives in ui-conversation, which the client bundle purity gate keeps
 * external — access rides the ctx service seam, never a value import). */
interface ConversationServiceFace {
  readonly input: {
    for(actx: unknown): {
      addImages(ids: readonly DraftAttachmentId[]): boolean
    }
  }
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[]
  releaseDraftImages(images: readonly ComposerAttachment[]): void
}

/** Services required: the slot registry for presentation seats and the
 * session service resolving per-session scopes for the attach entry's intake
 * (the conversation service itself is read lazily off the resolved scope). */
export const inject = ['slots', 'sessions']

/** Register attachment presentation without exporting React components as package values. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'attach',
    order: 10,
    locale: 'conversation',
    inject: (sessionId: SessionId): { addImages: NonNullable<ComposerBarInjected['addImages']> } => {
      const actx = ctx.sessions.scope(sessionId)
      const conversation = actx?.get('conversation') as ConversationServiceFace | undefined
      const input = conversation === undefined || actx === undefined
        ? undefined
        : conversation.input.for(actx)
      return {
        addImages: (files) => {
          if (conversation === undefined || input === undefined) return null
          try {
            const images = conversation.createDraftImages(files)
            if (!input.addImages(images.map(image => image.id))) {
              conversation.releaseDraftImages(images)
            }
            return null
          } catch {
            return 'unsupported image type'
          }
        },
      }
    },
  }, AttachButton))
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    locale: 'conversation',
  }, ComposerAttachments))
  ctx.slots.inject('conversation.message.images', () => ctx.slots.register({
    name: 'conversation.message.images',
    locale: 'conversation',
  }, MessageImages))
  ctx.slots.inject('conversation.trajectory.images', () => ctx.slots.register({
    name: 'conversation.trajectory.images',
    locale: 'conversation',
  }, MessageImages))
}
