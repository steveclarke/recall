import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { decodeHTML } from 'entities';
import { Temporal } from '@js-temporal/polyfill';

export type ArchiveFormat = 'html' | 'json';
export interface FacebookMessage {
  id: string;
  sender: string | null;
  content: string;
  sentAt: string | null;
  sentLocal: string;
  precision: 'minute' | 'millisecond';
  attachments: unknown[];
  sourceFile: string;
  sourceOrder: number;
  payload: unknown;
}
export interface FacebookConversation {
  id: string;
  path: string;
  title: string;
  participants: string[];
  messages: FacebookMessage[];
}
export interface FacebookArchive {
  id: string;
  root: string;
  format: ArchiveFormat;
  exportDate: string;
  timezone: string;
  files: { path: string; sha256: string }[];
  conversations: FacebookConversation[];
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Expected a YYYY-MM-DD date');
  return Temporal.PlainDate.from(value).toString();
}

// Facebook JSON frequently represents UTF-8 bytes as Latin-1 code points.
// Decode only when every byte forms valid UTF-8; genuine Unicode stays intact.
export function facebookText(value: string): string {
  if ([...value].some(c => c.codePointAt(0)! > 255)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from([...value], c => c.charCodeAt(0)),
    );
  } catch { return value; }
}

export function htmlDate(value: string, timezone: string) {
  const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/.exec(value);
  if (!m) throw new Error('Unrecognized Facebook HTML message date');
  const hour = Number(m[4]);
  if (hour < 1 || hour > 12) throw new Error('Invalid Facebook HTML hour');
  const wall = Temporal.PlainDateTime.from({
    year: Number(m[3]), month: 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(m[1]) + 1,
    day: Number(m[2]), hour: hour % 12 + (m[6] === 'PM' ? 12 : 0), minute: Number(m[5]),
  }, { overflow: 'reject' });
  let sentAt: string | null;
  try { sentAt = wall.toZonedDateTime(timezone, { disambiguation: 'reject' }).toInstant().toString(); }
  catch { sentAt = null; } // Preserve ambiguous/nonexistent DST wall times without guessing.
  return { sentAt, sentLocal: wall.toString(), precision: 'minute' as const };
}

interface HtmlCard { sender: string; body: string; date: string; links: unknown[] }
export async function parseFacebookHtml(text: string, timezone: string) {
  let title = '', participantText = '';
  let current: HtmlCard | null = null;
  const cards: HtmlCard[] = [];
  const rewriter = new HTMLRewriter()
    .on('title', { text(chunk) { title += chunk.text; } })
    .on('div.pam', { element(e) {
      const card: HtmlCard = { sender: '', body: '', date: '', links: [] };
      current = card;
      e.onEndTag(() => { cards.push(card); current = null; });
    } })
    .on('div.pam div._2lel', { text(chunk) { if (current) current.sender += chunk.text; } })
    .on('div.pam div._2let', { text(chunk) { if (current) current.body += chunk.text; } })
    .on('div.pam div._3-94', { text(chunk) { if (current) current.date += chunk.text; } })
    .on('div.pam div._2lek:not(._2lel)', { text(chunk) { participantText += chunk.text; } })
    .on('div._2let div, div._2let p, div._2let br, div._2let li', { element(e) {
      if (current) current.body += '\n';
      if (e.tagName !== 'br') e.onEndTag(() => { if (current) current.body += '\n'; });
    } })
    .on('div._2let a, div._2let img, div._2let video, div._2let audio, div._2let source', { element(e) {
      const uri = e.getAttribute('href') ?? e.getAttribute('src');
      if (current && uri) current.links.push({ tag: e.tagName, uri: decodeHTML(uri), alt: decodeHTML(e.getAttribute('alt') ?? '') });
    } });
  await rewriter.transform(new Response(text)).text();
  const messages = cards.filter(c => c.date.trim()).map(c => ({
    sender: decodeHTML(c.sender).trim() || null,
    content: decodeHTML(c.body).trim(),
    ...htmlDate(decodeHTML(c.date).trim(), timezone),
    attachments: c.links,
    payload: { date: decodeHTML(c.date).trim() },
  }));
  if (cards.some(c => !c.date.trim() && (c.sender.trim() || c.body.trim()))) {
    throw new Error('A message card has no date');
  }
  const participants = new Set(messages.flatMap(m => m.sender ? [m.sender] : []));
  const label = decodeHTML(title).trim();
  const group = decodeHTML(participantText).trim();
  if (group.startsWith('Participants: ')) {
    group.slice('Participants: '.length).split(/, | and /u).forEach(n => participants.add(n.trim()));
  } else if (!(participants.size > 2 && label.includes(' and '))) {
    participants.add(label);
  }
  participants.delete('');
  // Deleted/unnamed accounts can have an intentionally empty title and sender.
  return { title: label, participants: [...participants], messages };
}

