import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { denyReason, emptyRead, judgePath, resolveWindowsPath, splitWindowsPattern, type ReadCtx, type ReadResult, type RmTarget } from './targets.js';

export const PS_PARSE_TIMEOUT_MS = 3000;
export const POWERSHELL_WORDS = /\b(?:remove-item|ri|rm|del|erase|rd|rmdir|sh|bash|cmd|powershell|pwsh)(?:\.exe)?\b|::\s*delete\b/i;
const DELETE_WORD = /(?<![\w.-])(?:remove-item|ri|rm|del|erase|rd|rmdir)(?![\w-])|::\s*delete\b/i;
const EXCERPT_CHARS = 200;
const KNOWN_ENV = ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

export type PowerShellRunner = (source: string) => Promise<string | null>;

type Value = { const: string } | { expand: string } | { variable: string } | { array: Value[] } | { dynamic: string };
type Item =
  | { kind: 'delete'; path: Value | null; literalPath: Value | null; literal: boolean; dotnet: boolean; whatIf: boolean; bindError: boolean; inPipeline: boolean }
  | { kind: 'cd'; path: Value | null; literal: boolean; inBlock: boolean }
  | { kind: 'pop' }
  | { kind: 'assign'; name: string; value: Value }
  | { kind: 'shell'; name: string; args: Value[]; raw: string; inPipeline: boolean }
  | { kind: 'dynamic'; text: string | null };
type Parsed = { items: Item[]; unstable: Set<string>; anyVariable: boolean };

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
    if ($ast.Extent.Text.Contains([string][char]96 + '$')) { return @{ dynamic = $ast.Extent.Text } }
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
  if ($name -eq 'cd..' -or $name -eq 'cd\') { return $name }
  $name = $name -replace '^Microsoft\.PowerShell\.Management\\', ''
  $name = ($name -split '[\\/]')[-1]
  return ($name -replace '\.exe$', '').ToLowerInvariant()
}

function TopLevel($ast) {
  for ($p = $ast.Parent; $null -ne $p; $p = $p.Parent) {
    if ($p -eq $root) { return $true }
    if (-not ($p -is [System.Management.Automation.Language.PipelineAst] -or $p -is [System.Management.Automation.Language.NamedBlockAst])) { return $false }
  }
  return $false
}

function Bound($command) {
  $binding = [System.Management.Automation.Language.StaticParameterBinder]::BindCommand($command, $true)
  $out = @{ bindError = ($binding.BindingExceptions.Count -gt 0); whatIf = $false }
  foreach ($key in $binding.BoundParameters.Keys) {
    $result = $binding.BoundParameters[$key]
    switch ($key) {
      'Path' { $out.path = Value $result.Value }
      'LiteralPath' { $out.literalPath = Value $result.Value }
      'Name' { $out.name = $result }
      'WhatIf' {
        $v = $result.Value
        if ($null -eq $v) { $out.whatIf = ($result.ConstantValue -eq $true) }
        else { $out.whatIf = ($v -is [System.Management.Automation.Language.VariableExpressionAst]) -and ($v.VariablePath.UserPath -eq 'true') }
      }
    }
  }
  return $out
}

$deletes = @('remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir')
$moves = @('set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd')
$pops = @('pop-location', 'popd')
$shells = @('sh', 'bash', 'cmd', 'powershell', 'pwsh')
$dynamics = @('invoke-expression', 'iex', 'start-process', 'saps', 'start', 'invoke-command', 'icm', 'start-job', 'sajb', 'set-alias', 'sal', 'new-alias', 'nal')
$variableCommands = @('set-variable', 'sv', 'new-variable', 'nv', 'remove-variable', 'rv', 'clear-variable', 'clv')
$variableParameters = @('outvariable', 'ov', 'errorvariable', 'ev', 'warningvariable', 'wv', 'informationvariable', 'iv', 'pipelinevariable', 'pv')
$dotnet = @('system.io.file', 'io.file', 'file', 'system.io.directory', 'io.directory', 'directory')
$unstable = New-Object System.Collections.ArrayList
$anyVariable = $false

