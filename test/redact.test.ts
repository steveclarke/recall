import { expect, test } from 'bun:test';
import { redactTree } from '../shared/redact.js';

test('identifiers, timestamps and encoded data survive redaction', () => {
  const line = {
    type: 'assistant',
    uuid: 'e9415c48-a553-4ad4-982c-f41a1e47a4cb',
    timestamp: '2026-10-12T11:29:43.455Z',
    message: {
      id: 'msg_011CfxJLRTFcK5PeiNqM39UP',
      content: [
        { type: 'tool_use', id: 'toolu_0168VBggrUd8EDr1dfCk3MJq', input: { command: 'ls' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgfCk455' } },
        { type: 'text', text: 'what the fuck\u0000 happened' },
      ],
    },
  };
  const out = redactTree(line) as typeof line;
  expect(out.uuid).toBe(line.uuid);
  expect(out.timestamp).toBe(line.timestamp);
  expect(out.message.id).toBe(line.message.id);
  expect((out.message.content[0] as any).id).toBe('toolu_0168VBggrUd8EDr1dfCk3MJq');
  expect((out.message.content[1] as any).source.data).toBe('iVBORw0KGgoAAAANSUhEUgfCk455');
  const text = (out.message.content[2] as any).text as string;
  expect(text).not.toContain('fuck');
  expect(text).not.toContain('\u0000');
  expect(text.startsWith('what the ')).toBe(true);
});
