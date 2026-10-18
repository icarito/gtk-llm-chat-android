import { contacts, messages, pendingActions } from '@/xmpp/store';
import type { XmppMessage } from '@/types/xmpp';

function msg(id: string, from: string, body = id): XmppMessage {
  return {
    id, from, to: 'me@x', type: 'chat', body,
    timestamp: new Date(0).toISOString(), direction: 'in', isGroup: false,
  };
}

describe('xmpp store', () => {
  it('only notifies subscribers of the conversation that changed', () => {
    const a = jest.fn();
    const b = jest.fn();
    const unA = messages.subscribe('a@x', a);
    const unB = messages.subscribe('b@x', b);

    messages.setConversation('a@x', [msg('1', 'a@x')]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    // una "corrección" en A (nuevo array inmutable) tampoco toca a B
    messages.setConversation('a@x', [{ ...msg('1', 'a@x'), body: 'fixed' }]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).not.toHaveBeenCalled();

    unA();
    messages.setConversation('a@x', []);
    expect(a).toHaveBeenCalledTimes(2); // desuscrito
    unB();
  });

  it('keeps per-conversation snapshots stable and immutable', () => {
    messages.setConversation('c@x', [msg('1', 'c@x')]);
    const snap = messages.getConversation('c@x');
    expect(messages.getConversation('c@x')).toBe(snap);
    messages.setConversation('d@x', [msg('2', 'd@x')]);
    expect(messages.getConversation('c@x')).toBe(snap); // otra conversación no la reemplaza
    messages.setConversation('c@x', [...snap, msg('3', 'c@x')]);
    expect(messages.getConversation('c@x')).not.toBe(snap);
    expect(snap).toHaveLength(1);
  });

  it('returns one shared empty array for unknown conversations', () => {
    expect(messages.getConversation('nobody@x')).toBe(messages.getConversation('other@x'));
    expect(messages.getConversation('nobody@x')).toHaveLength(0);
  });

  it('copies the global map only when something changed since the last read', () => {
    messages.setConversation('e@x', [msg('1', 'e@x')]);
    const first = messages.getAll();
    expect(messages.getAll()).toBe(first);
    messages.setConversation('e@x', [msg('1', 'e@x'), msg('2', 'e@x')]);
    const second = messages.getAll();
    expect(second).not.toBe(first);
    expect(second.get('e@x')).toHaveLength(2);
    expect(first.get('e@x')).toHaveLength(1);
  });

  it('global subscribers hear every conversation', () => {
    const all = jest.fn();
    const un = messages.subscribeAll(all);
    messages.setConversation('f@x', [msg('1', 'f@x')]);
    messages.setConversation('g@x', [msg('1', 'g@x')]);
    expect(all).toHaveBeenCalledTimes(2);
    un();
  });

  it('publishes contacts as a fresh snapshot only on commit()', () => {
    const cb = jest.fn();
    const un = contacts.subscribe(cb);
    contacts.clear();
    contacts.set('z@x', { jid: 'z@x', name: 'Z', subscription: 'both', presence: 'offline' });
    expect(cb).not.toHaveBeenCalled();
    const before = contacts.getAll();
    contacts.commit();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(contacts.getAll()).not.toBe(before);
    expect(contacts.getAll().map((c) => c.jid)).toEqual(['z@x']);
    expect(contacts.getAll()).toBe(contacts.getAll());
    un();
  });

  it('pending actions publish a snapshot on commit()', () => {
    const cb = jest.fn();
    const un = pendingActions.subscribe(cb);
    pendingActions.map.set('1', {
      id: '1', conversationJid: 'a@x', messageId: 'm', timestamp: new Date(0).toISOString(),
      detail: '', kind: 'quick-response', label: 'ok', value: 'ok',
    });
    pendingActions.commit();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(pendingActions.getAll()).toHaveLength(1);
    pendingActions.map.clear();
    pendingActions.commit();
    un();
  });
});
