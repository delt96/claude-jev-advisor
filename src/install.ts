import path from 'node:path';
import { readConfig, updateConfig, type Display, type Lang } from './config.js';
import { applyStatusLineDisplay, withModDisplay, withoutModDisplay } from './display/settings.js';
import { HOOK_SPECS, HOOK_TIMEOUT_SECONDS, LEGACY_RM_GUARD, STATUSLINE_SCRIPT, SUPPORTED_PLATFORMS, ownScriptPattern, type Feature } from './features.js';
import { backupsDir, dataDir, settingsPath } from './paths.js';
import { backupSettingsFile, readSettingsFile, writeSettingsFile } from './settings-file.js';
import { commandMatches, findCommands, hookCommand, withHook, withoutCommands, type Settings } from './settings.js';

export type InstallOptions = {
  home: string;
  features: Feature[];
  distDir: string;
  platform: NodeJS.Platform;
  now: Date;
  lang?: Lang;
  keyFile?: string;
  display?: Display;
  delimiter?: string;
};

export type InstallResult = {
  settingsFile: string;
  backup: string | null;
  installed: Feature[];
  skipped: { feature: Feature; reason: string }[];
  replacedLegacyRmGuard: boolean;
  display: Display | null;
};

function withoutFeature(settings: Settings, feature: Feature): Settings {
  return HOOK_SPECS[feature].reduce((s, spec) => withoutCommands(s, ownScriptPattern(spec.script)), settings);
}

function withDisplay(settings: Settings, opts: { home: string; distDir: string; display: Display | null; delimiter: string }): Settings {
  let next = withoutModDisplay(settings, opts.delimiter);
  const statusLine = opts.display === 'statusline' ? hookCommand(path.join(opts.distDir, STATUSLINE_SCRIPT)) : null;
  next = applyStatusLineDisplay(next, opts.home, statusLine);
  if (opts.display === 'mod') next = withModDisplay(next, path.join(opts.distDir, '..', 'mod'), dataDir(opts.home), opts.delimiter);
  return next;
}

function save(home: string, settings: Settings, now: Date): string | null {
  const file = settingsPath(home);
  const backup = backupSettingsFile(file, backupsDir(home), now);
  writeSettingsFile(file, settings);
  return backup;
}

const same = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);

export function install(opts: InstallOptions): InstallResult {
  const delimiter = opts.delimiter ?? path.delimiter;
  const file = settingsPath(opts.home);
  const before = readSettingsFile(file);
  let next = before;
  const installed: Feature[] = [];
  const skipped: InstallResult['skipped'] = [];
  let replacedLegacyRmGuard = false;
  for (const feature of opts.features) {
    const platforms = SUPPORTED_PLATFORMS[feature];
    if (platforms && !platforms.includes(opts.platform)) {
      skipped.push({ feature, reason: `${feature} works on ${platforms.join(', ')} only` });
      continue;
    }
    for (const spec of HOOK_SPECS[feature]) {
      if (!commandMatches(hookCommand(path.join(opts.distDir, spec.script)), ownScriptPattern(spec.script))) {
        throw new Error(`cannot install from ${opts.distDir}: the hook path must contain claude-jev-advisor/dist/`);
      }
    }
    next = withoutFeature(next, feature);
    if (feature === 'rm' && findCommands(next, LEGACY_RM_GUARD).length) {
      next = withoutCommands(next, LEGACY_RM_GUARD);
      replacedLegacyRmGuard = true;
    }
    for (const spec of HOOK_SPECS[feature]) {
      const command = hookCommand(path.join(opts.distDir, spec.script), ...spec.args);
      next = withHook(next, { event: spec.event, matcher: spec.matcher, command, timeout: HOOK_TIMEOUT_SECONDS });
    }
    installed.push(feature);
  }
  const display = installed.includes('context') ? (opts.display ?? readConfig(opts.home).display) : null;
  if (display !== null) next = withDisplay(next, { home: opts.home, distDir: opts.distDir, display, delimiter });
  const backup = same(before, next) ? null : save(opts.home, next, opts.now);
  updateConfig(opts.home, (c) => ({
    ...c,
    lang: opts.lang ?? c.lang,
    keyFile: opts.keyFile ?? c.keyFile,
    display: opts.display ?? c.display,
    rm: installed.includes('rm') ? { ...c.rm, enabled: true } : c.rm,
    context: installed.includes('context') ? { ...c.context, enabled: true } : c.context,
  }));
  return { settingsFile: file, backup, installed, skipped, replacedLegacyRmGuard, display };
}

export function uninstall(opts: { home: string; features: Feature[]; now: Date; delimiter?: string }): { settingsFile: string; backup: string | null; removed: Feature[] } {
  const delimiter = opts.delimiter ?? path.delimiter;
  const file = settingsPath(opts.home);
  const before = readSettingsFile(file);
  let next = before;
  const removed: Feature[] = [];
  for (const feature of opts.features) {
    let after = withoutFeature(next, feature);
    if (feature === 'context') after = withDisplay(after, { home: opts.home, distDir: '', display: null, delimiter });
    if (!same(after, next)) removed.push(feature);
    next = after;
  }
  const backup = removed.length ? save(opts.home, next, opts.now) : null;
  return { settingsFile: file, backup, removed };
}

export function setEnabled(home: string, features: Feature[], enabled: boolean): void {
  updateConfig(home, (c) => ({
    ...c,
    rm: features.includes('rm') ? { ...c.rm, enabled } : c.rm,
    context: features.includes('context') ? { ...c.context, enabled } : c.context,
  }));
}
