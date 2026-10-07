import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasShortcut, installShortcut, newKeybindings, normalizeChord, removeShortcut, shortcutState, shortcutTakenBy, withShortcut, withoutShortcut, type Keybindings } from '../src/display/keybindings.js';
import { backupsDir, keybindingsPath } from '../src/paths.js';

const NOW = new Date(2026, 9, 7, 10, 0, 0);
const OURS = { context: 'DiffDialog', bindings: { 'ctrl+x ctrl+f': 'diff:back' } };
const CHAT = { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } };
const kb = (...bindings: unknown[]): Keybindings => ({ $schema: 'x', bindings });
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-kb-'));
function writeKb(home: string, text: string) {
  fs.mkdirSync(path.dirname(keybindingsPath(home)), { recursive: true });
  fs.writeFileSync(keybindingsPath(home), text);
}
const readKb = (home: string) => JSON.parse(fs.readFileSync(keybindingsPath(home), 'utf8'));

test('normalizeChord reads case, spacing and control as one chord', () => {
  assert.equal(normalizeChord('Ctrl+X Ctrl+F'), 'ctrl+x ctrl+f');
  assert.equal(normalizeChord(' control+x   control+f '), 'ctrl+x ctrl+f');
});

test('withShortcut adds our binding in a new DiffDialog block or beside the user ones, once', () => {
  assert.deepEqual(withShortcut(kb(CHAT)).bindings, [CHAT, OURS]);
  const diff = { context: 'DiffDialog', bindings: { left: 'diff:previousSource' } };
  assert.deepEqual(withShortcut(kb(diff)).bindings, [{ context: 'DiffDialog', bindings: { left: 'diff:previousSource', 'ctrl+x ctrl+f': 'diff:back' } }]);
  const once = withShortcut(kb(CHAT));
  assert.equal(withShortcut(once), once);
});

test('the chord bound to anything else, in any block or spelling, is taken', () => {
  assert.equal(shortcutTakenBy(kb(CHAT)), null);
  assert.equal(shortcutTakenBy(kb(OURS)), null);
  assert.equal(shortcutTakenBy(kb({ context: 'Chat', bindings: { 'Ctrl+X Ctrl+F': 'chat:stash' } })), 'Chat: chat:stash');
  assert.equal(shortcutTakenBy(kb({ context: 'DiffDialog', bindings: { 'ctrl+x ctrl+f': 'diff:dismiss' } })), 'DiffDialog: diff:dismiss');
  assert.equal(shortcutTakenBy(kb({ context: 'Global', bindings: { 'ctrl+x ctrl+f': null } })), 'Global: null');
});

test('withoutShortcut takes out only our binding and a DiffDialog block it emptied', () => {
  assert.deepEqual(withoutShortcut(kb(CHAT, OURS)).bindings, [CHAT]);
  const shared = { context: 'DiffDialog', bindings: { left: 'diff:previousSource', 'ctrl+x ctrl+f': 'diff:back' } };
  assert.deepEqual(withoutShortcut(kb(shared)).bindings, [{ context: 'DiffDialog', bindings: { left: 'diff:previousSource' } }]);
  const changed = kb({ context: 'DiffDialog', bindings: { 'ctrl+x ctrl+f': 'diff:dismiss' } });
  assert.equal(withoutShortcut(changed), changed);
});

test('installShortcut creates keybindings.json with the schema and the docs link when there is none', () => {
  const home = tempHome();
  assert.deepEqual(installShortcut(home, NOW), { shortcut: 'ctrl+x ctrl+f', takenBy: null, problem: null, backup: null });
  assert.deepEqual(readKb(home), { ...newKeybindings(), bindings: [OURS] });
});

test('installShortcut backs up an existing file, keeps its entries, and changes nothing the second time', () => {
  const home = tempHome();
  const original = JSON.stringify({ bindings: [CHAT] }, null, 2);
  writeKb(home, original);
  const first = installShortcut(home, NOW);
  assert.equal(first.backup, path.join(backupsDir(home), 'keybindings.json.2026-10-07-100000-before-claude-jev-advisor'));
  assert.equal(fs.readFileSync(first.backup as string, 'utf8'), original);
  assert.deepEqual(readKb(home), { bindings: [CHAT, OURS] });
  assert.deepEqual(installShortcut(home, NOW), { shortcut: 'ctrl+x ctrl+f', takenBy: null, problem: null, backup: null });
});

