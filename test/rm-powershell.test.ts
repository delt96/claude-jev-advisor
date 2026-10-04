import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POWERSHELL_WORDS, readPowerShell, realPowerShell, type PowerShellRunner } from '../src/rm/powershell.js';

const PROJECT = 'C:\\workspace\\proj';
const TMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
const skip = process.platform !== 'win32' && 'PowerShell parsing is checked on Windows only';
const real = realPowerShell(process.env);

type Options = { cwd?: string | null; exists?: (p: string) => boolean; run?: PowerShellRunner };

function read(source: string, { cwd = PROJECT, exists = () => true, run = real }: Options = {}) {
  const env = { TEMP: TMP, TMP, USERPROFILE: 'C:\\Users\\me' };
  return readPowerShell(source, { cwd, home: 'C:\\Users\\me', tmpdirs: [TMP], env, probe: { exists, isIgnored: () => false } }, run);
}

const shown = async (source: string, opts?: Options) => (await read(source, opts)).targets.map((t) => t.shown);
const denied = async (source: string, opts?: Options) => (await read(source, opts)).deny ?? '';

test('the words that start the parser', () => {
  for (const source of ['Remove-Item x', 'rm x', 'ri x', 'del x', 'erase x', 'rd x', 'rmdir x', '[IO.File]::Delete("x")', '(Get-Item x).Delete()', 'Get-ChildItem | % Delete', 'cmd /c dir', 'pwsh.exe -c x', 'bash -c ls']) {
    assert.match(source, POWERSHELL_WORDS, source);
  }
  for (const source of ['Get-ChildItem', 'Push-Location x', 'Remove-ItemProperty -Path HKCU:\\X -Name y', 'git status', 'npm run build']) {
    assert.doesNotMatch(source, POWERSHELL_WORDS, source);
  }
});

test('a command without those words never starts PowerShell', async () => {
  let calls = 0;
  const spy: PowerShellRunner = async () => (calls++, null);
  assert.deepEqual(await read('Get-ChildItem; git status', { run: spy }), { deny: null, targets: [], failed: [], shells: [] });
  assert.equal(calls, 0);
});

test('aliases, shortened parameters, positional paths and lists name what is deleted', { skip }, async () => {
  assert.deepEqual(await shown('rm -r -fo .\\dist2, "C:\\a b\\c.txt"'), ['C:\\workspace\\proj\\dist2', 'C:\\a b\\c.txt']);
  assert.deepEqual(await shown('Microsoft.PowerShell.Management\\Remove-Item x.txt'), ['C:\\workspace\\proj\\x.txt']);
  assert.deepEqual(await shown('erase a.txt; rd old; rmdir older; del b.txt'), ['C:\\workspace\\proj\\a.txt', 'C:\\workspace\\proj\\old', 'C:\\workspace\\proj\\older', 'C:\\workspace\\proj\\b.txt']);
  assert.deepEqual(await shown('ri -Pa:$env:TEMP\\y.txt'), []);
});

test('a deletion inside a block, a script block or a subexpression is found', { skip }, async () => {
  const at = (name: string) => ({ shown: `C:\\workspace\\proj\\${name}`, path: `C:\\workspace\\proj\\${name}` });
  assert.deepEqual(await read('if ($ok) { Remove-Item a.txt }; & { ri b.txt }; $r = $(Remove-Item c.txt); foreach ($i in 1) { del d.txt }'), {
    deny: null,
    targets: [at('a.txt'), at('b.txt'), at('c.txt'), at('d.txt')],
    failed: [],
    shells: [],
  });
});

test('-WhatIf, other providers, missing files and plain text are left alone', { skip }, async () => {
  assert.deepEqual(await read('Remove-Item x.txt -WhatIf'), { deny: null, targets: [], failed: [], shells: [] });
  assert.deepEqual(await shown('Remove-Item x.txt -WhatIf:$false'), ['C:\\workspace\\proj\\x.txt']);
  const none = { deny: null, targets: [], failed: [], shells: [] };
  assert.deepEqual(await read('Remove-Item Env:FOO, HKCU:\\Software\\X, Registry::HKEY_CURRENT_USER\\X'), none);
  assert.deepEqual(await read('Write-Host "Remove-Item x"'), none);
  assert.deepEqual(await read('Remove-Item gone.txt', { exists: () => false }), none);
});

