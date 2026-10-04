import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTool, nestedScript } from '../src/rm/dispatch.js';
import { realPowerShell, type PowerShellRunner } from '../src/rm/powershell.js';
import type { ShellCall } from '../src/rm/targets.js';

const PROJECT = 'C:\\workspace\\proj';
const TMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
const skip = process.platform !== 'win32' && 'PowerShell parsing is checked on Windows only';
const real = realPowerShell(process.env);
const never: PowerShellRunner = async () => {
  throw new Error('PowerShell should not run');
};

function decide(tool: 'Bash' | 'PowerShell', command: string, run: PowerShellRunner = never) {
  const env = { TEMP: TMP, TMP, USERPROFILE: 'C:\\Users\\me' };
  return decideTool(tool, command, { cwd: PROJECT, home: 'C:\\Users\\me', tmpdirs: [TMP], env, probe: { exists: () => true, isIgnored: () => false } }, run);
}

const call = (name: string, args: (string | null)[]): ShellCall => ({ name, args, cwd: PROJECT, raw: [name, ...args].join(' ') });
const bashQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

test('the script inside a nested shell is found the way each shell reads its arguments', () => {
  assert.deepEqual(nestedScript(call('bash', ['-c', 'rm a'])), { shell: 'bash', script: 'rm a' });
  assert.deepEqual(nestedScript(call('sh', ['-lc', 'rm a', 'arg0'])), { shell: 'bash', script: 'rm a' });
  assert.deepEqual(nestedScript(call('bash', ['-e', '-o', 'pipefail', '-c', 'rm a'])), { shell: 'bash', script: 'rm a' });
  assert.equal(nestedScript(call('bash', ['script.sh'])), null);
  assert.deepEqual(nestedScript(call('bash', ['-c', null])), { shell: 'bash', script: null });
  assert.deepEqual(nestedScript(call('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Remove-Item', "'a b'"])), { shell: 'powershell', script: "Remove-Item 'a b'" });
  assert.deepEqual(nestedScript(call('pwsh', ['-c', 'ri x'])), { shell: 'powershell', script: 'ri x' });
  assert.deepEqual(nestedScript(call('powershell', ['Remove-Item', 'x'])), { shell: 'powershell', script: 'Remove-Item x' });
  assert.equal(nestedScript(call('pwsh', ['./clean.ps1'])), null);
  assert.equal(nestedScript(call('powershell', ['-File', 'clean.ps1'])), null);
  assert.equal(nestedScript(call('powershell', ['-Command', '-'])), null);
  const encoded = Buffer.from('Remove-Item C:\\data\\e.txt', 'utf16le').toString('base64');
  assert.deepEqual(nestedScript(call('powershell', ['-enc', encoded])), { shell: 'powershell', script: 'Remove-Item C:\\data\\e.txt' });
  assert.deepEqual(nestedScript(call('cmd', ['/s', '/c', 'del', 'C:\\a b\\x.txt'])), { shell: 'cmd', script: 'del "C:\\a b\\x.txt"' });
  assert.deepEqual(nestedScript(call('cmd', ['/c', 'del C:\\data\\a.txt & del "C:\\a b\\x.txt"'])), { shell: 'cmd', script: 'del C:\\data\\a.txt & del "C:\\a b\\x.txt"' });
  assert.deepEqual(nestedScript(call('cmd', ['//c', 'rd', '/s', '/q', 'old'])), { shell: 'cmd', script: 'rd /s /q old' });
  assert.equal(nestedScript(call('cmd', [])), null);
});

test('deletions inside shells started from Bash are judged like any other', async () => {
  assert.deepEqual((await decide('Bash', 'cmd //c del "C:\\data\\x.txt"'))?.targets, [{ shown: 'C:\\data\\x.txt', path: 'C:\\data\\x.txt' }]);
  assert.deepEqual((await decide('Bash', "bash -lc 'rm src/a.ts'"))?.targets, [{ shown: 'C:\\workspace\\proj\\src\\a.ts', path: 'C:\\workspace\\proj\\src\\a.ts' }]);
  assert.deepEqual((await decide('Bash', 'cd sub && sh -c "rm a.txt"'))?.targets, [{ shown: 'C:\\workspace\\proj\\sub\\a.txt', path: 'C:\\workspace\\proj\\sub\\a.txt' }]);
  assert.equal(await decide('Bash', 'bash -c "$CMD"'), null);
  assert.equal(await decide('Bash', 'bash ./build.sh && cmd //c dir'), null);
  assert.match((await decide('Bash', 'bash -c "rm $X"'))?.reason ?? '', /a bash script that cannot be worked out/);
  assert.match((await decide('Bash', 'find . | xargs sh -c \'rm "$@"\''))?.reason ?? '', /xargs feeding a shell that deletes/);
  assert.equal(await decide('Bash', 'find . -name "vite.config.*" | xargs -I{} sh -c \'echo "== {}"; cat "{}"\''), null);
});

