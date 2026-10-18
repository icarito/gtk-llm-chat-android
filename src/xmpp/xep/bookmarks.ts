import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';

export const NS_BOOKMARKS = 'urn:xmpp:bookmarks:1';
export const NS_PUBSUB = 'http://jabber.org/protocol/pubsub';
export const NS_PUBSUB_PUBLISH_OPTIONS =
  'http://jabber.org/protocol/pubsub#publish-options';
export const NS_DATA_FORMS = 'jabber:x:data';

export interface BookmarkOptions {
  name?: string;
  nick?: string;
  autojoin: boolean;
}

export interface Bookmark {
  jid: string;
  name?: string;
  nick?: string;
  autojoin: boolean;
}

function formField(
  variable: string,
  type: string,
  value: string,
): Element {
  return xml(
    'field',
    { var: variable, type },
    xml('value', {}, value),
  );
}

/**
 * Publica (o reemplaza) un bookmark XEP-0402 en el nodo PEP
 * `urn:xmpp:bookmarks:1`. Las publish-options fijan el nodo para que sobreviva
 * sin items antiguos y sólo sea visible para los contactos autorizados.
 */
export function buildPublishBookmark(
  roomJid: string,
  options: BookmarkOptions,
): Element {
  const conferenceAttrs: Record<string, string> = {
    xmlns: NS_BOOKMARKS,
    jid: roomJid,
    autojoin: options.autojoin ? 'true' : 'false',
  };
  if (options.name) conferenceAttrs.name = options.name;

  const conferenceChildren: Element[] = [];
  if (options.nick) conferenceChildren.push(xml('nick', {}, options.nick));

  const publishOptions = xml(
    'x',
    { xmlns: NS_DATA_FORMS, type: 'submit' },
    formField('FORM_TYPE', 'hidden', NS_PUBSUB_PUBLISH_OPTIONS),
    formField('pubsub#persist_items', 'boolean', 'true'),
    formField('pubsub#max_items', 'text-single', 'max'),
    formField('pubsub#send_last_published_item', 'list-single', 'never'),
    formField('pubsub#access_model', 'list-single', 'whitelist'),
  );

  return xml(
    'iq',
    { type: 'set' },
    xml(
      'pubsub',
      { xmlns: NS_PUBSUB },
      xml(
        'publish',
        { node: NS_BOOKMARKS },
        xml(
          'item',
          { id: roomJid },
          xml('conference', conferenceAttrs, ...conferenceChildren),
        ),
      ),
      xml('publish-options', {}, publishOptions),
    ),
  );
}

export function buildRetractBookmark(roomJid: string): Element {
  return xml(
    'iq',
    { type: 'set' },
    xml(
      'pubsub',
      { xmlns: NS_PUBSUB },
      xml(
        'retract',
        { node: NS_BOOKMARKS },
        xml('item', { id: roomJid }),
      ),
    ),
  );
}

function parseAutojoin(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function parseBookmarksItems(itemsEl: Element): Bookmark[] {
  const bookmarks: Bookmark[] = [];

  for (const node of itemsEl.children) {
    // Nodos de texto (espacios entre elementos) no son <item>.
    if (typeof node === 'string') continue;
    const conference =
      node.name === 'conference' ? node : node.getChild('conference');
    if (!conference) continue;

    // XEP-0402: la sala es el id del <item>; `jid` en <conference> sólo lo emite nuestro builder.
    const jid = conference.attrs.jid ?? node.attrs.id;
    if (!jid) continue;

    const nick = conference.getChildText('nick');
    const bookmark: Bookmark = {
      jid,
      autojoin: parseAutojoin(conference.attrs.autojoin),
    };
    if (conference.attrs.name) bookmark.name = conference.attrs.name;
    if (nick) bookmark.nick = nick;
    bookmarks.push(bookmark);
  }

  return bookmarks;
}
