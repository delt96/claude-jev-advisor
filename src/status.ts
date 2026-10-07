import fs from 'node:fs';
import path from 'node:path';
import { readConfig, type Config } from './config.js';
import { shortcutState } from './display/keybindings.js';
import { adviceLine, formatSize, parseState, type ContextState } from './display/line.js';
import { PLUGIN_DIRS_ENV, isOurStatusLine } from './display/settings.js';
import { FEATURES, HOOK_SPECS, LEGACY_RM_GUARD, MOD_DIR_PATTERN, MOD_PLUGIN_NAME, ownScriptPattern } from './features.js';
import { readJevKey } from './jev.js';
import { configPath, settingsPath, stateDir } from './paths.js';
import { readSettingsFile } from './settings-file.js';
import { findCommands, type Settings } from './settings.js';

const SCRIPT_IN_COMMAND = /^node "([^"]+)"/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displaySetUp(settings: Settings, config: Config): boolean {
  if (config.display === 'message') return true;
  if (config.display === 'statusline') return isOurStatusLine(settings.statusLine);
  const env = isRecord(settings.env) ? settings.env : {};
  const dirs = typeof env[PLUGIN_DIRS_ENV] === 'string' ? (env[PLUGIN_DIRS_ENV] as string) : '';
  const hasDir = dirs.split(path.delimiter).some((dir) => MOD_DIR_PATTERN.test(dir.replace(/\\/g, '/')));
  return hasDir && isRecord(settings.pluginConfigs) && MOD_PLUGIN_NAME in settings.pluginConfigs;
}

function newestState(home: string): ContextState | null {
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const name of fs.readdirSync(stateDir(home))) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(stateDir(home), name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    return newest ? parseState(JSON.parse(fs.readFileSync(newest.file, 'utf8'))) : null;
  } catch {
    return null;
  }
}

function shortcutLine(home: string, config: Config): string {
  if (!config.shortcut) return '  shortcut: none (press the button with a click, or ctrl+x tab then Enter)';
  const state = shortcutState(home);
  if (state === 'present') return `  shortcut: ${config.shortcut}`;
  const why = state === 'unreadable' ? 'keybindings.json cannot be read' : 'missing from keybindings.json';
  return `  shortcut: ${config.shortcut} (${why} - run "claude-jev-advisor install context")`;
}

function contextLines(home: string, settings: Settings, config: Config, env: Record<string, string | undefined>): string[] {
  const c = config.context;
  const lines = [
    `  display: ${config.display}${displaySetUp(settings, config) ? '' : ` (not set up in settings.json - run "claude-jev-advisor install context --display ${config.display}")`}`,
    `  key: ${readJevKey(env, config.keyFile) ? 'set' : 'missing'}`,
    `  thresholds: judge from ${formatSize(c.minTokens)}, /compact from ${formatSize(c.compactMinTokens)}, red at ${c.redRemainingPct}% left`,
    `  Jev: work done from ${c.unitDoneYes}, stage done (/clear) from ${c.phaseDoneYes}`,
  ];
  if (config.display === 'mod') lines.splice(1, 0, shortcutLine(home, config));
  const last = newestState(home);
  if (last) {
    const line = adviceLine({ size: last.size, threshold: null, judgment: last.judgment, config }) || '(no size)';
    lines.push(`  last judgment: ${new Date(last.at).toISOString()} ${line}`);
  }
  return lines;
}

function rmJevLine(config: Config, env: Record<string, string | undefined>): string {
  if (!config.rm.jev) return '  jev: off';
  const key = readJevKey(env, config.keyFile) ? '' : ' (no key - every real file asks)';
  return `  jev: on, lifts the ask from ${config.rm.throwawayYes}${key}`;
}

// Claude Code reads a missing, empty or "*" matcher as every tool, and any other matcher as a pattern for the name.
function coversPowerShell(matcher: string | undefined): boolean {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test('PowerShell');
  } catch {
    return false;
  }
}

export function statusLines(home: string, env: Record<string, string | undefined> = process.env): string[] {
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
    if (feature === 'context') lines.push(...contextLines(home, settings, config, env));
    if (feature === 'rm') {
      lines.push(rmJevLine(config, env));
      if (!commands.some((c) => coversPowerShell(c.matcher))) {
        lines.push('  Bash only: run "claude-jev-advisor install rm" to cover PowerShell');
      }
    }
  }
  if (findCommands(settings, LEGACY_RM_GUARD).length) {
    lines.push('legacy rm-guard hook (~/.claude/hooks/rm-guard) is still registered - "claude-jev-advisor install rm" replaces it');
  }
  return lines;
}
