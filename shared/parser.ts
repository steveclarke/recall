/**
 * Parse Claude Code session JSONL files
 *
 * Extracts structured data from raw session transcripts including:
 * - Token usage (total and per-model)
 * - User messages
 * - Tools used
 * - Files touched (from tool calls)
 * - Timestamps
 *
 * Parsing is incremental: a SessionAccumulator folds one JSONL line at a
 * time into running totals, and can be seeded with the totals already
 * stored for a session. The sync reads only the bytes appended since its
 * last run and adds them to what the database already holds, so a growing
 * transcript is never parsed twice and never held in memory whole.
 */

import { readFileSync } from 'fs';
import type {
  SessionMessage,
  AssistantMessage,
  ParsedSession,
  SessionAggregates,
  ContentBlock,
} from './types.js';

/**
 * Line types left out of the archive. Claude Code logs every API request
 * it sends (`api-request`, `api-request-blob`, `api-request-shape`): each
 * is a copy of the conversation so far, so together they are most of a
 * long session's bytes (69% of a 1.39 GB coordinator transcript, 41% of
 * the Mac Studio's whole corpus) while holding nothing the conversation
 * lines do not. `type` is the first key Claude Code writes, so these lines
 * are recognised by their first bytes and never parsed.
 */
const SKIPPED_LINE_PREFIX = '{"type":"api-request';

export function isSkippedLine(line: string): boolean {
  return line.startsWith(SKIPPED_LINE_PREFIX);
}

/**
 * Stream complete lines from a file, starting at a byte offset.
 *
 * Yields each line with the absolute byte offset just past its newline, so
 * the caller can checkpoint exactly where it stopped. A last line with no
 * newline yet (Claude Code mid-write) is held back for the next run. Memory
 * stays at one read buffer plus the longest line.
 */
export async function* readLines(
  filePath: string,
  start = 0
): AsyncGenerator<{ line: string; end: number }> {
  let carry = Buffer.alloc(0);
  let base = start; // absolute offset of carry[0]
  for await (const chunk of Bun.file(filePath).slice(start).stream()) {
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const buf = carry.length ? Buffer.concat([carry, view]) : view;
    let lineStart = 0;
    let newline: number;
    while ((newline = buf.indexOf(10, lineStart)) !== -1) {
      if (newline > lineStart) {
        yield {
          line: buf.toString('utf8', lineStart, newline),
          end: base + newline + 1,
        };
      }
      lineStart = newline + 1;
    }
    // Copy the remainder: the stream may reuse the chunk's memory.
    carry = Buffer.from(buf.subarray(lineStart));
    base += lineStart;
  }
}

export function emptyAggregates(): SessionAggregates {
  return {
    startedAt: null,
    endedAt: null,
    gitBranch: 'unknown',
    cwd: '',
    version: '',
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    userMessages: [],
    toolsUsed: [],
    filesFromToolCalls: [],
    modelsUsed: [],
    modelTokens: {},
  };
}

/**
 * Folds parsed JSONL lines into session totals.
 */
export class SessionAccumulator {
  private totals: SessionAggregates;
  private toolsUsed: Set<string>;
  private files: Set<string>;
  private models: Set<string>;

  constructor(seed: SessionAggregates = emptyAggregates()) {
    this.totals = structuredClone(seed);
    this.toolsUsed = new Set(seed.toolsUsed);
    this.files = new Set(seed.filesFromToolCalls);
    this.models = new Set(seed.modelsUsed);
  }

