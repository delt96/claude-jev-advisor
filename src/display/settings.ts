import fs from 'node:fs';
import path from 'node:path';
import { MOD_DIR_PATTERN, MOD_PLUGIN_NAME, STATUSLINE_SCRIPT, ownScriptPattern } from '../features.js';
import { statusLineBeforePath } from '../paths.js';
import { commandMatches, type Settings } from '../settings.js';

export const PLUGIN_DIRS_ENV = 'CLAUDE_CODE_PLUGIN_DIRS';
export const STATUSLINE_REFRESH_SECONDS = 3;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const forwardSlashes = (text: string) => text.replace(/\\/g, '/');

function withoutKey(settings: Settings, key: string): Settings {
  const { [key]: _removed, ...rest } = settings;
  return rest;
}

export function withoutModDisplay(settings: Settings, delimiter: string): Settings {
  let next = settings;
  const env = isRecord(settings.env) ? settings.env : null;
  const dirs = env?.[PLUGIN_DIRS_ENV];
  if (env && typeof dirs === 'string') {
    const all = dirs.split(delimiter);
    const kept = all.filter((dir) => !MOD_DIR_PATTERN.test(forwardSlashes(dir)));
    if (kept.length !== all.length) {
      const { [PLUGIN_DIRS_ENV]: _ours, ...otherEnv } = env;
      const nextEnv = kept.length ? { ...env, [PLUGIN_DIRS_ENV]: kept.join(delimiter) } : otherEnv;
      next = Object.keys(nextEnv).length ? { ...next, env: nextEnv } : withoutKey(next, 'env');
    }
  }
  const configs = isRecord(next.pluginConfigs) ? next.pluginConfigs : null;
  if (configs && MOD_PLUGIN_NAME in configs) {
    const { [MOD_PLUGIN_NAME]: _ours, ...others } = configs;
    next = Object.keys(others).length ? { ...next, pluginConfigs: others } : withoutKey(next, 'pluginConfigs');
  }
  return next;
}

export function withModDisplay(settings: Settings, modDir: string, dataDirPath: string, delimiter: string): Settings {
  const base = withoutModDisplay(settings, delimiter);
  const env = isRecord(base.env) ? base.env : {};
  const dirs = typeof env[PLUGIN_DIRS_ENV] === 'string' && env[PLUGIN_DIRS_ENV] !== '' ? `${env[PLUGIN_DIRS_ENV]}${delimiter}` : '';
  const configs = isRecord(base.pluginConfigs) ? base.pluginConfigs : {};
  return {
    ...base,
    env: { ...env, [PLUGIN_DIRS_ENV]: `${dirs}${forwardSlashes(modDir)}` },
    pluginConfigs: { ...configs, [MOD_PLUGIN_NAME]: { options: { dataDir: forwardSlashes(dataDirPath) } } },
  };
}

export function isOurStatusLine(value: unknown): boolean {
  return isRecord(value) && typeof value.command === 'string' && commandMatches(value.command, ownScriptPattern(STATUSLINE_SCRIPT));
}

export function readStatusLineBefore(home: string): Json | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(statusLineBeforePath(home), 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStatusLineBefore(home: string, value: Json | null): void {
  const file = statusLineBeforePath(home);
  if (!value) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function applyStatusLineDisplay(settings: Settings, home: string, command: string | null): Settings {
  const current = settings.statusLine;
  const ours = isOurStatusLine(current);
  const userLine = ours ? readStatusLineBefore(home) : isRecord(current) ? current : null;
  if (command !== null) {
    writeStatusLineBefore(home, userLine);
    return { ...settings, statusLine: { type: 'command', command, refreshInterval: STATUSLINE_REFRESH_SECONDS } };
  }
  if (!ours) return settings;
  writeStatusLineBefore(home, null);
  return userLine ? { ...settings, statusLine: userLine } : withoutKey(settings, 'statusLine');
}
