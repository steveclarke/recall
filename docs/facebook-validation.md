# Facebook import verification

Production migration, import, deployment and restore remain untested and unperformed. All data proof below comes from an isolated PostgreSQL 18 container and loopback HTTP API on the Mac Studio. No archive content is copied into this repository.

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
- The expanded parser/import/API suite passes all 18 tests on Bun 1.4.4 and PostgreSQL 18. It also passes on the deployed runtime line, Bun 1.3.14, in a read-only, resource-limited container with no external network and a disposable synthetic-only database.
- The corrected parser again reads all 696 conversations and 143,853 entries from the real HTML snapshot. The corrected importer succeeds in a disposable Studio database; no operational Recall database is changed.

## Review and release

- The same independent reviewer rechecks the corrected head before release approval.
- API route names remain proposed until approval for release.
- Original source zips, unpacked exports and private proof files stay outside Git.
- The disposable API and database are removed after verification; a live Recall import is a separate approved step.
