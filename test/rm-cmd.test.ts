import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCmd } from '../src/rm/cmd.js';

const PROJECT = 'C:\\workspace\\proj';
const TMP = 'C:\\Users\\me\\AppData\\Local\\Temp';

type Options = { cwd?: string | null; exists?: (p: string) => boolean };

function read(line: string, { cwd = PROJECT, exists = () => true }: Options = {}) {
  const env = { TEMP: TMP, TMP, USERPROFILE: 'C:\\Users\\me' };
  return readCmd(line, { cwd, home: 'C:\\Users\\me', tmpdirs: [TMP], env, probe: { exists, isIgnored: () => false } });
}

const shown = (line: string, opts?: Options) => read(line, opts).targets.map((t) => t.shown);
const denied = (line: string, opts?: Options) => read(line, opts).deny;

test('del, erase, rd and rmdir name the files and folders they delete', () => {
  assert.deepEqual(shown('del /q /f src\\a.ts'), ['C:\\workspace\\proj\\src\\a.ts']);
  assert.deepEqual(shown('erase C:\\data\\x.txt'), ['C:\\data\\x.txt']);
  assert.deepEqual(shown('rd /s /q dist2'), ['C:\\workspace\\proj\\dist2']);
  assert.deepEqual(shown('RMDIR old'), ['C:\\workspace\\proj\\old']);
  assert.deepEqual(shown('@del.exe a.txt'), ['C:\\workspace\\proj\\a.txt']);
  assert.deepEqual(shown('del "C:\\a b\\c.txt"'), ['C:\\a b\\c.txt']);
  assert.deepEqual(shown('del a.txt,b.txt;c.txt'), ['C:\\workspace\\proj\\a.txt', 'C:\\workspace\\proj\\b.txt', 'C:\\workspace\\proj\\c.txt']);
  assert.deepEqual(shown('dir & echo del a.txt'), []);
});

test('temp files, missing files and other commands are left alone', () => {
  assert.deepEqual(shown('del /q %TEMP%\\x.txt'), []);
  assert.deepEqual(shown(`rd /s /q "${TMP}\\probe"`), []);
  assert.deepEqual(shown('del gone.txt', { exists: () => false }), []);
  assert.deepEqual(shown('echo hi > out.txt'), []);
});

test('known variables are read, other variables are refused', () => {
  assert.deepEqual(shown('del %USERPROFILE%\\notes.txt'), ['C:\\Users\\me\\notes.txt']);
  assert.deepEqual(shown('del %CD%\\a.txt'), ['C:\\workspace\\proj\\a.txt']);
  assert.match(denied('del %FOO%\\a.txt') ?? '', /a variable that cannot be worked out \(%\?%\\a\.txt\)/);
  assert.match(denied('del !X!') ?? '', /cannot be worked out/);
  assert.match(denied('del %FOO%') ?? '', /Example: del \/q "C:\\full\\path\\file\.txt"/);
});

test('a caret escapes the next character and redirects are not targets', () => {
  assert.deepEqual(shown('del a^&b.txt'), ['C:\\workspace\\proj\\a&b.txt']);
  assert.deepEqual(shown('del x.txt 2>nul'), ['C:\\workspace\\proj\\x.txt']);
  assert.deepEqual(shown('del x.txt >nul 2>&1 && echo done'), ['C:\\workspace\\proj\\x.txt']);
});

test('cd, chdir, pushd and popd move the folder that relative names are read in', () => {
  assert.deepEqual(shown('cd sub && del y.txt'), ['C:\\workspace\\proj\\sub\\y.txt']);
  assert.deepEqual(shown('cd /d D:\\x & del y.txt'), ['D:\\x\\y.txt']);
  assert.deepEqual(shown('cd D:\\x & del y.txt'), ['C:\\workspace\\proj\\y.txt']);
  assert.deepEqual(shown('chdir Program Files & del y.txt'), ['C:\\workspace\\proj\\Program Files\\y.txt']);
  assert.deepEqual(shown('pushd D:\\x & del y.txt'), ['D:\\x\\y.txt']);
  assert.match(denied('popd & del y.txt') ?? '', /a path relative to a folder that cannot be worked out/);
  assert.match(denied('D: & del y.txt') ?? '', /cannot be worked out/);
  assert.deepEqual(shown('popd & del C:\\abs\\y.txt'), ['C:\\abs\\y.txt']);
});

test('a wildcard in the last part asks, a wildcard in a folder name is refused', () => {
  assert.deepEqual(shown('del /s dist2\\*.js'), ['C:\\workspace\\proj\\dist2\\*.js']);
  assert.deepEqual(shown('del C:\\*.log'), ['C:\\*.log']);
  assert.deepEqual(shown('del \\*.log'), ['C:\\*.log']);
  assert.deepEqual(shown('del %TEMP%\\cja*.txt'), []);
  assert.match(denied('del src*\\x.ts') ?? '', /a wildcard in a folder name/);
  assert.equal(read('del dist2\\*.js').targets[0].path, null);
});