test('a whole cmd script passed as one quoted argument is read without its outer quotes', async () => {
  assert.deepEqual((await decide('Bash', 'cmd //c "del C:\\data\\a.txt & del C:\\data\\b.txt"'))?.targets?.map((t) => t.shown), ['C:\\data\\a.txt', 'C:\\data\\b.txt']);
});

test('a shell that reads its script from a pipe is refused, a shell with its own script is read', async () => {
  assert.match((await decide('Bash', 'echo "rm -rf /c/data" | bash'))?.reason ?? '', /pipeline input feeding a shell \(bash\)/);
  assert.match((await decide('Bash', 'cat clean.sh |& sh -s'))?.reason ?? '', /pipeline input feeding a shell/);
  assert.match((await decide('Bash', 'cmd //c "type clean.txt | cmd"'))?.reason ?? '', /pipeline input feeding a shell \(cmd\)/);
  assert.equal(await decide('Bash', 'git log | bash -c "grep fix"'), null);
  assert.equal(await decide('Bash', 'echo hi || bash ./build.sh'), null);
});

test('PowerShell started from Bash, and shells started from PowerShell, are read too', { skip }, async () => {
  assert.deepEqual((await decide('Bash', 'powershell -NoProfile -Command "Remove-Item \'C:\\data\\a b.txt\'"', real))?.targets, [{ shown: 'C:\\data\\a b.txt', path: 'C:\\data\\a b.txt' }]);
  assert.deepEqual((await decide('PowerShell', 'cmd /c rd /s /q C:\\data\\old; bash -c "rm -rf /c/data/older"', real))?.targets, [
    { shown: 'C:\\data\\old', path: 'C:\\data\\old' },
    { shown: 'C:\\data\\older', path: 'C:\\data\\older' },
  ]);
  const encoded = Buffer.from('Remove-Item C:\\data\\e.txt', 'utf16le').toString('base64');
  assert.deepEqual((await decide('Bash', `powershell -EncodedCommand ${encoded}`, real))?.targets, [{ shown: 'C:\\data\\e.txt', path: 'C:\\data\\e.txt' }]);
});

test('three nested shells are read, a fourth is refused when it deletes', async () => {
  let script = 'rm x.txt';
  for (let i = 0; i < 3; i++) script = `bash -c ${bashQuote(script)}`;
  assert.deepEqual((await decide('Bash', script))?.targets, [{ shown: 'C:\\workspace\\proj\\x.txt', path: 'C:\\workspace\\proj\\x.txt' }]);
  assert.match((await decide('Bash', `bash -c ${bashQuote(script)}`))?.reason ?? '', /shells nested more than 3 deep/);
  let quiet = 'ls';
  for (let i = 0; i < 4; i++) quiet = `bash -c ${bashQuote(quiet)}`;
  assert.equal(await decide('Bash', quiet), null);
});

test('targets from every level are asked together, a refusal anywhere wins, and an unread part keeps Jev out', async () => {
  const both = await decide('Bash', 'rm a.txt && cmd //c del b.txt');
  assert.equal(both?.decision, 'ask');
  assert.equal(both?.reason, '실제 파일 삭제: C:\\workspace\\proj\\a.txt, C:\\workspace\\proj\\b.txt');
  assert.equal((await decide('Bash', 'rm a.txt; cmd //c del %FOO%'))?.decision, 'deny');
  const unread = await decide('Bash', 'rm a.txt && powershell -c "Remove-Item b.txt"', async () => null);
  assert.equal(unread?.decision, 'ask');
  assert.equal(unread?.reason, '실제 파일 삭제: C:\\workspace\\proj\\a.txt · 삭제 명령을 분석하지 못함: Remove-Item b.txt');
  assert.deepEqual(unread?.targets?.map((t) => t.path), ['C:\\workspace\\proj\\a.txt', null]);
});
