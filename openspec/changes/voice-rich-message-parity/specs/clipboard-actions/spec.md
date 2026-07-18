## ADDED Requirements

### Requirement: Reliable message copying
The client SHALL provide explicit copy actions for complete messages and code blocks that do not depend on transient native text selection.

#### Scenario: User long-presses a message
- **WHEN** the user chooses Copy from the message actions
- **THEN** the complete current message body is placed on the clipboard and confirmation is shown

#### Scenario: User copies a code block
- **WHEN** the user activates the code block Copy control
- **THEN** the code content is placed on the clipboard without Markdown fence characters

### Requirement: Explicit composer paste
The client SHALL provide a paste action that reads clipboard text into the composer and SHALL never silently truncate pasted content.

#### Scenario: Clipboard text fits
- **WHEN** the user activates Paste with text within the supported composer length
- **THEN** the text is inserted at the current selection or cursor position

#### Scenario: Clipboard text exceeds the limit
- **WHEN** pasted text exceeds the supported message length
- **THEN** the client either accepts the complete text under an increased limit or warns and rejects it without partial silent truncation
