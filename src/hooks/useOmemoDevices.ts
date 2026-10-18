import { useEffect, useSyncExternalStore } from 'react';
import { omemo2Api, type Omemo2Device } from '@/xmpp/omemo2';

/** Dispositivos OMEMO 2 de `jid` con su confianza; se refresca al montar y ante cambios. */
export function useOmemoDevices(jid: string): Omemo2Device[] {
  useEffect(() => {
    void omemo2Api.refresh(jid);
  }, [jid]);
  return useSyncExternalStore(omemo2Api.subscribe, () => omemo2Api.devices(jid));
}