export function parseFacebookJson(text: string, timezone: string) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.messages) || !Array.isArray(data.participants) || typeof data.title !== 'string') {
    throw new Error('Invalid Facebook JSON conversation');
  }
  const participants = data.participants.map((p: { name: string }) => {
    if (typeof p.name !== 'string') throw new Error('Invalid Facebook participant');
    return facebookText(p.name);
  });
  const messages = data.messages.map((m: Record<string, unknown>) => {
    if (!Number.isSafeInteger(m.timestamp_ms)) throw new Error('Message timestamp_ms is missing or invalid');
    const instant = Temporal.Instant.fromEpochMilliseconds(m.timestamp_ms as number);
    const sender = typeof m.sender_name === 'string' ? facebookText(m.sender_name) : null;
    if (sender) participants.push(sender);
    return {
      sender,
      content: typeof m.content === 'string' ? facebookText(m.content) : '',
      sentAt: instant.toString(),
      sentLocal: instant.toZonedDateTimeISO(timezone).toPlainDateTime().toString(),
      precision: 'millisecond' as const,
      attachments: ['photos', 'videos', 'audio_files', 'files', 'gifs', 'sticker', 'share']
        .filter(k => m[k] != null).map(k => ({ kind: k, value: m[k] })),
      payload: m,
    };
  });
  return { title: facebookText(data.title), participants: [...new Set(participants)], messages };
}

async function messageFiles(root: string, suffix: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Archive symlink is not supported: ${path}`);
    if (entry.isDirectory()) files.push(...await messageFiles(path, suffix));
    else if (new RegExp(`^message_\\d+\\.${suffix}$`).test(entry.name)) files.push(path);
  }
  return files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export async function readFacebookArchive(root: string, format: ArchiveFormat, exportDate: string, timezone: string): Promise<FacebookArchive> {
  validDate(exportDate);
  Temporal.Now.instant().toZonedDateTimeISO(timezone); // Validate the explicit IANA zone.
  root = resolve(root);
  const paths = await messageFiles(join(root, 'messages'), format);
  if (!paths.length) throw new Error(`No supported message_*.${format} files found`);
  const files = [];
  for (const path of paths) files.push({ path: relative(root, path), sha256: hash(await readFile(path)) });
  const id = hash(JSON.stringify({ format, exportDate, timezone, files }));
  const conversations = new Map<string, FacebookConversation>();
  for (let i = 0; i < paths.length; i++) {
    const path = files[i].path;
    const body = await readFile(paths[i]);
    if (hash(body) !== files[i].sha256) throw new Error(`Source changed during import: ${path}`);
    const sourceThread = path.slice(0, path.lastIndexOf('/'));
    const cid = hash(`${id}\n${sourceThread}`);
    let parsed;
    try {
      parsed = format === 'html' ? await parseFacebookHtml(body.toString('utf8'), timezone) : parseFacebookJson(body.toString('utf8'), timezone);
    } catch (e) { throw new Error(`Cannot parse ${path}: ${(e as Error).message}`); }
    let conversation = conversations.get(cid);
    if (!conversation) {
      conversation = { id: cid, path: sourceThread, title: parsed.title, participants: [], messages: [] };
      conversations.set(cid, conversation);
    }
    conversation.participants = [...new Set([...conversation.participants, ...parsed.participants])];
    for (let ordinal = 0; ordinal < parsed.messages.length; ordinal++) {
      conversation.messages.push({
        ...parsed.messages[ordinal], id: hash(`${cid}\n${basename(path)}\n${ordinal}`),
        sourceFile: path, sourceOrder: conversation.messages.length,
      });
    }
  }
  return { id, root, format, exportDate, timezone, files, conversations: [...conversations.values()] };
}

export function archiveSummary(archive: FacebookArchive) {
  return {
    export_id: archive.id, format: archive.format, export_date: archive.exportDate,
    conversations: archive.conversations.length,
    messages: archive.conversations.reduce((n, c) => n + c.messages.length, 0),
    unresolved_utc_timestamps: archive.conversations.reduce((n, c) => n + c.messages.filter(m => !m.sentAt).length, 0),
    files: archive.files.length,
  };
}