test('a network path asks without being looked up', () => {
  const seen: string[] = [];
  const result = read('del \\\\server\\share\\x.txt', { exists: (p) => (seen.push(p), true) });
  assert.deepEqual(result.targets, [{ shown: '\\\\server\\share\\x.txt', path: null }]);
  assert.deepEqual(seen, []);
});

test('shells started from cmd are handed back with their arguments and folder', () => {
  const result = read('cd sub & powershell -NoProfile -Command "Remove-Item \'a b\'" & bash -c ls & cmd /c del %FOO%');
  assert.deepEqual(result.shells, [
    { name: 'powershell', args: ['-NoProfile', '-Command', "Remove-Item 'a b'"], cwd: 'C:\\workspace\\proj\\sub', raw: 'powershell -NoProfile -Command "Remove-Item \'a b\'"' },
    { name: 'bash', args: ['-c', 'ls'], cwd: 'C:\\workspace\\proj\\sub', raw: 'bash -c ls' },
    { name: 'cmd', args: ['/c', 'del', null], cwd: 'C:\\workspace\\proj\\sub', raw: 'cmd /c del %?%' },
  ]);
  assert.equal(result.deny, null);
});

test('a delete inside if, else, for, call, start or a block is refused with a hint to write a plain line', () => {
  for (const line of [
    'if exist dist2 rmdir /s /q dist2',
    'if /i not "%FOO%"=="x" del a.txt',
    'if exist a.txt (del a.txt) else (del b.txt)',
    'if exist a.txt (echo yes) else del b.txt',
    'if exist a.txt (del a.txt) else if exist b.txt del b.txt',
    'if exist x del report(1).txt',
    'if exist x (for %f in (*.txt) do del %f)',
    'for %f in (*.txt) do del %f',
    'call del x.txt',
    'start "" /b del y.txt',
    '(del a.txt) & (del b.txt)',
    '%X% del a.txt',
  ]) {
    assert.match(denied(line) ?? '', /a delete inside if, else, for, call, start, a block or a command that cannot be worked out \(.*\); write it as a plain del or rd line/, line);
  }
});

test('if, for, call and start lines that do not delete are left alone', () => {
  for (const line of ['if exist a.txt echo found', 'if %ERRORLEVEL% neq 0 exit /b 1', 'if exist node_modules (echo ok) else (npm install)', 'for /f "tokens=*" %i in (\'git status\') do echo %i', 'call build.bat', 'start "" notepad notes.txt']) {
    assert.deepEqual(read(line), { deny: null, targets: [], failed: [], shells: [] }, line);
  }
});

test('a switch right after the name, cd.. and cd\\ are read the way cmd reads them', () => {
  assert.deepEqual(shown('del/q x.txt'), ['C:\\workspace\\proj\\x.txt']);
  assert.deepEqual(shown('rd/s/q old'), ['C:\\workspace\\proj\\old']);
  assert.deepEqual(shown('cd.. & del x.txt'), ['C:\\workspace\\x.txt']);
  assert.deepEqual(shown('cd\\ & del x.txt'), ['C:\\x.txt']);
  assert.deepEqual(shown('del,a.txt'), ['C:\\workspace\\proj\\a.txt']);
});

test('parentheses inside a name belong to it', () => {
  assert.deepEqual(shown('del report(1).txt'), ['C:\\workspace\\proj\\report(1).txt']);
});

test('del /s deletes the name in every subfolder, so it asks for it as a pattern', () => {
  assert.deepEqual(read('del /s /q Thumbs.db', { exists: () => false }).targets, [{ shown: 'C:\\workspace\\proj\\Thumbs.db', path: null }]);
  assert.deepEqual(read('erase /q /s x.txt').targets, [{ shown: 'C:\\workspace\\proj\\x.txt', path: null }]);
  for (const line of ['del /s/q Thumbs.db', 'del/s/q Thumbs.db', 'del /q/s Thumbs.db', 'erase /f/s/q Thumbs.db']) {
    assert.deepEqual(read(line, { exists: () => false }).targets, [{ shown: 'C:\\workspace\\proj\\Thumbs.db', path: null }], line);
  }
  assert.deepEqual(shown('del /s /q %TEMP%\\x.tmp'), []);
  assert.deepEqual(read('rd /s /q old').targets, [{ shown: 'C:\\workspace\\proj\\old', path: 'C:\\workspace\\proj\\old' }]);
});

test('a command name behind an unknown variable is still read when its last part is known', () => {
  assert.deepEqual(read('"%ProgramFiles%\\Git\\bin\\bash.exe" -c "rm -rf x"').shells, [
    { name: 'bash', args: ['-c', 'rm -rf x'], cwd: PROJECT, raw: '"%?%\\Git\\bin\\bash.exe" -c "rm -rf x"' },
  ]);
  assert.deepEqual(shown('%EDITOR% notes.txt & del y.txt'), ['C:\\workspace\\proj\\y.txt']);
});

test('%CD% is the folder the line started in, and a drive-relative wildcard is refused', () => {
  assert.deepEqual(shown('cd sub & del %CD%\\a.txt'), ['C:\\workspace\\proj\\a.txt']);
  assert.match(denied('del D:*.log') ?? '', /a path relative to another drive's folder \(D:\)/);
});