test('-WhatIf with a value other than the constant true still deletes', { skip }, async () => {
  assert.deepEqual(await shown('$x = $false; Remove-Item a.txt -WhatIf:$x'), ['C:\\workspace\\proj\\a.txt']);
  assert.deepEqual(await shown('Remove-Item a.txt -WhatIf:(0)'), ['C:\\workspace\\proj\\a.txt']);
});

test('known variables and plain assignments are read, other variables and expressions are refused', { skip }, async () => {
  assert.deepEqual(await shown('Remove-Item "$env:USERPROFILE\\n.txt", $HOME\\m.txt, "${env:TEMP}\\t.txt"'), ['C:\\Users\\me\\n.txt', 'C:\\Users\\me\\m.txt']);
  assert.deepEqual(await shown('$d = "C:\\data"; Remove-Item "$d\\x.txt"; Remove-Item $d'), ['C:\\data\\x.txt', 'C:\\data']);
  assert.match(await denied('Remove-Item $foo'), /a variable that cannot be worked out \(\$foo\)/);
  assert.match(await denied('Get-ChildItem | ForEach-Object { Remove-Item $_ }'), /a variable that cannot be worked out \(\$_\)/);
  assert.match(await denied('Remove-Item (Join-Path $a b)'), /an expression that cannot be worked out/);
  assert.match(await denied('Remove-Item @splat'), /an expression that cannot be worked out \(@splat\)/);
  assert.match(await denied('foreach ($f in 1) { $d = "C:\\x" }; Remove-Item $d'), /a variable that cannot be worked out/);
  assert.match(await denied('Remove-Item $foo'), /Example: Remove-Item -LiteralPath "C:\\full\\path\\file\.txt"/);
});

test('pipeline input feeding Remove-Item is refused like xargs feeding rm', { skip }, async () => {
  assert.match(await denied('Get-ChildItem *.log | Remove-Item'), /pipeline input feeding Remove-Item/);
  assert.deepEqual(await shown('Remove-Item x.txt | Out-Null'), ['C:\\workspace\\proj\\x.txt']);
});

test('a wildcard in the last part asks, a wildcard in a folder name is refused, -LiteralPath has none', { skip }, async () => {
  assert.deepEqual((await read('Remove-Item dist2\\*.js')).targets, [{ shown: 'C:\\workspace\\proj\\dist2\\*.js', path: null }]);
  assert.match(await denied('Remove-Item src*\\x.ts'), /a wildcard in a folder name/);
  assert.deepEqual((await read('Remove-Item -LiteralPath "a[1].txt"')).targets, [{ shown: 'C:\\workspace\\proj\\a[1].txt', path: 'C:\\workspace\\proj\\a[1].txt' }]);
  assert.deepEqual((await read('Remove-Item "a[1].txt"')).targets, [{ shown: 'C:\\workspace\\proj\\a[1].txt', path: null }]);
  assert.deepEqual(await shown(`Remove-Item "${TMP}\\cja*.txt"`), []);
});

test('Set-Location and its relatives move relative names, and a move inside a block makes the folder unknown', { skip }, async () => {
  assert.deepEqual(await shown('Set-Location sub; Remove-Item a.txt'), ['C:\\workspace\\proj\\sub\\a.txt']);
  assert.deepEqual(await shown('Push-Location D:\\x; ri y.txt'), ['D:\\x\\y.txt']);
  assert.deepEqual(await shown('Set-Location ~; Remove-Item n.txt'), ['C:\\Users\\me\\n.txt']);
  assert.deepEqual(await shown('cd sub; Remove-Item $PWD\\a.txt'), ['C:\\workspace\\proj\\sub\\a.txt']);
  assert.match(await denied('Pop-Location; Remove-Item y.txt'), /a path relative to a folder that cannot be worked out/);
  assert.match(await denied('if ($true) { Set-Location sub }; Remove-Item y.txt'), /a path relative to a folder that cannot be worked out/);
  assert.deepEqual(await shown('Pop-Location; Remove-Item C:\\abs\\y.txt'), ['C:\\abs\\y.txt']);
});

