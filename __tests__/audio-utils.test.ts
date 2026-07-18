import { isAudioMime, isAudioUrl, isPlayableMime } from '../src/xmpp/audioUtils';

describe('isAudioMime', () => {
  it.each([
    ['audio/mp4', true],
    ['audio/x-m4a', true],
    ['audio/mpeg', true],
    ['audio/ogg', true],
    ['audio/opus', true],
    ['audio/wav', true],
    ['audio/x-wav', true],
    ['audio/wave', true],
    ['audio/ogg; codecs=opus', true],
    ['Audio/Ogg', true],
    ['image/png', false],
    ['text/plain', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('isAudioMime(%s) = %s', (mime, expected) => {
    expect(isAudioMime(mime as string | null | undefined)).toBe(expected);
  });
});

describe('isAudioUrl', () => {
  it.each([
    ['https://example.com/voice.ogg', true],
    ['https://example.com/audio.opus', true],
    ['https://example.com/rec.m4a?token=xyz', true],
    ['https://example.com/file.mp3', true],
    ['https://example.com/sound.wav', true],
    ['https://example.com/image.png', false],
    ['https://example.com/file.txt', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('isAudioUrl(%s) = %s', (url, expected) => {
    expect(isAudioUrl(url as string | null | undefined)).toBe(expected);
  });
});

describe('isPlayableMime', () => {
  it('delegates to isAudioMime', () => {
    expect(isPlayableMime('audio/ogg')).toBe(true);
    expect(isPlayableMime('image/png')).toBe(false);
  });
});
