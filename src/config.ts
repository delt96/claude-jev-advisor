import fs from 'node:fs';
import path from 'node:path';
import { configToSave, normalizeConfig, type Config } from './config-shape.js';
import { configPath } from './paths.js';

export * from './config-shape.js';

export function readConfig(home: string): Config {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(home), 'utf8').replace(/^\uFEFF/, '')));
  } catch {
    return normalizeConfig({});
  }
}

export function writeConfig(home: string, config: Config): void {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(configToSave(config), null, 2)}\n`);
}

export function updateConfig(home: string, change: (config: Config) => Config): Config {
  const next = change(readConfig(home));
  writeConfig(home, next);
  return next;
}
