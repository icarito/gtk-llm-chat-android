export type PushTokenState = 'idle' | 'requesting' | 'ready' | 'denied' | 'error';
export type PushRegistrationState = 'idle' | 'pending' | 'registered' | 'error';

export interface XmppPushStatus {
  token: PushTokenState;
  registration: PushRegistrationState;
  error: string | null;
  updatedAt: string | null;
}

type Listener = (status: XmppPushStatus) => void;

const listeners = new Set<Listener>();

let status: XmppPushStatus = {
  token: 'idle',
  registration: 'idle',
  error: null,
  updatedAt: null,
};

function snapshot(): XmppPushStatus {
  return { ...status };
}

export const PushStatus = {
  get(): XmppPushStatus {
    return snapshot();
  },

  update(patch: Partial<Omit<XmppPushStatus, 'updatedAt'>>): XmppPushStatus {
    status = {
      ...status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const next = snapshot();
    listeners.forEach((listener) => listener(next));
    return next;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  },
};
