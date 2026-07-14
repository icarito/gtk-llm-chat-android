import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import React from 'react';
import { XmppService } from '@/xmpp/XmppService';
import { useXmppAccount } from '@/hooks/useXmppAccount';
import type { XmppContact, XmppConnectionState, XmppMessage, XmppPendingAction } from '@/types/xmpp';

interface XmppContextValue {
  state: XmppConnectionState;
  contacts: XmppContact[];
  messages: Map<string, XmppMessage[]>;
  pendingActions: XmppPendingAction[];
  connect: (jid: string, password: string, service?: string, resource?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  sendMessage: (to: string, body: string, type?: 'chat' | 'groupchat') => Promise<string>;
  sendTyping: (to: string) => Promise<void>;
  answerPendingAction: (actionId: string) => Promise<void>;
  setApprovalBypass: (targetJid: string, enabled: boolean, minutes?: number) => Promise<string>;
  account: { jid: string; service: string } | null;
  isConfigured: boolean;
}

const XmppContext = createContext<XmppContextValue | null>(null);

export function XmppProvider({ children }: { children: React.ReactNode }) {
  const { account, loading, saveAccount } = useXmppAccount();
  const [state, setState] = useState<XmppConnectionState>(() => XmppService.getState());
  const [contacts, setContacts] = useState<XmppContact[]>(() => XmppService.getContacts());
  const [messages, setMessages] = useState<Map<string, XmppMessage[]>>(() => XmppService.getMessages());
  const [pendingActions, setPendingActions] = useState<XmppPendingAction[]>(() => XmppService.getPendingActions());

  // Subscribe to XmppService singleton
  useEffect(() => {
    const unsubState = XmppService.onStateChange(setState);
    const unsubContacts = XmppService.onContactsChange(setContacts);
    const unsubMessages = XmppService.onMessagesChange(setMessages);
    const unsubPendingActions = XmppService.onPendingActionsChange(setPendingActions);
    return () => {
      unsubState();
      unsubContacts();
      unsubMessages();
      unsubPendingActions();
    };
  }, []);

  const connect = useCallback(
    async (jid: string, password: string, service = 'wss://hablar.fuentelibre.org:5281/xmpp-websocket', resource = 'gtk-llm-chat') => {
      const effectiveAccount = jid && password
        ? { jid, password, service, resource }
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

  const setApprovalBypass = useCallback(async (targetJid: string, enabled: boolean, minutes = 15) => {
    return XmppService.setApprovalBypass(targetJid, enabled, minutes);
  }, []);

  const value: XmppContextValue = {
    state,
    contacts,
    messages,
    pendingActions,
    connect,
    disconnect,
    sendMessage,
    sendTyping,
    answerPendingAction,
    setApprovalBypass,
    account: account ? { jid: account.jid, service: account.service } : null,
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
