declare module '@xmpp/xml' {
  export function xml(
    name: string,
    attrs?: Record<string, string>,
    ...children: (string | Element)[]
  ): Element;
}
