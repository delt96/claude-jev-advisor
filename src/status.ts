import fs from 'node:fs';
import { readConfig } from './config.js';
import { FEATURES, HOOK_SPECS, LEGACY_RM_GUARD, ownScriptPattern } from './features.js';
import { configPath, settingsPath } from './paths.js';
import { readSettingsFile } from './settings-file.js';
import { findCommands, type Settings } from './settings.js';

const SCRIPT_IN_COMMAND = /^node "([^"]+)"/;

export function statusLines(home: string): string[] {
  const lines = [`settings: ${settingsPath(home)}`, `config:   ${configPath(home)}`];
  let settings: Settings;
  try {
    settings = readSettingsFile(settingsPath(home));
  } catch (err) {
    return [...lines, `settings.json could not be read: ${(err as Error).message}`];
  }
  const config = readConfig(home);
  for (const feature of FEATURES) {
    const state = config[feature].enabled ? 'on' : 'off';
    const commands = HOOK_SPECS[feature].flatMap((spec) => findCommands(settings, ownScriptPattern(spec.script)));
    if (!commands.length) {
      lines.push(`${feature}: not installed (${state})`);
      continue;
    }
    lines.push(`${feature}: installed, ${state}`);
    for (const c of commands) {
      const script = SCRIPT_IN_COMMAND.exec(c.command)?.[1];
      if (script && !fs.existsSync(script)) {
        lines.push(`  broken: ${c.event} hook points to a missing file (${script}) - run "claude-jev-advisor install ${feature}" again, or "claude-jev-advisor uninstall ${feature}"`);
      }
    }
  }
  if (findCommands(settings, LEGACY_RM_GUARD).length) {
    lines.push('legacy rm-guard hook (~/.claude/hooks/rm-guard) is still registered - "claude-jev-advisor install rm" replaces it');
  }
  return lines;
}
