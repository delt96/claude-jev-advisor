import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { denyReason, emptyRead, judgePath, resolveWindowsPath, splitWindowsPattern, type ReadCtx, type ReadResult, type RmTarget } from './targets.js';

export const PS_PARSE_TIMEOUT_MS = 3000;
export const POWERSHELL_WORDS = /\b(?:remove-item|ri|rm|del|erase|rd|rmdir|sh|bash|cmd|powershell|pwsh)(?:\.exe)?\b|::\s*delete\b/i;
const EXCERPT_CHARS = 200;
const KNOWN_ENV = ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

export type PowerShellRunner = (source: string) => Promise<string | null>;

type Value = { const: string } | { expand: string } | { variable: string } | { array: Value[] } | { dynamic: string };
type Item =
  | { kind: 'delete'; name: string; path?: Value | null; literalPath?: Value | null; literal?: boolean; whatIf?: boolean; bindError?: boolean; inPipeline?: boolean }
  | { kind: 'cd'; path: Value | null; inBlock: boolean }
  | { kind: 'pop' }
  | { kind: 'assign'; name: string; value: Value; inBlock: boolean }
  | { kind: 'shell'; name: string; args: Value[] | Value; raw: string };

// Runs in powershell.exe or pwsh: PowerShell's own parser and static parameter binder read the command, so aliases,
// shortened parameter names, positional arguments, quoting and nested blocks follow PowerShell's rules exactly.
const READER = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$root = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)

function Value($ast) {
  if ($null -eq $ast) { return @{ dynamic = '' } }
  if ($ast -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return @{ const = $ast.Value } }
  if ($ast -is [System.Management.Automation.Language.ConstantExpressionAst]) { return @{ const = [string]$ast.Value } }
  if ($ast -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    foreach ($n in $ast.NestedExpressions) {
      if (-not ($n -is [System.Management.Automation.Language.VariableExpressionAst]) -or $n.Splatted) { return @{ dynamic = $ast.Extent.Text } }
    }
    return @{ expand = $ast.Value }
  }
  if ($ast -is [System.Management.Automation.Language.VariableExpressionAst] -and -not $ast.Splatted) { return @{ variable = $ast.VariablePath.UserPath } }
  if ($ast -is [System.Management.Automation.Language.ArrayLiteralAst]) { return @{ array = @($ast.Elements | ForEach-Object { Value $_ }) } }
  if ($ast -is [System.Management.Automation.Language.CommandParameterAst]) { return @{ const = $ast.Extent.Text } }
  return @{ dynamic = $ast.Extent.Text }
}

function NameOf($command) {
  $name = $command.GetCommandName()
  if ($null -eq $name) { return $null }
  $name = $name -replace '^Microsoft\.PowerShell\.Management\\', ''
  $name = ($name -split '[\\/]')[-1]
  return ($name -replace '\.exe$', '').ToLowerInvariant()
}

function InBlock($ast) {
  for ($p = $ast.Parent; $null -ne $p; $p = $p.Parent) {
    if ($p -eq $root) { return $false }
    if ($p -is [System.Management.Automation.Language.StatementBlockAst] -or $p -is [System.Management.Automation.Language.ScriptBlockAst]) { return $true }
  }
  return $false
}

function Bound($command) {
  $binding = [System.Management.Automation.Language.StaticParameterBinder]::BindCommand($command, $true)
  $out = @{ bindError = ($binding.BindingExceptions.Count -gt 0) }
  foreach ($key in $binding.BoundParameters.Keys) {
    $result = $binding.BoundParameters[$key]
    switch ($key) {
      'Path' { $out.path = Value $result.Value }
      'LiteralPath' { $out.literalPath = Value $result.Value }
      'WhatIf' { $out.whatIf = ($result.ConstantValue -ne $false) }
    }
  }
  return $out
}

$deletes = @('remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir')
$moves = @('set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd')
$pops = @('pop-location', 'popd')
$shells = @('sh', 'bash', 'cmd', 'powershell', 'pwsh')
$dotnet = @('system.io.file', 'io.file', 'system.io.directory', 'io.directory')

