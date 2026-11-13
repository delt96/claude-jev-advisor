import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MAX_COPY_BYTES, MAX_NAMED_PATHS, fileRecovery, namedPaths, sameContent } from '../src/rm/recover.js';

const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'the rm helper runs on Windows only' };

function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function makeRepo(config: string[] = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  git(repo, 'init', '-q', '-b', 'main');
  for (const c of config) git(repo, 'config', ...c.split('='));
  return repo;
}

function commit(repo: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', `add ${file}`);
}

const cleanup = (...dirs: string[]) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

test('namedPaths finds literal paths in quotes and bare words, in Git Bash and Windows spelling, and skips variables, wildcards and URLs', () => {
  const command = '$v = "C:\\vault\\a.md"; fsutil hardlink create "$v" "C:\\repo\\docs\\a.md"; cp /c/repo/b.md ./c.md; rm $x *.md https://x.y/z';
  assert.deepEqual(namedPaths(command, 'C:\\work', 'C:\\Users\\me'), ['C:\\vault\\a.md', 'C:\\repo\\docs\\a.md', 'C:\\repo\\b.md', 'C:\\work\\c.md']);
  assert.deepEqual(namedPaths('cat ~/notes/n.md \\\\srv\\share\\x.md //srv/share/y.md', 'C:\\work', 'C:\\Users\\me'), ['C:\\Users\\me\\notes\\n.md']);
  const many = Array.from({ length: 40 }, (_, i) => `C:\\d\\f${i}.md`).join(' ');
  assert.equal(namedPaths(many, 'C:\\work', 'C:\\Users\\me').length, MAX_NAMED_PATHS);
  assert.deepEqual(namedPaths('cp C:\\d\\A.md c:/d/a.md', 'C:\\work', 'C:\\Users\\me'), ['C:\\d\\A.md']);
});

test('sameContent accepts identical bytes and line-ending-only differences, and nothing over 2MB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    const write = (name: string, data: string | Buffer) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, data);
      return file;
    };
    assert.equal(sameContent(write('a1', 'a\r\nb'), write('a2', 'a\nb')), true);
    assert.equal(sameContent(write('b1', 'a\nb'), write('b2', 'a\nc')), false);
    const big = Buffer.alloc(MAX_COPY_BYTES + 1, 'x');
    assert.equal(sameContent(write('c1', big), write('c2', big)), false);
  } finally {
    cleanup(dir);
  }
});

test('a tracked unchanged file is in git; a changed one is not and says so', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'a.md', 'one\n');
    const file = path.join(repo, 'a.md');
    assert.deepEqual(fileRecovery(file, [], [file]), { lift: 'git' });
    fs.appendFileSync(file, 'two\n');
    assert.deepEqual(fileRecovery(file, [], [file]), { lift: null, note: { kind: 'changed', path: 'a.md' } });
  } finally {
    cleanup(repo);
  }
});

test('an untracked file whose content is committed on another branch is in git', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'keep.md', 'k\n');
    git(repo, 'checkout', '-q', '-b', 'feat');
    commit(repo, 'plan.md', 'the plan\n');
    git(repo, 'checkout', '-q', 'main');
    const file = path.join(repo, 'plan.md');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'the plan\n');
    assert.deepEqual(fileRecovery(file, [], [file]), { lift: 'git' });
    fs.writeFileSync(file, 'another plan\n');
    assert.deepEqual(fileRecovery(file, [], [file]), { lift: null, note: { kind: 'untracked', path: 'plan.md' } });
  } finally {
    cleanup(repo);
  }
});

test('a CRLF working file in an autocrlf repository matches its committed blob', WINDOWS_ONLY, () => {
  const repo = makeRepo(['core.autocrlf=true']);
  try {
    commit(repo, 'x.md', 'a\nb\n');
    const file = path.join(repo, 'x.md');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    assert.deepEqual(fileRecovery(file, [], [file]), { lift: 'git' });
  } finally {
    cleanup(repo);
  }
});

test('other case and slashes still find the tracked file', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'Docs/A.md', 'doc\n');
    const spelled = `${fs.realpathSync(repo).toLowerCase().replace(/\\/g, '/')}/docs/a.MD`;
    assert.deepEqual(fileRecovery(spelled, [], [spelled]), { lift: 'git' });
  } finally {
    cleanup(repo);
  }
});

test('outside a repository only an identical copy that is not a target lifts the file', WINDOWS_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    const vault = path.join(root, 'vault', 'n.md');
    const repoFile = path.join(root, 'repo', 'n.md');
    for (const f of [vault, repoFile]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'same text\n');
    }
    assert.deepEqual(fileRecovery(vault, [repoFile], [vault]), { lift: 'copy', copy: repoFile });
    assert.deepEqual(fileRecovery(vault, [repoFile], [vault, repoFile]), { lift: null, note: null });
    assert.deepEqual(fileRecovery(vault, [repoFile], [vault, path.dirname(repoFile)]), { lift: null, note: null });
    assert.deepEqual(fileRecovery(vault, [repoFile.toUpperCase()], [vault, path.dirname(repoFile).replace(/\\/g, '/')]), { lift: null, note: null });
    fs.writeFileSync(repoFile, 'different\n');
    assert.deepEqual(fileRecovery(vault, [repoFile], [vault]), { lift: null, note: null });
  } finally {
    cleanup(root);
  }
});

test('a git that fails or times out means not recoverable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    const file = path.join(root, 'f.md');
    fs.writeFileSync(file, 'x\n');
    const failing = () => ({ status: null, stdout: '', stderr: '' });
    assert.deepEqual(fileRecovery(file, [], [file], failing), { lift: null, note: null });
  } finally {
    cleanup(root);
  }
});
