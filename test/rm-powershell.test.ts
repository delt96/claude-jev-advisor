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
  for (const source of ['Remove-Item x', 'rm x', 'ri x', 'del x', 'erase x', 'rd x', 'rmdir x', '[IO.File]::Delete("x")', 'cmd /c dir', 'pwsh.exe -c x', 'bash -c ls']) {
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
  assert.deepEqual(await shown('if ($ok) { Remove-Item a.txt }; & { ri b.txt }; $r = $(Remove-Item c.txt); foreach ($i in 1) { del d.txt }'), [
    'C:\\workspace\\proj\\a.txt',
    'C:\\workspace\\proj\\b.txt',
    'C:\\workspace\\proj\\c.txt',
    'C:\\workspace\\proj\\d.txt',
  ]);
});

test('-WhatIf, other providers, missing files and plain text are left alone', { skip }, async () => {
  assert.deepEqual(await read('Remove-Item x.txt -WhatIf'), { deny: null, targets: [], failed: [], shells: [] });
  assert.deepEqual(await shown('Remove-Item x.txt -WhatIf:$false'), ['C:\\workspace\\proj\\x.txt']);
  assert.deepEqual(await shown('Remove-Item Env:FOO, HKCU:\\Software\\X, Registry::HKEY_CURRENT_USER\\X'), []);
  assert.deepEqual(await shown('Write-Host "Remove-Item x"'), []);
  assert.deepEqual(await shown('Remove-Item gone.txt', { exists: () => false }), []);
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
  const bindError = fake('{"errors":false,"items":{"kind":"delete","name":"remove-item","path":null,"literalPath":null,"whatIf":false,"bindError":true,"inPipeline":false}}');
  assert.deepEqual(await read('Remove-Item -LP x.txt', { run: bindError }), { deny: null, targets: [], failed: ['Remove-Item -LP x.txt'], shells: [] });
});

test('the real runner gives up after its time limit', { skip }, async () => {
  const started = Date.now();
  assert.equal(await realPowerShell(process.env, 1)('Remove-Item x'), null);
  assert.ok(Date.now() - started < 2000);
});