test('.NET File and Directory Delete calls are deletions too', { skip }, async () => {
  assert.deepEqual(await shown('[System.IO.File]::Delete("C:\\q.txt"); [IO.Directory]::Delete(\'C:\\old\', $true)'), ['C:\\q.txt', 'C:\\old']);
  assert.match(await denied('[IO.File]::Delete($p)'), /a variable that cannot be worked out \(\$p\)/);
});

test('network paths ask without a lookup; provider-qualified and Korean paths are read', { skip }, async () => {
  const seen: string[] = [];
  const unc = await read('Remove-Item \\\\server\\share\\x.txt', { exists: (p) => (seen.push(p), true) });
  assert.deepEqual(unc.targets, [{ shown: '\\\\server\\share\\x.txt', path: null }]);
  assert.deepEqual(seen, []);
  assert.deepEqual(await shown('Remove-Item Microsoft.PowerShell.Core\\FileSystem::C:\\data\\x.txt'), ['C:\\data\\x.txt']);
  assert.deepEqual(await shown('Remove-Item "C:\\한글 폴더\\파일.txt"'), ['C:\\한글 폴더\\파일.txt']);
});

test('shells started from PowerShell are handed back with their arguments and folder', { skip }, async () => {
  const result = await read('Set-Location sub; bash -c "rm x"; cmd /c del y; & "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Remove-Item z"; powershell -enc $b');
  assert.deepEqual(result.shells, [
    { name: 'bash', args: ['-c', 'rm x'], cwd: 'C:\\workspace\\proj\\sub', raw: 'bash -c "rm x"' },
    { name: 'cmd', args: ['/c', 'del', 'y'], cwd: 'C:\\workspace\\proj\\sub', raw: 'cmd /c del y' },
    { name: 'pwsh', args: ['-Command', 'Remove-Item z'], cwd: 'C:\\workspace\\proj\\sub', raw: '& "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Remove-Item z"' },
    { name: 'powershell', args: ['-enc', null], cwd: 'C:\\workspace\\proj\\sub', raw: 'powershell -enc $b' },
  ]);
});

test('a parse error, a binding error or a failed run asks with the start of the command', { skip }, async () => {
  const long = `Remove-Item (${'x'.repeat(300)}`;
  assert.deepEqual(await read(long), { deny: null, targets: [], failed: [long.slice(0, 200)], shells: [] });
  const fake = (stdout: string | null): PowerShellRunner => async () => stdout;
  assert.deepEqual((await read('Remove-Item x', { run: fake(null) })).failed, ['Remove-Item x']);
  assert.deepEqual((await read('Remove-Item x', { run: fake('not json') })).failed, ['Remove-Item x']);
  assert.deepEqual((await read('Remove-Item x', { run: fake('{"items":[]}') })).failed, ['Remove-Item x']);
  assert.deepEqual((await read('Remove-Item x', { run: async () => { throw new Error('boom'); } })).failed, ['Remove-Item x']);
  const bindError = fake('{"errors":false,"anyVariable":false,"unstable":[],"items":[{"kind":"delete","path":null,"literalPath":null,"literal":false,"dotnet":false,"whatIf":false,"bindError":true,"inPipeline":false,"ordered":true},{"kind":"delete","path":{"const":"z.txt"},"literalPath":null,"literal":false,"dotnet":false,"whatIf":false,"bindError":true,"inPipeline":false,"ordered":true}]}');
  assert.deepEqual(await read('Remove-Item -LP x.txt; ri -LP y.txt', { run: bindError }), { deny: null, targets: [], failed: ['Remove-Item -LP x.txt; ri -LP y.txt'], shells: [] });
});

