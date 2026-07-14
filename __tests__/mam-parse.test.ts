/**
 * Regression tests for XEP-0313 result parsing.
 *
 * The bug these lock down: archived messages arrive as standalone <message>
 * stanzas wrapping <result><forwarded>, NOT inside the IQ reply. Parsing the
 * IQ for <forwarded> always yielded zero messages, so history never loaded.
 */
// @xmpp/xml re-exports ltx's Element but not its parser; ltx is where parse lives.
import { parse } from 'ltx';
import { parseMamResult } from '@/xmpp/XmppService';

const OWN_JID = 'me@hablar.fuentelibre.org';
const PEER_JID = 'nanoclaw@hablar.fuentelibre.org';

/** A MAM hit as Prosody actually sends it: its own message stanza. */
function mamStanza(opts: {
  from: string;
  to: string;
  body: string;
  stamp: string;
  archiveId?: string;
  queryid?: string;
}) {
  const stanza = parse(
    `<message xmlns="jabber:client">
       <result xmlns="urn:xmpp:mam:2" queryid="${opts.queryid ?? 'q1'}" id="${opts.archiveId ?? 'arch-1'}">
         <forwarded xmlns="urn:xmpp:forward:0">
           <delay xmlns="urn:xmpp:delay" stamp="${opts.stamp}"/>
           <message xmlns="jabber:client" type="chat" from="${opts.from}" to="${opts.to}" id="m1">
             <body>${opts.body}</body>
           </message>
         </forwarded>
       </result>
     </message>`,
  );
  return stanza.getChild('result', 'urn:xmpp:mam:2')!;
}

describe('parseMamResult', () => {
  it('extracts a message the peer sent to us as incoming', () => {
    const msg = parseMamResult(
      mamStanza({
        from: `${PEER_JID}/bot`,
        to: OWN_JID,
        body: 'hola desde el archivo',
        stamp: '2026-07-13T10:00:00Z',
        archiveId: 'arch-42',
      }),
      OWN_JID,
    );

    expect(msg).not.toBeNull();
    expect(msg!.body).toBe('hola desde el archivo');
    expect(msg!.direction).toBe('in');
    expect(msg!.from).toBe(PEER_JID);
    expect(msg!.mamId).toBe('arch-42');
  });

  it('extracts a message we sent as outgoing', () => {
    const msg = parseMamResult(
      mamStanza({
        from: `${OWN_JID}/phone`,
        to: PEER_JID,
        body: 'lo dije yo',
        stamp: '2026-07-13T10:01:00Z',
      }),
      OWN_JID,
    );

    // Direction is what tells the two sides of the archive apart on replay —
    // the resource on `from` must not defeat the comparison.
    expect(msg!.direction).toBe('out');
    expect(msg!.body).toBe('lo dije yo');
  });

  it('uses the <delay> stamp, not the time of replay', () => {
    const msg = parseMamResult(
      mamStanza({
        from: `${PEER_JID}/bot`,
        to: OWN_JID,
        body: 'mensaje viejo',
        stamp: '2026-07-01T08:30:00Z',
      }),
      OWN_JID,
    );

    // Without this the message is stamped "now" and sorts to the bottom.
    expect(new Date(msg!.timestamp).toISOString()).toBe('2026-07-01T08:30:00.000Z');
  });

  it('ignores archived stanzas that carry no body', () => {
    const stanza = parse(
      `<message xmlns="jabber:client">
         <result xmlns="urn:xmpp:mam:2" queryid="q1" id="arch-9">
           <forwarded xmlns="urn:xmpp:forward:0">
             <delay xmlns="urn:xmpp:delay" stamp="2026-07-13T10:00:00Z"/>
             <message xmlns="jabber:client" type="chat" from="${PEER_JID}" to="${OWN_JID}">
               <composing xmlns="http://jabber.org/protocol/chatstates"/>
             </message>
           </forwarded>
         </result>
       </message>`,
    );
    const result = stanza.getChild('result', 'urn:xmpp:mam:2')!;

    expect(parseMamResult(result, OWN_JID)).toBeNull();
  });
});
