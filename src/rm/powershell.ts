import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DELETE_WORDS, denyReason, emptyRead, judgePath, resolveWindowsPath, splitWindowsPattern, type ReadCtx, type ReadResult, type RmTarget } from './targets.js';

export const PS_PARSE_TIMEOUT_MS = 3000;
export const POWERSHELL_WORDS = /\b(?:remove-item|ri|rm|del|erase|rd|rmdir|sh|bash|cmd|powershell|pwsh)(?:\.exe)?\b|\bdelete/i;
// PowerShell also calls Delete by a bare member name (`ForEach-Object Delete`).
const DELETE_WORD = new RegExp(`${DELETE_WORDS.source}|\\bdelete`, 'i');
const OTHER_DRIVES = new Set(['alias', 'env', 'function', 'variable', 'hklm', 'hkcu', 'cert', 'wsman']);
const EXCERPT_CHARS = 200;
const KNOWN_ENV = ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

export type PowerShellRunner = (source: string) => Promise<string | null>;

type Part = { const: string } | { variable: string };
type Value = Part | { expand: Part[]; text: string } | { array: Value[] } | { dynamic: string };
type Item =
  | { kind: 'delete'; path: Value | null; literalPath: Value | null; literal: boolean; dotnet: boolean; whatIf: boolean; bindError: boolean; inPipeline: boolean; ordered: boolean }
  | { kind: 'cd'; path: Value | null; literal: boolean; inBlock: boolean }
  | { kind: 'pop' }
  | { kind: 'assign'; name: string; value: Value }
  | { kind: 'shell'; name: string; args: Value[]; raw: string; inPipeline: boolean; ordered: boolean }
  | { kind: 'dynamic'; text: string | null; args: Value[] };
type Parsed = { items: Item[]; unstable: Set<string>; anyVariable: boolean };

