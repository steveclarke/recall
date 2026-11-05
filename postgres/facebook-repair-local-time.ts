import postgres, { type Sql } from 'postgres';
import { parseArgs } from 'node:util';

export async function repairFacebookLocalTimes(sql: Sql, apply = false) {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('recall-facebook-import'))`;
    const inspect = () => tx`SELECT count(*)::int AS messages,
      count(*) FILTER (WHERE m.sent_at IS NULL)::int AS unresolved,
      count(*) FILTER (WHERE m.sent_at IS NOT NULL AND
        m.sent_local IS DISTINCT FROM (m.sent_at AT TIME ZONE e.timezone))::int AS mismatches
      FROM facebook_messages m
      JOIN facebook_conversations c ON c.id = m.conversation_id
      JOIN facebook_exports e ON e.id = c.export_id`;
    const [before] = await inspect();
    if (apply && before.unresolved) {
      throw new Error('Unresolved UTC instants require source-based repair; no rows changed');
    }
    let corrected = 0;
    if (apply && before.mismatches) {
      const result = await tx`UPDATE facebook_messages m
        SET sent_local = m.sent_at AT TIME ZONE e.timezone
        FROM facebook_conversations c JOIN facebook_exports e ON e.id = c.export_id
        WHERE m.conversation_id = c.id AND m.sent_at IS NOT NULL
        AND m.sent_local IS DISTINCT FROM (m.sent_at AT TIME ZONE e.timezone)`;
      corrected = result.count;
      if (corrected !== before.mismatches) throw new Error('Repair row count changed; transaction rolled back');
    }
    const [after] = await inspect();
    if (apply && after.mismatches) throw new Error('Local-time mismatches remain; transaction rolled back');
    return {
      status: apply ? 'repaired' : 'dry_run', messages: before.messages,
      mismatches_before: before.mismatches, corrected,
      remaining_mismatches: after.mismatches, unresolved: before.unresolved,
    };
  });
}

if (import.meta.main) {
  let sql: Sql | undefined;
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
    if (!process.env.DATABASE_URL) throw new Error('Repair requires explicit DATABASE_URL');
    sql = postgres(process.env.DATABASE_URL, { max: 1 });
    console.log(JSON.stringify(await repairFacebookLocalTimes(sql, values.apply)));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally { await sql?.end(); }
}
