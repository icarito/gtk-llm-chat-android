/** Identity key en hex → grupos de 8 caracteres separados por espacio (minúsculas). */
export function formatFingerprint(hex: string): string {
  return (hex.toLowerCase().match(/.{1,8}/g) ?? []).join(' ');
}
