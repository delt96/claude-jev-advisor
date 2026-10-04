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