test('installShortcut leaves a taken chord and a file it cannot use exactly as they were', () => {
  const texts = [JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+x ctrl+f': 'chat:stash' } }] }), '{ not json', '{"bindings": {}}', '[]'];
  for (const text of texts) {
    const home = tempHome();
    writeKb(home, text);
    const r = installShortcut(home, NOW);
    assert.equal(r.shortcut, null, text);
    assert.equal(r.backup, null, text);
    assert.ok(r.takenBy || r.problem, text);
    assert.equal(fs.readFileSync(keybindingsPath(home), 'utf8'), text);
    assert.equal(fs.existsSync(backupsDir(home)), false, text);
  }
});

test('removeShortcut takes out our binding after a backup, and leaves anything else alone', () => {
  const home = tempHome();
  writeKb(home, JSON.stringify({ bindings: [CHAT, OURS] }));
  const r = removeShortcut(home, NOW);
  assert.equal(r.removed, true);
  assert.ok(r.backup);
  assert.deepEqual(readKb(home), { bindings: [CHAT] });
  assert.deepEqual(removeShortcut(home, NOW), { removed: false, backup: null });
  assert.deepEqual(removeShortcut(tempHome(), NOW), { removed: false, backup: null });
  const broken = tempHome();
  writeKb(broken, '{ not json');
  assert.deepEqual(removeShortcut(broken, NOW), { removed: false, backup: null });
});

test('shortcutState tells present, absent and unreadable apart', () => {
  const home = tempHome();
  assert.equal(shortcutState(home), 'absent');
  installShortcut(home, NOW);
  assert.equal(shortcutState(home), 'present');
  writeKb(home, '{ not json');
  assert.equal(shortcutState(home), 'unreadable');
});

test('equivalent keys report the first conflicting action even beside our binding', () => {
  assert.equal(shortcutTakenBy(kb({ context: 'DiffDialog', bindings: { 'ctrl+x ctrl+f': 'diff:back', 'Ctrl+X Ctrl+F': 'diff:dismiss', 'control+x ctrl+f': null } })), 'DiffDialog: diff:dismiss');
});

test('installShortcut skips a conflicting block even when our binding is installed', () => {
  const home = tempHome();
  const text = JSON.stringify({ bindings: [OURS, { context: 'Chat', bindings: { 'ctrl+x ctrl+f': 'chat:stash' } }] }, null, 2);
  writeKb(home, text);
  assert.deepEqual(installShortcut(home, NOW), { shortcut: null, takenBy: 'Chat: chat:stash', problem: null, backup: null });
  assert.equal(fs.readFileSync(keybindingsPath(home), 'utf8'), text);
  assert.equal(fs.existsSync(backupsDir(home)), false);
});

test('withoutShortcut preserves equivalent keys assigned to other actions', () => {
  assert.deepEqual(withoutShortcut(kb({ context: 'DiffDialog', bindings: { 'ctrl+x ctrl+f': 'diff:back', 'Ctrl+X Ctrl+F': 'diff:dismiss' } })).bindings, [{ context: 'DiffDialog', bindings: { 'Ctrl+X Ctrl+F': 'diff:dismiss' } }]);
  assert.deepEqual(withoutShortcut(kb({ context: 'DiffDialog', bindings: { 'Ctrl+X Ctrl+F': 'diff:dismiss', 'ctrl+x ctrl+f': 'diff:back', 'control+x ctrl+f': 'diff:back' } })).bindings, [{ context: 'DiffDialog', bindings: { 'Ctrl+X Ctrl+F': 'diff:dismiss' } }]);
});

test('hasShortcut finds our action after an equivalent conflicting key', () => {
  assert.equal(hasShortcut(kb({ context: 'DiffDialog', bindings: { 'Ctrl+X Ctrl+F': 'diff:dismiss', 'ctrl+x ctrl+f': 'diff:back' } })), true);
});
