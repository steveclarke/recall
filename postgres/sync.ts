#!/usr/bin/env bun
/**
 * Sync Claude Code sessions to PostgreSQL
 *
 * Usage:
 *   bun run postgres/sync.ts                    # Incremental sync (new/changed)
 *   bun run postgres/sync.ts --days 7           # Last 7 days only
 *   bun run postgres/sync.ts --force            # Rebuild every session from byte 0
 *
 * Environment:
 *   DATABASE_URL          - PostgreSQL connection string
 *   CLAUDE_SESSIONS_DIR   - Sessions directory (default: ~/.claude/projects)
 *
 * How it stays cheap (the same model as log shippers such as promtail or
 * Vector): each session row records how many bytes of its JSONL have been
 * read (`source_offset`) and the file size at that read (`source_size`).
 * A file whose size has not changed is skipped on a stat alone. A file that
 * grew is read from its checkpoint, line by line; the new lines are added
 * to the stored totals and appended to `transcript_chunks`, in the same
 * transaction that moves the checkpoint, so a crash never doubles or loses
 * lines. Memory is bounded by one transcript chunk, whatever the file size.
 */

import { readdirSync, statSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { parseArgs } from 'util';
import postgres from 'postgres';
import {
  SessionAccumulator,
  emptyAggregates,
  isSkippedLine,
  readLines,
  sessionIdFromPath,
} from '../shared/parser.js';
import { redactString, redactTree } from '../shared/redact.js';
import type { SessionAggregates } from '../shared/types.js';

// Configuration
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/claude_sessions';
const DEFAULT_SESSIONS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ||
  join(process.env.HOME || '', '.claude', 'projects');
// RECALL_HOSTNAME overrides the hostname stamped on rows. Primarily used
// for one-time imports from a retired machine where os.hostname() on the
// importing host doesn't reflect where the sessions originally came from.
const HOSTNAME = process.env.RECALL_HOSTNAME || hostname();

// Transcript lines are stored in rows of about this many source bytes. Small
// enough that a chunk is cheap to hold, redact and send; far under the
// 256 MB jsonb array limit, so no transcript is ever truncated.
const CHUNK_BYTES = 8 * 1024 * 1024;

// Connect to database
//
// onnotice: Postgres emits a NOTICE (code 54000, "word is too long to be
// indexed") for every tsvector token over 2047 chars. Long tool-call output
// or pasted blobs in user_messages trigger it on most syncs and dwarf the
// real log output. The token is just skipped in the search index — the
// insert still succeeds — so we silence that specific code and surface
// anything else.
const sql = postgres(DATABASE_URL, {
  onnotice: (notice) => {
    if (notice.code === '54000') return;
    console.warn(notice);
  },
});

interface SyncOptions {
  days?: number;
  force?: boolean;
  limit?: number;
}

type SyncResult = 'created' | 'appended' | 'rebuilt' | 'skipped' | 'error';
type SyncStats = Record<SyncResult, number>;

interface Checkpoint {
  size: number;
  offset: number;
}

interface SessionFile {
  path: string;
  size: number;
  mtime: Date;
}

/** Thrown inside a transaction to roll back a file with no conversation yet. */
class NoConversation extends Error {}

/**
 * Checkpoints for every session that has one. Session ids are UUIDs, unique
 * across machines, so no hostname filter is needed.
 */
async function getCheckpoints(): Promise<Map<string, Checkpoint>> {
  const rows = await sql`
    SELECT id, source_size, source_offset FROM sessions
    WHERE source_offset IS NOT NULL
  `;
  return new Map(
    rows.map((r) => [
      r.id,
      { size: Number(r.source_size), offset: Number(r.source_offset) },
    ])
  );
}

/**
 * Find all session directories
 */
function findSessionDirs(baseDir: string): string[] {
  try {
    return readdirSync(baseDir)
      .map((name) => join(baseDir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Find JSONL files to sync
 */
function findFilesToSync(baseDir: string, options: SyncOptions): SessionFile[] {
  const files: SessionFile[] = [];
  const cutoffDate = options.days
    ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000)
    : null;

  for (const dir of findSessionDirs(baseDir)) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = join(dir, file);
        const stat = statSync(filePath);

        // Skip old files unless doing full sync
        if (cutoffDate && stat.mtime < cutoffDate) continue;

        files.push({ path: filePath, size: stat.size, mtime: stat.mtime });
      }
    } catch {
      // Directory not readable
    }
  }

  // Sort by modification time (newest first)
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return options.limit ? files.slice(0, options.limit) : files;
}

/**
 * Stored totals for a session, locked for the rest of the transaction.
 */
async function lockAggregates(
  tx: postgres.TransactionSql,
  id: string
): Promise<SessionAggregates | null> {
  const [row] = await tx`
    SELECT started_at, ended_at, git_branch, cwd, version, message_count,
           input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
           user_messages, tools_used, files_touched, models_used, model_tokens
    FROM sessions WHERE id = ${id}
    FOR UPDATE
  `;
  if (!row) return null;
  return {
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    gitBranch: row.git_branch,
    cwd: row.cwd,
    version: row.version,
    messageCount: row.message_count,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheCreationTokens: Number(row.cache_creation_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    userMessages: row.user_messages,
    toolsUsed: row.tools_used,
    filesFromToolCalls: row.files_touched,
    modelsUsed: row.models_used,
    modelTokens: row.model_tokens,
  };
}

/**
 * Sync a single session to the database
 */
async function syncSession(
  file: SessionFile,
  checkpoint: Checkpoint | undefined,
  options: SyncOptions
): Promise<SyncResult> {
  const id = sessionIdFromPath(file.path);
  if (!id) return 'skipped';

  // Unchanged since the last read: decided on a stat, the file is never opened.
  if (!options.force && checkpoint && checkpoint.size === file.size) {
    return 'skipped';
  }

  // Start over when forced, when the session has never been read, or when
  // the file is now shorter than what was read (replaced, not appended to).
  const rebuild = options.force || !checkpoint || file.size < checkpoint.offset;
  const start = rebuild ? 0 : checkpoint.offset;

  try {
    return await sql.begin(async (tx) => {
      const stored = await lockAggregates(tx, id);
      if (rebuild) {
        await tx`DELETE FROM transcript_chunks WHERE session_id = ${id}`;
      }
      const acc = new SessionAccumulator(
        rebuild || !stored ? emptyAggregates() : stored
      );

      let chunk: unknown[] = [];
      let chunkBytes = 0;
      let chunkStart = start;
      let end = start;

      const flush = async () => {
        if (chunk.length > 0) {
          await tx`
            INSERT INTO transcript_chunks (session_id, start_offset, end_offset, lines)
            VALUES (${id}, ${chunkStart}, ${end}, ${tx.json(chunk as postgres.JSONValue)})
          `;
        }
        chunk = [];
        chunkBytes = 0;
        chunkStart = end;
      };

      for await (const { line, end: lineEnd } of readLines(file.path, start)) {
        end = lineEnd;
        if (isSkippedLine(line)) continue;
        let parsed: { type?: string };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // Skip malformed lines
        }
        // Scrub profanity before anything hits the DB. Intentionally
        // destructive — raw words are gone once stored. Tune word lists in
        // shared/redact.ts.
        acc.add(parsed, redactString);
        chunk.push(redactTree(parsed));
        chunkBytes += line.length;
        if (chunkBytes >= CHUNK_BYTES) await flush();
      }
      await flush();

      if (!acc.hasConversation) throw new NoConversation();
      const s = acc.result();

      await tx`
        INSERT INTO sessions (
          id, started_at, ended_at, git_branch, cwd, version, hostname,
          message_count, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens,
          user_messages, tools_used, files_touched, models_used, model_tokens,
          search_text, transcript_path, source_size, source_offset, synced_at
        ) VALUES (
          ${id}, ${s.startedAt}, ${s.endedAt}, ${s.gitBranch}, ${s.cwd},
          ${s.version}, ${HOSTNAME},
          ${s.messageCount}, ${s.inputTokens}, ${s.outputTokens},
          ${s.cacheCreationTokens}, ${s.cacheReadTokens},
          ${tx.json(s.userMessages)}, ${tx.json(s.toolsUsed)},
          ${tx.json(s.filesFromToolCalls)}, ${tx.json(s.modelsUsed)},
          ${tx.json(s.modelTokens)},
          ${s.userMessages.join(' ')}, ${file.path}, ${file.size}, ${end}, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at,
          git_branch = EXCLUDED.git_branch,
          cwd = EXCLUDED.cwd,
          version = EXCLUDED.version,
          hostname = EXCLUDED.hostname,
          message_count = EXCLUDED.message_count,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_creation_tokens = EXCLUDED.cache_creation_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          user_messages = EXCLUDED.user_messages,
          tools_used = EXCLUDED.tools_used,
          files_touched = EXCLUDED.files_touched,
          models_used = EXCLUDED.models_used,
          model_tokens = EXCLUDED.model_tokens,
          search_text = EXCLUDED.search_text,
          transcript_path = EXCLUDED.transcript_path,
          source_size = EXCLUDED.source_size,
          source_offset = EXCLUDED.source_offset,
          synced_at = NOW()
      `;

      if (!stored) return 'created';
      return rebuild ? 'rebuilt' : 'appended';
    });
  } catch (error) {
    if (error instanceof NoConversation) return 'skipped';
    console.error(`Error syncing ${file.path}:`, error);
    return 'error';
  }
}

/**
 * Main sync function
 */
async function sync(baseDir: string, options: SyncOptions): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, appended: 0, rebuilt: 0, skipped: 0, error: 0 };

  console.log(`Syncing sessions from: ${baseDir}`);
  console.log(`Hostname: ${HOSTNAME}`);

  const checkpoints = await getCheckpoints();
  console.log(`Found ${checkpoints.size} checkpointed sessions in database`);

  const files = findFilesToSync(baseDir, options);
  console.log(`Found ${files.length} session files to check`);

  for (const file of files) {
    const id = sessionIdFromPath(file.path);
    const result = await syncSession(file, id ? checkpoints.get(id) : undefined, options);
    stats[result]++;

    if (result !== 'skipped') {
      console.log(`  ${result}: ${file.path}`);
    }
  }

  return stats;
}

