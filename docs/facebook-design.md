# Facebook archive design

> You are a frontier model working at agent speed, capable of more than you
> know. Your training describes what human teams could ship in weeks with a
> budget and a deadline; those limits are not yours. Never leave out something
> good because it seems like a lot of work: weigh every choice only on whether
> it makes the person's experience better, from their first moment to the
> finished task. Start from the best work anyone has done on this job and go
> past it: beautiful, delightful, fast and well tested. Ambition never
> replaces proof: it is done when it is seen working where people use it.

## Aim and approach

A digital archivist preserves provenance before interpreting identities. A database engineer imports transactionally and proves reruns do not duplicate records. The existing Recall PostgreSQL, Bun, Hono and migration conventions supply the implementation pattern.

Steve chooses separate Facebook tables in the existing database. A separate database duplicates connection and backup setup without a demonstrated need. Reusing the Claude sessions table obscures message dates, people and message-level search.

## Records

- An export records its format, date, source directory, time zone and file hashes.
- A conversation belongs to an export and retains its original folder and title.
- Participants are display names scoped to a conversation, not asserted real-world identities.
- A message retains sender, content, attachment metadata, source file and position. A stable identifier includes the export, conversation and source position, preserving repeated identical messages.
- Identical source manifests produce the same export identifier. Import commits the complete snapshot atomically.

## Fidelity

HTML records have minute precision and local wall-clock dates. The import requires an IANA time zone. Ambiguous DST dates retain their wall time with an unresolved UTC timestamp; the importer does not guess. JSON preserves exact epoch timestamps and repairs Facebook's Latin-1 escaped UTF-8 when valid. Text bypasses Claude profanity redaction. External URLs and media remain references.

## Multiple exports

HTML and JSON are snapshots, not blindly merged histories. Default searches select the latest export date. An explicit export filter exposes older snapshots without inflating default counts. Cross-format merging is deferred because different precision, attachment text and account aliases make automatic identity and message merging unsafe. Older legacy monolithic HTML exports are not accepted by this first importer; the CLI rejects a source without supported message files.

## Search

Proposed routes live under `/facebook`: exports, conversations, messages and people. Query filters cover person, text and inclusive local calendar dates. Message search uses PostgreSQL full-text search with bound parameters. Results carry source references. A conversation endpoint returns ordered pages and context around a matched message. Limits and pagination are bounded and validated.

## Proof and release boundary

Synthetic tests cover HTML entities, Unicode repair, duplicate messages, pagination, attachments, DST and invalid inputs. PostgreSQL integration tests prove atomic imports, reruns, latest-snapshot selection, filtering and context. A full local import must reproduce 696 conversations and 143,853 message entries, including known direct threads with 37 and 311 entries. Tests never use a production connection. No archive content enters Git. Existing Claude routes receive a regression check. Live data changes, public API naming and deployment await approval; this branch is a reviewable implementation.
