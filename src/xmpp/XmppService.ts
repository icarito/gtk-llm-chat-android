/**
 * XMPP Service — fachada singleton sobre los módulos de src/xmpp. La conexión
 * vive todo el ciclo de la app; los componentes se suscriben, nunca la poseen.
 *
 * Aquí sólo vive el ciclo de vida (connect/disconnect/reconnect) y el cableado
 * del cliente; cada XEP tiene su módulo (mam, pep, commands, upload, …) y el
 * estado observable está en store.ts / connection.ts. La API pública que usan
 * pantallas y hooks (`XmppService.*` y los re-exports de abajo) se mantiene.
 */
import { client as createClient, xml } from '@xmpp/client';
import type { Client } from '@xmpp/xml';
import type {
  XmppAccountConfig,
  XmppConnectionState,
  XmppContact,
  XmppMessage,
  XmppPendingAction,
} from '@/types/xmpp';
import { dismissNotificationForJid, setConnected } from '@/xmpp/notifications';
import { getDeviceResourceSuffix } from '@/xmpp/deviceResource';
import { ForegroundService } from '@/xmpp/ForegroundService';
import {
  enqueueActionResponse,
  flushQueuedActionResponses,
  setActionQueueRunner,
} from '@/xmpp/actionQueue';
import {
  getForegroundServiceEnabled,
  setForegroundServiceEnabled,
} from '@/xmpp/foregroundServicePreference';
import { XmppHistory } from '@/xmpp/XmppHistory';
import {
  classifyApprovalCommandResult,
  clearPendingActions,
  getPendingAction,
  getPendingActions,
  isPendingActionExpired,
  notifyPendingActions,
  removePendingAction,
  removePendingActionsByMessage,
} from '@/xmpp/actions';
import {
  executeCommand,
  getElevatedSessionStatus,
  listAdhocCommands,
  runAdhocCommand,
  setElevatedSession,
} from '@/xmpp/commands';
import { resetInbound } from '@/xmpp/inbound';
import {
  loadCachedHistory,
  loadCachedPreviews,
  loadOlderHistory,
  refetchRecentForDecrypt,
  restoreCachedActions,
  syncHistory,
} from '@/xmpp/mam';
import { retryMessage, sendChatState, sendMessage, sendTyping } from '@/xmpp/messages';
import { react, retractMessage } from '@/xmpp/annotations';
import {
  acceptInvite,
  declineInvite,
  joinRoom,
  leaveRoom,
  removeBookmark,
  resetRoomCaches,
  setBookmark,
  startRooms,
} from '@/xmpp/rooms';
import {
  ban,
  getRoomConfig,
  invite,
  kick,
  setAffiliation,
  setRole,
  setSubject,
  submitRoomConfig,
} from '@/xmpp/moderation';
import { initOmemoOnOnline } from '@/xmpp/omemo';
import { omemo2Api } from '@/xmpp/omemo2';
import {
  avatarListeners,
  fetchAgentTelemetry,
  fetchAvatar,
  getAgentTelemetry,
  getAvatarUri,
  telemetryListeners,
  type AgentTelemetryListener,
} from '@/xmpp/pep';
import { agents, approvalForStanza } from '@/xmpp/agents';
import { pingServer, startPing, stopPing } from '@/xmpp/ping';
import { enableExpoPushIfAvailable, reportPushFailure } from '@/xmpp/push';
import { fetchRosterThenAnnounce, resetRoster } from '@/xmpp/roster';
import { routeStanza } from '@/xmpp/router';
import { attemptHook, connection, session, type StanzaCtx } from '@/xmpp/session';
import { contacts, invites, messages, pendingActions, rooms } from '@/xmpp/store';
import { isTyping, typingListeners } from '@/xmpp/typing';
import { resetUploadHost, sendFile } from '@/xmpp/upload';

// ── API pública re-exportada (los tests y las pantallas importan de aquí) ──

export {
  actionLooksLikeApproval,
  actionsLookLikeApproval,
  approvalFallbackExpiry,
  bodyLooksLikeApproval,
  classifyApprovalCommandResult,
  findDenyAction,
  isRestoredActionStale,
  pendingGroupLooksLikeApproval,
} from '@/xmpp/actions';
export { parseMamResult, persistAndDedupe } from '@/xmpp/mam';
export { parseTelemetry, type AgentTelemetryListener } from '@/xmpp/pep';
export {
  parseActionMetadata,
  parseInlineCommands,
  parseQuickResponses,
  parseReplaceId,
} from '@/xmpp/parse';

