import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, unlink, rmdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { facebookRoutes } from './facebook-api';
import { importFacebookArchive, migrateFacebook } from './facebook-import';
import { readFacebookArchive, type FacebookArchive } from './facebook-archive';

const url = process.env.FACEBOOK_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Facebook PostgreSQL import and search', () => {
  let sql: Sql, root: string, newest: FacebookArchive, older: FacebookArchive;
  let app: ReturnType<typeof facebookRoutes>;
  const ids = new Set<string>();
  beforeAll(async () => {
    const connection = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/recall_facebook_test') {
      throw new Error('Use the disposable loopback recall_facebook_test database');
    }
    sql = postgres(url!, { max: 1, onnotice() {} });
    await sql.unsafe(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await migrateFacebook(sql);
    root = await mkdtemp(join(tmpdir(), 'recall-facebook-fixture-'));
    const folder = join(root, 'messages/inbox/example');
    await mkdir(folder, { recursive: true });
    const marker = crypto.randomUUID();
    const card = (body: string, date = 'Oct 16, 2014, 8:08 PM') =>
      `<div class="pam"><div class="_2lel">Example Person</div><div class="_2let">${body}</div><div class="_3-94">${date}</div></div>`;
    await writeFile(join(folder, 'message_1.html'), `<title>Example Person</title>${card('reconciliation newest ' + marker)}${card('same')}${card('same')}${card('older day', 'Oct 15, 2014, 8:08 PM')}`);
    await writeFile(join(folder, 'message_2.html'), `<title>Example Person</title>${card('oldest', 'Oct 14, 2014, 8:08 PM')}`);
    newest = await readFacebookArchive(root, 'html', '2099-02-13', 'America/St_Johns');
    older = await readFacebookArchive(root, 'html', '2098-06-25', 'America/St_Johns');
    ids.add(newest.id); ids.add(older.id);
    app = facebookRoutes(sql);
  });
  afterAll(async () => {
    if (sql) {
      for (const id of ids) {
        await sql`DELETE FROM facebook_messages WHERE conversation_id IN (SELECT id FROM facebook_conversations WHERE export_id = ${id})`;
        await sql`DELETE FROM facebook_participants WHERE conversation_id IN (SELECT id FROM facebook_conversations WHERE export_id = ${id})`;
        await sql`DELETE FROM facebook_conversations WHERE export_id = ${id}`;
        await sql`DELETE FROM facebook_exports WHERE id = ${id}`;
      }
      await sql.end();
    }
    // Only files this test creates; no source archive paths enter this fixture directory.
    if (root) {
      await unlink(join(root, 'messages/inbox/example/message_1.html'));
      await unlink(join(root, 'messages/inbox/example/message_2.html'));
      for (const path of ['messages/inbox/example', 'messages/inbox', 'messages', '']) await rmdir(join(root, path));
    }
  });

  test('imports all positions atomically, preserves repeated text, and reruns add nothing', async () => {
    expect((await importFacebookArchive(sql, newest)).status).toBe('imported');
    expect((await importFacebookArchive(sql, newest)).status).toBe('already_imported');
    const rows = await sql`SELECT count(*)::int AS n FROM facebook_messages WHERE conversation_id = ${newest.conversations[0].id}`;
    expect(rows[0].n).toBe(5);
    expect(new Set(newest.conversations[0].messages.map(m => m.id)).size).toBe(5);
    const copy = await readFacebookArchive(root, 'html', '2099-02-13', 'America/St_Johns');
    expect(copy.id).toBe(newest.id);
  });
  test('rolls back a partially inserted export on a conflicting message', async () => {
    const broken = structuredClone(older);
    broken.id = '0'.repeat(64); ids.add(broken.id);
    broken.conversations[0].id = '1'.repeat(64);
    broken.conversations[0].messages[1].id = broken.conversations[0].messages[0].id;
    await expect(importFacebookArchive(sql, broken)).rejects.toThrow();
    expect((await sql`SELECT id FROM facebook_exports WHERE id = ${broken.id}`).length).toBe(0);
  });
  test('defaults to newest snapshot even when the older snapshot imports later', async () => {
    await importFacebookArchive(sql, older);
    const result = await (await app.request('/messages?search=reconciliation')).json();
    expect(result.export_id).toBe(newest.id);
    expect(result.count).toBe(1);
    const previous = await (await app.request(`/messages?export=${older.id}&search=reconciliation`)).json();
    expect(previous.export_id).toBe(older.id);
    expect(previous.count).toBe(1);
  });
  test('filters by participant, full text and inclusive local dates with literal SQL input', async () => {
    const result = await (await app.request('/messages?person=Example&since=2014-10-16&until=2014-10-16')).json();
    expect(result.count).toBe(3);
    expect(result.data[0].sent_local).toBe('2014-10-16 20:08:00');
    expect(result.data[0].timezone).toBe('America/St_Johns');
    const missing = await (await app.request('/messages?person=%25')).json();
    expect(missing.count).toBe(0);
    const injection = await app.request('/messages?search=' + encodeURIComponent("'; DROP TABLE facebook_messages; --"));
    expect(injection.status).toBe(200);
    const names = await (await app.request('/people')).json();
    expect(names.data[0].name).toBe('Example Person');
  });
  test('returns deterministic same-minute chronology and context around search hits', async () => {
    const conversation = newest.conversations[0];
    const result = await (await app.request(`/conversations/${conversation.id}/messages`)).json();
    expect(result.data.map((m: any) => m.source_order)).toEqual([4, 3, 2, 1, 0]);
    const target = conversation.messages[1].id;
    const context = await (await app.request(`/conversations/${conversation.id}/messages?around=${target}&before=1&after=1`)).json();
    expect(context.data.map((m: any) => m.source_order)).toEqual([2, 1, 0]);
    const wrong = await app.request(`/conversations/${conversation.id}/messages?around=${older.conversations[0].messages[0].id}`);
    expect(wrong.status).toBe(404);
  });
  test('rejects invalid pagination and date ranges without a database error', async () => {
    for (const query of ['limit=NaN', 'limit=101', 'limit=0', 'offset=-1', 'since=2021-02-30', 'since=2021-02-03&until=2020-01-01', 'export=nope']) {
      expect((await app.request('/messages?' + query)).status).toBe(400);
    }
    expect((await app.request('/conversations/' + 'f'.repeat(64) + '/messages')).status).toBe(404);
    expect((await app.request('/messages?export=' + 'f'.repeat(64))).status).toBe(404);
  });
  test('mounts Facebook routes without breaking existing session search and health', async () => {
    process.env.DATABASE_URL = url;
    const { default: api } = await import('./api');
    const health = await api.fetch(new Request('http://localhost/health'));
    expect(health.status).toBe(200);
    const sessions = await api.fetch(new Request('http://localhost/sessions?limit=1'));
    expect(sessions.status).toBe(200);
    const facebook = await api.fetch(new Request('http://localhost/facebook/messages?search=reconciliation'));
    expect((await facebook.json()).count).toBe(1);
  });
});
