import { readCmd } from './cmd.js';
import { readBash } from './guard.js';
import { readPowerShell, type PowerShellRunner } from './powershell.js';
import { DELETE_WORDS, decisionOf, denyReason, type ReadCtx, type ReadResult, type RmDecision, type Shell, type ShellCall } from './targets.js';

export const MAX_NESTING = 3;
// The shortest start PowerShell takes for each switch that takes a value; -co is -Command, -config the configuration.
const POWERSHELL_VALUE_PARAMS: [string, number][] = [['executionpolicy', 2], ['windowstyle', 2], ['outputformat', 2], ['inputformat', 2], ['workingdirectory', 2], ['configurationname', 6], ['settingsfile', 2], ['version', 2], ['psconsolefile', 2], ['custompipename', 2]];
const POWERSHELL_VALUE_ALIASES = ['ep', 'ex', 'w', 'o', 'of', 'if', 'wd', 'v'];

export type Nested = { shell: Shell; script: string | null; moved?: boolean } | null;

const paramName = (arg: string) => arg.replace(/^(?:--|-|\/)/, '').toLowerCase();
const isParam = (arg: string) => /^(?:--|-|\/)[A-Za-z]/.test(arg);
const startsWord = (name: string, full: string, min: number) => name.length >= min && full.startsWith(name);

// cmd gets one command line, so an argument with spaces needs its quotes back; PowerShell and bash get argv entries.
// When that line after /c starts with a quote, cmd drops the first and the last quote before running it.
function cmdLine(args: string[]): string {
  const line = args.map((a) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a)).join(' ');
  const last = line.lastIndexOf('"');
  return line.startsWith('"') && last > 0 ? `${line.slice(1, last)}${line.slice(last + 1)}` : line;
}

function bashScript(args: (string | null)[]): Nested {
  let hasC = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === null) return { shell: 'bash', script: null };
    if (a === '--') {
      i++;
      break;
    }
    if (!/^[-+]/.test(a)) break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) hasC = true;
    if (/^[-+][oO]$/.test(a) || a === '--rcfile' || a === '--init-file') i++;
  }
  if (!hasC || i >= args.length) return null;
  return { shell: 'bash', script: args[i] };
}

function powerShellScript(name: string, args: (string | null)[]): Nested {
  let moved = false;
  const found = (script: string | null): Nested => ({ shell: 'powershell', script, ...(moved ? { moved } : {}) });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === null) return found(null);
    if (!isParam(a)) {
      // powershell.exe reads its first plain argument as a command, pwsh reads it as a script file.
      if (name === 'pwsh') return null;
      const rest = args.slice(i);
      return found(rest.includes(null) ? null : rest.join(' '));
    }
    const p = paramName(a);
    if (p === 'e' || p === 'ec' || startsWord(p, 'encodedcommand', 2)) {
      const encoded = args[i + 1];
      if (encoded === undefined) return null;
      return found(encoded === null ? null : Buffer.from(encoded, 'base64').toString('utf16le'));
    }
    if (p === 'cwa' || startsWord(p, 'command', 1) || startsWord(p, 'commandwithargs', 8)) {
      const rest = args.slice(i + 1);
      if (!rest.length || rest[0] === '-') return null;
      return found(rest.includes(null) ? null : rest.join(' '));
    }
    if (p === 'f' || startsWord(p, 'file', 2)) return null;
    if (POWERSHELL_VALUE_ALIASES.includes(p) || POWERSHELL_VALUE_PARAMS.some(([full, min]) => startsWord(p, full, min))) {
      if (p === 'wd' || startsWord(p, 'workingdirectory', 2)) moved = true;
      i++;
    }
  }
  return null;
}

export function nestedScript({ name, args }: ShellCall): Nested {
  if (name === 'sh' || name === 'bash') return bashScript(args);
  if (name === 'powershell' || name === 'pwsh') return powerShellScript(name, args);
  if (name === 'cmd') {
    const at = args.findIndex((a) => a !== null && /^\/{1,2}[ck]$/i.test(a));
    if (at === -1) return null;
    const rest = args.slice(at + 1);
    return rest.includes(null) ? { shell: 'cmd', script: null } : { shell: 'cmd', script: cmdLine(rest as string[]) };
  }
  return null;
}

function readShell(shell: Shell, script: string, ctx: ReadCtx, run: PowerShellRunner): Promise<ReadResult> | ReadResult {
  if (shell === 'bash') return readBash(script, ctx);
  if (shell === 'cmd') return readCmd(script, ctx);
  return readPowerShell(script, ctx, run);
}

async function readNested(shell: Shell, script: string, ctx: ReadCtx, run: PowerShellRunner, depth: number): Promise<ReadResult> {
  const result = await readShell(shell, script, ctx, run);
  if (result.deny !== null) return result;
  const merged: ReadResult = { deny: null, targets: [...result.targets], failed: [...result.failed], shells: [] };
  for (const call of result.shells) {
    const nested = nestedScript(call);
    if (nested === null) {
      // Without a script argument the shell runs what reaches its stdin (a pipe, a heredoc, a here-string), which this
      // reader never sees; when the command shows a delete, that is where it could go.
      if (call.piped && DELETE_WORDS.test(script)) return { ...merged, deny: denyReason(shell, `a shell reading its script from stdin (${call.raw})`) };
      continue;
    }
    if (nested.script === null || depth >= MAX_NESTING) {
      if (!DELETE_WORDS.test(call.raw) && !DELETE_WORDS.test(nested.script ?? '')) continue;
      const why = nested.script === null ? `a ${call.name} script that cannot be worked out (${call.raw})` : `shells nested more than ${MAX_NESTING} deep (${call.raw})`;
      return { ...merged, deny: denyReason(shell, why) };
    }
    const inner = await readNested(nested.shell, nested.script, { ...ctx, cwd: nested.moved ? null : call.cwd }, run, depth + 1);
    if (inner.deny !== null) return { ...merged, deny: inner.deny };
    merged.targets.push(...inner.targets);
    merged.failed.push(...inner.failed);
  }
  return merged;
}

export async function decideTool(tool: 'Bash' | 'PowerShell', command: string, ctx: ReadCtx, run: PowerShellRunner): Promise<RmDecision | null> {
  return decisionOf(await readNested(tool === 'Bash' ? 'bash' : 'powershell', command, ctx, run, 0));
}
