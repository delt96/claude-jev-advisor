import fs from 'node:fs';
import path from 'node:path';
import { readConfig, updateConfig, type Display, type Lang } from '../config.js';
import type { ShortcutInstall } from '../display/keybindings.js';
import { SHORTCUT_CHORD } from '../display/shortcut.js';
import { FEATURES, isFeature, type Feature } from '../features.js';
import { install, setEnabled, uninstall } from '../install.js';
import { readJevKey } from '../jev.js';
import { checkJevKey, promptForKey, saveJevKey, type KeyCheck, type KeyPrompt } from '../key.js';
import { savedKeyPath } from '../paths.js';
import { reportLines } from '../report.js';
import { statusLines } from '../status.js';

export type CliIo = {
  home: string;
  distDir: string;
  platform: NodeJS.Platform;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  env?: Record<string, string | undefined>;
  prompt?: KeyPrompt;
  checkKey?: (key: string) => Promise<KeyCheck>;
};

const USAGE = [
  'Usage: claude-jev-advisor <command> [helpers] [options]',
  '',
  'Commands:',
  '  install [rm] [context]     register hooks in ~/.claude/settings.json (backs it up first)',
  '  uninstall [rm] [context]   remove this package\'s hooks and display from ~/.claude/settings.json',
  '  on [rm] [context]          switch helpers on (open sessions too)',
  '  off [rm] [context]         switch helpers off (open sessions too)',
  '  status                     show what is registered and switched on',
  '  key                        ask for the TypeSafe API key, check it and save it',
  '  report [--days 7]          list the /compact and /clear advice shown and what followed',
  '',
  'Options for install: --lang ko|en  --key-file <path>  --display mod|statusline|message',
  'The display is set up when context is installed: "install context --display <mode>" switches it.',
  'Leaving out the helpers means all of them.',
  'Run "claude-jev-advisor uninstall" before "npm rm -g": npm does not run uninstall scripts.',
].join('\n');

const INSTALL_OPTIONS = ['lang', 'key-file', 'display'];
const REPORT_DAYS = 7;
const LANGS = ['ko', 'en'];
const DISPLAYS = ['mod', 'statusline', 'message'];

type Parsed = { command: string; features: Feature[]; options: Record<string, string> };

function parse(argv: string[]): Parsed | string {
  const [command = 'help', ...rest] = argv;
  const features: Feature[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      options[arg.slice(2)] = value;
      i++;
    } else if (isFeature(arg)) {
      if (!features.includes(arg)) features.push(arg);
    } else {
      return `unknown helper "${arg}" (known: ${FEATURES.join(', ')})`;
    }
  }
  return { command, features: features.length ? features : [...FEATURES], options };
}

function checkOptions(command: string, options: Record<string, string>): string | null {
  const names = Object.keys(options);
  if (command === 'report') {
    const unknown = names.find((n) => n !== 'days');
    if (unknown) return `unknown option --${unknown}`;
    return options.days === undefined || /^[1-9]\d{0,3}$/.test(options.days) ? null : '--days takes a whole number of days from 1';
  }
  if (command !== 'install') return names.length ? `options are only for install and report (got --${names[0]})` : null;
  const unknown = names.find((n) => !INSTALL_OPTIONS.includes(n));
  if (unknown) return `unknown option --${unknown}`;
  if (options.lang !== undefined && !LANGS.includes(options.lang)) return '--lang takes ko or en';
  if (options.display !== undefined && !DISPLAYS.includes(options.display)) return '--display takes mod, statusline or message';
  return null;
}

async function askAndSaveKey(io: CliIo, prompt: KeyPrompt): Promise<void> {
  const key = await promptForKey(prompt, io.checkKey ?? ((candidate) => checkJevKey(candidate)));
  if (!key) {
    io.out('No key saved. Run "claude-jev-advisor key" to add one later.');
    return;
  }
  const before = readConfig(io.home).keyFile;
  const file = saveJevKey(io.home, key);
  updateConfig(io.home, (c) => ({ ...c, keyFile: file }));
  io.out(`Saved the key to ${file}`);
  if (before && path.resolve(before) !== path.resolve(file)) io.out(`The config now uses this file instead of ${before}.`);
  if ((io.env ?? process.env).TYPESAFE_API_KEY?.trim()) io.out('TYPESAFE_API_KEY is set in your environment; the hooks use it before the saved key.');
}

