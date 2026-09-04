# Prove the Ticket

This context describes the language used to connect a ticket's confirmed promises to reproducible evidence from an exact local code state.

## Language

**Ticket**:
A GitHub issue plus the human-confirmed acceptance criteria derived from it.
_Avoid_: Task

**Acceptance criterion**:
One confirmed, checkable promise preserved or derived from the ticket.

**Code fingerprint**:
The identity of the exact local code state under verification.

**Proof subject**:
The criteria hash paired with the code fingerprint.

**Evidence plan**:
The human-approved mapping from each criterion to commands, code references, or repeatable manual checks.

**Proof run**:
One attempt to execute an evidence plan against one proof subject.

**Proof card**:
The human-readable rendering of a proof run's structured result.

**Proof seal**:
The deterministic identifier derived from the proof subject, evidence plan, and result.