test('an answer of an unexpected shape, or a reading error, asks', async () => {
  const fake = (stdout: string): PowerShellRunner => async () => stdout;
  const wrap = (items: string) => `{"errors":false,"anyVariable":false,"unstable":[],"items":${items}}`;
  for (const stdout of [
    wrap('[null]'),
    wrap('[{"kind":"delete","path":"a.txt","literalPath":null,"literal":false,"dotnet":false,"whatIf":false,"bindError":false,"inPipeline":false}]'),
    wrap('[{"kind":"delete","path":{"const":5},"literalPath":null,"literal":false,"dotnet":false,"whatIf":false,"bindError":false,"inPipeline":false}]'),
    wrap('[{"kind":"delete","path":{"expand":"$d\\\\x"},"literalPath":null,"literal":false,"dotnet":false,"whatIf":false,"bindError":false,"inPipeline":false,"ordered":true}]'),
    wrap('[{"kind":"delete","path":{"const":"a.txt"},"literalPath":null,"literal":false,"dotnet":false,"whatIf":false,"bindError":false,"inPipeline":false}]'),
    wrap('[{"kind":"surprise"}]'),
    wrap('null'),
    '{"errors":false,"anyVariable":false,"unstable":[]}',
    '{"errors":false,"anyVariable":false,"items":[]}',
    '{"errors":false,"anyVariable":false,"unstable":"d","items":[]}',
    '{"errors":false,"items":[]}',
    'null',
  ]) {
    assert.deepEqual((await read('Remove-Item x', { run: fake(stdout) })).failed, ['Remove-Item x'], stdout);
  }
});

test('a variable written any other way than one plain top-level = is unknown everywhere', { skip }, async () => {
  const sources = [
    '$p = "$env:TEMP\\x"; $script:p = "C:\\data"; Remove-Item $p',
    '[string]$d = "C:\\data"; Remove-Item $d',
    '$d, $e = "C:\\a", "C:\\b"; Remove-Item $d',
    'Set-Variable d "C:\\data"; Remove-Item $d',
    '$d = "$env:TEMP\\x"; foreach ($i in 1) { Remove-Item $d; $d = "C:\\data" }',
    '$d = "$env:TEMP\\x"; function f { Remove-Item $d }; $d = "C:\\data"; f',
    'for ($i = 1; $i -le 3; $i++) { Remove-Item "C:\\data\\log$i.txt" }',
    '$p = "C:\\data"; $p += "\\a.txt"; Remove-Item $p',
    'Get-Item x -OutVariable d; Remove-Item "C:\\data\\$d"',
  ];
  const results = await Promise.all(sources.map((source) => denied(source)));
  sources.forEach((source, i) => assert.match(results[i], /a variable that cannot be worked out/, source));
});

test('a variable whose name is handed to a command or a variable method as text, or declared as a parameter, is unknown', { skip }, async () => {
  assert.deepEqual(await shown('$png = "C:\\data\\a.png"; $ch.Chart.Export($png, "PNG"); Remove-Item $png'), ['C:\\data\\a.png']);
  const sources = [
    '$d = "$env:TEMP\\x"; Get-Item C:\\data -OutVar d | Out-Null; Remove-Item $d -Recurse',
    '$d = "$env:TEMP\\x"; Get-Item C:\\nope -ErrorVar d; Remove-Item $d -Recurse',
    '$d = "$env:TEMP\\x"; function f($d) { Remove-Item $d -Recurse }; f C:\\data',
    '$d = "$env:TEMP\\x"; Get-Item C:\\data | Tee-Object -Variable d | Out-Null; Remove-Item $d -Recurse',
    '$d = "$env:TEMP\\x"; iex \'$d = "C:\\data"\'; Remove-Item $d -Recurse',
    '$d = "$env:TEMP\\x"; data d { "C:\\data" }; Remove-Item $d -Recurse',
    '$d = "$env:TEMP\\x"; Set-Item variable:d C:\\data; Remove-Item $d -Recurse',
    '$d = "$env:TEMP\\x"; (Get-Variable d).Value = "C:\\data"; Remove-Item $d -Recurse',
    '[Environment]::SetEnvironmentVariable("TEMP", "C:\\data"); Remove-Item "$env:TEMP\\x" -Recurse',
    '$PWD = "C:\\data"; Remove-Item "$PWD\\x" -Recurse',
  ];
  const results = await Promise.all(sources.map((source) => denied(source)));
  sources.forEach((source, i) => assert.match(results[i], /a variable that cannot be worked out/, source));
});

