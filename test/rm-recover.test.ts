import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGit, type GitRunner } from '../src/rm/git.js';
import { MAX_COPY_BYTES, MAX_NAMED_PATHS, fileRecovery, folderRecovery, namedPaths, recoverTargets, sameContent } from '../src/rm/recover.js';

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

for (const bit of ['--assume-unchanged', '--skip-worktree']) {
  test(`a tracked file with ${bit} and uncommitted edits is not in git`, WINDOWS_ONLY, () => {
    const repo = makeRepo();
    try {
      commit(repo, 'a.md', 'one\n');
      git(repo, 'update-index', bit, 'a.md');
      const file = path.join(repo, 'a.md');
      assert.deepEqual(fileRecovery(file, [], [file]), { lift: 'git' });
      fs.appendFileSync(file, 'two\n');
      assert.deepEqual(fileRecovery(file, [], [file]), { lift: null, note: { kind: 'changed', path: 'a.md' } });
    } finally {
      cleanup(repo);
    }
  });
}

test('the file reached by another spelling of its own path is not its copy', WINDOWS_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    const dir = path.join(root, 'docs');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'n.md');
    fs.writeFileSync(file, 'same text\n');
    const link = path.join(root, 'link');
    fs.symlinkSync(dir, link, 'junction');
    assert.deepEqual(fileRecovery(file, [path.join(link, 'n.md')], [file]), { lift: null, note: null });
    const other = path.join(root, 'other.md');
    fs.writeFileSync(other, 'same text\n');
    assert.deepEqual(fileRecovery(file, [path.join(link, 'n.md'), other], [file]), { lift: 'copy', copy: other });
  } finally {
    cleanup(root);
  }
});

const write = (file: string, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('a clean folder inside a repository is in git, also with ignored build output', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, '.gitignore', 'node_modules/\n');
    commit(repo, 'src/a.ts', 'a');
    write(path.join(repo, 'src', 'node_modules', 'x', 'i.js'));
    fs.mkdirSync(path.join(repo, 'empty'));
    assert.deepEqual(folderRecovery(path.join(repo, 'src')), { lift: 'git' });
    assert.deepEqual(folderRecovery(path.join(repo, 'empty')), { lift: 'git' });
  } finally {
    cleanup(repo);
  }
});

test('an untracked file, a change or an ignored file outside build folders keeps the folder, and names the first one', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'src/a.ts', 'a');
    const src = path.join(repo, 'src');
    write(path.join(src, 'new.ts'));
    assert.deepEqual(folderRecovery(src), { lift: null, note: { kind: 'untracked', path: 'new.ts' } });
    fs.rmSync(path.join(src, 'new.ts'));
    write(path.join(src, 'a.ts'), 'changed');
    assert.deepEqual(folderRecovery(src), { lift: null, note: { kind: 'changed', path: 'a.ts' } });
    git(repo, 'checkout', '--', 'src/a.ts');
    commit(repo, '.gitignore', '.env.local\n');
    write(path.join(src, '.env.local'));
    assert.deepEqual(folderRecovery(src), { lift: null, note: { kind: 'untracked', path: '.env.local' } });
  } finally {
    cleanup(repo);
  }
});

test('a tracked file hidden by assume-unchanged or skip-worktree keeps the folder', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'src/a.ts', 'a');
    commit(repo, 'src/b.ts', 'b');
    git(repo, 'update-index', '--assume-unchanged', 'src/a.ts');
    write(path.join(repo, 'src', 'a.ts'), 'edited');
    assert.deepEqual(folderRecovery(path.join(repo, 'src')), { lift: null, note: { kind: 'changed', path: 'a.ts' } });
    git(repo, 'update-index', '--no-assume-unchanged', 'src/a.ts');
    git(repo, 'update-index', '--skip-worktree', 'src/b.ts');
    git(repo, 'checkout', '--', 'src/a.ts');
    assert.deepEqual(folderRecovery(path.join(repo, 'src')), { lift: null, note: { kind: 'changed', path: 'b.ts' } });
  } finally {
    cleanup(repo);
  }
});

test('Korean names are read correctly', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'src/설계.md', 'a');
    const src = path.join(repo, 'src');
    assert.deepEqual(folderRecovery(src), { lift: 'git' });
    write(path.join(src, '메모.md'));
    assert.deepEqual(folderRecovery(src), { lift: null, note: { kind: 'untracked', path: '메모.md' } });
  } finally {
    cleanup(repo);
  }
});

test('a folder with its own repository is never lifted', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'a.txt', 'a');
    assert.deepEqual(folderRecovery(repo), { lift: null, note: { kind: 'repository' } });
  } finally {
    cleanup(repo);
  }
});

