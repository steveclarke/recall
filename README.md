# Recall

Durable, cross-machine archive of every Claude Code session, with a small
HTTP API for searching your history and recalling where you left off.

## What it does

Claude Code stores its transcripts as JSONL files in `~/.claude/projects/`
on the machine where each session ran. That's locked to one machine, and
Claude Code will eventually rotate those files out. Recall sweeps them
into Postgres on a central host (over Tailscale or LAN) so every machine
you use writes to the same archive, and the archive survives local
cleanup.

## Pieces

- **`postgres/`** — Dockerized Postgres database + HTTP API (Bun + Hono).
  Lives on one central host; every other machine talks to it.
- **`shared/`** — Parser, types, and redaction used by the sync and API.
- **`file-based/`** — Zero-setup JSONL search, no database required.
  Useful for quick one-off searches on a single machine.

## Quick start — Postgres

```bash
cd postgres
bun install
bun run db:up                        # starts the Docker stack
DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions" \
    bun run sync                     # populate
DATABASE_URL="…" bun run serve       # HTTP API on :3847
```

Then schedule `bun run sync.ts` every 15 minutes on each machine you use
Claude Code from (launchd on macOS, systemd user timer on Linux). New
sessions show up in the archive within the interval.

The sync is incremental, like a log shipper: each session row records how
many bytes of its JSONL have been read, unchanged files are skipped on a
stat alone, and a growing file is read only from where the last run
stopped. A run with nothing new takes under a second and about 50 MB of
memory; memory stays bounded however large a transcript grows.

## Quick start — file-based

```bash
bun run file-based/search.ts --query "email system" --days 7
```

No database, no setup — just greps your local JSONLs. Useful until you
have enough history to want real search.

## API (Postgres mode)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/sessions` | Search/list — `?search=`, `?days=`, `?since=`, `?until=`, `?tools=`, `?file_pattern=`, `?hostname=`, `?limit=` |
| `GET` | `/sessions/:id` | Single session. `?with_transcript=true` returns the full archived transcript. |
| `GET` | `/sessions/stats` | Usage stats. `?days=N` to scope. |

See `postgres/api.ts` for the source of truth.

## Using from Claude Code

The natural pairing is a `/recall` skill that hits the HTTP API when the
user asks things like *"where did we leave off on X"* or *"what did we
discuss about Y last week"*. There's a starter skill in
`shared/claude-skill.md`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects` | Where Claude Code writes its JSONLs |
| `DATABASE_URL` | `postgres://localhost/claude_sessions` | Postgres connection string |
| `RECALL_HOSTNAME` | `os.hostname()` | Overrides the hostname stamped on rows — useful for one-time imports from a retired machine |
| `PORT` | `3847` | HTTP API port |

## Credits

Forked from [`alexknowshtml/kuato`](https://github.com/alexknowshtml/kuato)
(MIT) as of early 2026-04. The core design — user-messages-as-signal,
weighted tsvector, file-based + Postgres variants — is Alex's. Renamed
and extended in this fork with hostname-stamped rows, full transcript
archival in Postgres, incremental sync, profanity redaction at sync time, daily pg_dump
backups, and Postgres 18.

## License

MIT
