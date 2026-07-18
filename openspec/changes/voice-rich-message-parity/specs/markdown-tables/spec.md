## ADDED Requirements

### Requirement: Structured Markdown table rendering
The client SHALL render valid GitHub-style Markdown tables as structured rows and cells with a visually distinct header.

#### Scenario: Message contains a table
- **WHEN** a message contains a valid Markdown header row, delimiter row, and body rows
- **THEN** the client displays the table structure rather than raw delimiter characters

### Requirement: Table overflow and live updates
The client SHALL constrain wide tables using horizontal scrolling and SHALL retain table rendering during message-list updates and corrections.

#### Scenario: Table exceeds available width
- **WHEN** table content is wider than the message bubble
- **THEN** the table scrolls horizontally without widening the conversation viewport

#### Scenario: Conversation state updates
- **WHEN** presence, telemetry, history reconciliation, or XEP-0308 correction causes a re-render
- **THEN** the table remains correctly rendered from the latest message body