$items = New-Object System.Collections.ArrayList
$found = $root.FindAll({
  param($a)
  $a -is [System.Management.Automation.Language.CommandAst] -or
  $a -is [System.Management.Automation.Language.AssignmentStatementAst] -or
  $a -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -or
  $a -is [System.Management.Automation.Language.UnaryExpressionAst] -or
  $a -is [System.Management.Automation.Language.ForEachStatementAst] -or
  $a -is [System.Management.Automation.Language.ConvertExpressionAst] -or
  $a -is [System.Management.Automation.Language.CommandParameterAst]
}, $true)
foreach ($a in $found) {
  if ($a -is [System.Management.Automation.Language.AssignmentStatementAst]) {
    $left = $a.Left
    if ($left -is [System.Management.Automation.Language.VariableExpressionAst] -and -not $left.Splatted -and ($left.VariablePath.IsUnqualified -or $left.VariablePath.IsDriveQualified) -and $a.Operator -eq 'Equals' -and (TopLevel $a)) {
      $right = if ($a.Right -is [System.Management.Automation.Language.CommandExpressionAst]) { Value $a.Right.Expression } else { @{ dynamic = $a.Right.Extent.Text } }
      [void]$items.Add(@{ kind = 'assign'; name = $left.VariablePath.UserPath; value = $right })
    } else {
      foreach ($v in $left.FindAll({ param($x) $x -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)) { [void]$unstable.Add($v.VariablePath.UserPath) }
    }
    continue
  }
  if ($a -is [System.Management.Automation.Language.UnaryExpressionAst]) {
    if ($a.Child -is [System.Management.Automation.Language.VariableExpressionAst] -and @('PlusPlus', 'MinusMinus', 'PostfixPlusPlus', 'PostfixMinusMinus') -contains [string]$a.TokenKind) { [void]$unstable.Add($a.Child.VariablePath.UserPath) }
    continue
  }
  if ($a -is [System.Management.Automation.Language.ForEachStatementAst]) {
    [void]$unstable.Add($a.Variable.VariablePath.UserPath)
    continue
  }
  if ($a -is [System.Management.Automation.Language.ConvertExpressionAst]) {
    if ($a.Type.TypeName.Name -eq 'ref' -and $a.Child -is [System.Management.Automation.Language.VariableExpressionAst]) { [void]$unstable.Add($a.Child.VariablePath.UserPath) }
    continue
  }
  if ($a -is [System.Management.Automation.Language.CommandParameterAst]) {
    if ($variableParameters -contains $a.ParameterName.ToLowerInvariant()) { $anyVariable = $true }
    continue
  }
  if ($a -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
    if ($a.Static -and $a.Expression -is [System.Management.Automation.Language.TypeExpressionAst] -and $a.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $a.Member.Value -eq 'Delete' -and $dotnet -contains $a.Expression.TypeName.FullName.ToLowerInvariant()) {
      $first = if ($a.Arguments -and $a.Arguments.Count -gt 0) { Value $a.Arguments[0] } else { @{ dynamic = $a.Extent.Text } }
      [void]$items.Add(@{ kind = 'delete'; path = $first; literalPath = $null; literal = $true; dotnet = $true; whatIf = $false; bindError = $false; inPipeline = $false })
    }
    continue
  }
  $name = NameOf $a
  if ($null -eq $name) {
    [void]$items.Add(@{ kind = 'dynamic'; text = $null })
    continue
  }
  $pipeline = $a.Parent
  $inPipeline = ($pipeline -is [System.Management.Automation.Language.PipelineAst]) -and ($pipeline.PipelineElements.IndexOf($a) -gt 0)
  if ($deletes -contains $name) {
    $b = Bound $a
    [void]$items.Add(@{ kind = 'delete'; path = $b.path; literalPath = $b.literalPath; literal = ($null -ne $b.literalPath); dotnet = $false; whatIf = $b.whatIf; bindError = $b.bindError; inPipeline = $inPipeline })
  } elseif ($name -eq 'cd..' -or $name -eq 'cd\') {
    [void]$items.Add(@{ kind = 'cd'; path = @{ const = $name.Substring(2) }; literal = $true; inBlock = -not (TopLevel $a) })
  } elseif ($moves -contains $name) {
    $b = Bound $a
    $to = if ($null -ne $b.literalPath) { $b.literalPath } else { $b.path }
    [void]$items.Add(@{ kind = 'cd'; path = $to; literal = ($null -ne $b.literalPath); inBlock = -not (TopLevel $a) })
  } elseif ($pops -contains $name) {
    [void]$items.Add(@{ kind = 'pop' })
  } elseif ($shells -contains $name) {
    $elements = @($a.CommandElements | Select-Object -Skip 1 | ForEach-Object { Value $_ })
    [void]$items.Add(@{ kind = 'shell'; name = $name; args = $elements; raw = $a.Extent.Text; inPipeline = $inPipeline })
  } elseif ($dynamics -contains $name) {
    [void]$items.Add(@{ kind = 'dynamic'; text = $a.Extent.Text })
  } elseif ($variableCommands -contains $name) {
    $b = Bound $a
    if ($null -ne $b.name -and $null -ne $b.name.ConstantValue) { foreach ($n in @($b.name.ConstantValue)) { [void]$unstable.Add([string]$n) } } else { $anyVariable = $true }
  }
}
$result = @{ errors = ($errors.Count -gt 0); items = $items.ToArray(); unstable = $unstable.ToArray(); anyVariable = $anyVariable }
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

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function valueOf(raw: unknown): Value {
  if (!isRecord(raw)) throw new Error('bad value');
  for (const key of ['const', 'expand', 'variable', 'dynamic'] as const) {
    if (key in raw) {
      if (typeof raw[key] !== 'string') throw new Error('bad value');
      return { [key]: raw[key] } as Value;
    }
  }
  if ('array' in raw) return { array: list(raw.array).map(valueOf) };
  throw new Error('bad value');
}

const optionalValue = (raw: unknown): Value | null => (raw == null ? null : valueOf(raw));
const flag = (raw: unknown): boolean => {
  if (typeof raw !== 'boolean') throw new Error('bad flag');
  return raw;
};

function itemOf(raw: unknown): Item {
  if (!isRecord(raw) || typeof raw.kind !== 'string') throw new Error('bad item');
  switch (raw.kind) {
    case 'delete':
      return { kind: 'delete', path: optionalValue(raw.path), literalPath: optionalValue(raw.literalPath), literal: flag(raw.literal), dotnet: flag(raw.dotnet), whatIf: flag(raw.whatIf), bindError: flag(raw.bindError), inPipeline: flag(raw.inPipeline) };
    case 'cd':
      return { kind: 'cd', path: optionalValue(raw.path), literal: flag(raw.literal), inBlock: flag(raw.inBlock) };
    case 'pop':
      return { kind: 'pop' };
    case 'assign':
      if (typeof raw.name !== 'string') throw new Error('bad item');
      return { kind: 'assign', name: raw.name, value: valueOf(raw.value) };
    case 'shell':
      if (typeof raw.name !== 'string' || typeof raw.raw !== 'string') throw new Error('bad item');
      return { kind: 'shell', name: raw.name, args: list(raw.args).map(valueOf), raw: raw.raw, inPipeline: flag(raw.inPipeline) };
    case 'dynamic':
      if (raw.text != null && typeof raw.text !== 'string') throw new Error('bad item');
      return { kind: 'dynamic', text: typeof raw.text === 'string' ? raw.text : null };
    default:
      throw new Error('bad item');
  }
}

function parse(stdout: string): Parsed {
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed) || parsed.errors !== false || !('items' in parsed) || typeof parsed.anyVariable !== 'boolean') throw new Error('bad answer');
  const unstable = list(parsed.unstable).map((name) => {
    if (typeof name !== 'string') throw new Error('bad answer');
    return baseName(name);
  });
  return { items: list(parsed.items).map(itemOf), unstable: new Set(unstable), anyVariable: parsed.anyVariable };
}