test('cd.. and cd\\ move, and a Set-Location target with a wildcard or another provider makes the folder unknown', { skip }, async () => {
  assert.deepEqual(await shown('cd..; Remove-Item a.txt'), ['C:\\workspace\\a.txt']);
  assert.deepEqual(await shown('cd\\; Remove-Item a.txt'), ['C:\\a.txt']);
  assert.match(await denied('Set-Location sr*; Remove-Item a.txt'), /a path relative to a folder that cannot be worked out/);
  assert.match(await denied('Set-Location HKCU:\\Software; Remove-Item a.txt'), /a path relative to a folder that cannot be worked out/);
  assert.deepEqual(await shown('Set-Location FileSystem::C:\\data; Remove-Item a.txt'), ['C:\\data\\a.txt']);
  assert.deepEqual(await shown('Set-Location -LiteralPath "a[1]"; Remove-Item x.txt'), ['C:\\workspace\\proj\\a[1]\\x.txt']);
});

test('pipeline input feeding a shell is refused', { skip }, async () => {
  assert.match(await denied('"rm -rf /c/data" | bash'), /pipeline input feeding a shell/);
  assert.match(await denied('\'Remove-Item C:\\data\' | powershell -Command -'), /pipeline input feeding a shell/);
});

test('PowerShell, not a pattern, decides where a variable name in a string ends', { skip }, async () => {
  assert.deepEqual(await shown('$폴더 = "C:\\data"; Remove-Item "$폴더\\a.txt"'), ['C:\\data\\a.txt']);
  assert.match(await denied('Remove-Item "$env:TEMP한\\..\\Temp\\x" -Recurse'), /a variable that cannot be worked out/);
  assert.match(await denied('Remove-Item -LiteralPath "$PWD?\\..\\proj\\build" -Recurse'), /a variable that cannot be worked out/);
  assert.match(await denied('Remove-Item "$HOME\\a`$HOME"'), /an expression that cannot be worked out/);
  assert.deepEqual((await read('cmd /c "rmdir /s /q `"$env:TEMP\\x`""')).shells[0].args, ['/c', `rmdir /s /q "${TMP}\\x"`]);
});

test('a command PowerShell runs by a name it only learns while running asks when the command deletes', { skip }, async () => {
  const sources = [
    '$c = "Remove-Item"; & $c C:\\data\\a.txt',
    'Invoke-Expression \'Remove-Item C:\\data\\a.txt\'',
    'Start-Process pwsh -ArgumentList \'-c Remove-Item C:\\data\\a.txt\'',
    'Set-Alias zz Remove-Item; zz C:\\data\\a.txt',
  ];
  const results = await Promise.all(sources.map((source) => read(source)));
  sources.forEach((source, i) => assert.deepEqual(results[i].failed, [source], source));
  assert.deepEqual(await read('Start-Process notepad; Remove-Item C:\\data\\a.txt'), { deny: null, targets: [{ shown: 'C:\\data\\a.txt', path: 'C:\\data\\a.txt' }], failed: [], shells: [] });
  assert.deepEqual(await shown('using namespace System.IO; [File]::Delete("C:\\data\\a.txt")'), ['C:\\data\\a.txt']);
});

