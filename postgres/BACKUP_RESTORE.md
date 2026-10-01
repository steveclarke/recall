# Recall Backup & Restore

## What's running

The `pgbackup` service (image: `prodrigestivill/postgres-backup-local`)
runs alongside the DB in `docker-compose.yml`. It:

- Runs `pg_dump` on the `claude_sessions` DB daily at 02:15 UTC
- Gzips the output
- Writes to the host-mounted `./backups/` directory
- Retains the last two nights on dockervm (`BACKUP_KEEP_DAYS` 1, weeks and months 0)
- Uses `--clean --if-exists` so restores emit `DROP` statements first

## File layout on the host

```
./backups/
├── daily/
│   └── claude_sessions-YYYYMMDD-HHMMSS.sql.gz
├── weekly/
├── monthly/
└── last/
    └── claude_sessions-latest.sql.gz  (symlink/copy to the most recent daily)
```

`last/` always points to the newest dump — use that for routine restores.

## Copies on storage.home

Every dump is a full copy of the archive, so history is not kept on
dockervm's disk. storage.home's nightly `dockervm-backup` User Script
(04:30 Newfoundland time) pulls `daily/claude_sessions-latest.sql.gz` to
`backups-clarke/dockervm/recall-YYYYMMDD.sql.gz` and keeps seven. Kopia
carries that folder to B2. A dump older than 30 hours fails that job's
Healthchecks check. Restore from one of those copies the same way as below,
after copying it back to dockervm.

## Manual one-off backup

```bash
docker exec claude-sessions-backup /backup.sh
ls -la backups/daily | tail -5
```

## Restore

### Full restore into the same DB (overwrites current contents)

```bash
# From the dockervm host, in the recall/postgres directory
gunzip -c backups/last/claude_sessions-latest.sql.gz \
  | docker exec -i claude-sessions-db \
      psql -U claude -d claude_sessions
```

Because the dumps include `DROP ... IF EXISTS`, this drops current
tables/indexes and rebuilds them from the dump. Downtime = seconds.

### Restore into a fresh DB (e.g. for testing or migration)

```bash
# Spin up a throwaway Postgres locally
docker run --rm -d --name recall-restore-test \
  -e POSTGRES_USER=claude \
  -e POSTGRES_PASSWORD=sessions \
  -e POSTGRES_DB=claude_sessions \
  -p 5434:5432 \
  postgres:16-alpine

# Wait for it to be ready
sleep 3

# Restore
gunzip -c backups/last/claude_sessions-latest.sql.gz \
  | docker exec -i recall-restore-test \
      psql -U claude -d claude_sessions

# Poke around
docker exec -it recall-restore-test psql -U claude -d claude_sessions -c "SELECT COUNT(*) FROM sessions;"

# Tear down
docker rm -f recall-restore-test
```

## Verifying the backup ran

```bash
docker logs claude-sessions-backup --tail 30
ls -lht backups/daily | head -5
```

## What's NOT covered by this

- **Point-in-time recovery.** We dump once a day; up to 24h of sync'd
  sessions could be lost. Acceptable for now — the JSONL source files
  on each machine are the real source of truth.
- **DB config/roles.** The dump targets `claude_sessions` only. If the
  Postgres container itself is wiped, `schema.sql` recreates the role
  via the init script.
