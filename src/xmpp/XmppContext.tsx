import { createContext, useContext, useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import React from 'react';
import { AppState } from 'react-native';
import { XmppService } from '@/xmpp/XmppService';
import { connection } from '@/xmpp/session';
import { contacts as contactsStore, invites as invitesStore, messages as messagesStore, pendingActions as pendingStore, rooms as roomsStore } from '@/xmpp/store';
import { getAgentSnapshot, subscribeAgent } from '@/xmpp/agents';
import type { AgentState } from '@/xmpp/pep/agentState';
import { PushStatus, type XmppPushStatus } from '@/xmpp/pushStatus';
import { useXmppAccount } from '@/hooks/useXmppAccount';
import type { XmppContact, XmppConnectionState, XmppMessage, XmppPendingAction, XmppRoom, XmppRoomInvite } from '@/types/xmpp';

interface XmppContextValue {
  state: XmppConnectionState;
  contacts: XmppContact[];
  messages: Map<string, XmppMessage[]>;
  pendingActions: XmppPendingAction[];
  pushStatus: XmppPushStatus;
  connect: (jid: string, password: string, service?: string, resource?: string, omemoEnabled?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  sendMessage: (to: string, body: string, type?: 'chat' | 'groupchat') => Promise<string>;
  sendTyping: (to: string) => Promise<void>;
  answerPendingAction: (actionId: string) => Promise<void>;
  setElevatedSession: (targetJid: string, enabled: boolean, minutes?: number) => Promise<string>;
  getElevatedSessionStatus: (targetJid: string) => Promise<{ active: boolean; remainingMinutes?: number }>;
  account: { jid: string; service: string } | null;
  omemoEnabled: boolean;
  setOmemoEnabled: (enabled: boolean) => Promise<void>;
  isConfigured: boolean;
}

const XmppContext = createContext<XmppContextValue | null>(null);

export function XmppProvider({ children }: { children: React.ReactNode }) {
  const { account, loading, saveAccount } = useXmppAccount();
  const appState = useRef(AppState.currentState);
  // Snapshots estables del store (ver store.ts): sólo re-renderiza lo que cambió.
  const state = useSyncExternalStore(connection.subscribe.bind(connection), () => connection.legacyState());
  const contacts = useSyncExternalStore(contactsStore.subscribe, contactsStore.getAll);
  const messages = useSyncExternalStore(messagesStore.subscribeAll, messagesStore.getAll);
  const pendingActions = useSyncExternalStore(pendingStore.subscribe.bind(pendingStore), () => pendingStore.getAll());
  const [pushStatus, setPushStatus] = useState<XmppPushStatus>(() => PushStatus.get());

  useEffect(() => PushStatus.subscribe(setPushStatus), []);

  useEffect(() => {
    if (!account || loading) return undefined;

    // Cold start must not depend on a screen calling connect() or on a future
    // background→active transition. The singleton deduplicates concurrent
    // recovery attempts and keeps ownership outside React components.
    XmppService.reconnectIfNeeded(account).catch(() => {
      // Structured state is surfaced through the service listener.
    });

    const sub = AppState.addEventListener('change', (nextState) => {
      const wasSuspended = appState.current === 'background' || appState.current === 'inactive';
      appState.current = nextState;
      if (!wasSuspended || nextState !== 'active') return;

      XmppService.reconnectIfNeeded(account).catch(() => {
        // The service state listener will surface the failure as `error`.
      });
    });

    return () => sub.remove();
  }, [account, loading]);

  const connect = useCallback(
    async (jid: string, password: string, service = 'wss://hablar.fuentelibre.org:5281/xmpp-websocket', resource = 'gtk-llm-chat', omemoEnabled = true) => {
      const effectiveAccount = jid && password
        ? { jid, password, service, resource, omemoEnabled }
        : account;
      if (!effectiveAccount) throw new Error('No hay cuenta configurada');
      await saveAccount(effectiveAccount);
      await XmppService.connect(effectiveAccount);
    },
    [account, saveAccount],
  );

  const disconnect = useCallback(async () => {
    await XmppService.disconnect();
  }, []);

  const setOmemoEnabled = useCallback(async (enabled: boolean) => {
    if (!account) throw new Error('No hay cuenta configurada');
    const updated = { ...account, omemoEnabled: enabled };
    await saveAccount(updated);
    // connect() owns the exclusive disconnect/reconnect transition. Doing a
    // separate disconnect here races the provider effect that observes the
    // newly saved account and can reconnect with stale settings.
    await XmppService.connect(updated);
  }, [account, saveAccount]);

  const sendMessage = useCallback(
    async (to: string, body: string, type: 'chat' | 'groupchat' = 'chat') => {
      return XmppService.sendMessage(to, body, type);
    },
    [],
  );

  const sendTyping = useCallback(
    async (to: string) => {
      await XmppService.sendTyping(to);
    },
    [],
  );

  const answerPendingAction = useCallback(async (actionId: string) => {
    await XmppService.answerPendingAction(actionId);
  }, []);

  const setElevatedSession = useCallback(async (targetJid: string, enabled: boolean, minutes = 10) => {
    return XmppService.setElevatedSession(targetJid, enabled, minutes);
  }, []);

  const getElevatedSessionStatus = useCallback(async (targetJid: string) => {
    return XmppService.getElevatedSessionStatus(targetJid);
  }, []);

  const value: XmppContextValue = {
    state,
    contacts,
    messages,
    pendingActions,
    pushStatus,
    connect,
    disconnect,
    sendMessage,
    sendTyping,
    answerPendingAction,
    setElevatedSession,
    getElevatedSessionStatus,
    account: account ? { jid: account.jid, service: account.service } : null,
    omemoEnabled: account?.omemoEnabled ?? true,
    setOmemoEnabled,
    isConfigured: account !== null && !loading,
  };

  return <XmppContext.Provider value={value}>{children}</XmppContext.Provider>;
}

export function useXmpp(): XmppContextValue {
  const ctx = useContext(XmppContext);
  if (!ctx) {
    throw new Error('useXmpp must be used within XmppProvider');
  }
  return ctx;
}

/**
 * Mensajes en vivo de UNA conversación. Sólo re-renderiza cuando esa
 * conversación cambia (una corrección en otro chat no la toca).
 */
export function useConversation(jid: string): readonly XmppMessage[] {
  return useSyncExternalStore(
    useCallback((cb: () => void) => messagesStore.subscribe(jid, cb), [jid]),
    () => messagesStore.getConversation(jid),
  );
}

/** Telemetría + hooks del agente `jid`; `undefined` si no ha publicado nada (usar agentStatus.ts). */
export function useAgentState(jid: string): AgentState | undefined {
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribeAgent(jid, cb), [jid]),
    () => getAgentSnapshot(jid),
  );
}

