# Observable client lifecycle and XMPP profile

## Problem

The native splash only waits for fonts, while the first XMPP connection is not
started by the provider itself. Connection, retry and roster synchronization
states are fragmented across screens. The user cannot inspect or edit their own
presence and vCard from a coherent profile surface.

## Outcome

Connect as soon as stored account loading settles, present an app-owned startup
surface with explicit phases, and expose retry/account actions. Add a profile
screen for local presence/status and vCard display name, avatar and supported
fields, consistent with the desktop client.

