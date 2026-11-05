#!/usr/bin/env bun
/**
 * Session Search API Server
 *
 * Usage:
 *   bun run postgres/api.ts
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string
 *   PORT         - Server port (default: 3847)
 *
 * Endpoints:
 *   GET /sessions         - Search sessions
 *   GET /sessions/:id     - Get single session
 *   GET /sessions/stats   - Usage statistics
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import postgres from 'postgres';
import { facebookRoutes } from './facebook-api';

// Configuration
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/claude_sessions';
const PORT = parseInt(process.env.PORT || '3847', 10);

// Connect to database
const sql = postgres(DATABASE_URL);

// Create app
const app = new Hono();

// Enable CORS for local development
const sessionCors = cors();
app.use('*', (c, next) => {
  // Private Facebook messages are queried by agents/CLI clients, not arbitrary
  // browser origins. Preserve the existing session API's CORS behavior only.
  return c.req.path === '/facebook' || c.req.path.startsWith('/facebook/')
    ? next()
    : sessionCors(c, next);
});
app.route('/facebook', facebookRoutes(sql));

/**
 * Search sessions
 *
 * Query params:
 *   search       - Full-text search query
 *   days         - Limit to last N days
 *   since        - Sessions after this date
 *   until        - Sessions before this date
 *   tools        - Filter by tools (comma-separated)
 *   file_pattern - Filter by file path pattern
 *   hostname     - Filter by machine hostname (e.g. uber-om, mac-studio)
 *   limit        - Max results (default 20, max 100)
 */
app.get('/sessions', async (c) => {
  const {
    search,
    days,
    since,
    until,
    tools,
    file_pattern,
    hostname,
    limit: limitStr,
  } = c.req.query();

  const limit = Math.min(parseInt(limitStr || '20', 10), 100);

  // Build query conditions
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Date filtering
  if (days) {
    conditions.push(`ended_at > NOW() - INTERVAL '${parseInt(days, 10)} days'`);
  }
  if (since) {
    conditions.push(`ended_at >= $${paramIndex++}`);
    params.push(new Date(since));
  }
  if (until) {
    conditions.push(`ended_at <= $${paramIndex++}`);
    params.push(new Date(until));
  }

  // Tool filtering
  if (tools) {
    const toolList = tools.split(',').map((t) => t.trim());
    conditions.push(`tools_used ?| $${paramIndex++}`);
    params.push(toolList);
  }

  // File pattern filtering
  if (file_pattern) {
    conditions.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(files_touched) f
      WHERE f ILIKE $${paramIndex++}
    )`);
    params.push(`%${file_pattern}%`);
  }

  // Hostname filtering (exact match)
  if (hostname) {
    conditions.push(`hostname = $${paramIndex++}`);
    params.push(hostname);
  }

  // Full-text search
  let orderBy = 'ended_at DESC';
  let selectFields = `
    id,
    started_at,
    ended_at,
    synced_at,
    git_branch,
    cwd,
    version,
    hostname,
    message_count,
    input_tokens,
    output_tokens,
    tools_used,
    files_touched,
    user_messages,
    models_used,
    summary,
    category,
    transcript_path
  `;

  if (search) {
    const tsQuery = search
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `${term}:*`)
      .join(' & ');

    conditions.push(`search_vector @@ to_tsquery('english', $${paramIndex++})`);
    params.push(tsQuery);

    // Add relevance score
    selectFields += `,
      ts_rank(search_vector, to_tsquery('english', $${paramIndex++})) as relevance
    `;
    params.push(tsQuery);
    orderBy = 'relevance DESC, ended_at DESC';
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Execute query
  const query = `
    SELECT ${selectFields}
    FROM sessions
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;

  try {
    const rows = await sql.unsafe(query, params);

    return c.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error('Search error:', error);
    return c.json({ success: false, error: 'Search failed' }, 500);
  }
});

