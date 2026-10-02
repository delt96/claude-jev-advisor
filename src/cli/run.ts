import fs from 'node:fs';
import path from 'node:path';
import { readConfig, updateConfig, type Display, type Lang } from '../config.js';
import { FEATURES, isFeature, type Feature } from '../features.js';
import { install, setEnabled, uninstall } from '../install.js';
import { readJevKey } from '../jev.js';
import { checkJevKey, promptForKey, saveJevKey, type KeyCheck, type KeyPrompt } from '../key.js';
import { savedKeyPath } from '../paths.js';
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
  '',
  'Options for install: --lang ko|en  --key-file <path>  --display mod|statusline|message',
  'The display is set up when context is installed: "install context --display <mode>" switches it.',
  'Leaving out the helpers means all of them.',
  'Run "claude-jev-advisor uninstall" before "npm rm -g": npm does not run uninstall scripts.',
].join('\n');

const INSTALL_OPTIONS = ['lang', 'key-file', 'display'];
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
  if (command !== 'install') return names.length ? `options are only for install (got --${names[0]})` : null;
  const unknown = names.find((n) => !INSTALL_OPTIONS.includes(n));
  if (unknown) return `unknown option --${unknown}`;
  if (options.lang !== undefined && !LANGS.includes(options.lang)) return '--lang takes ko or en';
  if (options.display !== undefined && !DISPLAYS.includes(options.display)) return '--display takes mod, statusline or message';
  return null;
}

async function askAndSaveKey(io: CliIo, prompt: KeyPrompt): Promise<boolean> {
  const key = await promptForKey(prompt, io.checkKey ?? ((candidate) => checkJevKey(candidate)));
  if (!key) {
    io.out('No key saved. Run "claude-jev-advisor key" to add one later.');
    return false;
  }
  const file = saveJevKey(io.home, key);
  updateConfig(io.home, (c) => ({ ...c, keyFile: file }));
  io.out(`Saved the key to ${file}`);
  return true;
}

async function ensureKey(io: CliIo): Promise<void> {
  if (readJevKey(io.env ?? process.env, readConfig(io.home).keyFile)) return;
  if (!io.prompt) {
    io.out('No TypeSafe API key yet: run "claude-jev-advisor key" in a terminal to add one (context needs it to judge).');
    return;
  }
  await askAndSaveKey(io, io.prompt);
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
        if (r.installed.length) io.out('Hooks apply right away, also in open Claude Code sessions; the bottom-row display starts with the next new session.');
        if (r.installed.includes('context')) await ensureKey(io);
        return 0;
      }
      case 'uninstall': {
        const r = uninstall({ home: io.home, features, now: io.now() });
        if (!r.removed.length) io.out('nothing to remove');
        for (const f of r.removed) io.out(`removed ${f}`);
        if (r.backup) io.out(`backup: ${r.backup}`);
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
