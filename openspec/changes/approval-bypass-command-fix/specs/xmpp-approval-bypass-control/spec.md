## ADDED Requirements

### Requirement: Bypass switch invokes the real ad-hoc command

The app SHALL activate/deactivate the exec approval bypass by executing the
server's `approval-bypass` XEP-0050 ad-hoc command (execute + form submit),
not by sending a plain chat message.

#### Scenario: Activating bypass

- **WHEN** the user toggles the bypass switch on
- **THEN** the app executes the `approval-bypass` ad-hoc command with
  `mode=on` and a `minutes` value, and shows the server's actual
  confirmation text to the user

#### Scenario: Deactivating bypass

- **WHEN** the user toggles the bypass switch off
- **THEN** the app executes the `approval-bypass` ad-hoc command with
  `mode=off`

### Requirement: Bypass switch appears on the approval sticky card popover

The app SHALL show the bypass switch inside the expanded popover of a
pending approval sticky card, in addition to the general agent controls
panel.

#### Scenario: Expanding an approval card

- **WHEN** the user expands the popover for a pending action that is an
  approval request
- **THEN** the bypass switch is visible in that popover

#### Scenario: Expanding a non-approval pending action

- **WHEN** the user expands the popover for a pending action that is not
  an approval request (a plain question)
- **THEN** the bypass switch is not shown in that popover

### Requirement: Bypass status reflects server-side auto-reversion

While the approval popover is open, the app SHALL periodically query the
server for the real bypass status so the switch does not stay "on" after
the server has already auto-reverted it.

#### Scenario: Bypass expires while popover is open

- **WHEN** an active bypass expires on the server while the approval
  popover remains open
- **THEN** the next status poll updates the switch to its inactive state
  without requiring user interaction

#### Scenario: Status query fails transiently

- **WHEN** a status poll fails due to a transient network error
- **THEN** the app does not change the switch's displayed state and does
  not interrupt the user with an error
