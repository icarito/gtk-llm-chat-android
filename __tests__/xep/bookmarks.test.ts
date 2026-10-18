import { xml } from '@xmpp/client';
import {
  NS_BOOKMARKS,
  NS_DATA_FORMS,
  NS_PUBSUB,
  NS_PUBSUB_PUBLISH_OPTIONS,
  buildPublishBookmark,
  buildRetractBookmark,
  parseBookmarksItems,
} from '@/xmpp/xep/bookmarks';

describe('bookmarks (XEP-0402)', () => {
  it('publica un bookmark con publish-options completas', () => {
    const iq = buildPublishBookmark('sala@conference.example.org', {
      name: 'Sala de pruebas',
      nick: 'ana',
      autojoin: true,
    });

    expect(iq.attrs.type).toBe('set');
    const pubsub = iq.getChild('pubsub', NS_PUBSUB);
    const publish = pubsub?.getChild('publish');
    expect(publish?.attrs.node).toBe(NS_BOOKMARKS);

    const item = publish?.getChild('item');
    expect(item?.attrs.id).toBe('sala@conference.example.org');
    const conference = item?.getChild('conference');
    expect(conference?.attrs).toEqual({
      xmlns: NS_BOOKMARKS,
      jid: 'sala@conference.example.org',
      autojoin: 'true',
      name: 'Sala de pruebas',
    });
    expect(conference?.getChildText('nick')).toBe('ana');

    const form = pubsub?.getChild('publish-options')?.getChild('x', NS_DATA_FORMS);
    const fields = new Map(
      form?.getChildren('field').map((field) => [
        field.attrs.var,
        field.getChildText('value'),
      ]),
    );
    expect(fields.get('FORM_TYPE')).toBe(NS_PUBSUB_PUBLISH_OPTIONS);
    expect(fields.get('pubsub#persist_items')).toBe('true');
    expect(fields.get('pubsub#max_items')).toBe('max');
    expect(fields.get('pubsub#send_last_published_item')).toBe('never');
    expect(fields.get('pubsub#access_model')).toBe('whitelist');
  });

  it('omite nombre y nick cuando no se pasan', () => {
    const iq = buildPublishBookmark('sala@conference.example.org', { autojoin: false });
    const conference = iq
      .getChild('pubsub', NS_PUBSUB)
      ?.getChild('publish')
      ?.getChild('item')
      ?.getChild('conference');

    expect(conference?.attrs.name).toBeUndefined();
    expect(conference?.attrs.autojoin).toBe('false');
    expect(conference?.getChild('nick')).toBeUndefined();
  });

  it('construye el retract del nodo de bookmarks', () => {
    const iq = buildRetractBookmark('sala@conference.example.org');
    const retract = iq.getChild('pubsub', NS_PUBSUB)?.getChild('retract');

    expect(retract?.attrs.node).toBe(NS_BOOKMARKS);
    expect(retract?.getChild('item')?.attrs.id).toBe('sala@conference.example.org');
  });

  it('parsea items publicados en el nodo de bookmarks', () => {
    const publish = buildPublishBookmark('sala@conference.example.org', {
      name: 'Sala',
      nick: 'ana',
      autojoin: true,
    })
      .getChild('pubsub', NS_PUBSUB)
      ?.getChild('publish');
    const items = xml(
      'items',
      { xmlns: 'http://jabber.org/protocol/pubsub#event', node: NS_BOOKMARKS },
      publish?.getChild('item') ?? xml('item', {}),
    );

    expect(parseBookmarksItems(items)).toEqual([
      {
        jid: 'sala@conference.example.org',
        name: 'Sala',
        nick: 'ana',
        autojoin: true,
      },
    ]);
  });

  it('ignora items sin conference y toma la sala del id del item si falta jid (XEP-0402)', () => {
    const items = xml(
      'items',
      { xmlns: NS_BOOKMARKS },
      xml('item', { id: 'sin-conferencia' }),
      xml('item', { id: 'sin-jid' }, xml('conference', { xmlns: NS_BOOKMARKS })),
    );

    expect(parseBookmarksItems(items)).toEqual([{ jid: 'sin-jid', autojoin: false }]);
  });
});