// CLI entry point
async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: 'string', short: 'd' },
      force: { type: 'boolean', short: 'f' },
      limit: { type: 'string', short: 'l' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
Claude Code Session Sync (PostgreSQL)

Usage:
  bun run sync.ts [options]

Options:
  -d, --days <n>         Only check files changed in the last N days
  -f, --force            Rebuild every session from the start of its file
  -l, --limit <n>        Max files to check
  --dir <path>           Sessions directory
  -h, --help             Show this help

Environment:
  DATABASE_URL           PostgreSQL connection string
  CLAUDE_SESSIONS_DIR    Default sessions directory

Examples:
  bun run sync.ts                    # Incremental sync
  bun run sync.ts --days 7           # Last week only
  bun run sync.ts --force            # Rebuild everything
`);
    process.exit(0);
  }

  const options: SyncOptions = {
    days: values.days ? parseInt(values.days, 10) : undefined,
    force: values.force,
    limit: values.limit ? parseInt(values.limit, 10) : undefined,
  };

  const baseDir = values.dir || DEFAULT_SESSIONS_DIR;

  try {
    const stats = await sync(baseDir, options);

    console.log('\nSync complete:');
    console.log(`  Created:  ${stats.created}`);
    console.log(`  Appended: ${stats.appended}`);
    console.log(`  Rebuilt:  ${stats.rebuilt}`);
    console.log(`  Skipped:  ${stats.skipped}`);
    console.log(`  Errors:   ${stats.error}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});
