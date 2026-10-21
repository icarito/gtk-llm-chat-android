import type { ThreadMessageLike } from '@assistant-ui/react-native';
import type { ChatMessage } from './toIMessage';

/**
 * Puente del modelo local (ChatMessage, derivado de XMPP) al modelo de
 * ThreadMessage de assistant-ui. Todo lo que la burbuja necesita se transporta
 * en `metadata.custom.chat`: el contenido visible (texto, imagen, audio, tablas,
 * código, aprobaciones, reacciones, cita) se dibuja desde ahí, no desde los
 * `parts`. La `content` mínima (sólo texto) evita restricciones del converter
 * (p.ej. audio sólo en mensajes de usuario), y mantiene el renderizado
 * completamente bajo nuestro control.
 */
export function toThreadMessageLike(c: ChatMessage): ThreadMessageLike {
  const createdAt = Number.isFinite(c.createdAt) ? new Date(c.createdAt) : new Date();
  return {
    id: String(c._id),
    role: c.meta.mine ? 'user' : 'assistant',
    createdAt,
    content: [{ type: 'text', text: c.text }],
    metadata: { custom: { chat: c } },
  };
}
