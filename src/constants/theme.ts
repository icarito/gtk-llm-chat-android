export const Colors = {
  background: '#0A0E14',
  surface: '#131822',
  surfaceBorder: '#1E2A3A',
  primary: '#4FC3F7',
  secondary: '#8090A0',
  muted: '#607589',
  text: '#E0E0E0',
  textDim: '#506070',
  error: '#FF5252',
  success: '#69F0AE',
  warning: '#FFD740',
  // The two bubbles must read as different at a glance: mine is a saturated
  // blue, theirs a desaturated slate. The old pair (#1E4A6E / #1A2838) were
  // both dark blue and nearly indistinguishable on the dark background.
  userBubble: '#2A6FA8',
  userBubbleText: '#FFFFFF',
  assistantBubble: '#1C2530',
  assistantBubbleBorder: '#2C3947',
  inputBackground: '#10161F',
} as const;