// Runs in powershell.exe or pwsh: PowerShell's own parser and static parameter binder read the command, so aliases,
// shortened parameter names, positional arguments, quoting and nested blocks follow PowerShell's rules exactly.
const READER = String.raw`
param($source)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$root = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)

function Value($ast) {
  if ($null -eq $ast) { return @{ dynamic = '' } }
  if ($ast -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return @{ const = $ast.Value } }
  if ($ast -is [System.Management.Automation.Language.ConstantExpressionAst]) { return @{ const = [string]$ast.Value } }
  if ($ast -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    if ($ast.Extent.Text.Contains([string][char]96 + '$')) { return @{ dynamic = $ast.Extent.Text } }
    $parts = New-Object System.Collections.ArrayList
    $at = 0
    foreach ($n in $ast.NestedExpressions) {
      if (-not ($n -is [System.Management.Automation.Language.VariableExpressionAst]) -or $n.Splatted) { return @{ dynamic = $ast.Extent.Text } }
      $i = $ast.Value.IndexOf($n.Extent.Text, $at, [System.StringComparison]::Ordinal)
      if ($i -lt 0) { return @{ dynamic = $ast.Extent.Text } }
      if ($i -gt $at) { [void]$parts.Add(@{ const = $ast.Value.Substring($at, $i - $at) }) }
      [void]$parts.Add(@{ variable = $n.VariablePath.UserPath })
      $at = $i + $n.Extent.Text.Length
    }
    if ($at -lt $ast.Value.Length) { [void]$parts.Add(@{ const = $ast.Value.Substring($at) }) }
    return @{ expand = $parts.ToArray(); text = $ast.Extent.Text }
  }
  if ($ast -is [System.Management.Automation.Language.VariableExpressionAst] -and -not $ast.Splatted) { return @{ variable = $ast.VariablePath.UserPath } }
  if ($ast -is [System.Management.Automation.Language.ArrayLiteralAst]) { return @{ array = @($ast.Elements | ForEach-Object { Value $_ }) } }
  if ($ast -is [System.Management.Automation.Language.CommandParameterAst]) { return @{ const = $ast.Extent.Text } }
  return @{ dynamic = $ast.Extent.Text }
}

function Constant($ast) {
  if ($ast -is [System.Management.Automation.Language.CommandParameterAst]) { return ($null -eq $ast.Argument) -or (Constant $ast.Argument) }
  if ($ast -is [System.Management.Automation.Language.ArrayLiteralAst]) { return @($ast.Elements | Where-Object { -not (Constant $_) }).Count -eq 0 }
  return $ast -is [System.Management.Automation.Language.ConstantExpressionAst]
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

function InOrder($ast) {
  for ($p = $ast.Parent; $null -ne $p -and $p -ne $root; $p = $p.Parent) {
    if ($p -is [System.Management.Automation.Language.LoopStatementAst] -or $p -is [System.Management.Automation.Language.SwitchStatementAst] -or $p -is [System.Management.Automation.Language.ScriptBlockAst] -or $p -is [System.Management.Automation.Language.TrapStatementAst]) { return $false }
  }
  return $true
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
      'MemberName' { $out.member = $result }
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
$dynamics = @('invoke-expression', 'iex', 'start-process', 'saps', 'start', 'invoke-command', 'icm', 'start-job', 'sajb', 'start-threadjob', 'set-alias', 'sal', 'new-alias', 'nal', 'add-type')
$members = @('foreach-object', '%', 'foreach')
$drives = @('new-psdrive', 'ndr', 'mount')
$variableCommands = @('set-variable', 'sv', 'new-variable', 'nv', 'remove-variable', 'rv', 'clear-variable', 'clv', 'get-variable', 'gv')
$variableParameters = @('outvariable', 'errorvariable', 'warningvariable', 'informationvariable', 'pipelinevariable')
$variableAliases = @('ov', 'ev', 'wv', 'iv', 'pv')
$nameParameters = @('variable', 'bindingvariable') + $variableParameters

function NamesVariable($element) {
  if (-not ($element -is [System.Management.Automation.Language.CommandParameterAst])) { return $false }
  $p = $element.ParameterName.ToLowerInvariant()
  return $variableAliases -contains $p -or ($p.Length -ge 2 -and @($nameParameters | Where-Object { $_.StartsWith($p) }).Count -gt 0)
}
$codeMethods = @('invoke', 'invokereturnasis', 'invokewithcontext', 'invokescript', 'newscriptblock', 'addscript', 'addcommand', 'begininvoke')
$dotnet = @('system.io.file', 'io.file', 'file', 'system.io.directory', 'io.directory', 'directory')
$fileCommands = @('get-item', 'gi', 'get-childitem', 'gci', 'ls', 'dir', 'new-item', 'ni')
$unstable = New-Object System.Collections.ArrayList
$anyVariable = $false
# An instance Delete() deletes a file only on an object a file command, -PassThru or a FileInfo made; COM objects have
# one too.
$fileObjects = ($source -match 'FileInfo|DirectoryInfo|FileSystemInfo') -or @($root.FindAll({
  param($x)
  ($x -is [System.Management.Automation.Language.CommandAst] -and $fileCommands -contains (NameOf $x)) -or
  ($x -is [System.Management.Automation.Language.CommandParameterAst] -and $x.ParameterName.Length -ge 3 -and 'passthru'.StartsWith($x.ParameterName.ToLowerInvariant()))
}, $true)).Count -gt 0
$processStart = $source -match 'ProcessStartInfo|Diagnostics\.Process'

# A name handed over as text (-OutVariable d, Tee-Object -Variable d, Set-Item variable:d, 'TEMP' handed to
# SetEnvironmentVariable, '$d = 1' handed to iex) can write a variable without the parser seeing a variable there.
$named = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($s in $root.FindAll({ param($x) $x -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true)) {
  foreach ($m in [regex]::Matches($s.Value, '\$\{?(?:\w+:)?([\w?]+)')) { [void]$named.Add($m.Groups[1].Value) }
  $parent = $s.Parent
  $at = if ($parent -is [System.Management.Automation.Language.CommandAst]) { $parent.CommandElements.IndexOf($s) } else { -1 }
  if ($s.Value -match '^(?:[\w.]+\\)?(?:variable|env|environment):{1,2}[\\/]?(.+)$') { [void]$named.Add($Matches[1]) }
  elseif (($at -gt 0 -and (NamesVariable $parent.CommandElements[$at - 1])) -or (NamesVariable $parent) -or ($parent -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $parent.Member -ne $s -and $parent.Member.Value -match 'variable|^set$|^get$')) {
    [void]$named.Add(($s.Value -replace '^\+', '' -replace '^(?:script|global|local|private):', ''))
  }
}
foreach ($d in $root.FindAll({ param($x) $x -is [System.Management.Automation.Language.DataStatementAst] }, $true)) { if ($d.Variable) { [void]$named.Add($d.Variable) } }
foreach ($v in $root.FindAll({ param($x) $x -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)) {
  $path = $v.VariablePath.UserPath
  if ($v.Parent -is [System.Management.Automation.Language.ParameterAst] -or $named.Contains(($path -split ':')[-1])) { [void]$unstable.Add($path) }
}

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
    # PowerShell takes any unambiguous start of a parameter name, so -OutVar and -ErrorVar count too.
    $p = $a.ParameterName.ToLowerInvariant()
    if ($variableAliases -contains $p -or ($p.Length -ge 2 -and @($variableParameters | Where-Object { $_.StartsWith($p) }).Count -gt 0)) { $anyVariable = $true }
    continue
  }
  if ($a -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
    $member = if ($a.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $a.Member.Value.ToLowerInvariant() } else { $null }
    $type = if ($a.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) { $a.Expression.TypeName.FullName.ToLowerInvariant() } else { $null }
    if ($a.Static -and $member -eq 'delete' -and $dotnet -contains $type) {
      $first = if ($a.Arguments -and $a.Arguments.Count -gt 0) { Value $a.Arguments[0] } else { @{ dynamic = $a.Extent.Text } }
      [void]$items.Add(@{ kind = 'delete'; path = $first; literalPath = $null; literal = $true; dotnet = $true; whatIf = $false; bindError = $false; inPipeline = $false; ordered = (InOrder $a) })
    } elseif ($null -eq $member -or ($a.Static -and $null -eq $type) -or $codeMethods -contains $member -or
      ($member -eq 'create' -and $type -match '(^|\.)(scriptblock|powershell)$') -or
      ($member -eq 'start' -and ($type -match '(^|\.)process$' -or ($null -eq $type -and $processStart))) -or
      ($member.StartsWith('delete') -and ($null -ne $type -or $fileObjects))) {
      [void]$items.Add(@{ kind = 'dynamic'; text = $null; args = @() })
    }
    continue
  }
  if ($a.CommandElements[0] -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { continue }
  $name = NameOf $a
  if ($null -eq $name) {
    [void]$items.Add(@{ kind = 'dynamic'; text = $null; args = @() })
    continue
  }
  $pipeline = $a.Parent
  $inPipeline = ($pipeline -is [System.Management.Automation.Language.PipelineAst]) -and ($pipeline.PipelineElements.IndexOf($a) -gt 0)
  if ($deletes -contains $name) {
    $b = Bound $a
    [void]$items.Add(@{ kind = 'delete'; path = $b.path; literalPath = $b.literalPath; literal = ($null -ne $b.literalPath); dotnet = $false; whatIf = $b.whatIf; bindError = $b.bindError; inPipeline = $inPipeline; ordered = (InOrder $a) })
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
    [void]$items.Add(@{ kind = 'shell'; name = $name; args = $elements; raw = $a.Extent.Text; inPipeline = $inPipeline; ordered = (InOrder $a) })
  } elseif ($dynamics -contains $name) {
    if ($inPipeline) {
      [void]$items.Add(@{ kind = 'dynamic'; text = $null; args = @() })
    } else {
      $values = New-Object System.Collections.ArrayList
      foreach ($e in @($a.CommandElements | Select-Object -Skip 1)) {
        if (Constant $e) { continue }
        [void]$values.Add((Value $(if ($e -is [System.Management.Automation.Language.CommandParameterAst]) { $e.Argument } else { $e })))
      }
      [void]$items.Add(@{ kind = 'dynamic'; text = $a.Extent.Text; args = $values.ToArray() })
    }
  } elseif ($members -contains $name) {
    $m = (Bound $a).member
    if ($null -ne $m) {
      $v = $m.ConstantValue
      if ($null -eq $v -or ([string]$v) -match '^delete' -or $codeMethods -contains ([string]$v).ToLowerInvariant()) { [void]$items.Add(@{ kind = 'dynamic'; text = $null; args = @() }) }
    }
  } elseif ($drives -contains $name) {
    # A drive made here can carry a one-letter name that reads like a real drive.
    [void]$items.Add(@{ kind = 'dynamic'; text = $null; args = @() })
  } elseif ($variableCommands -contains $name) {
    $b = Bound $a
    $names = if ($null -ne $b.name) { @($b.name.ConstantValue) } else { @() }
    if ($names.Count -eq 0 -or @($names | Where-Object { $null -eq $_ -or [System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters([string]$_) }).Count -gt 0) { $anyVariable = $true }
    else { foreach ($n in $names) { [void]$unstable.Add([string]$n) } }
  }
}
$result = @{ errors = ($errors.Count -gt 0); items = $items.ToArray(); unstable = $unstable.ToArray(); anyVariable = $anyVariable }
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 12 -Compress))
`;

