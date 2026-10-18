import { xml } from '@xmpp/client';
import {
  NS_CONFERENCE_INVITE,
  NS_DATA_FORMS,
  NS_MUC,
  NS_MUC_ADMIN,
  NS_MUC_OWNER,
  NS_MUC_ROOMCONFIG,
  NS_MUC_USER,
  buildBan,
  buildConfigGet,
  buildConfigSubmit,
  buildInvite,
  buildJoinPresence,
  buildKick,
  buildSetAffiliation,
  buildSetRole,
  buildSetSubject,
  parseConfigForm,
  parseInvite,
  parseMucPresence,
  roleLabel,
} from '@/xmpp/xep/muc';

describe('muc (XEP-0045)', () => {
  it('construye la presencia de join sin historial por defecto', () => {
    const presence = buildJoinPresence('sala@conference.example.org', 'ana');

    expect(presence.attrs.to).toBe('sala@conference.example.org/ana');
    const x = presence.getChild('x', NS_MUC);
    expect(x?.getChild('history')?.attrs.maxstanzas).toBe('0');
  });

  it('acepta historial explícito y contraseña', () => {
    const presence = buildJoinPresence('sala@conference.example.org', 'ana', {
      historyMaxStanzas: 20,
      password: 'secreto',
    });
    const x = presence.getChild('x', NS_MUC);

    expect(x?.getChild('history')?.attrs.maxstanzas).toBe('20');
    expect(x?.getChildText('password')).toBe('secreto');
  });

  it('parsea la presencia propia con código 110 y JID real', () => {
    const presence = xml(
      'presence',
      { from: 'sala@conference.example.org/ana', type: 'available' },
      xml(
        'x',
        { xmlns: NS_MUC_USER },
        xml('item', {
          affiliation: 'member',
          role: 'participant',
          jid: 'ana@example.org/phone',
        }),
        xml('status', { code: '110' }),
        xml('status', { code: '100' }),
      ),
    );

    expect(parseMucPresence(presence)).toEqual({
      room: 'sala@conference.example.org',
      nick: 'ana',
      affiliation: 'member',
      role: 'participant',
      realJid: 'ana@example.org/phone',
      statusCodes: [110, 100],
      self: true,
      kicked: false,
      banned: false,
      nickChanged: false,
    });
  });

  it('detecta kick (307), ban (301) y cambio de nick (303)', () => {
    const presence = (codes: string[], nick?: string) =>
      xml(
        'presence',
        { from: 'sala@conference.example.org/ana', type: 'unavailable' },
        xml(
          'x',
          { xmlns: NS_MUC_USER },
          xml('item', {
            affiliation: 'outcast',
            role: 'none',
            ...(nick ? { nick } : {}),
          }),
          ...codes.map((code) => xml('status', { code })),
        ),
      );

    const kicked = parseMucPresence(presence(['307']));
    expect(kicked?.kicked).toBe(true);
    expect(kicked?.banned).toBe(false);

    const banned = parseMucPresence(presence(['301']));
    expect(banned?.banned).toBe(true);

    const renamed = parseMucPresence(
      xml(
        'presence',
        { from: 'sala@conference.example.org/ana' },
        xml(
          'x',
          { xmlns: NS_MUC_USER },
          xml('item', { nick: 'ana-nueva', affiliation: 'member', role: 'participant' }),
          xml('status', { code: '303' }),
        ),
      ),
    );
    expect(renamed?.nickChanged).toBe(true);
    expect(renamed?.newNick).toBe('ana-nueva');
  });

  it('devuelve null para una presencia que no es de sala', () => {
    expect(parseMucPresence(xml('presence', { from: 'ana@example.org' }))).toBeNull();
  });

  it('construye set de rol y afiliación, y sus atajos kick/ban', () => {
    const role = buildSetRole('sala@conference.example.org', 'ana', 'visitor', 'silencio');
    const roleItem = role.getChild('query', NS_MUC_ADMIN)?.getChild('item');
    expect(role.attrs.type).toBe('set');
    expect(roleItem?.attrs.nick).toBe('ana');
    expect(roleItem?.attrs.role).toBe('visitor');
    expect(roleItem?.getChildText('reason')).toBe('silencio');

    expect(
      buildKick('sala@conference.example.org', 'ana').getChild('query', NS_MUC_ADMIN)?.getChild('item')
        ?.attrs.role,
    ).toBe('none');

    const affiliation = buildSetAffiliation(
      'sala@conference.example.org',
      'ana@example.org',
      'member',
    );
    expect(
      affiliation.getChild('query', NS_MUC_ADMIN)?.getChild('item')?.attrs.affiliation,
    ).toBe('member');

    expect(
      buildBan('sala@conference.example.org', 'ana@example.org').getChild('query', NS_MUC_ADMIN)
        ?.getChild('item')?.attrs.affiliation,
    ).toBe('outcast');
  });

  it('construye el cambio de tema', () => {
    const msg = buildSetSubject('sala@conference.example.org', 'Nuevo tema');

    expect(msg.attrs.type).toBe('groupchat');
    expect(msg.getChildText('subject')).toBe('Nuevo tema');
  });

  it('round-trip de invitación mediada', () => {
    const msg = buildInvite('sala@conference.example.org', 'leo@example.org', 'únete');
    msg.attrs.from = 'sala@conference.example.org';

    expect(parseInvite(msg)).toEqual({
      room: 'sala@conference.example.org',
      from: 'sala@conference.example.org',
      reason: 'únete',
    });
  });

  it('parsea invitación directa XEP-0249 con password', () => {
    const msg = xml(
      'message',
      { from: 'ana@example.org/phone' },
      xml('x', {
        xmlns: NS_CONFERENCE_INVITE,
        jid: 'sala@conference.example.org',
        reason: 'pásate',
        password: 'clave',
      }),
    );

    expect(parseInvite(msg)).toEqual({
      room: 'sala@conference.example.org',
      from: 'ana@example.org/phone',
      reason: 'pásate',
      password: 'clave',
    });
  });

  it('devuelve null si el mensaje no invita a ninguna sala', () => {
    expect(parseInvite(xml('message', {}, xml('body', {}, 'hola')))).toBeNull();
  });

  it('construye config get y config submit con FORM_TYPE', () => {
    const get = buildConfigGet('sala@conference.example.org');
    expect(get.attrs.type).toBe('get');
    expect(get.getChild('query', NS_MUC_OWNER)).toBeDefined();

    const submit = buildConfigSubmit('sala@conference.example.org', [
      { var: 'muc#roomconfig_roomname', type: 'text-single', values: ['Sala'] },
      { var: 'muc#roomconfig_membersonly', type: 'boolean', values: ['1'] },
    ]);
    expect(submit.attrs.type).toBe('set');
    const form = submit
      .getChild('query', NS_MUC_OWNER)
      ?.getChild('x', NS_DATA_FORMS);
    expect(form?.attrs.type).toBe('submit');
    const fields = parseConfigForm(submit);
    expect(fields[0]).toEqual({
      var: 'FORM_TYPE',
      type: 'hidden',
      values: [NS_MUC_ROOMCONFIG],
    });
    expect(fields[1].var).toBe('muc#roomconfig_roomname');
    expect(fields[1].values).toEqual(['Sala']);
  });

  it('etiqueta roles y afiliaciones en español', () => {
    expect(roleLabel('moderator', 'owner')).toBe('dueño');
    expect(roleLabel('participant', 'admin')).toBe('admin');
    expect(roleLabel('moderator', 'member')).toBe('moderador');
    expect(roleLabel('participant', 'member')).toBe('miembro');
    expect(roleLabel('participant', 'none')).toBe('participante');
    expect(roleLabel('none', 'none')).toBe('participante');
    expect(roleLabel('visitor', 'none')).toBe('visitante');
    expect(roleLabel('', '')).toBe('');
  });
});
