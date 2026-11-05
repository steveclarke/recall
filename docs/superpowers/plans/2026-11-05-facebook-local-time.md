# Facebook Local-Time Repair Implementation Plan

> **For agentic workers:** Implement in this session; reuse the authorized source-only reviewer. No archive access by reviewers.

**Goal:** Preserve source wall-clock times regardless of client timezone and repair existing stored local times from preserved exact instants.

**Architecture:** Explicit PostgreSQL timestamp-without-time-zone parameters prevent the driver's JavaScript date serializer from interpreting a naive timestamp in the client's local zone. A dry-run-first repair uses each export's IANA zone and exact message instants inside a serialized transaction.

**Tech Stack:** Bun, postgres.js, PostgreSQL 18, existing Facebook import and API.

**Spec:** The owner authorizes the importer fix and correction of live stored local times after an archive lookup reveals the mismatch. Source files and exact instants are preserved.

## Global Constraints

- Preserve message content, exact UTC timestamps, identifiers, export membership and source order.
- Do not modify Claude session tables.
- Back up Facebook tables before the live correction; verify a restored copy before applying the repair.
- No private source messages or names in Git or reviewer context.
- Do not guess UTC instants for unresolved HTML wall times.

## Review Focus

- Non-UTC client timezone changes a naive timestamp during driver serialization.
- Non-UTC database session timezone changes a timestamptz-to-timestamp assignment.
- Date boundaries and seasonal offsets must follow the source wall time.
- Existing null UTC instants cannot be reconstructed from exact instants alone.
- A repeated repair must change zero rows and preserve all nonlocal-time fields.

### Task 1: Reproduce and fix transport

**Files:** `postgres/facebook-import.ts`, `postgres/facebook.integration.test.ts`.

- [ ] Reproduce the shifted wall time with an explicit non-UTC client timezone.
- [ ] Force timestamp-without-time-zone transport with an explicit UTC suffix used only for deterministic JavaScript serialization.
- [ ] Verify summer, winter, local-midnight, millisecond and unresolved-DST inputs with non-UTC client and server zones.

### Task 2: Add and test the repair

**Files:** `postgres/facebook-repair-local-time.ts`, integration tests, `postgres/FACEBOOK.md`, package scripts.

- [ ] Add a dry-run-first transaction using the import advisory lock; count mismatches and unresolved instants.
- [ ] Reject an apply with unresolved instants; update only `sent_local` for mismatched resolved messages.
- [ ] Verify dry-run preservation, correction, repeat safety, date filters and unchanged payload/instant fields.
- [ ] Restore the pre-repair real-data backup into an isolated Studio database, test the repair there, and compare all nonlocal-time fields.

### Task 3: Release and verify

- [ ] Complete source-only independent review, scoped checks on the published head, and the approved code release.
- [ ] Apply the approved live repair after backup and restored-copy proof.
- [ ] Verify zero mismatches, original message times, local date filters, unchanged counts and nonlocal-time fingerprint.
- [ ] Refresh the verified backup, record the repair and remove temporary resources.