// Windows caps a command line at 32,767 characters, which the encoded reader outgrows, so only this loader goes on the
// command line and the reader arrives on stdin ahead of the command, split from it by a NUL.
const LOADER = String.raw`
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$all = [Console]::In.ReadToEnd()
$cut = $all.IndexOf([char]0)
& ([scriptblock]::Create($all.Substring(0, $cut))) $all.Substring($cut + 1)
`;

// Claude Code runs the PowerShell tool in pwsh when it finds it and in powershell.exe otherwise; read with the same one.
export function powerShellExe(env: Record<string, string | undefined>): string {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, 'pwsh.exe'))) return path.join(dir, 'pwsh.exe');
  }
  return 'powershell.exe';
}

export function realPowerShell(env: Record<string, string | undefined>, timeoutMs = PS_PARSE_TIMEOUT_MS): PowerShellRunner {
  const encoded = Buffer.from(LOADER, 'utf16le').toString('base64');
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
      child.stdin.end(`${READER}\0${source}`, 'utf8');
    });
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function partOf(raw: unknown): Part {
  if (!isRecord(raw)) throw new Error('bad value');
  if (typeof raw.const === 'string') return { const: raw.const };
  if (typeof raw.variable === 'string') return { variable: raw.variable };
  throw new Error('bad value');
}

