# XMPP client behavior

## Approval actions

Approval controls are rendered from XEP action metadata and stale actions are
discarded using `expiresAtMs`. Restored history also filters expired approval
actions so dead cards do not come back after reopening the conversation.

The header bypass toggle sends the gateway textual fallback command
`/oc approval-bypass <mode>`. This avoids relying on XEP-0050 discovery against
bare JIDs, which some servers answer from account/PEP instead of the agent
resource.

- `on`: enables gateway auto mode (`allowlist` plus flash reviewer).
- `off`: returns the gateway to `ask`.

## Code fences

Triple-backtick code fences render as distinct blocks in message bubbles. Each
block shows a language label, monospace horizontally scrollable content, and a
copy button that copies only that block.

Plain text outside fences keeps the existing lightweight text rendering.
