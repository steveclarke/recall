import { describe, expect, test } from 'bun:test';
import { facebookText, htmlDate, parseFacebookHtml, parseFacebookJson, validDate } from './facebook-archive';

export const htmlMessage = (body: string, date = 'Oct 16, 2014, 8:08 PM') =>
  `<div class="pam"><div class="_2lel">Someone &amp; Co</div><div class="_2let">${body}</div><div class="_3-94">${date}</div></div>`;

describe('Facebook source fidelity', () => {
  test('decodes entities once, preserves original words, lines and identical messages', async () => {
    const result = await parseFacebookHtml(`<title>Someone &amp; Co</title>${htmlMessage('<div>shit &amp; &#39;quotes&#39;</div><div>&amp;lt;literal&amp;gt;</div>')}${htmlMessage('same')}${htmlMessage('same')}`, 'America/St_Johns');
    expect(result.title).toBe('Someone & Co');
    expect(result.messages[0].content).toContain("shit & 'quotes'");
    expect(result.messages[0].content).toContain('\n&lt;literal&gt;');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].content).toBe(result.messages[2].content);
  });
  test('retains attachment-only messages and never fetches their URLs', async () => {
    const result = await parseFacebookHtml(`<title>Someone</title>${htmlMessage('<a href="files/a.pdf">document</a><img src="https://invalid.example/photo.jpg">')}`, 'America/St_Johns');
    expect(result.messages[0].attachments).toHaveLength(2);
    expect(result.messages[0].attachments[0]).toMatchObject({ uri: 'files/a.pdf' });
  });
  test('handles line breaks without expecting an HTML end tag', async () => {
    const result = await parseFacebookHtml(`<title>A</title>${htmlMessage('first<br>second')}`, 'UTC');
    expect(result.messages[0].content).toBe('first\nsecond');
  });
  test('preserves unnamed conversations and senders without inventing an identity', async () => {
    const result = await parseFacebookHtml(`<title></title><div class="pam"><div class="_2lel"></div><div class="_2let">hello</div><div class="_3-94">Oct 16, 2014, 8:08 PM</div></div>`, 'UTC');
    expect(result.title).toBe('');
    expect(result.participants).toEqual([]);
    expect(result.messages[0].sender).toBeNull();
  });
  test('rejects undated attachment-only cards and unsupported HTML instead of losing entries', async () => {
    await expect(parseFacebookHtml('<title></title><div class="pam"><div class="_2lel"></div><div class="_2let"><img src="files/example.jpg"></div><div class="_3-94"></div></div>', 'UTC')).rejects.toThrow('no date');
    await expect(parseFacebookHtml('<title>A</title><p>unrecognized export</p>', 'UTC')).rejects.toThrow('No supported');
  });
  test('preserves authored edge spaces, nonbreaking spaces and newlines exactly', async () => {
    const result = await parseFacebookHtml(`<title>A</title>${htmlMessage('<div>&nbsp;&nbsp;indented&nbsp;</div>')}${htmlMessage('\n  line one\nline two  \n')}${htmlMessage('<br>edge<br>')}`, 'UTC');
    expect(result.messages[0].content).toBe('\u00a0\u00a0indented\u00a0');
    expect(result.messages[1].content).toBe('\n  line one\nline two  \n');
    expect(result.messages[2].content).toBe('\nedge\n');
  });
  test('requires dates for message cards, excluding participant headers', async () => {
    await expect(parseFacebookHtml('<title>Group</title><div class="pam"><div class="_2lek">Participants: A and B</div><div class="_3-94"></div></div>', 'America/St_Johns')).resolves.toMatchObject({ participants: ['A', 'B'], messages: [] });
    await expect(parseFacebookHtml('<title>A</title><div class="pam"><div class="_2lel">A</div><div class="_2let">lost date</div></div>', 'America/St_Johns')).rejects.toThrow('no date');
  });
  test('converts Newfoundland summer and winter dates, leaving DST folds unresolved', () => {
    expect(htmlDate('Jun 20, 2012, 6:30 PM', 'America/St_Johns').sentAt).toBe('2012-06-20T21:00:00Z');
    expect(htmlDate('Feb 13, 2021, 1:23 PM', 'America/St_Johns').sentAt).toBe('2021-02-13T16:53:00Z');
    expect(htmlDate('Nov 1, 2020, 1:30 AM', 'America/St_Johns').sentAt).toBeNull();
    expect(htmlDate('Mar 8, 2020, 2:30 AM', 'America/St_Johns').sentAt).toBeNull();
    expect(() => htmlDate('Feb 30, 2021, 1:23 PM', 'America/St_Johns')).toThrow();
    expect(() => validDate('2021-02-30')).toThrow();
  });
  test('repairs Facebook JSON encoding without damaging Unicode or genuine accents', () => {
    const mojibake = Buffer.from('It’s café 👋', 'utf8').toString('latin1');
    expect(facebookText(mojibake)).toBe('It’s café 👋');
    expect(facebookText('Already 👋')).toBe('Already 👋');
    expect(facebookText('café')).toBe('café');
    const parsed = parseFacebookJson(JSON.stringify({ title: mojibake, participants: [{ name: 'A' }], messages: [
      { sender_name: 'A', timestamp_ms: 1340226059085, content: mojibake, photos: [{ uri: 'photo.jpg' }], reactions: [{ reaction: 'x' }] },
    ] }), 'America/St_Johns');
    expect(parsed.messages[0].content).toBe('It’s café 👋');
    expect(parsed.messages[0].sentAt).toBe('2012-06-20T21:00:59.085Z');
    expect(parsed.messages[0].payload).toMatchObject({ reactions: [{ reaction: 'x' }] });
    expect(parsed.messages[0].attachments).toHaveLength(1);
    expect(() => parseFacebookJson('{"title":"A","participants":[],"messages":[{}]}', 'UTC')).toThrow('timestamp_ms');
  });
});
