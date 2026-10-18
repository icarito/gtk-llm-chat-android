/**
 * Ruido de transporte del gateway que el servidor sigue enviando como cuerpo de
 * mensaje: 'toast' se avisa y se oculta, 'discard' se oculta sin más.
 */
export function approvalTransportNotice(body: string): 'toast' | 'discard' | null {
  const text = body.trim().replace(/\s+/g, ' ');
  if (/^Command (submitted|expired)\.?$/i.test(text)) return 'toast';
  if (/^✅\s*Approval\s+(allow-once|allow-always|deny)\s+submitted\b/i.test(text)) {
    return 'toast';
  }
  if (/^✅\s*aprobado\s*[—-]/i.test(text)) return 'toast';
  if (/^❌?\s*Failed to submit approval\b/i.test(text)) return 'toast';
  if (/\bapproval already pending for session\b/i.test(text)) return 'toast';
  if (/^Recibido\s*[·.-]\s*preparando…?$/i.test(text)) return 'discard';
  if (/^Turno completado sin respuesta visible\.?$/i.test(text)) return 'discard';
  if (/Command approval requested/i.test(text) && /Approval:/i.test(text)) {
    return 'discard';
  }
  if (/```\s*```/.test(text) && !/🔒/.test(text)) {
    return 'discard';
  }
  return null;
}
