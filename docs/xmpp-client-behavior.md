# XMPP client behavior

## Approval actions

Approval controls are rendered from XEP action metadata and stale actions are
discarded using `expiresAtMs`. Restored history also filters expired approval
actions so dead cards do not come back after reopening the conversation.

The elevated-session toggle executes the real XEP-0050 ad-hoc command with
node `elevated` (`XmppService.setElevatedSession`), the same path as the other
native ad-hoc commands. It submits a data form with a `mode` field (`on`,
`off`, or `status`) and, when enabling, a `minutes` field (default `10`).

- `on`: enables gateway auto mode (`allowlist` plus flash reviewer) for the
  requested number of minutes.
- `off`: returns the gateway to `ask`.
- `status`: queries the current state (`XmppService.getElevatedSessionStatus`);
  the result carries the structured `active` and `remaining-seconds` fields,
  which the client maps to a remaining-minutes value.

While the approval popover is open, `status` is polled every 15 seconds so the
switch reflects the server-side auto-expiry; polling stops when the popover
closes.

## Code fences

Triple-backtick code fences render as distinct blocks in message bubbles. Each
block shows a language label, monospace horizontally scrollable content, and a
copy button that copies only that block.

Plain text outside fences keeps the existing lightweight text rendering.