  /**
   * Add one parsed line. Metadata extraction only looks at user/assistant
   * conversation turns. `userMessage` is passed through `cleanText` before
   * it is kept, so callers can redact on the way in.
   */
  add(
    parsed: { type?: string },
    cleanText: (text: string) => string = (text) => text
  ): void {
    if (parsed.type !== 'user' && parsed.type !== 'assistant') return;
    const msg = parsed as SessionMessage;
    const t = this.totals;

    if (t.messageCount === 0) {
      t.startedAt = msg.timestamp;
      t.gitBranch = msg.gitBranch || 'unknown';
      t.cwd = msg.cwd || '';
      t.version = msg.version || '';
    }
    t.messageCount++;
    t.endedAt = msg.timestamp;

    if (msg.type === 'user') {
      // isMeta turns are injected by Claude Code (skill bodies, command
      // caveats), not typed by anyone; they would drown the search text.
      if ((parsed as { isMeta?: boolean }).isMeta) return;
      const text = userText(msg.message as { content: unknown });
      if (text) t.userMessages.push(cleanText(text));
      return;
    }

    const assistantMsg = msg.message as AssistantMessage;
    const model = assistantMsg.model;
    if (model) {
      this.models.add(model);
      t.modelTokens[model] ??= { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    }

    const usage = assistantMsg.usage;
    if (usage) {
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheCreation = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      t.inputTokens += input;
      t.outputTokens += output;
      t.cacheCreationTokens += cacheCreation;
      t.cacheReadTokens += cacheRead;
      if (model) {
        const m = t.modelTokens[model];
        m.input += input;
        m.output += output;
        m.cacheCreation += cacheCreation;
        m.cacheRead += cacheRead;
      }
    }

    if (Array.isArray(assistantMsg.content)) {
      for (const block of assistantMsg.content) {
        extractFromContentBlock(block, this.toolsUsed, this.files);
      }
    }
  }

  get hasConversation(): boolean {
    return this.totals.messageCount > 0;
  }

  result(): SessionAggregates {
    return {
      ...this.totals,
      toolsUsed: Array.from(this.toolsUsed),
      filesFromToolCalls: Array.from(this.files),
      modelsUsed: Array.from(this.models),
    };
  }
}

/**
 * The text a person typed. A plain prompt is a string; a prompt sent with
 * an image or a long paste is an array of blocks, whose text blocks count.
 * Tool results also arrive as user turns and are not something anyone typed.
 */
function userText(message: { content: unknown }): string | null {
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim() ? content : null;
  }
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === 'tool_result')) return null;
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  return text.trim() ? text : null;
}

/**
 * Parse a single JSONL file into structured session data
 */
export function parseSessionFile(filePath: string): ParsedSession | null {
  const content = readFileSync(filePath, 'utf-8');
  return parseSessionContent(content, filePath);
}

/**
 * Parse JSONL content string into structured session data
 */
export function parseSessionContent(
  content: string,
  sessionId?: string
): ParsedSession | null {
  const acc = new SessionAccumulator();
  let firstSessionId: string | undefined;

  for (const line of content.split('\n')) {
    if (!line || isSkippedLine(line)) continue;
    try {
      const parsed = JSON.parse(line);
      firstSessionId ??= parsed.sessionId;
      acc.add(parsed);
    } catch {
      // Skip malformed lines
    }
  }

  if (!acc.hasConversation) return null;

  // Derive session ID from file path or first message
  const totals = acc.result();
  return {
    ...totals,
    id: sessionIdFromPath(sessionId ?? '') || firstSessionId || 'unknown',
    startedAt: new Date(totals.startedAt!),
    endedAt: new Date(totals.endedAt!),
  };
}

export function sessionIdFromPath(filePath: string): string | undefined {
  return filePath.match(/([a-f0-9-]{36})\.jsonl$/)?.[1];
}

/**
 * Extract tool names and file paths from a content block
 */
function extractFromContentBlock(
  block: ContentBlock,
  toolsUsed: Set<string>,
  filesFromToolCalls: Set<string>
): void {
  if (block.type === 'tool_use' && block.name) {
    toolsUsed.add(block.name);

    // Extract file paths from tool inputs
    if (block.input) {
      extractFilePaths(block.input, filesFromToolCalls);
    }
  }
}

/**
 * Recursively extract file paths from tool input
 */
function extractFilePaths(
  input: Record<string, unknown>,
  files: Set<string>
): void {
  for (const [key, value] of Object.entries(input)) {
    // Common file path parameter names
    if (
      ['file_path', 'path', 'file', 'filename', 'filePath'].includes(key) &&
      typeof value === 'string'
    ) {
      // Only add if it looks like a path
      if (value.includes('/') || value.includes('\\')) {
        files.add(value);
      }
    }

    // Recurse into nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      extractFilePaths(value as Record<string, unknown>, files);
    }
  }
}

/**
 * Get a simple text summary suitable for search indexing
 */
export function getSearchableText(session: ParsedSession): string {
  const parts: string[] = [];

  // User messages are highest signal
  parts.push(...session.userMessages);

  // Tools and files provide context
  parts.push(...session.toolsUsed);
  parts.push(...session.filesFromToolCalls);

  return parts.join(' ');
}
