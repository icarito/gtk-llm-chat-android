// Shim de tipos: expo-quick-actions publica sus tipos sólo vía "exports" de
// package.json, que la moduleResolution "node" del tsconfig base de Expo SDK 52
// no sabe leer (Metro sí resuelve el módulo en runtime por la condición
// react-native). Esto replica la parte de la API que usamos de
// node_modules/expo-quick-actions/build/index.d.ts.
declare module 'expo-quick-actions' {
  export type Action = {
    id: string;
    title: string;
    icon?: string | null;
    /** iOS-only. Subtitle for the action. */
    subtitle?: string | null;
    /** Additional serial parameters for the action. */
    params?: Record<string, number | string | boolean | null | undefined> | null;
  };
  export const initial: Action | undefined;
  export const maxCount: number | undefined;
  export const setItems: <TAction extends Action = Action>(data?: TAction[]) => Promise<void>;
  export const isSupported: () => Promise<boolean>;
  export function addListener<TAction extends Action = Action>(
    listener: (action: TAction) => void,
  ): { remove: () => void };
}
