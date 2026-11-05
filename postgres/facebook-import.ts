import postgres, { type Sql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { archiveSummary, readFacebookArchive, type FacebookArchive, type ArchiveFormat } from './facebook-archive';

export async function migrateFacebook(sql: Sql) {
  await sql.unsafe(await readFile(new URL('./migrations/004_add_facebook.sql', import.meta.url), 'utf8'));
}

export async function importFacebookArchive(sql: Sql, archive: FacebookArchive) {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('recall-facebook-import'))`;
    const existing = await tx`SELECT id FROM facebook_exports WHERE id = ${archive.id}`;
    if (existing.length) return { status: 'already_imported', ...archiveSummary(archive) };
    await tx`INSERT INTO facebook_exports (id, export_date, format, timezone, source_root, manifest)
      VALUES (${archive.id}, ${archive.exportDate}, ${archive.format}, ${archive.timezone}, ${archive.root}, ${tx.json(archive.files)})`;
    for (const conversation of archive.conversations) {
      await tx`INSERT INTO facebook_conversations (id, export_id, source_thread, title)
        VALUES (${conversation.id}, ${archive.id}, ${conversation.path}, ${conversation.title})`;
      if (conversation.participants.length) {
        const participants = conversation.participants.map(name => ({ conversation_id: conversation.id, name }));
        await tx`INSERT INTO facebook_participants ${tx(participants)}`;
      }
      for (let i = 0; i < conversation.messages.length; i += 250) {
        const rows = conversation.messages.slice(i, i + 250).map(m => ({
          id: m.id, conversation_id: conversation.id, sender: m.sender, content: m.content,
          sent_at: m.sentAt, sent_local: m.sentLocal, precision: m.precision,
          attachments: tx.json(m.attachments), source_file: m.sourceFile, source_order: m.sourceOrder,
          payload: tx.json(m.payload),
        }));
        await tx`INSERT INTO facebook_messages ${tx(rows)}`;
      }
    }
    return { status: 'imported', ...archiveSummary(archive) };
  });
}

if (import.meta.main) {
  let sql: Sql | undefined;
  try {
    const { values } = parseArgs({ options: {
      source: { type: 'string' }, format: { type: 'string' }, 'export-date': { type: 'string' },
      timezone: { type: 'string' }, apply: { type: 'boolean', default: false }, migrate: { type: 'boolean', default: false },
    } });
    if (values.migrate) {
      if (!values.apply || !process.env.DATABASE_URL) throw new Error('Migration requires --apply and explicit DATABASE_URL');
      sql = postgres(process.env.DATABASE_URL, { max: 1 });
      await migrateFacebook(sql);
      console.log(JSON.stringify({ status: 'migrated' }));
    } else {
      if (!values.source || !values['export-date'] || !values.timezone || !['html', 'json'].includes(values.format ?? '')) {
        throw new Error('Required: --source DIR --format html|json --export-date YYYY-MM-DD --timezone IANA_ZONE [--apply]');
      }
      const archive = await readFacebookArchive(values.source, values.format as ArchiveFormat, values['export-date'], values.timezone);
      if (values.apply) {
        if (!process.env.DATABASE_URL) throw new Error('Import requires explicit DATABASE_URL');
        sql = postgres(process.env.DATABASE_URL, { max: 1 });
        console.log(JSON.stringify(await importFacebookArchive(sql, archive)));
      } else console.log(JSON.stringify({ status: 'dry_run', ...archiveSummary(archive) }));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally { await sql?.end(); }
}
