// En los config plugins de Expo, `xxxPermission: false` BORRA la clave del Info.plist aunque
// otro plugin la declare: así se perdió NSMicrophoneUsageDescription y iOS mataba la app (TCC)
// al grabar audio.
import appJson from '../app.json';

test('ningún plugin desactiva un permiso con false', () => {
  const off = (appJson.expo.plugins as unknown[])
    .filter((p): p is [string, Record<string, unknown>] => Array.isArray(p) && typeof p[1] === 'object')
    .flatMap(([name, opts]) => Object.entries(opts).filter(([k, v]) => /Permission$/.test(k) && v === false).map(([k]) => `${name}.${k}`));
  expect(off).toEqual([]);
});
