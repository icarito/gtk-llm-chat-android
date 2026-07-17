/**
 * El payload de telemetría, tal y como lo publica el gateway.
 *
 * Estos tests existen porque el parser y el que publica se desincronizaron una
 * vez: el cliente leía <context_used>texto</context_used> en el namespace
 * urn:xmpp:telemetry:0 mientras el gateway emitía <context used=… max=…/> en
 * urn:nanoclaw:telemetry:0. Nada fallaba en voz alta — la telemetría
 * simplemente no aparecía nunca.
 *
 * Por eso el XML de abajo se copia literal de buildTelemetryItem() en
 * src/channels/xmpp.ts del gateway. Si allí cambia, aquí debe romperse.
 */
// @xmpp/xml re-exports ltx's Element but not its parser; ltx is where parse vive.
import { parse } from 'ltx';
import { parseTelemetry } from '@/xmpp/XmppService';

const TELEMETRY_NODE = 'urn:nanoclaw:telemetry:0';

/** Un <item> del nodo PEP, con el <telemetry/> que emite el gateway. */
function telemetryItem(body: string) {
  return parse(
    `<item xmlns="http://jabber.org/protocol/pubsub#event" id="current">
       <telemetry xmlns="${TELEMETRY_NODE}">${body}</telemetry>
     </item>`,
  );
}

describe('parseTelemetry', () => {
  it('lee un item completo tal y como lo publica el gateway', () => {
    const telemetry = parseTelemetry(
      telemetryItem(`
        <context used="42000" max="128000"/>
        <tokens total="51234" input="48000" output="3234" requests="17"/>
        <cost usd="0.0431"/>
        <model>deepseek-v4-pro</model>
        <tool>bash</tool>
      `),
    );

    expect(telemetry).toEqual({
      context_used: 42000,
      context_max: 128000,
      tokens_total: 51234,
      tokens_input: 48000,
      tokens_output: 3234,
      tokens_requests: 17,
      cost: 0.0431,
      model: 'deepseek-v4-pro',
      tool: 'bash',
    });
  });

  it('omite las claves ausentes en vez de rellenarlas con cero', () => {
    // "sin dato" y "cero" son cosas distintas para una barra de progreso: un
    // contexto que aún no se ha medido no debe pintarse como contexto vacío.
    const telemetry = parseTelemetry(telemetryItem('<model>deepseek-v4-flash</model>'));

    expect(telemetry).toEqual({ model: 'deepseek-v4-flash' });
    expect(telemetry).not.toHaveProperty('context_used');
    expect(telemetry).not.toHaveProperty('cost');
  });

  it('descarta un contexto sin max: no hay fracción que pintar', () => {
    expect(parseTelemetry(telemetryItem('<context used="42000"/>'))).toEqual({});
    expect(parseTelemetry(telemetryItem('<context used="42000" max="0"/>'))).toEqual({});
  });

  it('acepta un coste de cero (es un dato, no una ausencia)', () => {
    expect(parseTelemetry(telemetryItem('<cost usd="0.0000"/>'))).toEqual({ cost: 0 });
  });

  it('ignora un item de otro namespace', () => {
    // Defensa contra la regresión exacta que motivó estos tests.
    const foreign = parse(
      `<item xmlns="http://jabber.org/protocol/pubsub#event" id="current">
         <telemetry xmlns="urn:xmpp:telemetry:0"><context used="1" max="2"/></telemetry>
       </item>`,
    );

    expect(parseTelemetry(foreign)).toEqual({});
  });

  it('ignora un item sin telemetría', () => {
    const empty = parse('<item xmlns="http://jabber.org/protocol/pubsub#event" id="current"/>');

    expect(parseTelemetry(empty)).toEqual({});
  });

  it('lee el namespace nuevo urn:openclaw:telemetry:0 (rename de NanoClaw a OpenClaw)', () => {
    const renamed = parse(
      `<item xmlns="http://jabber.org/protocol/pubsub#event" id="current">
         <telemetry xmlns="urn:openclaw:telemetry:0">
           <context used="1000" max="2000"/>
           <model>deepseek-v4-pro</model>
         </telemetry>
       </item>`,
    );

    expect(parseTelemetry(renamed)).toEqual({
      context_used: 1000,
      context_max: 2000,
      model: 'deepseek-v4-pro',
    });
  });
});