// $script:x, $global:x and $x name the same variable in a one-off command.
const baseName = (name: string) => name.toLowerCase().replace(/^(?:script|local|global|private|using|variable):/, '');

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

function folderOf(value: string, literal: boolean, cwd: string | null, home: string): string | null {
  const text = value.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '');
  if (text === '-' || /^Registry::/i.test(text) || /^[A-Za-z][A-Za-z0-9_]+:/.test(text) || (!literal && /[*?[]/.test(text))) return null;
  const resolved = resolveWindowsPath(text, cwd, home);
  return 'path' in resolved ? resolved.path : null;
}

export async function readPowerShell(source: string, ctx: ReadCtx, run: PowerShellRunner): Promise<ReadResult> {
  const out = emptyRead();
  if (!POWERSHELL_WORDS.test(source)) return out;
  const excerpt = source.slice(0, EXCERPT_CHARS);
  const failed = (): ReadResult => ({ ...emptyRead(), failed: [excerpt] });
  try {
    const stdout = await run(source);
    if (stdout === null) return failed();
    const { items, unstable, anyVariable } = parse(stdout);
    const assigned = new Map<string, number>();
    for (const item of items) if (item.kind === 'assign') assigned.set(baseName(item.name), (assigned.get(baseName(item.name)) ?? 0) + 1);
    const vars = new Map<string, string | null>();
    for (const name of KNOWN_ENV) {
      const value = ctx.env[name];
      if (value) vars.set(`env:${name.toLowerCase()}`, value);
    }
    vars.set('home', ctx.home);
    let cwd = ctx.cwd;
    const variable = (name: string): string | null => {
      const key = baseName(name);
      if (anyVariable || unstable.has(key)) return null;
      return key === 'pwd' ? cwd : vars.get(key) ?? null;
    };
    // PowerShell's tokenizer, not this pattern, decides where a variable name ends, so a `$` this pattern leaves behind
    // (a name outside ASCII, for one) makes the text unknown. Strings with a backtick before a `$` arrive as dynamic.
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
      return known && !result.includes('$') ? result : null;
    };
    const textOf = (value: Value | null): string | null => {
      if (!value) return null;
      if ('const' in value) return value.const;
      if ('expand' in value) return expand(value.expand);
      if ('variable' in value) return variable(value.variable);
      return null;
    };
    const deny = (why: string): ReadResult => ({ ...out, deny: denyReason('powershell', why) });
    for (const item of items) {
      if (item.kind === 'assign') {
        const key = baseName(item.name);
        vars.set(key, assigned.get(key) === 1 ? textOf(item.value) : null);
      } else if (item.kind === 'pop') {
        cwd = null;
      } else if (item.kind === 'cd') {
        const to = item.inBlock ? null : textOf(item.path);
        cwd = to === null ? null : folderOf(to, item.literal, cwd, ctx.home);
      } else if (item.kind === 'shell') {
        if (item.inPipeline) return deny(`pipeline input feeding a shell (${item.raw})`);
        out.shells.push({ name: item.name, args: item.args.map((a) => textOf(a)), cwd, raw: item.raw });
      } else if (item.kind === 'dynamic') {
        // A named call (iex, Start-Process) carries what it runs in its own text; a call by a variable could run anything.
        if (DELETE_WORD.test(item.text ?? source) && !out.failed.length) out.failed.push(excerpt);
      } else {
        if (item.whatIf) continue;
        if (item.bindError) {
          if (!out.failed.length) out.failed.push(excerpt);
          continue;
        }
        if (item.inPipeline) return deny('pipeline input feeding Remove-Item');
        const values = list(item.literalPath ?? item.path).flatMap((v) => ('array' in (v as Value) ? (v as { array: Value[] }).array : [v as Value]));
        for (const v of values) {
          if ('dynamic' in v || 'array' in v) return deny(`an expression that cannot be worked out (${'dynamic' in v ? v.dynamic : 'a nested list'})`);
          const text = textOf(v);
          if (text === null) return deny(`a variable that cannot be worked out (${'variable' in v ? `$${v.variable}` : 'expand' in v ? v.expand : ''})`);
          // .NET reads a relative path in the process's folder, which Set-Location does not change.
          const c = classify(text, item.literal, item.dotnet ? ctx.cwd : cwd, ctx);
          if (c.unresolvable) return deny(c.unresolvable);
          if (c.real) out.targets.push(c.real);
        }
      }
    }
    return out;
  } catch {
    return failed();
  }
}
