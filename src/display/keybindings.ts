import fs from 'node:fs';
import { backupsDir, keybindingsPath } from '../paths.js';
import { backupSettingsFile, readSettingsFile, writeSettingsFile } from '../settings-file.js';
import { SHORTCUT_ACTION, SHORTCUT_CHORD, SHORTCUT_CONTEXT } from './shortcut.js';

export const KEYBINDINGS_SCHEMA = 'https://www.schemastore.org/claude-code-keybindings.json';
export const KEYBINDINGS_DOCS = 'https://code.claude.com/docs/en/keybindings';

export type Keybindings = { bindings: unknown[]; [key: string]: unknown };
export type ShortcutInstall = { shortcut: string | null; takenBy: string | null; problem: string | null; backup: string | null };
export type ShortcutState = 'present' | 'absent' | 'unreadable';
type Block = { context: string; bindings: Record<string, unknown>; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlock(value: unknown): value is Block {
  return isRecord(value) && typeof value.context === 'string' && isRecord(value.bindings);
}

// A user binding spelled another way may still be the same chord to Claude Code, so every spelling counts as taken.
export function normalizeChord(chord: string): string {
  return chord
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((stroke) => stroke.split('+').map((key) => (key === 'control' ? 'ctrl' : key)).join('+'))
    .join(' ');
}

function chordKeys(block: Block): string[] {
  const target = normalizeChord(SHORTCUT_CHORD);
  return Object.keys(block.bindings).filter((key) => normalizeChord(key) === target);
}

function isOurs(block: Block, key: string): boolean {
  return block.context === SHORTCUT_CONTEXT && block.bindings[key] === SHORTCUT_ACTION;
}

export function parseKeybindings(raw: unknown): Keybindings | null {
  return isRecord(raw) && Array.isArray(raw.bindings) ? (raw as Keybindings) : null;
}

export function newKeybindings(): Keybindings {
  return { $schema: KEYBINDINGS_SCHEMA, $docs: KEYBINDINGS_DOCS, bindings: [] };
}

export function hasShortcut(kb: Keybindings): boolean {
  return kb.bindings.some((b) => isBlock(b) && chordKeys(b).some((key) => isOurs(b, key)));
}

export function shortcutTakenBy(kb: Keybindings): string | null {
  for (const b of kb.bindings) {
    if (!isBlock(b)) continue;
    for (const key of chordKeys(b)) {
      if (!isOurs(b, key)) return `${b.context}: ${String(b.bindings[key])}`;
    }
  }
  return null;
}

export function withShortcut(kb: Keybindings): Keybindings {
  if (hasShortcut(kb)) return kb;
  const bindings = [...kb.bindings];
  const at = bindings.findIndex((b) => isBlock(b) && b.context === SHORTCUT_CONTEXT);
  if (at === -1) {
    bindings.push({ context: SHORTCUT_CONTEXT, bindings: { [SHORTCUT_CHORD]: SHORTCUT_ACTION } });
  } else {
    const block = bindings[at] as Block;
    bindings[at] = { ...block, bindings: { ...block.bindings, [SHORTCUT_CHORD]: SHORTCUT_ACTION } };
  }
  return { ...kb, bindings };
}

export function withoutShortcut(kb: Keybindings): Keybindings {
  if (!hasShortcut(kb)) return kb;
  const bindings: unknown[] = [];
  for (const b of kb.bindings) {
    if (!isBlock(b)) {
      bindings.push(b);
      continue;
    }
    const keys = chordKeys(b).filter((key) => isOurs(b, key));
    if (!keys.length) {
      bindings.push(b);
      continue;
    }
    const rest = { ...b.bindings };
    for (const key of keys) delete rest[key];
    if (Object.keys(rest).length) bindings.push({ ...b, bindings: rest });
  }
  return { ...kb, bindings };
}

function readKeybindings(file: string): Keybindings | null | 'missing' {
  if (!fs.existsSync(file)) return 'missing';
  return parseKeybindings(readSettingsFile(file));
}

export function installShortcut(home: string, now: Date): ShortcutInstall {
  const none = (takenBy: string | null, problem: string | null): ShortcutInstall => ({ shortcut: null, takenBy, problem, backup: null });
  const file = keybindingsPath(home);
  try {
    const read = readKeybindings(file);
    if (read === null) return none(null, 'it holds no "bindings" list');
    const kb = read === 'missing' ? newKeybindings() : read;
    const takenBy = shortcutTakenBy(kb);
    if (takenBy) return none(takenBy, null);
    if (hasShortcut(kb)) return { shortcut: SHORTCUT_CHORD, takenBy: null, problem: null, backup: null };
    const backup = backupSettingsFile(file, backupsDir(home), now);
    writeSettingsFile(file, withShortcut(kb));
    return { shortcut: SHORTCUT_CHORD, takenBy: null, problem: null, backup };
  } catch (err) {
    return none(null, (err as Error).message);
  }
}

export function removeShortcut(home: string, now: Date): { removed: boolean; backup: string | null } {
  const file = keybindingsPath(home);
  try {
    const read = readKeybindings(file);
    if (read === 'missing' || read === null || !hasShortcut(read)) return { removed: false, backup: null };
    const backup = backupSettingsFile(file, backupsDir(home), now);
    writeSettingsFile(file, withoutShortcut(read));
    return { removed: true, backup };
  } catch {
    return { removed: false, backup: null };
  }
}

export function shortcutTakenInFile(home: string): string | null {
  try {
    const read = readKeybindings(keybindingsPath(home));
    return read === null || read === 'missing' ? null : shortcutTakenBy(read);
  } catch {
    return null;
  }
}

export function shortcutState(home: string): ShortcutState {
  try {
    const read = readKeybindings(keybindingsPath(home));
    if (read === null) return 'unreadable';
    return read !== 'missing' && hasShortcut(read) ? 'present' : 'absent';
  } catch {
    return 'unreadable';
  }
}