$items = New-Object System.Collections.ArrayList
$found = $root.FindAll({
  param($a)
  $a -is [System.Management.Automation.Language.CommandAst] -or
  $a -is [System.Management.Automation.Language.AssignmentStatementAst] -or
  $a -is [System.Management.Automation.Language.InvokeMemberExpressionAst]
}, $true)
foreach ($a in $found) {
  if ($a -is [System.Management.Automation.Language.AssignmentStatementAst]) {
    if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $a.Operator -eq 'Equals') {
      $right = if ($a.Right -is [System.Management.Automation.Language.CommandExpressionAst]) { Value $a.Right.Expression } else { @{ dynamic = $a.Right.Extent.Text } }
      [void]$items.Add(@{ kind = 'assign'; name = $a.Left.VariablePath.UserPath; value = $right; inBlock = (InBlock $a) })
    }
    continue
  }
  if ($a -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
    if ($a.Static -and $a.Expression -is [System.Management.Automation.Language.TypeExpressionAst] -and $a.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $a.Member.Value -eq 'Delete' -and $dotnet -contains $a.Expression.TypeName.FullName.ToLowerInvariant()) {
      $first = if ($a.Arguments -and $a.Arguments.Count -gt 0) { Value $a.Arguments[0] } else { @{ dynamic = $a.Extent.Text } }
      [void]$items.Add(@{ kind = 'delete'; name = $a.Expression.TypeName.FullName; path = $first; literal = $true })
    }
    continue
  }
  $name = NameOf $a
  if ($null -eq $name) { continue }
  $pipeline = $a.Parent
  $inPipeline = ($pipeline -is [System.Management.Automation.Language.PipelineAst]) -and ($pipeline.PipelineElements.IndexOf($a) -gt 0)
  if ($deletes -contains $name) {
    $b = Bound $a
    [void]$items.Add(@{ kind = 'delete'; name = $name; path = $b.path; literalPath = $b.literalPath; whatIf = [bool]$b.whatIf; bindError = $b.bindError; inPipeline = $inPipeline })
  } elseif ($moves -contains $name) {
    $b = Bound $a
    $to = if ($null -ne $b.literalPath) { $b.literalPath } else { $b.path }
    [void]$items.Add(@{ kind = 'cd'; path = $to; inBlock = (InBlock $a) })
  } elseif ($pops -contains $name) {
    [void]$items.Add(@{ kind = 'pop' })
  } elseif ($shells -contains $name) {
    $elements = @($a.CommandElements | Select-Object -Skip 1 | ForEach-Object { Value $_ })
    [void]$items.Add(@{ kind = 'shell'; name = $name; args = $elements; raw = $a.Extent.Text })
  }
}
$result = @{ errors = ($errors.Count -gt 0); items = $items.ToArray() }
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 12 -Compress))
`;

// Claude Code runs the PowerShell tool in pwsh when it finds it and in powershell.exe otherwise; read with the same one.
export function powerShellExe(env: Record<string, string | undefined>): string {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, 'pwsh.exe'))) return path.join(dir, 'pwsh.exe');
  }
  return 'powershell.exe';
}

export function realPowerShell(env: Record<string, string | undefined>, timeoutMs = PS_PARSE_TIMEOUT_MS): PowerShellRunner {
  const encoded = Buffer.from(READER, 'utf16le').toString('base64');
  return (source) =>
    new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = spawn(powerShellExe(env), ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code === 0 ? out : null));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stdin.on('error', () => {});
      child.stdin.end(source, 'utf8');
    });
}

const list = <T>(value: T[] | T | null | undefined): T[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

function classify(value: string, literal: boolean, cwd: string | null, ctx: ReadCtx): { real?: RmTarget; unresolvable?: string } {
  const text = value.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '');
  if (/^Registry::/i.test(text) || /^[A-Za-z][A-Za-z0-9_]+:/.test(text)) return {};
  let base = text;
  let pattern: string | null = null;
  if (!literal && /[*?[]/.test(text)) {
    const split = splitWindowsPattern(text, /[*?[]/);
    if (split === null) return { unresolvable: `a wildcard in a folder name (${value})` };
    base = split.dir;
    pattern = split.pattern;
  }
  const resolved = resolveWindowsPath(base, cwd, ctx.home);
  if ('unresolvable' in resolved) return { unresolvable: resolved.unresolvable };
  if ('unc' in resolved) return { real: { shown: value, path: null } };
  return { real: judgePath(resolved.path, pattern, ctx) ?? undefined };
}

export async function readPowerShell(source: string, ctx: ReadCtx, run: PowerShellRunner): Promise<ReadResult> {
  const out = emptyRead();
  if (!POWERSHELL_WORDS.test(source)) return out;
  const failed = (): ReadResult => ({ ...out, failed: [source.slice(0, EXCERPT_CHARS)] });
  let items: Item[];
  try {
    const stdout = await run(source);
    if (stdout === null) return failed();
    const parsed = JSON.parse(stdout) as { errors?: unknown; items?: unknown };
    if (parsed.errors !== false) return failed();
    items = list(parsed.items as Item[] | Item | null);
  } catch {
    return failed();
  }
  const vars = new Map<string, string | null>();
  for (const name of KNOWN_ENV) {
    const value = ctx.env[name];
    if (value) vars.set(`env:${name.toLowerCase()}`, value);
  }
  vars.set('home', ctx.home);
  let cwd = ctx.cwd;
  const variable = (name: string): string | null => (name.toLowerCase() === 'pwd' ? cwd : vars.get(name.toLowerCase()) ?? null);
  const expand = (text: string): string | null => {
    let known = true;
    const result = text.replace(/\$\{([^}]+)\}|\$((?:env:)?[A-Za-z_][A-Za-z0-9_]*)/gi, (m: string, braced?: string, bare?: string) => {
      const v = variable(braced ?? bare ?? '');
      if (v === null) {
        known = false;
        return m;
      }
      return v;
    });
    return known ? result : null;
  };
  const textOf = (value: Value | null | undefined): string | null => {
    if (!value) return null;
    if ('const' in value) return value.const;
    if ('expand' in value) return expand(value.expand);
    if ('variable' in value) return variable(value.variable);
    return null;
  };
  const deny = (why: string): ReadResult => ({ ...out, deny: denyReason('powershell', why) });
  for (const item of items) {
    if (item.kind === 'assign') {
      vars.set(item.name.toLowerCase(), item.inBlock ? null : textOf(item.value));
    } else if (item.kind === 'pop') {
      cwd = null;
    } else if (item.kind === 'cd') {
      const to = item.inBlock ? null : textOf(item.path);
      const resolved = to === null || to === '-' ? null : resolveWindowsPath(to, cwd, ctx.home);
      cwd = resolved !== null && 'path' in resolved ? resolved.path : null;
    } else if (item.kind === 'shell') {
      out.shells.push({ name: item.name, args: list(item.args).map((a) => textOf(a)), cwd, raw: item.raw });
    } else if (item.kind === 'delete') {
      if (item.whatIf) continue;
      if (item.bindError) {
        out.failed.push(source.slice(0, EXCERPT_CHARS));
        continue;
      }
      if (item.inPipeline) return deny('pipeline input feeding Remove-Item');
      const literal = item.literal === true || item.literalPath != null;
      const values = list(item.literalPath ?? item.path).flatMap((v) => ('array' in v ? list(v.array) : [v]));
      for (const v of values) {
        if ('dynamic' in v || 'array' in v) return deny(`an expression that cannot be worked out (${'dynamic' in v ? v.dynamic : 'a nested list'})`);
        const text = textOf(v);
        if (text === null) return deny(`a variable that cannot be worked out (${'variable' in v ? `$${v.variable}` : 'expand' in v ? v.expand : ''})`);
        const c = classify(text, literal, cwd, ctx);
        if (c.unresolvable) return deny(c.unresolvable);
        if (c.real) out.targets.push(c.real);
      }
    }
  }
  return out;
}
