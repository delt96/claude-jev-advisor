import fs from 'node:fs';
import path from 'node:path';
import { parseLines } from './context/transcript.js';
import { logDir } from './paths.js';

export type LogRecord = Record<string, unknown>;

function monthFiles(home: string, since: Date, now: Date): string[] {
  const files: string[] = [];
  for (let d = new Date(since.getFullYear(), since.getMonth(), 1); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    files.push(path.join(logDir(home), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`));
  }
  return files;
}

export function readLogRecords(home: string, since: Date, now: Date): LogRecord[] {
  const records: LogRecord[] = [];
  for (const file of monthFiles(home, since, now)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const record of parseLines(text)) {
      const at = typeof record.at === 'string' ? Date.parse(record.at) : NaN;
      if (at >= since.getTime() && at <= now.getTime()) records.push(record);
    }
  }
  return records;
}
