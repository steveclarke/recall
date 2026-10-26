import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SessionAccumulator,
  isSkippedLine,
  parseSessionContent,
  readLines,
} from '../shared/parser.js';
import type { SessionAggregates } from '../shared/types.js';

const user = (content: unknown, ts: string) =>
  JSON.stringify({ type: 'user', sessionId: 's', cwd: '/w', gitBranch: 'main', version: '2', timestamp: ts, message: { role: 'user', content } });
const assistant = (ts: string, model: string, tool?: { name: string; input: object }) =>
  JSON.stringify({
    type: 'assistant', sessionId: 's', timestamp: ts,
    message: {
      role: 'assistant', model,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 },
      content: tool ? [{ type: 'tool_use', name: tool.name, input: tool.input }] : [{ type: 'text', text: 'ok' }],
    },
  });

const LINES = [
  JSON.stringify({ type: 'custom-title', title: 'x' }),
  user('first prompt', '2026-10-01T00:00:00.000Z'),
  JSON.stringify({ type: 'api-request', params: { messages: ['huge copy'] } }),
  assistant('2026-10-01T00:00:01.000Z', 'opus', { name: 'Read', input: { file_path: '/a/b.ts' } }),
  user([{ type: 'tool_result', content: 'file body' }], '2026-10-01T00:00:02.000Z'),
  user([{ type: 'text', text: 'prompt with image' }, { type: 'image' }], '2026-10-01T00:00:03.000Z'),
  'not json',
  assistant('2026-10-01T00:00:04.000Z', 'sonnet', { name: 'Edit', input: { file_path: '/a/c.ts' } }),
  user('last prompt', '2026-10-01T00:00:05.000Z'),
  JSON.stringify({ ...JSON.parse(user([{ type: 'text', text: 'Base directory for this skill: /x' }], '2026-10-01T00:00:06.000Z')), isMeta: true }),
];

async function fold(path: string, start: number, seed?: SessionAggregates) {
  const acc = new SessionAccumulator(seed);
  let end = start;
  for await (const { line, end: e } of readLines(path, start)) {
    end = e;
    if (isSkippedLine(line)) continue;
    try { acc.add(JSON.parse(line)); } catch {}
  }
  return { totals: acc.result(), end };
}

describe('incremental parse', () => {
  test('reading in two runs from a checkpoint equals one full read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const full = join(dir, 'full.jsonl');
    writeFileSync(full, LINES.join('\n') + '\n');
    const once = await fold(full, 0);

    for (let split = 0; split <= LINES.length; split++) {
      const grown = join(dir, `grown-${split}.jsonl`);
      // First run sees `split` lines plus half of the next one, mid-write.
      const head = LINES.slice(0, split).map((l) => l + '\n').join('');
      const partial = split < LINES.length ? LINES[split].slice(0, 7) : '';
      writeFileSync(grown, head + partial);
      const first = await fold(grown, 0);
      expect(first.end).toBe(Buffer.byteLength(head));

      appendFileSync(grown, (split < LINES.length ? LINES[split].slice(7) + '\n' : '') + LINES.slice(split + 1).map((l) => l + '\n').join(''));
      const second = await fold(grown, first.end, first.totals);
      expect(second.end).toBe(once.end);
      expect(second.totals).toEqual(once.totals);
    }
  });

  test('totals', async () => {
    const s = parseSessionContent(LINES.join('\n'), '/x/12345678-1234-1234-1234-123456789012.jsonl')!;
    expect(s.id).toBe('12345678-1234-1234-1234-123456789012');
    expect(s.messageCount).toBe(7);
    expect(s.userMessages).toEqual(['first prompt', 'prompt with image', 'last prompt']);
    expect(s.toolsUsed).toEqual(['Read', 'Edit']);
    expect(s.filesFromToolCalls).toEqual(['/a/b.ts', '/a/c.ts']);
    expect(s.inputTokens).toBe(20);
    expect(s.modelTokens.opus).toEqual({ input: 10, output: 5, cacheCreation: 2, cacheRead: 1 });
    expect(s.startedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(s.endedAt.toISOString()).toBe('2026-10-01T00:00:06.000Z');
  });

  test('multi-byte characters across read-buffer boundaries keep exact offsets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const p = join(dir, 'utf8.jsonl');
    const lines = Array.from({ length: 3000 }, (_, i) => user('é→🙂 '.repeat(50) + i, '2026-10-01T00:00:00.000Z'));
    writeFileSync(p, lines.join('\n') + '\n');
    const out: string[] = [];
    let end = 0;
    for await (const r of readLines(p, 0)) { out.push(r.line); end = r.end; }
    expect(out).toEqual(lines);
    expect(end).toBe(Buffer.byteLength(lines.join('\n') + '\n'));
  });
});
