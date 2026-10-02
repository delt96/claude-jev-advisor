import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupName, backupSettingsFile, readSettingsFile, writeSettingsFile } from '../src/settings-file.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-settings-'));

test('a missing settings file reads as an empty object', () => {
  assert.deepEqual(readSettingsFile(path.join(tempDir(), 'nope', 'settings.json')), {});
});

test('a settings file with a UTF-8 BOM is read', () => {
  const file = path.join(tempDir(), 'settings.json');
  fs.writeFileSync(file, '\uFEFF{"theme": "dark"}');
  assert.deepEqual(readSettingsFile(file), { theme: 'dark' });
});

test('invalid JSON or a non-object throws', () => {
  const file = path.join(tempDir(), 'settings.json');
  fs.writeFileSync(file, '{"theme": ');
  assert.throws(() => readSettingsFile(file));
  fs.writeFileSync(file, '[1, 2]');
  assert.throws(() => readSettingsFile(file), /JSON object/);
});

test('backupName stamps the local date and time', () => {
  assert.equal(backupName(new Date(2026, 9, 2, 9, 5, 7)), 'settings.json.2026-10-02-090507-before-claude-jev-advisor');
});

test('backupSettingsFile copies the file and returns null when there is nothing to copy', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const backups = path.join(dir, 'backups');
  assert.equal(backupSettingsFile(file, backups, new Date(2026, 9, 2, 9, 5, 7)), null);
  fs.writeFileSync(file, '{"a": 1}');
  const copy = backupSettingsFile(file, backups, new Date(2026, 9, 2, 9, 5, 7));
  assert.equal(copy, path.join(backups, 'settings.json.2026-10-02-090507-before-claude-jev-advisor'));
  assert.equal(fs.readFileSync(copy!, 'utf8'), '{"a": 1}');
});

test('a second backup in the same second keeps the first', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const backups = path.join(dir, 'backups');
  const now = new Date(2026, 9, 2, 9, 5, 7);
  fs.writeFileSync(file, '{"a": 1}');
  const first = backupSettingsFile(file, backups, now);
  fs.writeFileSync(file, '{"a": 2}');
  const second = backupSettingsFile(file, backups, now);
  assert.equal(second, `${first}-2`);
  assert.equal(fs.readFileSync(first!, 'utf8'), '{"a": 1}');
  assert.equal(fs.readFileSync(second!, 'utf8'), '{"a": 2}');
});

test('writeSettingsFile creates the folder and writes two-space JSON with a newline', () => {
  const file = path.join(tempDir(), 'new', 'settings.json');
  writeSettingsFile(file, { theme: 'dark', hooks: {} });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "theme": "dark",\n  "hooks": {}\n}\n');
  assert.equal(fs.existsSync(`${file}.claude-jev-advisor.tmp`), false);
});

test('a failed rename leaves no temp file and the original content', { skip: process.platform !== 'win32' && 'renaming over a read-only file fails only on Windows' }, () => {
  const file = path.join(tempDir(), 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  fs.chmodSync(file, 0o444);
  try {
    assert.throws(() => writeSettingsFile(file, { b: 2 }));
    assert.equal(fs.existsSync(`${file}.claude-jev-advisor.tmp`), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  } finally {
    fs.chmodSync(file, 0o666);
  }
});
