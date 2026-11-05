# Facebook conversations

Facebook exports use dedicated tables inside the existing Recall database. Claude sessions keep their existing tables and importer.

## Install and inspect

Run commands from `postgres/` with Bun 1.3 or later. `bun install --frozen-lockfile` installs Hono, postgres, the HTML entity decoder and the Temporal date library.

The source is an unpacked personal export containing `messages/**/message_*.html` or `messages/**/message_*.json`. Source files are read only. Media is never loaded, uploaded or fetched; attachment paths and URLs remain references.

```sh
bun run facebook:import --source /path/to/unpacked-export \
  --format html --export-date 2021-02-13 --timezone America/St_Johns
```

The default is a dry run. It reports only export identifiers, conversation/message counts, file counts and unresolved timestamps. JSON imports use `--format json`. The importer rejects a source without supported message files; older monolithic `html/messages.htm` downloads require a separate adapter.

## Approved live import

Live migration and import require approval of the target database and code release first. `DATABASE_URL` must explicitly identify that database; there is no implicit production connection. The migration adds four tables and indexes without modifying Claude session tables.

```sh
# DATABASE_URL is provided by the approved environment; do not paste credentials into logs.
bun run facebook:import --migrate --apply
bun run facebook:import --source /path/to/unpacked-export \
  --format html --export-date 2021-02-13 --timezone America/St_Johns --apply
```

The file manifest, format, export date and time zone identify an immutable snapshot. Repeating the same import returns `already_imported`. Each message identifier includes its source file and position, so repeated identical messages remain distinct. A snapshot commits in one transaction; failure rolls back the complete snapshot. Changed sources create a new snapshot rather than editing an existing one. Import the newest export first, then older snapshots when useful.

## Search API

The existing Recall API gains these proposed routes after deployment. These private routes do not opt into the existing session API's wildcard browser CORS policy; agents and CLI clients can query them over the approved private network:

| Route | Result |
| --- | --- |
| `GET /facebook/exports` | Available export identifiers, dates, formats and conversation counts |
| `GET /facebook/conversations` | Titles, participants, message counts and date ranges |
| `GET /facebook/messages` | Matching individual messages with source references |
| `GET /facebook/people` | Distinct display names and number of conversations per name |
| `GET /facebook/conversations/:id/messages` | A conversation in chronological order |

List routes accept `limit` (1–100) and `offset` (0–1,000,000). Conversation messages default to 50; people default to 100; other lists default to 20. A result's `count` describes the current page, not the complete match count.

Conversations, messages and people accept `export=<identifier>`; omitting it selects the newest export date, with an identifier tie-break for equal dates. Older snapshots do not inflate default results. An explicit conversation identifier selects that conversation's own snapshot.

`person` matches a literal substring of participant display names in conversations, messages and people. In message search this includes messages from all participants in matching conversations, not only messages authored by the named person. `%` and `_` are literal characters, not wildcards.

Conversations and messages accept inclusive local calendar dates through `since=YYYY-MM-DD` and `until=YYYY-MM-DD`. Messages also accept `search`, using PostgreSQL web-search syntax: words, quoted phrases, `OR` and excluded terms. Search covers sender and content, not attachment file contents. PostgreSQL ignores individual tokens longer than 2,047 bytes; the complete message text remains stored.

```text
/facebook/messages?person=Example&search=reconciliation&since=2014-10-01&until=2014-10-31
/facebook/conversations/CONVERSATION_ID/messages?offset=50&limit=50
/facebook/conversations/CONVERSATION_ID/messages?around=MESSAGE_ID&before=5&after=5
```

An `around` query returns up to 49 messages before and after the match, plus the match itself. Without `around`, offset pagination applies. JSON conversation pages and context use exact UTC instants, with source order breaking equal timestamps. HTML conversation pages and context reverse the export's newest-first source order, including during ambiguous DST wall times. Message search orders JSON by exact instant and HTML by local wall time; the latter cannot establish an exact cross-conversation order during a DST fold. Source file and order identify each original entry; the export manifest records file hashes and the source directory.

## Fidelity and scope

- Text keeps the export's wording and profanity. HTML entities decode once; block boundaries become line breaks. JSON's Latin-1 escaped UTF-8 is repaired when valid; raw JSON message fields remain in `payload`.
- HTML dates have minute precision. A required IANA time zone supplies historical offsets. Ambiguous or nonexistent DST wall times retain `sent_local` with a null `sent_at`; no offset is guessed. `sent_local` is a wall-clock string without a UTC suffix; responses also identify the time zone. JSON keeps millisecond precision.
- Blank titles and senders stay blank/null. Participant names are source display labels, not verified person identities. Generic deleted-account labels do not identify distinct people. The people endpoint excludes `Facebook User` and `Other User`, but includes the archive owner's named participation.
- Group participant labels in HTML are split at Facebook's comma/“and” separators. The source remains available for names whose punctuation makes this ambiguous; structured JSON keeps explicit participant entries.
- Exports are independently searchable snapshots. Automatic cross-export merging is deliberately absent: changed names, minute-versus-millisecond timestamps, attachment representations and repeated text make guessed merging unsafe. Earlier missing messages can be investigated with an explicit export filter.
- Photos, posts and comments outside message threads are outside this importer. No external URLs are requested and no media download route is added.

The tables are part of `claude_sessions`, so the existing whole-database `pg_dump` backup includes them after a live import. Source media stays outside that dump and requires the original archive backup. The source directory in a manifest may name another machine after an approved deployment; these references are provenance, not an assurance that the API host can open that path.

## Verification

```sh
bun run test:facebook

# Disposable PostgreSQL only; the integration suite rejects remote hosts and other DB names.
FACEBOOK_TEST_DATABASE_URL=postgres://recall_test:recall_test@127.0.0.1:TEST_PORT/recall_facebook_test \
  bun run test:facebook
```

Without `FACEBOOK_TEST_DATABASE_URL`, database tests are explicitly skipped. The integration suite creates synthetic export records and removes only its own records and fixture files. It also loads the existing session schema in this disposable database for regression probes. Never point it at an operational Recall database.

Studio-local real-data verification imports the archive into a disposable PostgreSQL 18 container and queries the API over loopback HTTP. The February 2021 snapshot must read back as 696 conversations and 143,853 message entries. Known direct threads must retain 37 and 311 entries, respectively. Re-import must add no records. The June 2020 JSON dry run must retain 139,769 entries. Private data and proof captures stay outside Git.

Production migration, import, deployment and production backup restoration are untested until separately approved and executed. Local proof does not establish production availability.

## Repair earlier local-time imports

The original importer can shift `sent_local` when the importing client uses a non-UTC timezone. Exact `sent_at` instants and source files remain intact. The corrected importer transports the wall-clock fields as an explicit PostgreSQL timestamp-without-time-zone parameter, independent of client and database timezones.

The repair defaults to inspection:

```sh
bun run facebook:repair-local-time
```

After backup and approval of the live correction:

```sh
bun run facebook:repair-local-time --apply
```

Both commands require an explicit `DATABASE_URL`. The report counts messages, mismatches and unresolved UTC instants without printing message text. Apply takes the same transaction-level lock as imports, corrects only `sent_local` from each exact instant and export timezone, and verifies the remaining mismatch count. An apply with any unresolved instant fails before changing rows; that case needs source-based recovery. Repeating a completed repair changes zero rows. Other columns and Claude sessions are outside the update.
