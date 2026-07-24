declare module '@xmpp/xml' {
  export interface Client extends Element {
    start(): Promise<void>;
    stop(): Promise<void>;
    disconnect(): Promise<void>;
    send(element: Element): Promise<void>;
    on(event: 'online' | 'offline' | 'error' | 'disconnect', handler: (...args: unknown[]) => void): void;
    on(event: 'stanza', handler: (stanza: Element) => void): void;
    on(event: 'status', handler: (status: string) => void): void;
    reconnect: Reconnect;
    iqCaller: IqCaller;
    streamManagement: StreamManagement;
  }

  export interface StreamManagement {
    /** Resume id del stream negociado (XEP-0198); '' si no está habilitado. */
    id: string;
    /** Contador de stanzas entrantes reconocidas ('h' en la spec). */
    inbound: number;
    /** Contador de stanzas salientes reconocidas. */
    outbound: number;
    enabled: boolean;
    /** ms entre <r/> automáticos; 0 desactiva ese watchdog interno. */
    requestAckInterval: number;
    /** ms de espera de <a/> antes de forzar disconnect(); 0 desactiva. */
    timeout: number;
    on(event: 'resumed' | 'ack' | 'fail', handler: (...args: unknown[]) => void): void;
  }

  export interface Element {
    name: string;
    attrs: Record<string, string>;
    children: Element[];
    parent: Element | null;

    is(name: string, xmlns?: string): boolean;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string, xmlns?: string): Element[];
    getChildText(name: string, xmlns?: string): string | undefined;
    getChildElements(): Element[];
    text(): string;
    toString(): string;
  }

  export interface Reconnect {
    delay: number;
    on(event: 'reconnecting' | 'reconnected', handler: () => void): void;
    stop(): void;
  }

  export interface IqCaller {
    request(stanza: Element, timeout?: number): Promise<Element>;
  }
}

declare module 'ltx' {
  import type { Element } from '@xmpp/xml';
  export function parse(xml: string): Element;
}

declare module '@xmpp/client' {
  import type { Element, Client } from '@xmpp/xml';
  export function client(options: {
    service: string;
    domain: string;
    username: string;
    password: string;
    resource?: string;
  }): Client;

  export function xml(name: string, attrs?: Record<string, string>, ...children: (string | Element)[]): Element;
}
