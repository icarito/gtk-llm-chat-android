import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import React from 'react';
import { AppState } from 'react-native';
import { XmppService } from '@/xmpp/XmppService';
import { PushStatus, type XmppPushStatus } from '@/xmpp/pushStatus';
import { useXmppAccount } from '@/hooks/useXmppAccount';
import type { XmppContact, XmppConnectionState, XmppMessage, XmppPendingAction } from '@/types/xmpp';

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
  setApprovalBypass: (targetJid: string, enabled: boolean, minutes?: number) => Promise<string>;
  getApprovalBypassStatus: (targetJid: string) => Promise<{ active: boolean; remainingMinutes?: number }>;
  account: { jid: string; service: string } | null;
  omemoEnabled: boolean;
  setOmemoEnabled: (enabled: boolean) => Promise<void>;
  isConfigured: boolean;
}

const XmppContext = createContext<XmppContextValue | null>(null);

export function XmppProvider({ children }: { children: React.ReactNode }) {
  const { account, loading, saveAccount } = useXmppAccount();
  const appState = useRef(AppState.currentState);
  const [state, setState] = useState<XmppConnectionState>(() => XmppService.getState());
  const [contacts, setContacts] = useState<XmppContact[]>(() => XmppService.getContacts());
  const [messages, setMessages] = useState<Map<string, XmppMessage[]>>(() => XmppService.getMessages());
  const [pendingActions, setPendingActions] = useState<XmppPendingAction[]>(() => XmppService.getPendingActions());
  const [pushStatus, setPushStatus] = useState<XmppPushStatus>(() => PushStatus.get());

  // Subscribe to XmppService singleton
  useEffect(() => {
    const unsubState = XmppService.onStateChange(setState);
    const unsubContacts = XmppService.onContactsChange(setContacts);
    const unsubMessages = XmppService.onMessagesChange(setMessages);
    const unsubPendingActions = XmppService.onPendingActionsChange(setPendingActions);
    const unsubPushStatus = PushStatus.subscribe(setPushStatus);
    return () => {
      unsubState();
      unsubContacts();
      unsubMessages();
      unsubPendingActions();
      unsubPushStatus();
    };
  }, []);

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

  const setApprovalBypass = useCallback(async (targetJid: string, enabled: boolean, minutes = 10) => {
    return XmppService.setApprovalBypass(targetJid, enabled, minutes);
  }, []);

  const getApprovalBypassStatus = useCallback(async (targetJid: string) => {
    return XmppService.getApprovalBypassStatus(targetJid);
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
    setApprovalBypass,
    getApprovalBypassStatus,
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