function valueOf(raw: unknown): Value {
  if (!isRecord(raw)) throw new Error('bad value');
  if ('expand' in raw) {
    if (!Array.isArray(raw.expand) || typeof raw.text !== 'string') throw new Error('bad value');
    return { expand: raw.expand.map(partOf), text: raw.text };
  }
  if ('array' in raw) return { array: list(raw.array).map(valueOf) };
  if ('dynamic' in raw) {
    if (typeof raw.dynamic !== 'string') throw new Error('bad value');
    return { dynamic: raw.dynamic };
  }
  return partOf(raw);
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
      return { kind: 'delete', path: optionalValue(raw.path), literalPath: optionalValue(raw.literalPath), literal: flag(raw.literal), dotnet: flag(raw.dotnet), whatIf: flag(raw.whatIf), bindError: flag(raw.bindError), inPipeline: flag(raw.inPipeline), ordered: flag(raw.ordered) };
    case 'cd':
      return { kind: 'cd', path: optionalValue(raw.path), literal: flag(raw.literal), inBlock: flag(raw.inBlock) };
    case 'pop':
      return { kind: 'pop' };
    case 'assign':
      if (typeof raw.name !== 'string') throw new Error('bad item');
      return { kind: 'assign', name: raw.name, value: valueOf(raw.value) };
    case 'shell':
      if (typeof raw.name !== 'string' || typeof raw.raw !== 'string') throw new Error('bad item');
      return { kind: 'shell', name: raw.name, args: list(raw.args).map(valueOf), raw: raw.raw, inPipeline: flag(raw.inPipeline), ordered: flag(raw.ordered) };
    case 'dynamic':
      if ((raw.text != null && typeof raw.text !== 'string') || !Array.isArray(raw.args)) throw new Error('bad item');
      return { kind: 'dynamic', text: typeof raw.text === 'string' ? raw.text : null, args: raw.args.map(valueOf) };
    default:
      throw new Error('bad item');
  }
}

function parse(stdout: string): Parsed {
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed) || parsed.errors !== false || !Array.isArray(parsed.items) || !Array.isArray(parsed.unstable) || typeof parsed.anyVariable !== 'boolean') throw new Error('bad answer');
  const unstable = parsed.unstable.map((name) => {
    if (typeof name !== 'string') throw new Error('bad answer');
    return baseName(name);
  });
  return { items: parsed.items.map(itemOf), unstable: new Set(unstable), anyVariable: parsed.anyVariable };
}

// $script:x, $global:x and $x name the same variable in a one-off command.
const baseName = (name: string) => name.toLowerCase().replace(/^(?:script|local|global|private|using|variable):/, '');

