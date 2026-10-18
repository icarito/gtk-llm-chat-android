/**
 * XEP-0085: quién está "escribiendo…" ahora mismo. Con timeout de seguridad:
 * si el contacto muere sin mandar <paused/>, el indicador no queda pegado.
 */
const typingJids = new Set<string>();
export const typingListeners = new Set<(jid: string, typing: boolean) => void>();
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TYPING_TIMEOUT_MS = 15000;

export function setTyping(jid: string, typing: boolean) {
  const timer = typingTimers.get(jid);
  if (timer) {
    clearTimeout(timer);
    typingTimers.delete(jid);
  }
  const had = typingJids.has(jid);
  if (typing) {
    typingJids.add(jid);
    typingTimers.set(jid, setTimeout(() => setTyping(jid, false), TYPING_TIMEOUT_MS));
  } else {
    typingJids.delete(jid);
  }
  if (had !== typing) {
    for (const listener of typingListeners) listener(jid, typing);
  }
}
export function isTyping(bare: string): boolean {
  return typingJids.has(bare);
}