async function ensureKey(io: CliIo, keyFileGiven: boolean): Promise<void> {
  const keyFile = readConfig(io.home).keyFile;
  if (readJevKey(io.env ?? process.env, keyFile)) return;
  if (keyFileGiven) {
    io.out(`No TYPESAFE_API_KEY line found in ${keyFile}; context cannot judge until it has one.`);
    return;
  }
  if (!io.prompt) {
    io.out('No TypeSafe API key yet: run "claude-jev-advisor key" in a terminal to add one (context needs it to judge).');
    return;
  }
  await askAndSaveKey(io, io.prompt);
}

function shortcutLine(s: ShortcutInstall): string {
  if (s.shortcut) return `shortcut: ${s.shortcut} presses the advice button above the prompt (~/.claude/keybindings.json)`;
  const why = s.takenBy ? `${SHORTCUT_CHORD} is already bound (${s.takenBy})` : `keybindings.json: ${s.problem}`;
  return `shortcut: none - ${why}; press the button with a click, or ctrl+x tab then Enter`;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const parsed = parse(argv);
  const problem = typeof parsed === 'string' ? parsed : checkOptions(parsed.command, parsed.options);
  if (typeof parsed === 'string' || problem) {
    io.err(problem ?? String(parsed));
    io.err(USAGE);
    return 2;
  }
  const { command, features, options } = parsed;
  try {
    switch (command) {
      case 'install': {
        const r = install({
          home: io.home,
          features,
          distDir: io.distDir,
          platform: io.platform,
          now: io.now(),
          lang: options.lang as Lang | undefined,
          keyFile: options['key-file'] === undefined || path.isAbsolute(options['key-file']) ? options['key-file'] : path.resolve(options['key-file']),
          display: options.display as Display | undefined,
        });
        for (const f of r.installed) io.out(`installed ${f}`);
        for (const s of r.skipped) io.out(`skipped ${s.feature}: ${s.reason}`);
        if (r.replacedLegacyRmGuard) io.out('replaced the legacy rm-guard hook (its files under ~/.claude/hooks/rm-guard were left in place)');
        if (r.display) io.out(`display: ${r.display}`);
        if (r.backup) io.out(`backup: ${r.backup}`);
        if (r.shortcut) io.out(shortcutLine(r.shortcut));
        if (r.shortcut?.backup) io.out(`backup: ${r.shortcut.backup}`);
        if (r.shortcutRemoved?.removed) {
          io.out(`removed the ${SHORTCUT_CHORD} shortcut from keybindings.json`);
          if (r.shortcutRemoved.backup) io.out(`backup: ${r.shortcutRemoved.backup}`);
        }
        if (r.installed.length) {
          io.out(
            r.display === 'mod'
              ? 'Hooks apply right away, also in open Claude Code sessions; the bottom-row display and the advice button start with the next new session.'
              : 'Hooks apply right away, also in open Claude Code sessions.',
          );
        }
        if (r.installed.includes('context')) await ensureKey(io, options['key-file'] !== undefined);
        return 0;
      }
      case 'uninstall': {
        const r = uninstall({ home: io.home, features, now: io.now() });
        if (!r.removed.length) io.out('nothing to remove');
        for (const f of r.removed) io.out(`removed ${f}`);
        if (r.backup) io.out(`backup: ${r.backup}`);
        if (r.shortcut?.removed) io.out(`removed the ${SHORTCUT_CHORD} shortcut from keybindings.json`);
        if (r.shortcut?.backup) io.out(`backup: ${r.shortcut.backup}`);
        if (r.removed.includes('context') && fs.existsSync(savedKeyPath(io.home))) io.out(`kept your saved TypeSafe key at ${savedKeyPath(io.home)}`);
        return 0;
      }
      case 'key': {
        if (!io.prompt) {
          io.err('claude-jev-advisor key needs an interactive terminal (or set TYPESAFE_API_KEY, or use install --key-file).');
          return 1;
        }
        await askAndSaveKey(io, io.prompt);
        return 0;
      }
      case 'on':
      case 'off':
        setEnabled(io.home, features, command === 'on');
        io.out(`${features.join(', ')}: ${command}`);
        return 0;
      case 'status':
        for (const line of statusLines(io.home)) io.out(line);
        return 0;
      case 'report':
        for (const line of reportLines(io.home, io.now(), options.days === undefined ? REPORT_DAYS : Number(options.days))) io.out(line);
        return 0;
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return 0;
      default:
        io.err(`unknown command "${command}"`);
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    io.err(`claude-jev-advisor: ${(err as Error).message}`);
    return 1;
  }
}
