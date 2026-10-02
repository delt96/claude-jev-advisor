import type { Display, Lang } from '../config.js';
import { FEATURES, isFeature, type Feature } from '../features.js';
import { install, setEnabled, uninstall } from '../install.js';
import { statusLines } from '../status.js';

export type CliIo = {
  home: string;
  distDir: string;
  platform: NodeJS.Platform;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = [
  'Usage: claude-jev-advisor <command> [helpers] [options]',
  '',
  'Commands:',
  '  install [rm]     register hooks in ~/.claude/settings.json (backs it up first)',
  '  uninstall [rm]   remove this package\'s hooks from ~/.claude/settings.json',
  '  on [rm]          switch helpers on (open sessions too)',
  '  off [rm]         switch helpers off (open sessions too)',
  '  status           show what is registered and switched on',
  '',
  'Options for install: --lang ko|en  --key-file <path>  --display mod|statusline|message',
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

export function runCli(argv: string[], io: CliIo): number {
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
          keyFile: options['key-file'],
          display: options.display as Display | undefined,
        });
        for (const f of r.installed) io.out(`installed ${f}`);
        for (const s of r.skipped) io.out(`skipped ${s.feature}: ${s.reason}`);
        if (r.replacedLegacyRmGuard) io.out('replaced the legacy rm-guard hook (its files under ~/.claude/hooks/rm-guard were left in place)');
        if (r.backup) io.out(`backup: ${r.backup}`);
        if (r.installed.length) io.out('Hooks apply to Claude Code sessions started from now on.');
        return 0;
      }
      case 'uninstall': {
        const r = uninstall({ home: io.home, features, now: io.now() });
        if (!r.removed.length) io.out('nothing to remove');
        for (const f of r.removed) io.out(`removed ${f}`);
        if (r.backup) io.out(`backup: ${r.backup}`);
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
