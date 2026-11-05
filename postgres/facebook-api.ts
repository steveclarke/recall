import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Sql } from 'postgres';
import { validDate } from './facebook-archive';

function number(c: Context, name: string, fallback: number, max: number, min = 0) {
  const value = c.req.query(name);
  if (value == null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new HTTPException(400, { message: `Invalid ${name}` });
  }
  return Number(value);
}
function text(c: Context, name: string, max = 512) {
  const value = c.req.query(name)?.trim();
  if (value && value.length > max) throw new HTTPException(400, { message: `${name} is too long` });
  return value || null;
}
function dates(c: Context) {
  const since = text(c, 'since', 10), until = text(c, 'until', 10);
  try {
    if (since) validDate(since);
    if (until) validDate(until);
    if (since && until && since > until) throw new Error();
  } catch { throw new HTTPException(400, { message: 'Invalid date range; use inclusive YYYY-MM-DD dates' }); }
  return { since, until };
}
const literalLike = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export function facebookRoutes(sql: Sql) {
  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof HTTPException) return c.json({ success: false, error: e.message }, e.status);
    console.error('Facebook query failed:', e instanceof Error ? e.name : 'unknown error');
    return c.json({ success: false, error: 'Facebook query failed' }, 500);
  });
  async function exportId(c: Context) {
    const requested = text(c, 'export', 64);
    if (requested && !/^[a-f0-9]{64}$/.test(requested)) throw new HTTPException(400, { message: 'Invalid export identifier' });
    const rows = requested
      ? await sql`SELECT id FROM facebook_exports WHERE id = ${requested}`
      : await sql`SELECT id FROM facebook_exports ORDER BY export_date DESC, id DESC LIMIT 1`;
    if (requested && !rows.length) throw new HTTPException(404, { message: 'Export not found' });
    return rows[0]?.id ?? null;
  }
  const fields = sql`m.id, m.conversation_id, m.sender, m.content, m.sent_at, m.sent_local::text AS sent_local,
    m.precision, m.attachments, m.source_file, m.source_order`;

  app.get('/exports', async c => {
    const limit = number(c, 'limit', 20, 100, 1), offset = number(c, 'offset', 0, 1_000_000);
    const rows = await sql`SELECT e.id, e.export_date, e.format, e.timezone, e.imported_at,
      (SELECT count(*)::int FROM facebook_conversations t WHERE t.export_id = e.id) AS conversation_count
      FROM facebook_exports e ORDER BY e.export_date DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`;
    return c.json({ success: true, count: rows.length, data: rows });
  });

  app.get('/conversations', async c => {
    const id = await exportId(c), person = text(c, 'person', 256);
    const { since, until } = dates(c);
    const limit = number(c, 'limit', 20, 100, 1), offset = number(c, 'offset', 0, 1_000_000);
    const rows = await sql`SELECT t.id, t.title, t.source_thread, e.timezone,
      array(SELECT name FROM facebook_participants p WHERE p.conversation_id = t.id ORDER BY name) AS participants,
      count(m.id)::int AS message_count, min(m.sent_local)::text AS first_message, max(m.sent_local)::text AS last_message
      FROM facebook_conversations t JOIN facebook_exports e ON e.id = t.export_id
      LEFT JOIN facebook_messages m ON m.conversation_id = t.id
      WHERE t.export_id = ${id}
      AND ${person ? sql`EXISTS (SELECT 1 FROM facebook_participants p WHERE p.conversation_id = t.id AND p.name ILIKE ${literalLike(person)})` : sql`true`}
      AND ${since || until ? sql`EXISTS (SELECT 1 FROM facebook_messages d WHERE d.conversation_id = t.id
        AND ${since ? sql`d.sent_local >= ${since}::date` : sql`true`}
        AND ${until ? sql`d.sent_local < ${until}::date + INTERVAL '1 day'` : sql`true`})` : sql`true`}
      GROUP BY t.id, e.timezone ORDER BY max(m.sent_local) DESC NULLS LAST, t.id LIMIT ${limit} OFFSET ${offset}`;
    return c.json({ success: true, export_id: id, count: rows.length, data: rows });
  });

  app.get('/messages', async c => {
    const id = await exportId(c), person = text(c, 'person', 256), search = text(c, 'search');
    const { since, until } = dates(c);
    const limit = number(c, 'limit', 20, 100, 1), offset = number(c, 'offset', 0, 1_000_000);
    const rows = await sql`SELECT ${fields}, t.title, e.timezone
      FROM facebook_messages m JOIN facebook_conversations t ON t.id = m.conversation_id
      JOIN facebook_exports e ON e.id = t.export_id
      WHERE t.export_id = ${id}
      AND ${person ? sql`EXISTS (SELECT 1 FROM facebook_participants p WHERE p.conversation_id = t.id AND p.name ILIKE ${literalLike(person)})` : sql`true`}
      AND ${search ? sql`m.search_vector @@ websearch_to_tsquery('simple', ${search})` : sql`true`}
      AND ${since ? sql`m.sent_local >= ${since}::date` : sql`true`}
      AND ${until ? sql`m.sent_local < ${until}::date + INTERVAL '1 day'` : sql`true`}
      ORDER BY m.sent_local DESC, t.id, m.source_order ASC LIMIT ${limit} OFFSET ${offset}`;
    return c.json({ success: true, export_id: id, count: rows.length, data: rows });
  });

  app.get('/people', async c => {
    const id = await exportId(c), person = text(c, 'person', 256);
    const limit = number(c, 'limit', 100, 100, 1), offset = number(c, 'offset', 0, 1_000_000);
    const rows = await sql`SELECT p.name, count(*)::int AS conversation_count
      FROM facebook_participants p JOIN facebook_conversations t ON t.id = p.conversation_id
      WHERE t.export_id = ${id} AND p.name NOT IN ('Facebook User', 'Other User')
      AND ${person ? sql`p.name ILIKE ${literalLike(person)}` : sql`true`}
      GROUP BY p.name ORDER BY p.name LIMIT ${limit} OFFSET ${offset}`;
    return c.json({ success: true, export_id: id, count: rows.length, data: rows });
  });

  app.get('/conversations/:id/messages', async c => {
    const id = c.req.param('id'), around = text(c, 'around', 64);
    if (!/^[a-f0-9]{64}$/.test(id) || (around && !/^[a-f0-9]{64}$/.test(around))) {
      throw new HTTPException(400, { message: 'Invalid conversation or message identifier' });
    }
    const limit = number(c, 'limit', 50, 100, 1), offset = number(c, 'offset', 0, 1_000_000);
    const before = number(c, 'before', 5, 49), after = number(c, 'after', 5, 49);
    const conversations = await sql`SELECT t.id, t.title, t.export_id, e.timezone FROM facebook_conversations t
      JOIN facebook_exports e ON e.id = t.export_id WHERE t.id = ${id}`;
    if (!conversations.length) throw new HTTPException(404, { message: 'Conversation not found' });
    let rows;
    if (around) {
      const found = await sql`SELECT id FROM facebook_messages WHERE id = ${around} AND conversation_id = ${id}`;
      if (!found.length) throw new HTTPException(404, { message: 'Message not found in this conversation' });
      rows = await sql`WITH ordered AS (
        SELECT ${fields}, row_number() OVER (ORDER BY m.sent_local, m.source_order DESC) AS position
        FROM facebook_messages m WHERE m.conversation_id = ${id}
      ), anchor AS (SELECT position FROM ordered WHERE id = ${around})
      SELECT ordered.* FROM ordered, anchor
      WHERE ordered.position BETWEEN anchor.position - ${before} AND anchor.position + ${after}
      ORDER BY ordered.position`;
    } else {
      rows = await sql`SELECT ${fields} FROM facebook_messages m WHERE m.conversation_id = ${id}
        ORDER BY m.sent_local, m.source_order DESC LIMIT ${limit} OFFSET ${offset}`;
    }
    return c.json({ success: true, conversation: conversations[0], count: rows.length, data: rows });
  });
  return app;
}
