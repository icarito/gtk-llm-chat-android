import { Alert, Linking } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

export type Picked = { uri: string; name: string; mime: string };

const MAX_SIDE = 2048;

function denied(what: string) {
  Alert.alert(`Permiso de ${what} denegado`, `Actívalo en los ajustes del sistema para usar ${what}.`, [
    { text: 'Cancelar', style: 'cancel' },
    { text: 'Ajustes', onPress: () => { void Linking.openSettings(); } },
  ]);
}

/** Reduce a MAX_SIDE (lado mayor) y recomprime a JPEG 0.8. */
async function downscale(asset: ImagePicker.ImagePickerAsset): Promise<Picked> {
  const big = Math.max(asset.width, asset.height) > MAX_SIDE;
  const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri);
  if (big) ctx.resize(asset.width >= asset.height ? { width: MAX_SIDE } : { height: MAX_SIDE });
  const out = await (await ctx.renderAsync()).saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 });
  return { uri: out.uri, name: `foto_${Date.now()}.jpg`, mime: 'image/jpeg' };
}

export async function pickPhoto(source: 'camera' | 'gallery'): Promise<Picked | null> {
  const cam = source === 'camera';
  const perm = cam
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) { denied(cam ? 'cámara' : 'galería'); return null; }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
  const res = cam ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const asset = res.canceled ? undefined : res.assets[0];
  return asset ? downscale(asset) : null;
}

export async function pickFile(): Promise<Picked | null> {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  const a = res.canceled ? undefined : res.assets?.[0];
  return a ? { uri: a.uri, name: a.name || 'file', mime: a.mimeType || 'application/octet-stream' } : null;
}

/** Cámara / Galería / Archivo; resuelve null si se cancela. */
export function chooseAttachment(): Promise<Picked | null> {
  return new Promise((resolve) => {
    const run = (p: () => Promise<Picked | null>) => () => { p().then(resolve, (e) => { resolve(null); Alert.alert('No se pudo adjuntar', String(e?.message ?? e)); }); };
    Alert.alert('Adjuntar', undefined, [
      { text: 'Cámara', onPress: run(() => pickPhoto('camera')) },
      { text: 'Galería', onPress: run(() => pickPhoto('gallery')) },
      { text: 'Archivo', onPress: run(pickFile) },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
}

/** Foto de perfil: recorte cuadrado del selector y PNG 256x256 en base64. */
export async function pickAvatarImage(source: 'camera' | 'gallery') {
  const cam = source === 'camera';
  const perm = cam
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) { denied(cam ? 'cámara' : 'galería'); return null; }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 };
  const res = cam ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const asset = res.canceled ? undefined : res.assets[0];
  if (!asset) return null;
  const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri).resize({ width: 256, height: 256 });
  const out = await (await ctx.renderAsync()).saveAsync({ format: ImageManipulator.SaveFormat.PNG, base64: true });
  return out.base64 ? { base64: out.base64, mime: 'image/png', width: out.width, height: out.height } : null;
}
