export const NS_TELEMETRY = 'urn:openclaw:telemetry:0';
export const NS_TELEMETRY_LEGACY = 'urn:nanoclaw:telemetry:0';
export const NS_HOOKS_ACTIVITY = 'urn:openclaw:hooks:activity:0';
export const NS_HOOKS_APPROVAL = 'urn:openclaw:hooks:approval:0';
export const NS_HOOKS_PROGRESS = 'urn:openclaw:hooks:progress:0';
export const NS_FLEET = 'urn:joework:monitoring:2';

/** Features XEP-0115 +notify que un agente OpenClaw anuncia. */
export function capsNotifyFeatures(): string[] {
  return [
    `${NS_TELEMETRY}+notify`,
    `${NS_TELEMETRY_LEGACY}+notify`,
    `${NS_HOOKS_ACTIVITY}+notify`,
    `${NS_HOOKS_APPROVAL}+notify`,
    `${NS_HOOKS_PROGRESS}+notify`,
  ];
}
