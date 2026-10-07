import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from './settings.js';

export function readSettingsFile(file: string): Settings {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object`);
  return parsed as Settings;
}

export function backupName(now: Date, fileName = 'settings.json'): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${fileName}.${stamp}-before-claude-jev-advisor`;
}

export function backupSettingsFile(file: string, dir: string, now: Date): string | null {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const baseName = backupName(now, path.basename(file));
  let target = path.join(dir, baseName);
  let suffix = 2;
  while (true) {
    try {
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        target = path.join(dir, `${baseName}-${suffix}`);
        suffix++;
      } else {
        throw err;
      }
    }
  }
}

export function writeSettingsFile(file: string, settings: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.claude-jev-advisor.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw err;
  }
}
