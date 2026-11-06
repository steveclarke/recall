# Facebook import verification

The approved Facebook release, both snapshot imports and local-time correction are verified live on November 5, 2026. Facebook-only production backups restore successfully in isolated PostgreSQL 18 databases. A complete restore of the historical Claude database remains untested. No archive content is copied into this repository.

## November 5, 2026 local proof

- The initial parser and PostgreSQL/API integration suite passes: 14 tests, 59 assertions, zero failures, using Bun 1.4.4 and PostgreSQL 18.
- The February 2021 HTML archive parses and imports as 696 conversations, 703 message files and 143,853 message entries. No message has an unresolved UTC timestamp in this snapshot.
- The real API lists all 696 conversations with message counts summing to 143,853. Two known direct threads read back as 37 and 311 entries; a known final message matches the source verbatim. Search returns a hit and the context endpoint includes it.
- Repeating the complete HTML import reports `already_imported`, retaining the same export identifier and counts.
- The June 2020 JSON archive parses and imports as 693 conversations, 700 message files and 139,769 entries. An explicit-export API listing reproduces those counts. Default search still selects February 2021 after the older snapshot imports.
- Existing `/health` and `/sessions` routes answer successfully against the disposable database. No production service is contacted.
- One overlapping test run times out while an archive import holds table locks. The next serial run passes all 14 tests; no timeout is hidden by changing the test limits.
- PostgreSQL reports its existing 2,047-byte search-token limitation for a few long tokens. Import succeeds and the original text remains stored. The limit is documented.

## Independent review and corrections

- An independent source-only reviewer checks `940fb48` against `604ae0b` after Steve authorizes the no-subagents exception. The reviewer does not read private archives or execute code. Its first verdict is FIX.
- The parent reproduces undated attachment-only entry loss, JSON ordering errors through a DST rollback, and HTML edge-whitespace loss with synthetic fixtures. The fixes reject incomplete/unsupported HTML, preserve authored spaces and newlines, and use exact JSON instants for ordering, pages and context. HTML conversation retrieval follows the original source order.
- Private Facebook routes are excluded from the existing session API's wildcard browser CORS policy. The original session policy keeps its prior behavior.
- The expanded parser/import/API suite passes all 18 tests on Bun 1.4.4 and PostgreSQL 18. The final reviewed code passes 73 assertions, including authored edge br elements. It also passes on the deployed runtime line, Bun 1.3.14, in a read-only, resource-limited container with no external network and a disposable synthetic-only database.
- The corrected parser again reads all 696 conversations and 143,853 entries from the real HTML snapshot. The corrected importer succeeds in a disposable Studio database. Loopback HTTP reproduces the counts, a known direct thread, original final text, search context and absence of wildcard CORS. No operational Recall database is changed.

## Initial pre-release review

- The same independent reviewer returns source-only PASS on corrected implementation head `2c15e19df90f2a4fff27e86b740a5500a678104e`; the report is saved in `docs/facebook-review.md`. It performs no runtime checks and accesses no private data.
- API route names are proposed at this review stage; the approved release below adopts `/facebook`.
- Original source zips, unpacked exports and private proof files stay outside Git.
- The disposable API and database are removed after local verification. Live import follows as a separate approved step below.

## November 5, 2026 production release

- The owner approves the `/facebook` prefix, deployment and both live imports. [PR 1](https://github.com/steveclarke/recall/pull/1) merges as `620998ca9c1a6dbcd407a5c7319d3d94e29fd904`. The live checkout and API files match the reviewed release.
- Live API pagination confirms 696 conversations and 143,853 entries in the default February 2021 HTML snapshot. The separate June 2020 JSON snapshot has 693 conversations and 139,769 entries. The database holds 283,622 Facebook message records and retains the original 15,915 Claude sessions.
- Live checks cover original message text, person/date/text search, conversation context, existing health and session routes, and the Facebook browser CORS policy.
- A fresh full pre-import dump passes a complete compressed-payload read. It is not fully restored. A Facebook-only post-import dump restores into isolated PostgreSQL 18 and reproduces both snapshots' counts. The existing nightly backup includes the new tables; a new offsite copy is not verified here.

## November 5, 2026 local-time correction

- A later archive lookup finds shifted `sent_local` values. Exact UTC instants and source files remain correct. The importer fix and repair utility are independently reviewed; [PR 2](https://github.com/steveclarke/recall/pull/2) merges as `e56a9df4ff95d344595be4057708d32da0abd5d4`.
- The old importer fails with a non-UTC importing client. The fix passes 21 focused tests and 90 assertions on Bun 1.3.14 and PostgreSQL 18 with `TZ=America/St_Johns`. Tests cover a non-UTC database zone, seasonal offsets, midnight boundaries, milliseconds and unresolved instants.
- A fresh Facebook-only production backup restores into an isolated database. The repair there corrects 283,622 local fields, preserves the record count and every other message field's aggregate fingerprint, and changes zero rows on repeat. Original local times and a date-boundary query agree afterward. The live pre-repair audit matches the backup's full Facebook message fingerprint.
- The owner approves the live correction. Deployed importer and repair files match the reviewed source. Live apply corrects all 283,622 local fields, leaving zero mismatches or unresolved instants. The repeat dry run reports zero changes. The complete corrected live fingerprint matches the repaired copy; all fields other than `sent_local` match their pre-repair fingerprint.
- Live HTTP checks confirm original local and UTC times, JSON milliseconds, original text and the local-calendar date filter. Health and existing session routes pass.
- A fresh Facebook-only post-repair production dump restores into isolated PostgreSQL 18. Its 283,622 records match the complete corrected live Facebook message fingerprint and have zero timestamp mismatches. Private backup files remain outside Git. Test databases, their network, temporary worktrees and merged feature branches are removed after proof.