export type XmppStateListener = (state: XmppConnectionState) => void;
export type XmppContactListener = (contacts: XmppContact[]) => void;
export type XmppMessageListener = (messages: Map<string, XmppMessage[]>) => void;
export type XmppPendingActionListener = (actions: XmppPendingAction[]) => void;

// ── Ciclo de vida ──

/** connect() en curso: los llamadores concurrentes esperan al mismo intento. */
let connectInFlight: Promise<void> | null = null;
let reconnectPromise: Promise<void> | null = null;

/**
 * Clientes que descartamos a propósito (disconnect, ping muerto, reconexión).
 * Sus eventos 'disconnect'/'offline'/'error' son esperados y no deben disparar
 * la política de reconexión.
 */
const retired = new WeakSet<Client>();

const CONNECT_TIMEOUT_MS = 30000;

/**
 * Estado de XEP-0198 (Stream Management) de la sesión anterior, guardado
 * fuera del ciclo de vida del cliente para poder pedir <resume/> en la
 * próxima conexión en vez de un bind completo. connectExclusive() crea un
 * Client nuevo en cada llamada — sin esto, cada reconexión (constante en
 * móvil por Doze/cambios de red) perdía el resume id y forzaba al servidor a
 * reenviar mensajes/carbons pendientes como si fuera una sesión nueva.
 *
 * Se captura en el evento 'disconnect' (antes de 'offline'): el propio
 * módulo @xmpp/stream-management resetea sm.id/inbound/outbound al ver
 * 'offline', así que hay que leerlos un paso antes.
 *
 * Atado al jid: si se cambia de cuenta un resume id viejo no debe
 * reutilizarse contra un stream que el servidor nunca asoció a esa sesión.
 */
let savedStreamManagement: { jid: string; id: string; inbound: number; outbound: number } | null = null;

/** Tira el cliente a propósito: marcarlo antes de stop() para que sus eventos no reconecten. */
async function retireClient(client: Client) {
  retired.add(client);
  await client.stop().catch(() => {});
}

/** El servicio en primer plano es opcional (preferencia persistida, default on). */
async function startForegroundServiceIfEnabled(jid: string) {
  if (!(await getForegroundServiceEnabled())) return;
  await ForegroundService.start(jid);
}

/**
 * Un fallo de conexión (evento 'error' o rechazo de start()). Un fallo de
 * autenticación detiene el backoff (reintentar con credenciales malas sólo
 * martilla al servidor); cualquier otro entra en la política única.
 */
function handleConnectionFailure(err: unknown, failed?: Client) {
  if (connection.state === 'AUTH_FAILED') return;
  if (err instanceof Error && err.name === 'SASLError') {
    connection.step('sasl', 'failed');
    connection.set('AUTH_FAILED');
    if (failed) {
      retired.add(failed);
      failed.stop().catch(() => {});
      if (session.client === failed) session.client = null;
    }
    return;
  }
  connection.set('RECONNECTING', 'error');
  connection.scheduleReconnect();
}

// La política de reconexión pide un intento; lo ejecuta el mismo camino que el
// AppState (coalesce con intentos en curso, ping previo si ya estamos online).
attemptHook.fn = async () => {
  if (session.account) await XmppService.reconnectIfNeeded(session.account);
};

/** Respuesta real a una acción ya resuelta como pendiente (requiere conexión). */
async function executePendingAction(actionId: string): Promise<void> {
  const action = getPendingAction(actionId);
  if (!action) return;
  if (isPendingActionExpired(action)) {
    removePendingAction(actionId);
    return;
  }
  // Marcar como submitted inmediatamente: la UI atenúa el botón y la card
  // se retira visualmente. La corrección XEP-0308 autoritativa o la
  // clasificación del resultado del IQ limpia el estado persistente.
  action.submitted = true;
  notifyPendingActions();
  try {
    if (action.kind === 'quick-response') {
      await sendMessage(action.conversationJid, action.value ?? action.label, 'chat');
    } else if (action.jid && action.node) {
      const result = await executeCommand(action.jid, action.node);
      const outcome = classifyApprovalCommandResult(result);
      if (outcome === 'expired') {
        XmppHistory.markResolvedByStanzaId(action.conversationJid, action.messageId)
          .catch(() => {});
        removePendingActionsByMessage(action.conversationJid, action.messageId);
        return;
      }
    }
  } catch (err) {
    // El optimismo de `submitted` solo vale mientras el envío siga en pie.
    // Si executeCommand falla (sin conexión, IQ inválido, timeout de 30 s)
    // la card se quedaba en "Enviada…" para una decisión que nunca salió, y
    // sin aviso: la excepción moría como unhandled rejection. Revertimos y
    // re-lanzamos para que la UI avise, igual que hace GTK en on_error.
    action.submitted = false;
    notifyPendingActions();
    throw err;
  }
  await XmppHistory.markResolvedByStanzaId(
    action.conversationJid,
    action.messageId,
  );
  removePendingActionsByMessage(action.conversationJid, action.messageId);
  dismissNotificationForJid(action.conversationJid).catch(() => {});
}