test('code handed over in a variable or a pipe, run by a method, or a Delete method the reader cannot follow asks', { skip }, async () => {
  const sources = [
    '$s = \'Remove-Item C:\\data\\a.txt\'; Invoke-Expression $s',
    '\'Remove-Item C:\\data -Recurse\' | iex',
    '$n = \'Remove-Item\'; Set-Alias zz $n; zz C:\\data\\a.txt',
    '$a = \'-c Remove-Item C:\\data\'; Start-Process pwsh -ArgumentList $a',
    '$sb = [scriptblock]::Create(\'Remove-Item C:\\data\'); Invoke-Command $sb',
    '[scriptblock]::Create(\'Remove-Item C:\\data\').Invoke()',
    '$ExecutionContext.InvokeCommand.InvokeScript(\'Remove-Item C:\\data\')',
    '$t = [IO.File]; $t::Delete(\'C:\\data\\a.txt\')',
    '[Diagnostics.Process]::Start(\'cmd\', \'/c rmdir /s /q C:\\data\')',
    '(Get-Item C:\\data).Delete($true)',
    'Get-ChildItem C:\\data | ForEach-Object Delete',
    'Get-ChildItem C:\\data | ForEach-Object { $_.Delete() }',
    '$f = Copy-Item a.txt C:\\data\\b.txt -PassThru; $f.Delete()',
  ];
  const results = await Promise.all(sources.map((source) => read(source)));
  sources.forEach((source, i) => assert.deepEqual(results[i], { deny: null, targets: [], failed: [source], shells: [] }, source));
  const plain = [
    '$p = "C:\\data\\deck.pptx"; Start-Process $p',
    '$ch = $ws.ChartObjects().Add(0, 0, 10, 10); $ch.Delete()',
    '[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)',
    '$sw = New-Object Diagnostics.Stopwatch; $sw.Start()',
  ].map((source) => `${source}; Remove-Item C:\\data\\a.txt`);
  const plainResults = await Promise.all(plain.map((source) => read(source)));
  plain.forEach((source, i) => assert.deepEqual(plainResults[i], { deny: null, targets: [{ shown: 'C:\\data\\a.txt', path: 'C:\\data\\a.txt' }], failed: [], shells: [] }, source));
});

test('a relative .NET Delete path is read in the folder the command started in', { skip }, async () => {
  assert.deepEqual(await shown('Set-Location sub; [IO.File]::Delete("a.txt")'), ['C:\\workspace\\proj\\a.txt']);
  assert.match(await denied('[Environment]::CurrentDirectory = "C:\\data"; [IO.File]::Delete("a.txt")'), /a path relative to a folder that cannot be worked out/);
});

test('a loop, a function or a script block that may run after a folder move reads relative names in an unknown folder', { skip }, async () => {
  assert.match(await denied('foreach ($i in 1, 2) { Remove-Item a.txt; Set-Location C:\\data }'), /a path relative to a folder that cannot be worked out/);
  assert.match(await denied('function f { Remove-Item a.txt }; Set-Location C:\\data; f'), /a path relative to a folder that cannot be worked out/);
  assert.equal((await read('foreach ($i in 1, 2) { bash -c "rm a"; Set-Location C:\\data }')).shells[0].cwd, null);
  assert.deepEqual(await shown('Set-Location sub; if (Test-Path a.txt) { Remove-Item a.txt }; foreach ($i in 1) { Remove-Item C:\\abs\\b.txt }'), ['C:\\workspace\\proj\\sub\\a.txt', 'C:\\abs\\b.txt']);
});

test('paths on providers other than the file system are left alone, and a drive the reader does not know is refused', { skip }, async () => {
  assert.match(await denied('Set-Location Microsoft.PowerShell.Core\\Registry::HKCU\\Software; Remove-Item a.txt'), /a path relative to a folder that cannot be worked out/);
  assert.deepEqual(await read('Remove-Item Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER\\X, Function:f, Alias:zz, Variable:v, Cert:\\x, WSMan:\\x, HKLM:\\x'), { deny: null, targets: [], failed: [], shells: [] });
  assert.match(await denied('New-PSDrive -Name Data -PSProvider FileSystem -Root C:\\data; Remove-Item Data:\\x -Recurse'), /a path on a PowerShell drive that cannot be worked out \(Data:\\x\)/);
});

test('the real runner gives up after its time limit', { skip }, async () => {
  const started = Date.now();
  assert.equal(await realPowerShell(process.env, 1)('Remove-Item x'), null);
  assert.ok(Date.now() - started < 2000);
});
