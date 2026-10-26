/**
 * Profanity redaction for archived transcripts.
 *
 * Runs at sync time, before the row hits Postgres, so the DB never sees
 * the raw words. Intentionally destructive — there's no undo short of
 * re-syncing from a JSONL that still has the originals.
 *
 * Uses `obscenity` with its English preset. Adjust `extraWords` /
 * `allowWords` in this file for project-specific tuning.
 */

import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
} from 'obscenity';

/**
 * Words to ALWAYS scrub, beyond obscenity's English preset.
 * Add entries when a word you care about slips through.
 */
const extraWords: string[] = [
  // add additional terms here as lowercase simple strings, e.g. 'frig'
];

/**
 * Words to NEVER scrub, even if the preset matches them.
 * Add entries when a false positive affects legitimate content.
 * Uses obscenity's phrase IDs (the English preset's metadata key).
 */
const allowPhraseIds: string[] = [
  // e.g. 'ass' — often false-positive on 'class', 'assist', etc.
  // obscenity handles word boundaries well so these are rare; leave empty
  // until something actually misfires.
];

// Build a customized dataset once at module load
const dataset = englishDataset;
for (const id of allowPhraseIds) {
  dataset.removePhraseWithId(id);
}
for (const word of extraWords) {
  dataset.addPhrase((p) =>
    p.setMetadata({ originalWord: word }).addPattern(pattern`${word}`)
  );
}

const matcher = new RegExpMatcher({
  ...dataset.build(),
  ...englishRecommendedTransformers,
});

const censor = new TextCensor();

/**
 * Scrub profanity from a single string. Returns the string unchanged
 * if nothing matches, so callers don't need to diff.
 *
 * Also strips NUL (\u0000) bytes: Postgres JSON and TEXT columns reject
 * them outright (`unsupported Unicode escape sequence`), and JSONL rows
 * containing binary-file previews (ELF headers, images read by a tool,
 * etc.) will otherwise abort the whole upsert. Cheap to do here since
 * every string bound for the DB already passes through this function.
 */
export function redactString(input: string): string {
  if (!input) return input;
  const sanitized = stripNul(input);
  const matches = matcher.getAllMatches(sanitized);
  if (matches.length === 0) return sanitized;
  return censor.applyTo(sanitized, matches);
}

/**
 * Fields that hold identifiers, timestamps, signatures or encoded bytes,
 * never words. The English preset reads digits as letters ("455" as "ass",
 * "fCk" as a swear word), so scrubbing these corrupted UUIDs, timestamps
 * and the tool_use ids that pair each tool call with its result, and broke
 * base64 images. Skipping them is also most of redaction's cost: base64
 * image data alone was over a third of it.
 */
const MACHINE_KEYS = new Set([
  'uuid', 'parentUuid', 'leafUuid', 'sessionId', 'messageId', 'promptId',
  'requestId', 'agentId', 'id', 'tool_use_id', 'toolUseID',
  'sourceToolUseID', 'timestamp', 'signature', 'data', 'base64',
  'media_type', 'type', 'cwd', 'realParentDir', 'gitBranch', 'version',
  'model', 'slug', 'userType', 'stop_reason', 'entrypoint',
]);

/** A long run with no whitespace is an encoded blob or a hash, not prose. */
const BLOB = /^\S{200,}$/;

function stripNul(input: string): string {
  return input.includes('\u0000') ? input.replace(/\u0000/g, '') : input;
}

/**
 * Walk a parsed-JSON tree and redact every string leaf that holds words.
 * Returns a new tree — does NOT mutate the input.
 *
 * Used for the archived transcript. Scrubs user messages, assistant text
 * blocks, tool_result contents, and any other string field — we prefer
 * over-scrubbing to under-scrubbing here — except the machine fields above,
 * which only have NUL bytes stripped.
 */
export function redactTree(node: unknown, key?: string): unknown {
  if (typeof node === 'string') {
    if ((key && MACHINE_KEYS.has(key)) || BLOB.test(node)) return stripNul(node);
    return redactString(node);
  }
  if (Array.isArray(node)) {
    return node.map((v) => redactTree(v, key));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = redactTree(v, k);
    }
    return out;
  }
  return node;
}
