## ADDED Requirements

### Requirement: Initiate a 1:1 audio call
The client SHALL let the user start an audio call with an online contact/agent by sending an XEP-0353 `propose`; on acceptance, the client SHALL negotiate an XEP-0166 session with RTP audio (Opus), ICE-UDP with trickle, and DTLS-SRTP.

#### Scenario: User calls a contact and the call is accepted
- **WHEN** the user taps call on an online contact/agent
- **THEN** the client sends an XEP-0353 `propose`, and upon `proceed` (XEP-0353 §3.4, addressed to the accepting resource's full JID) sends a Jingle `session-initiate` with an RTP audio description, ICE-UDP transport, and DTLS-SRTP fingerprint

#### Scenario: User calls a contact that is not online
- **WHEN** the target has no available resource
- **THEN** the client reports the call cannot be started without leaving a stale session

### Requirement: Receive an incoming call
The client SHALL surface an incoming XEP-0353 `propose` in a modal with accept/reject actions, and SHALL ring (XEP-0353 `ringing`); accepting SHALL send `proceed` and `session-accept`, rejecting SHALL send `reject`.

#### Scenario: User accepts an incoming call
- **WHEN** the user taps accept on the incoming-call modal
- **THEN** the client replies with XEP-0353 `proceed` to the initiator's full JID and, after receiving `session-initiate`, responds with a Jingle `session-accept` that echoes the initiator's content (creator/name) with the responder's transport

#### Scenario: User rejects an incoming call
- **WHEN** the user taps reject on the incoming-call modal
- **THEN** the client sends XEP-0353 `reject` (or a Jingle `session-terminate` with reason `decline` if already initiated) and shows no active call

### Requirement: In-call state and controls
During a call, the client SHALL show a visible state (connecting/active), a timer, a mute toggle, and a hang-up control that sends a Jingle `session-terminate`.

#### Scenario: Call connects
- **WHEN** ICE and DTLS-SRTP complete
- **THEN** the UI shows the call as active with a running timer and the remote audio stream

#### Scenario: User mutes
- **WHEN** the user toggles mute
- **THEN** the local microphone track is disabled/enabled and the UI reflects the mute state

#### Scenario: User hangs up
- **WHEN** the user taps hang-up
- **THEN** the client sends a Jingle `session-terminate` (reason `success` or `cancel`), closes the peer connection, and returns the chat UI to idle

### Requirement: Dino interoperability
The client SHALL implement the XEPs Dino supports (0166/0167/0176/0320/0353) for audio, and cross-validation against Dino SHALL be the documented compatibility target.

#### Scenario: Audio call with Dino
- **WHEN** the peer is Dino sharing a 1:1 audio Jingle session
- **THEN** the call establishes and carries audio bidirectionally

### Requirement: Error and connectivity handling
The client SHALL end a call with a clear error state (e.g. reason `connectivity-error`) when the network or media fails, and SHALL NOT leave the session hanging.

#### Scenario: Connectivity fails during a call
- **WHEN** ICE/DTLS or the XMPP connection fails mid-call
- **THEN** the client terminates the session with `connectivity-error`, shows the error state, and cleans up the peer connection and session

### Requirement: Multi-device behavior
While a call with a contact is active, the client SHALL suppress notifications from that contact, and SHALL restore them when the call ends.

#### Scenario: Message arrives during a call
- **WHEN** a message from the in-call contact arrives during the active call
- **THEN** no notification is raised for that contact for the duration of the call

#### Scenario: Call ends
- **WHEN** the call terminates
- **THEN** notifications for that contact are restored