/** Una sala (undefined si no la conocemos). Snapshot estable: cambia sólo si esa sala cambia. */
export function useRoom(jid: string): XmppRoom | undefined {
  return useSyncExternalStore(roomsStore.subscribe, () => roomsStore.get(jid));
}

/** Estado de cifrado de una sala para el header (string: re-render sólo si el texto cambia). undefined = aún sin consultar. */
export function useRoomOmemoLabel(jid: string): string | undefined {
  return useSyncExternalStore(roomsStore.subscribe, () => {
    const r = roomsStore.get(jid);
    if (!r || r.nonAnonymous === undefined) return undefined;
    if (!r.nonAnonymous) return `Sin cifrar: ${r.omemoUnavailableReason ?? 'sala anónima'}`;
    return r.omemoSkipped ? `OMEMO 2 · ${r.omemoSkipped} sin OMEMO 2` : 'Cifrado OMEMO 2';
  });
}

/** Todas las salas conocidas (marcadores + unidas). */
export function useRooms(): readonly XmppRoom[] {
  return useSyncExternalStore(roomsStore.subscribe, roomsStore.getAll);
}

/** Invitaciones a salas pendientes de aceptar o rechazar. */
export function useRoomInvites(): readonly XmppRoomInvite[] {
  return useSyncExternalStore(invitesStore.subscribe, invitesStore.getAll);
}