export const XmppService = {
  /** Máquina de estados + fases de arranque observables (futuro checklist de inicio). */
  connection,

  getState(): XmppConnectionState {
    return connection.legacyState();
  },

  getContacts(): XmppContact[] {
    return [...contacts.getAll()];
  },

  getMessages(): Map<string, XmppMessage[]> {
    return new Map(messages.getAll());
  },

  getPendingActions(): XmppPendingAction[] {
    return getPendingActions();
  },

  getAccount(): XmppAccountConfig | null {
    return session.account;
  },

  onStateChange(fn: XmppStateListener) {
    let last = connection.legacyState();
    return connection.subscribe(() => {
      const state = connection.legacyState();
      if (state === last) return;
      last = state;
      fn(state);
    });
  },

  onContactsChange(fn: XmppContactListener) {
    return contacts.subscribe(() => fn(contacts.getAll()));
  },

  onMessagesChange(fn: XmppMessageListener) {
    return messages.subscribeAll(() => fn(messages.getAll()));
  },

  onPendingActionsChange(fn: XmppPendingActionListener) {
    return pendingActions.subscribe(() => fn([...pendingActions.getAll()]));
  },

  /** XEP-0085: ¿está este contacto "escribiendo…" ahora? */
  isTyping,

  onTypingChange(fn: (jid: string, typing: boolean) => void) {
    typingListeners.add(fn);
    return () => typingListeners.delete(fn);
  },

  sendChatState,
  retryMessage,
  getAgentTelemetry,

  /** Store de telemetría + hooks PEP por agente (ver agents.ts). */
  agents,
  approvalForStanza,

  onTelemetry(fn: AgentTelemetryListener) {
    telemetryListeners.add(fn);
    return () => telemetryListeners.delete(fn);
  },

  getAvatarUri,
  fetchAvatar,

  onAvatarChange(fn: (jid: string, uri: string | null) => void) {
    avatarListeners.add(fn);
    return () => avatarListeners.delete(fn);
  },

  fetchAgentTelemetry,

  async connect(config: XmppAccountConfig) {
    // Exclusividad: al volver del background pueden pedir conexión a la vez el
    // AppState handler (reconnectIfNeeded) y la pantalla de chat. Sin este
    // guard, cada connect() tumba el cliente del otro a mitad de handshake y
    // el estado oscila connecting→offline→connecting sin converger.
    if (connectInFlight) return connectInFlight;
    connectInFlight = this.connectExclusive(config).finally(() => {
      connectInFlight = null;
    });
    return connectInFlight;
  },

  async connectExclusive(config: XmppAccountConfig) {
    if (session.client) {
      await this.disconnect();
    }
    // Después del disconnect de arriba, que lo deja puesto: conectar es la
    // intención contraria y reabre la puerta al auto-retry.
    connection.resume();
    // Sólo el timer: el contador del backoff lo resetea llegar a SYNCING/ONLINE.
    // Resetearlo aquí (como hacía stopRetry) lo dejaba siempre en 5s, porque
    // cada intento automático pasa por este mismo connect().
    connection.cancelPendingRetry();

    connection.set('CONNECTING');
    connection.step('tls', 'active');
    session.account = config;
    resetInbound();
    messages.reset();
    clearPendingActions();
    // Reset, or a reconnect keeps phantom "online" resources and stale roster.
    resetRoster();

    const botNick = config.jid.split('@')[0]!;
    const domain = config.jid.split('@')[1];
    const deviceSuffix = await getDeviceResourceSuffix();

    const client = createClient({
      service: config.service,
      domain,
      username: config.jid.split('@')[0],
      password: config.password,
      // Sufijo estable, no aleatorio por arranque: así el servidor reemplaza
      // nuestra sesión anterior en vez de dejarla como zombi (ver
      // getDeviceResourceSuffix).
      resource: `${config.resource || 'gtk-llm-chat-android'}-${deviceSuffix}`,
    });
    session.client = client;
    const ctx: StanzaCtx = { client, config, botNick };
    const isCurrent = () => session.client === client && !retired.has(client);

    // @xmpp/reconnect (5s fijos, sobre el MISMO cliente) queda desactivado: la
    // recuperación es la política única de connection.ts, que crea un Client
    // nuevo por intento y reinyecta el resume id de XEP-0198 (abajo).
    client.reconnect.stop();

    // XEP-0198 Stream Management: si la sesión anterior (misma cuenta) dejó
    // un resume id guardado, lo reinyectamos ANTES de conectar. El módulo lo
    // detecta él solo en la negociación de stream features y pide <resume/>
    // en vez de bind completo, evitando que el servidor reenvíe mensajes y
    // carbons ya entregados. bind2 no se usa acá (sin sasl2/fast configurado
    // con credenciales reales), así que el resume viaja por el camino
    // clásico post-bind — ver @xmpp/stream-management/stream-feature.js.
    if (savedStreamManagement?.jid === config.jid) {
      Object.assign(client.streamManagement, {
        id: savedStreamManagement.id,
        inbound: savedStreamManagement.inbound,
        outbound: savedStreamManagement.outbound,
      });
    }
    // El ping XEP-0199 propio (ping.ts) ya vigila la conexión como disparador de
    // la política de reconexión; el <r/> periódico interno de SM sería un segundo
    // reloj redundante vigilando lo mismo. Se desactiva (0 = sin timer) y SM
    // queda limitado a llevar la cuenta de acks para el resume.
    client.streamManagement.requestAckInterval = 0;
    client.streamManagement.timeout = 0;

    // Fases de arranque observables.
    client.on('status', (status: string) => {
      if (status !== 'connect' || !isCurrent()) return;
      connection.step('tls', 'done');
      connection.step('sasl', 'active');
    });

    client.on('disconnect', () => {
      if (session.client !== client) return;
      const sm = client.streamManagement;
      // Sin id no hubo (o no siguió habiendo) SM habilitado en esta sesión;
      // no hay nada que resumir la próxima vez.
      savedStreamManagement = sm.id
        ? { jid: config.jid, id: sm.id, inbound: sm.inbound, outbound: sm.outbound }
        : null;
      // Caída del socket que no provocamos nosotros: a la política única.
      if (retired.has(client) || connection.state === 'AUTH_FAILED') return;
      stopPing();
      connection.set('RECONNECTING', 'drop');
      connection.scheduleReconnect();
    });

    client.on('online', () => {
      if (!isCurrent()) return;
      connection.step('sasl', 'done');
      // Stream arriba: ya se puede hablar (equivale al antiguo 'online');
      // ONLINE llega cuando el roster y la presencia inicial terminan.
      connection.set('SYNCING');
      setConnected();
      startForegroundServiceIfEnabled(config.jid).catch(() => {});

      initOmemoOnOnline(config.jid, client, Boolean(config.omemoEnabled));

      // XEP-0280 Carbons — usar iqCaller para asegurar delivery y tener id
      client.iqCaller.request(
        xml('iq', { type: 'set', id: `carbons-${Date.now()}` },
          xml('enable', { xmlns: 'urn:xmpp:carbons:2' })),
        10000,
      ).catch(() => {});
      enableExpoPushIfAvailable().catch(reportPushFailure);

      // XEP-0199 Ping: sólo dispara la política única.
      startPing(config.jid, async (dead) => {
        retired.add(dead);
        await dead.stop().catch(() => {});
        session.client = null;
        connection.set('RECONNECTING', 'drop');
        connection.scheduleReconnect();
      });

      // Sesión nueva (SM no reanudó: 'online' no se emite al reanudar): el
      // servidor ya no tiene nuestra presencia en las salas; marcadores y rejoin
      // van tras roster + presencia inicial.
      fetchRosterThenAnnounce(ctx).then(() => startRooms(ctx)).catch(() => {});
    });

    client.on('offline', () => {
      if (!isCurrent()) return;
      stopPing();
      connection.set('RECONNECTING', 'drop');
      connection.scheduleReconnect();
    });

    client.on('error', (err: unknown) => {
      if (!isCurrent()) return;
      handleConnectionFailure(err, client);
    });

    client.on('stanza', (stanza) => routeStanza(stanza, ctx));

    let connectTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        client.start(),
        new Promise<never>((_resolve, reject) => {
          connectTimeout = setTimeout(
            () => reject(new Error('XMPP connection timed out')),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      if (session.client === client) {
        await retireClient(client);
        session.client = null;
      }
      handleConnectionFailure(err);
      throw err;
    } finally {
      if (connectTimeout) clearTimeout(connectTimeout);
    }
  },

  async reconnectIfNeeded(config: XmppAccountConfig) {
    const mergedConfig: XmppAccountConfig = {
      jid: config.jid || session.account?.jid || '',
      password: config.password || session.account?.password || '',
      service: config.service || session.account?.service || '',
      resource: config.resource || session.account?.resource || 'gtk-llm-chat-android',
      omemoEnabled: config.omemoEnabled ?? session.account?.omemoEnabled ?? true,
    };
    if (!mergedConfig.jid || !mergedConfig.password || !mergedConfig.service) {
      throw new Error('XMPP account config incomplete for reconnect');
    }
    session.account = mergedConfig;

    if (reconnectPromise) return reconnectPromise;
    if (connection.state === 'CONNECTING') return;

    if (session.client && connection.isUsable()) {
      try {
        await pingServer(mergedConfig.jid, 5000);
        return;
      } catch {
        connection.set('RECONNECTING', 'drop');
      }
    }

    reconnectPromise = (async () => {
      stopPing();
      const stale = session.client;
      if (stale) {
        // Marcado como descartado: su stop() dispara 'disconnect' y no debe
        // reabrir una reconexión en paralelo con el cliente nuevo que
        // connect() está por crear.
        await retireClient(stale);
        session.client = null;
      }
      await this.connect(mergedConfig);
    })().finally(() => {
      reconnectPromise = null;
    });

    return reconnectPromise;
  },

  async disconnect() {
    // El usuario se desconectó a propósito: que el auto-retry no lo revierta.
    connection.halt();
    stopPing();
    const client = session.client;
    if (client) {
      await retireClient(client);
      session.client = null;
    }
    await ForegroundService.stop().catch(() => {});
    connection.set('DISCONNECTED');
    // Logout explícito, no una caída: no tiene sentido resumir esta sesión
    // en el próximo login (el listener 'disconnect' de arriba la habrá
    // guardado igual, hay que descartarla acá).
    savedStreamManagement = null;
    // Otra cuenta puede estar en otro servidor: re-descubrir el componente
    // de subida en la próxima sesión.
    resetUploadHost();
    clearPendingActions();
    // Otra cuenta no hereda salas ni invitaciones de ésta.
    rooms.reset();
    invites.reset();
    resetRoomCaches();
    session.account = null;
  },

  sendMessage,
  sendFile,
  sendTyping,

  // ── Reacciones (XEP-0444) y retractación (XEP-0424) ──
  react,
  retractMessage,

  // ── OMEMO 2 ──
  /** `ownFingerprint`, `devices(jid)`, `setTrust`, `isEnabledFor`/`setEnabledFor`, `refresh`, `subscribe`, `onIdentityChanged`. */
  omemo2: omemo2Api,

  // ── Salas (MUC) ──
  /** Estado observable de salas: `get(jid)`, `getAll()`, `subscribe(cb)`. */
  rooms: { get: rooms.get, getAll: rooms.getAll, subscribe: rooms.subscribe },
  /** Invitaciones pendientes: `getAll()`, `subscribe(cb)`. */
  invites: { get: invites.get, getAll: invites.getAll, subscribe: invites.subscribe },
  joinRoom,
  leaveRoom,
  setBookmark,
  removeBookmark,
  acceptInvite,
  declineInvite,
  setRole,
  setAffiliation,
  kick,
  ban,
  setSubject,
  invite,
  getRoomConfig,
  submitRoomConfig,

  async answerPendingAction(actionId: string): Promise<void> {
    // Sin conexión usable la respuesta no se pierde: queda en cola y sale sola
    // cuando la sesión pase a online (observador al final del módulo).
    if (!connection.isUsable() || session.client === null) {
      enqueueActionResponse(actionId);
      return;
    }
    await executePendingAction(actionId);
  },

  listAdhocCommands,
  runAdhocCommand,
  setElevatedSession,
  getElevatedSessionStatus,

  isConnected(): boolean {
    return connection.isUsable() && session.client !== null;
  },

  /** Preferencia persistida del foreground service de Android. */
  getForegroundServiceEnabled,
  setForegroundServiceEnabled,

  // ── XEP-0313: MAM history ──
  loadCachedHistory,
  restoreCachedActions,
  loadCachedPreviews,
  syncHistory,
  loadOlderHistory,
  refetchRecentForDecrypt,
};

// Cola de respuestas de notificación: se vacía al volver a online.
setActionQueueRunner(executePendingAction);
XmppService.onStateChange((state) => {
  if (state !== 'online') return;
  flushQueuedActionResponses().catch(() => {});
});
