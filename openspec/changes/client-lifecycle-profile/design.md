# Design

Keep the native Expo splash only until fonts and secure account loading settle;
render an in-app startup screen for network phases so it can remain interactive.
Use the shared lifecycle vocabulary from the desktop change. `XmppService`
remains the sole connection owner and exposes phase/error metadata through
`XmppContext`.

Profile writes use XMPP vCard/presence APIs in the service, never directly from
React components. Optimistic UI is allowed only with visible rollback on error.

