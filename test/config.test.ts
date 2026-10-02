import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, readConfig, updateConfig, writeConfig, type Config } from '../src/config.js';
import { configPath, dataDir, settingsPath } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-home-'));

function writeRaw(home: string, text: string) {
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), text);
}

test('paths live under ~/.claude', () => {
  const home = path.join('C:', 'Users', 'me');
  assert.equal(dataDir(home), path.join(home, '.claude', 'claude-jev-advisor'));
  assert.equal(configPath(home), path.join(home, '.claude', 'claude-jev-advisor', 'config.json'));
  assert.equal(settingsPath(home), path.join(home, '.claude', 'settings.json'));
});

test('a missing config file reads as the defaults', () => {
  assert.deepEqual(readConfig(tempHome()), DEFAULT_CONFIG);
});

test('the defaults match the spec', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    lang: 'ko',
    keyFile: null,
    display: 'mod',
    context: { enabled: true, minTokens: 100000, compactMinTokens: 200000, redRemainingPct: 20, unitDoneYes: 0.7, goalDoneYes: 0.8 },
    rm: { enabled: true, jev: true, throwawayYes: 0.8, maxDirFiles: 50 },
  });
});

test('a written config reads back the same', () => {
  const home = tempHome();
  const config: Config = { ...DEFAULT_CONFIG, lang: 'en', keyFile: 'C:/k.env', rm: { ...DEFAULT_CONFIG.rm, enabled: false } };
  writeConfig(home, config);
  assert.deepEqual(readConfig(home), config);
});

test('fields with the wrong type or an unknown value fall back one by one', () => {
  const home = tempHome();
  writeRaw(home, JSON.stringify({ lang: 'fr', display: 42, keyFile: '', rm: { enabled: 'no', maxDirFiles: 10 }, extra: true }));
  const config = readConfig(home);
  assert.equal(config.lang, 'ko');
  assert.equal(config.display, 'mod');
  assert.equal(config.keyFile, null);
  assert.equal(config.rm.enabled, true);
  assert.equal(config.rm.maxDirFiles, 10);
  assert.equal('extra' in config, false);
});

test('a broken config file reads as the defaults and a BOM is ignored', () => {
  const home = tempHome();
  writeRaw(home, '{"lang": "en"');
  assert.deepEqual(readConfig(home), DEFAULT_CONFIG);
  writeRaw(home, '\uFEFF{"lang": "en"}');
  assert.equal(readConfig(home).lang, 'en');
});

test('updateConfig saves the changed config', () => {
  const home = tempHome();
  const next = updateConfig(home, (c) => ({ ...c, rm: { ...c.rm, enabled: false } }));
  assert.equal(next.rm.enabled, false);
  assert.equal(readConfig(home).rm.enabled, false);
});
