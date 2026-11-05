# Facebook Chats Implementation Plan

> **For agentic workers:** Implement task-by-task in this session. No subagents; the original archive brief requires this execution method.

**Goal:** Import and search original Facebook conversations in dedicated Recall tables.

**Architecture:** A source parser produces an immutable export snapshot. A transactional importer writes dedicated tables, and an isolated Hono router searches messages and retrieves conversation context.

**Tech Stack:** Bun, TypeScript, Hono, PostgreSQL 18, HTMLRewriter, entities and Temporal.

**Spec:** `docs/facebook-design.md`; approved direction and start are recorded in `docs/facebook-brief.md`.

## Global Constraints

- No production changes or archive uploads during implementation.
- Preserve message text; no profanity redaction or invented participant identities.
- No archive files, names lists or private quotations in Git.
- Original files stay read-only; default import mode is a dry run.
- Separate exports; newest snapshot is the default search scope.

## Review Focus

- Same-minute identical messages remain separate source entries.
- Ambiguous Newfoundland DST wall times never receive guessed UTC offsets.
- Malformed files abort the complete import rather than silently losing entries.
- Search parameters never become SQL syntax; dates and pagination are validated.
- Earlier snapshots and re-imports cannot inflate latest-export counts.

---

### Task 1: Parse source snapshots

**Files:** `postgres/facebook-archive.ts`, `postgres/facebook.test.ts`, dependency manifests.

**Interfaces:** `readFacebookArchive(root, format, exportDate, timezone)` returns a manifest, conversations, participants and source-backed messages.

- [x] Test entity decoding, multiline text, attachment-only entries, UTF-8 repair, identical messages and DST ambiguity.
- [x] Implement HTML and JSON parsers with required date/time-zone validation and deterministic manifests.
- [x] Run parser tests and compare full newest-export counts with the independent inspection.

### Task 2: Store snapshots transactionally

**Files:** `postgres/migrations/004_add_facebook.sql`, `postgres/facebook-import.ts`, `postgres/facebook.integration.test.ts`.

**Interfaces:** `importFacebookArchive(sql, archive)` inserts one immutable snapshot or returns already imported. CLI defaults to dry run and requires explicit `--apply` and `DATABASE_URL` for writes.

- [x] Test re-imports, rollback, duplicate source messages and old/new snapshot selection against disposable PostgreSQL.
- [x] Add foreign keys, constraints, message search index and source provenance.
- [x] Implement transactional batched writes and metadata-only CLI reporting.

### Task 3: Search and retrieve conversations

**Files:** `postgres/facebook-api.ts`, `postgres/api.ts`, integration tests, `postgres/FACEBOOK.md`, package scripts.

**Interfaces:** `facebookRoutes(sql)` returns a router mounted beneath `/facebook` in the existing API.

- [x] Test person/date/text filters, invalid query values, bounded pages, same-minute ordering and around-message context.
- [x] Add exports, conversations, messages and people routes with bound SQL and latest-export default.
- [x] Import the real archive into disposable local PostgreSQL; read back counts, known direct threads, search results and a repeated import.
- [x] Document setup, migration, dry run, local proof, snapshot limitations and the live import approval boundary.
- [x] Run all touched checks and a Claude route regression probe.
- [ ] Complete independent review and commit the reviewable branch.
