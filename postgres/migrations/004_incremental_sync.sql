-- 004 — Incremental sync: byte-offset checkpoints and an append-only transcript.
--
-- Before this, every sync read and MD5-hashed every JSONL in full, parsed
-- each file whole, and re-sent a changed session's entire transcript as one
-- jsonb value (capped at 128 MB, middle dropped). A growing coordinator
-- session cost gigabytes of RAM and a full re-upload on every run.
--
-- Now each row records how far its JSONL has been read:
--   source_size    file size at the last read; equal size means unchanged
--   source_offset  bytes consumed, up to the last complete line
-- and the transcript lives in transcript_chunks, one row per ~8 MB of source
-- lines, so new lines are appended instead of rewriting the whole value.
--
-- Rows moved from the old column keep end_offset NULL: their source offsets
-- are unknown, so the first sync after this migration rebuilds each session
-- whose JSONL still exists, and rows whose JSONL is gone keep the moved copy.
-- api-request lines (copies of the whole conversation per API call) are
-- dropped on the way across, as the new sync does.
--
-- Run once. Disk: the moved transcripts are written before the old column is
-- dropped, so allow free space of about the current TOAST size; VACUUM FULL
-- afterwards returns the old column's space.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS source_size BIGINT,
  ADD COLUMN IF NOT EXISTS source_offset BIGINT;

CREATE TABLE IF NOT EXISTS transcript_chunks (
  session_id VARCHAR(36) NOT NULL
    REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  start_offset BIGINT NOT NULL,
  end_offset BIGINT,
  lines JSONB COMPRESSION lz4 NOT NULL,
  PRIMARY KEY (session_id, start_offset)
);

INSERT INTO transcript_chunks (session_id, start_offset, end_offset, lines)
SELECT s.id, 0, NULL, kept.lines
FROM sessions s
CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(line ORDER BY n), '[]'::jsonb) AS lines
  FROM jsonb_array_elements(s.transcript) WITH ORDINALITY AS t(line, n)
  WHERE COALESCE(line->>'type', '') NOT LIKE 'api-request%'
) kept
WHERE s.transcript IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE sessions DROP COLUMN IF EXISTS transcript;
ALTER TABLE sessions DROP COLUMN IF EXISTS transcript_hash;

-- Indexes no query uses (idx_scan 0 in production, 2026-10-26).
-- files_touched: the API filters it with ILIKE over unnested elements,
-- which a jsonb GIN index cannot serve. category and summary are never set.
DROP INDEX IF EXISTS idx_sessions_files_touched;
DROP INDEX IF EXISTS idx_sessions_category;
DROP INDEX IF EXISTS idx_sessions_summary_trgm;
DROP INDEX IF EXISTS idx_sessions_started_at;
DROP EXTENSION IF EXISTS pg_trgm;

COMMIT;
