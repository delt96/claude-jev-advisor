import fs from 'node:fs';

export type Entry = Record<string, unknown>;
export type TranscriptFacts = { size: number | null; requests: string[]; replySeen: boolean };

export const TAIL_START_BYTES = 1024 * 1024;
export const TAIL_MAX_BYTES = 8 * 1024 * 1024;
export const REQUEST_COUNT = 3;
export const REQUEST_MAX_CHARS = 1000;

const REQUEST_ORIGINS = new Set(['human', 'channel', 'peer']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLines(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) entries.push(value);
    } catch {}
  }
  return entries;
}

export function readTail(file: string, bytes: number): { entries: Entry[]; whole: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    return { entries: parseLines(text), whole: length === size };
  } finally {
    fs.closeSync(fd);
  }
}

export function contextSize(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return 0;
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message)) continue;
    const { model, usage } = entry.message;
    if (model === '<synthetic>' || !isRecord(usage)) continue;
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    return count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
  }
  return null;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function isRequest(entry: Entry): boolean {
  return entry.type === 'user' && entry.isSidechain !== true && isRecord(entry.origin) && REQUEST_ORIGINS.has(String(entry.origin.kind));
}

export function requestText(entry: Entry): string {
  return messageText(isRecord(entry.message) ? entry.message.content : undefined).trim();
}

export function recentRequests(entries: Entry[], count = REQUEST_COUNT, maxChars = REQUEST_MAX_CHARS): string[] {
  const found: string[] = [];
  for (let i = entries.length - 1; i >= 0 && found.length < count; i--) {
    if (!isRequest(entries[i])) continue;
    const text = requestText(entries[i]);
    if (text) found.push(text.slice(0, maxChars));
  }
  return found.reverse();
}

export function replyWritten(entries: Entry[], reply: string): boolean {
  const wanted = reply.trim();
  if (!wanted) return true;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRequest(entry)) return false;
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message)) continue;
    // Each text block of a reply is its own entry, and the hook gets the blocks joined: the last block is enough.
    const text = messageText(entry.message.content).trim();
    if (text && wanted.endsWith(text)) return true;
  }
  return false;
}

export function readTranscript(file: string, reply = '', limits = { start: TAIL_START_BYTES, max: TAIL_MAX_BYTES }): TranscriptFacts {
  for (let bytes = limits.start; ; bytes *= 2) {
    const { entries, whole } = readTail(file, Math.min(bytes, limits.max));
    const size = contextSize(entries);
    const requests = recentRequests(entries);
    if ((size !== null && requests.length >= REQUEST_COUNT) || whole || bytes >= limits.max) {
      return { size, requests, replySeen: replyWritten(entries, reply) };
    }
  }
}