// Only the FileSystem provider holds files; null means another provider's path.
function fileSystemPath(value: string): string | null {
  const qualified = /^(?:[\w.]+\\)?(\w+)::/.exec(value);
  if (!qualified) return value;
  return qualified[1].toLowerCase() === 'filesystem' ? value.slice(qualified[0].length) : null;
}

function classify(value: string, literal: boolean, cwd: string | null, ctx: ReadCtx): { real?: RmTarget; unresolvable?: string } {
  const text = fileSystemPath(value);
  if (text === null) return {};
  const drive = /^([A-Za-z][A-Za-z0-9_]+):/.exec(text);
  if (drive) return OTHER_DRIVES.has(drive[1].toLowerCase()) ? {} : { unresolvable: `a path on a PowerShell drive that cannot be worked out (${value})` };
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
  const text = fileSystemPath(value);
  if (text === null || text === '-' || text === '+' || /^[A-Za-z][A-Za-z0-9_]+:/.test(text) || (!literal && /[*?[]/.test(text))) return null;
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
    // A loop, a function or a script block can run after a later folder move, so its relative names follow no move.
    const moves = items.some((item) => item.kind === 'cd' || item.kind === 'pop');
    // .NET reads a relative path in the process's folder, which Set-Location does not change but CurrentDirectory does.
    const processFolder = /CurrentDirectory/i.test(source) ? null : ctx.cwd;
    const vars = new Map<string, string | null>();
    for (const name of KNOWN_ENV) {
      const value = ctx.env[name];
      if (value) vars.set(`env:${name.toLowerCase()}`, value);
    }
    vars.set('home', ctx.home);
    let cwd = ctx.cwd;
    const variable = (name: string, here: string | null): string | null => {
      const key = baseName(name);
      if (anyVariable || unstable.has(key)) return null;
      if (key === 'pwd') return assigned.has('pwd') ? null : here;
      return vars.get(key) ?? null;
    };
    const textOf = (value: Value | null, here: string | null = cwd): string | null => {
      if (!value) return null;
      if ('const' in value) return value.const;
      if ('variable' in value) return variable(value.variable, here);
      if ('expand' in value) {
        let text = '';
        for (const part of value.expand) {
          const piece = 'const' in part ? part.const : variable(part.variable, here);
          if (piece === null) return null;
          text += piece;
        }
        return text;
      }
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
        if (item.inPipeline && DELETE_WORD.test(source)) return deny(`pipeline input feeding a shell (${item.raw})`);
        const here = item.ordered || !moves ? cwd : null;
        // Windows PowerShell passes an argument's inner double quotes to a program unescaped, so bash or PowerShell
        // would split it differently; cmd reads its whole command line again and keeps them.
        const args = item.args.map((a) => textOf(a, here)).map((t) => (t !== null && item.name !== 'cmd' && t.includes('"') ? null : t));
        out.shells.push({ name: item.name, args, cwd: here, raw: item.raw });
      } else if (item.kind === 'dynamic') {
        // A named call runs its own text and its arguments; with an argument that cannot be worked out, or with no
        // name, it could run anything the command holds.
        const values = item.text === null ? null : item.args.map((a) => textOf(a));
        const code = values === null || values.includes(null) ? source : [item.text, ...values].join(' ');
        if (DELETE_WORD.test(code) && !out.failed.length) out.failed.push(excerpt);
      } else {
        if (item.whatIf) continue;
        if (item.bindError) {
          if (!out.failed.length) out.failed.push(excerpt);
          continue;
        }
        if (item.inPipeline) return deny('pipeline input feeding Remove-Item');
        const here = item.ordered || !moves ? cwd : null;
        const values = list(item.literalPath ?? item.path).flatMap((v) => ('array' in (v as Value) ? (v as { array: Value[] }).array : [v as Value]));
        for (const v of values) {
          if ('dynamic' in v || 'array' in v) return deny(`an expression that cannot be worked out (${'dynamic' in v ? v.dynamic : 'a nested list'})`);
          const text = textOf(v, here);
          if (text === null) return deny(`a variable that cannot be worked out (${'variable' in v ? `$${v.variable}` : 'expand' in v ? v.text : ''})`);
          const c = classify(text, item.literal, item.dotnet ? processFolder : here, ctx);
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