/**
 * Get session statistics
 *
 * Must be declared before `/sessions/:id` — Hono matches routes in
 * declaration order, so the `:id` route would otherwise catch `/stats`.
 */
app.get('/sessions/stats', async (c) => {
  const { days } = c.req.query();
  const daysNum = parseInt(days || '7', 10);

  try {
    const stats = await sql`
      SELECT
        COUNT(*) as session_count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_creation_tokens) as total_cache_creation_tokens,
        SUM(cache_read_tokens) as total_cache_read_tokens,
        SUM(message_count) as total_messages,
        MIN(started_at) as earliest_session,
        MAX(ended_at) as latest_session
      FROM sessions
      WHERE ended_at > NOW() - (INTERVAL '1 day' * ${daysNum})
    `;

    // Category breakdown
    const categories = await sql`
      SELECT
        category,
        COUNT(*) as count
      FROM sessions
      WHERE ended_at > NOW() - (INTERVAL '1 day' * ${daysNum})
        AND category IS NOT NULL
      GROUP BY category
      ORDER BY count DESC
    `;

    // Model breakdown
    const modelStats = await sql`
      SELECT
        model_key as model,
        SUM((model_value->>'input')::bigint) as input_tokens,
        SUM((model_value->>'output')::bigint) as output_tokens
      FROM sessions,
        jsonb_each(model_tokens) as m(model_key, model_value)
      WHERE ended_at > NOW() - (INTERVAL '1 day' * ${daysNum})
      GROUP BY model_key
      ORDER BY input_tokens DESC
    `;

    return c.json({
      success: true,
      data: {
        ...stats[0],
        days: daysNum,
        by_category: categories,
        by_model: modelStats,
      },
    });
  } catch (error) {
    console.error('Stats error:', error);
    return c.json({ success: false, error: 'Failed to get stats' }, 500);
  }
});

/**
 * Get single session by ID
 */
app.get('/sessions/:id', async (c) => {
  const { id } = c.req.param();
  const { with_transcript } = c.req.query();

  try {
    const withTranscript = with_transcript === 'true';

    const rows = withTranscript
      ? await sql`
          SELECT
            id,
            started_at,
            ended_at,
            git_branch,
            cwd,
            version,
            hostname,
            message_count,
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            tools_used,
            files_touched,
            user_messages,
            models_used,
            model_tokens,
            summary,
            category,
            transcript_path,
            transcript
          FROM sessions
          WHERE id = ${id}
        `
      : await sql`
          SELECT
            id,
            started_at,
            ended_at,
            git_branch,
            cwd,
            version,
            hostname,
            message_count,
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            tools_used,
            files_touched,
            user_messages,
            models_used,
            model_tokens,
            summary,
            category,
            transcript_path
          FROM sessions
          WHERE id = ${id}
        `;

    if (rows.length === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    const session = rows[0];

    // Optionally attach transcript. Prefer the archived JSONB column;
    // fall back to reading the local JSONL file for pre-migration-003
    // rows whose transcript hasn't been backfilled yet.
    if (withTranscript) {
      if (Array.isArray(session.transcript)) {
        (session as Record<string, unknown>).messages = session.transcript;
      } else if (session.transcript_path) {
        try {
          const { readFileSync } = await import('fs');
          const content = readFileSync(session.transcript_path, 'utf-8');
          const messages = content
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          (session as Record<string, unknown>).messages = messages;
        } catch {
          // Transcript file not accessible (machine retired, file rotated)
        }
      }
      // Don't leak the raw column alongside the normalized messages field.
      delete (session as Record<string, unknown>).transcript;
    }

    return c.json({
      success: true,
      data: session,
    });
  } catch (error) {
    console.error('Get session error:', error);
    return c.json({ success: false, error: 'Failed to get session' }, 500);
  }
});

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Start server
console.log(`Session API server starting on port ${PORT}`);
console.log(`Database: ${DATABASE_URL.replace(/:[^@]+@/, ':***@')}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