function addWorktree(repo: string, name: string, ...args: string[]) {
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`);
  git(repo, 'worktree', 'add', '-q', ...args.map((a) => (a === '<wt>' ? wt : a)));
  return wt;
}

test('a merged linked worktree is in git; an unmerged one is not', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  let wt = '';
  let detached = '';
  try {
    commit(repo, 'a.txt', 'a');
    wt = addWorktree(repo, 'feat', '-b', 'feat', '<wt>', 'main');
    commit(wt, 'b.txt', 'b');
    assert.deepEqual(folderRecovery(wt), { lift: null, note: { kind: 'unmerged' } });
    git(repo, 'merge', '-q', 'feat');
    assert.deepEqual(folderRecovery(wt), { lift: 'git' });
    detached = addWorktree(repo, 'det', '--detach', '<wt>', 'main');
    assert.deepEqual(folderRecovery(detached), { lift: 'git' });
  } finally {
    cleanup(wt, detached, repo);
  }
});

test('a folder outside git that holds only merged worktrees is in git; a stray file keeps it', WINDOWS_ONLY, () => {
  const repoA = makeRepo();
  const repoB = makeRepo();
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    for (const [repo, name] of [[repoA, 'one'], [repoB, 'two']]) {
      commit(repo, 'a.txt', 'a');
      const wt = path.join(box, name);
      git(repo, 'worktree', 'add', '-q', '-b', `feat-${name}`, wt, 'main');
    }
    fs.mkdirSync(path.join(box, 'empty'));
    assert.deepEqual(folderRecovery(box), { lift: 'git' });
    write(path.join(box, 'notes.txt'));
    assert.deepEqual(folderRecovery(box), { lift: null, note: { kind: 'untracked', path: 'notes.txt' } });
    fs.rmSync(path.join(box, 'notes.txt'));
    write(path.join(box, 'one', 'extra.txt'));
    assert.deepEqual(folderRecovery(box), { lift: null, note: { kind: 'untracked', path: 'one/extra.txt' } });
    fs.rmSync(path.join(box, 'one', 'extra.txt'));
    for (let i = 0; i < 9; i++) fs.mkdirSync(path.join(box, `e${i}`));
    assert.deepEqual(folderRecovery(box), { lift: null, note: null });
  } finally {
    cleanup(box, repoA, repoB);
  }
});

test('a junction child of a container is not a folder to lift', WINDOWS_ONLY, () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    fs.symlinkSync(target, path.join(box, 'link'), 'junction');
    assert.deepEqual(folderRecovery(box), { lift: null, note: { kind: 'untracked', path: 'link' } });
  } finally {
    fs.rmSync(path.join(box, 'link'), { force: true, recursive: false });
    cleanup(box, target);
  }
});

test('a worktree whose main repository is gone is not lifted', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  const moved = `${repo}-moved`;
  let wt = '';
  try {
    commit(repo, 'a.txt', 'a');
    wt = addWorktree(repo, 'feat', '-b', 'feat', '<wt>', 'main');
    fs.renameSync(repo, moved);
    assert.equal(folderRecovery(wt).lift, null);
  } finally {
    cleanup(wt, repo, moved);
  }
});

test('a worktree whose HEAD cannot be read is not lifted', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  let wt = '';
  try {
    commit(repo, 'a.txt', 'a');
    wt = addWorktree(repo, 'feat', '-b', 'feat', '<wt>', 'main');
    commit(wt, 'b.txt', 'b');
    const failing: GitRunner = (args, env) => (args.includes('symbolic-ref') ? { status: null, stdout: '', stderr: '' } : runGit(args, env));
    assert.equal(folderRecovery(wt, failing).lift, null);
    assert.deepEqual(folderRecovery(wt), { lift: null, note: { kind: 'unmerged' } });
  } finally {
    cleanup(wt, repo);
  }
});

test('a repository embedded as a gitlink keeps the folder', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, 'lib/a.txt', 'a');
    const inner = path.join(repo, 'lib', 'inner');
    fs.mkdirSync(inner);
    git(inner, 'init', '-q', '-b', 'main');
    commit(inner, 'f.txt', 'f');
    git(repo, 'add', 'lib/inner');
    git(repo, 'commit', '-q', '-m', 'embed');
    git(repo, 'config', 'diff.ignoreSubmodules', 'all');
    git(inner, 'checkout', '-q', '-b', 'other');
    commit(inner, 'g.txt', 'only on other');
    git(inner, 'checkout', '-q', 'main');
    assert.deepEqual(folderRecovery(path.join(repo, 'lib')), { lift: null, note: { kind: 'repository', path: 'inner' } });
    write(path.join(inner, 'f.txt'), 'edited');
    assert.equal(folderRecovery(path.join(repo, 'lib')).lift, null);
  } finally {
    cleanup(repo);
  }
});

test('a wholly ignored folder names itself, and a folder inside a build folder is not judged by its ancestor', WINDOWS_ONLY, () => {
  const repo = makeRepo();
  try {
    commit(repo, '.gitignore', 'tmp/\nnode_modules/\n');
    write(path.join(repo, 'tmp', 'x.txt'));
    write(path.join(repo, 'node_modules', 'pkg', 'i.js'));
    assert.deepEqual(folderRecovery(path.join(repo, 'tmp')), { lift: null, note: { kind: 'untracked', path: 'tmp' } });
    assert.equal(folderRecovery(path.join(repo, 'node_modules', 'pkg')).lift, null);
  } finally {
    cleanup(repo);
  }
});

test('recoverTargets stops checking once out of time', () => {
  let spent = false;
  const tracked: GitRunner = (args) => {
    spent = args[2] === 'status';
    return { status: 0, stdout: args[2] === 'ls-files' ? 'H x\0' : '', stderr: '' };
  };
  const results = recoverTargets(['C:\\d\\a.md', 'C:\\d\\b.md'], 'rm C:/d/a.md C:/d/b.md', 'C:\\work', 'C:\\Users\\me', () => spent, tracked);
  assert.equal(results[0].lift, 'git');
  assert.deepEqual(results[1], { lift: null, note: null });
});
