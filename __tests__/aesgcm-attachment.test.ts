import { parseAttachment } from '@/chat/attachments';

const URL = 'aesgcm://up.example.org/abc/foto.jpg#' + 'a'.repeat(24) + 'b'.repeat(64);

test('una URL aesgcm nunca se muestra como texto', () => {
  expect(parseAttachment(URL)).toEqual({ kind: 'file', url: '', text: 'Adjunto cifrado (no disponible)' });
});

test('con localUri usa el archivo descifrado y el tipo de la extensión', () => {
  expect(parseAttachment(URL, null, 'file:///cache/aesgcm/x.bin'))
    .toEqual({ kind: 'image', url: 'file:///cache/aesgcm/x.bin', text: '' });
});
