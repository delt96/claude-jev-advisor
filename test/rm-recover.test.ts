import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv, runGit, type GitRunner } from '../src/rm/git.js';
import { MAX_COPY_BYTES, fileRecovery, folderRecovery, recoverTargets, sameContent, type ShellTool } from '../src/rm/recover.js';
import type { Skipped } from '../src/rm/targets.js';

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

test('a repository inside a folder outside git is named as a repository', WINDOWS_ONLY, () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-recover-'));
  try {
    const proj = path.join(box, 'proj');
    fs.mkdirSync(proj);
    git(proj, 'init', '-q', '-b', 'main');
    commit(proj, 'a.txt', 'a');
    assert.deepEqual(folderRecovery(box), { lift: null, note: { kind: 'repository', path: 'proj' } });
  } finally {
    cleanup(box);
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
  const results = recoverTargets(['C:\\d\\a.md', 'C:\\d\\b.md'], 'rm C:/d/a.md C:/d/b.md', 'Bash', 'C:\\work', 'C:\\Users\\me', [], () => spent, tracked);
  assert.equal(results[0].lift, 'git');
  assert.deepEqual(results[1], { lift: null, note: null });
});

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-copy-'));
  const dirs = { vault: path.join(root, 'vault'), other: path.join(root, 'other'), repo: path.join(root, 'repo'), sub: path.join(root, 'sub') };
  for (const d of Object.values(dirs)) {
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'n.md'), 'note\n');
  }
  fs.writeFileSync(path.join(root, 'x.md'), 'x\n');
  const nogit: GitRunner = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const s = (p: string) => p.replace(/\\/g, '/');
  const lift = (command: string, cwd = root, targets = [path.join(dirs.vault, 'n.md')], tool: ShellTool = 'Bash', skipped: Skipped[] = []) =>
    recoverTargets(targets, command, tool, cwd, 'C:\\Users\\me', skipped, () => false, nogit)[0].lift;
  return { root, ...dirs, s, lift };
}

test('a named file counts as a copy only when every statement of the command is a delete, a plain read or a plain copy onto the deleted file', WINDOWS_ONLY, () => {
  const { root, other, repo, vault, s, lift } = copyFixture();
  const rm = `rm "${s(vault)}/n.md"`;
  try {
    assert.equal(lift(`${rm} && cp "${s(root)}/x.md" "${s(other)}/n.md"`), null);
    assert.equal(lift(`${rm}; echo x > "${s(other)}/n.md"; cat "${s(other)}/n.md"`), null);
    assert.equal(lift(`${rm}; cat "${s(other)}/n.md"; echo x >> "${s(other)}/n.md"`), null);
    assert.equal(lift(`${rm}; cat "${s(other)}/n.md" | tee "${s(other)}/n.md"`), null);
    assert.equal(lift(`${rm}; mv "${s(root)}/x.md" "${s(other)}/n.md"; cat "${s(other)}/n.md"`), null);
    assert.equal(lift(`${rm}; cp -t "${s(root)}" "${s(other)}/n.md"`), null);
    assert.equal(lift(`$v = "${s(repo)}/n.md"; ${rm}`), null);
    assert.equal(lift(`p=${s(other)}/n.md; ${rm}; cat "${s(other)}/n.md"; cp "${s(repo)}/n.md" "$p"`), null);
    assert.equal(lift(`${rm} && cp "${s(repo)}/n.md" "${s(vault)}/n.md"`), 'copy');
    assert.equal(lift(`diff "${s(repo)}/n.md" "${s(vault)}/n.md" && ${rm}`), 'copy');
    assert.equal(lift(`Copy-Item "${s(root)}/x.md" -Destination "${s(repo)}/n.md"; Remove-Item "${s(vault)}/n.md"`), null);
    assert.equal(lift(`Remove-Item "${s(vault)}/n.md"; Copy-Item "${s(repo)}/n.md" -Destination "${s(vault)}/n.md"`), 'copy');
    assert.equal(lift(`${rm}; cat n.md`, other), 'copy');
    assert.equal(lift(`${rm}; certutil -hashfile "${s(repo)}/n.md" SHA256`), 'copy');
    assert.equal(lift(`${rm}; certutil -f -decode "${s(repo)}/n.md" "${s(other)}/n.md"`), null);
  } finally {
    cleanup(root);
  }
});

test('a copy statement with an option outside -f, -Force and the exact parameter names is not a plain copy', WINDOWS_ONLY, () => {
  const { root, other, repo, vault, s, lift } = copyFixture();
  const src = `"${s(repo)}/n.md"`;
  const dst = `"${s(vault)}/n.md"`;
  try {
    for (const extra of ['-pv v', '-pi v', '-iv v', '-fi x.md', '-ErrorAction Stop', '-EA SilentlyContinue', '-Desti x', '-Destination:x']) {
      assert.equal(lift(`Remove-Item ${dst}; Copy-Item ${src} ${dst} ${extra}`), null, extra);
    }
    assert.equal(lift(`Remove-Item ${dst}; Copy-Item "${s(other)}/n.md" -L ${src}`), null);
    assert.equal(lift(`Remove-Item ${dst}; Copy-Item ${src} ${dst} -L ${src}`), null);
    assert.equal(lift(`rm ${dst}; cp -f ${src} ${dst}`), 'copy');
    assert.equal(lift(`Remove-Item ${dst}; Copy-Item ${src} ${dst} -Force`), 'copy');
    assert.equal(lift(`Remove-Item ${dst}; Copy-Item -Path ${src} -Destination ${dst}`), 'copy');
  } finally {
    cleanup(root);
  }
});

test('a directory change, a directory destination or a tool that writes by its own rules leaves no copy', WINDOWS_ONLY, () => {
  const { root, other, repo, sub, vault, s, lift } = copyFixture();
  const rm = `rm "${s(vault)}/n.md"`;
  try {
    assert.equal(lift(`Push-Location "${s(other)}"; ${rm}; cat "${s(repo)}/n.md"`), null);
    assert.equal(lift(`cd "${s(other)}"; ${rm}; cat "${s(repo)}/n.md"`), null);
    assert.equal(lift(`Set-Location "${s(other)}"; ${rm}; cat "${s(repo)}/n.md"`), null);
    assert.equal(lift(`${rm}; cat "${s(other)}/n.md"; cp "${s(sub)}/n.md" "${s(other)}/"`), null);
    assert.equal(lift(`Remove-Item "${s(vault)}/n.md"; cat "${s(other)}/n.md"; Copy-Item "${s(sub)}/n.md" -Destination "${s(other)}"`), null);
    assert.equal(lift(`${rm}; cat "${s(other)}/n.md"; git -C "${s(other)}" checkout -- n.md`), null);
    assert.equal(lift(`${rm}; cat "${s(other)}/n.md"; tar -C "${s(other)}" -xf a.tar`), null);
    assert.equal(lift(`${rm}; cp "${s(repo)}/n.md" "${s(root)}/x.md"`), null);
    assert.equal(lift(`cat -n "${s(other)}/n.md" && ${rm}`), null);
    assert.equal(lift(`${rm}; cat "${s(other)}/n.md"; bash -c "echo x > n.md"`), null);
  } finally {
    cleanup(root);
  }
});

test('a command whose shell grammar the copy check does not read leaves no copy', WINDOWS_ONLY, () => {
  const { root, other, vault, s, lift } = copyFixture();
  const V = `"${s(vault)}/n.md"`;
  const O = `"${s(other)}/n.md"`;
  const X = `"${s(root)}/x.md"`;
  const W = path.join(root, 'w.md');
  fs.writeFileSync(W, 'w\n');
  try {
    assert.equal(lift(`Remove-Item ${V}; cat ${O} (cp ${X} ${O})`), null);
    assert.equal(lift(`Remove-Item ${V}; cat ${O} @(cp ${X} ${O})`), null);
    assert.equal(lift(`rm ${V}; cat ${O} #"\ncp ${X} ${O} #"`), null);
    assert.equal(lift(`rm ${V}; cat ${O} \\"; cp ${X} ${O}; echo \\"`), null);
    assert.equal(lift(`cat() ( cp ${X} ${O} ); rm ${V}; cat ${O}`), null);
    assert.equal(lift(`Remove-Item ${V}; cat ${O}; cat \u2018"\u2019; cp ${X} ${O}; cat \u2018"\u2019`), null);
    assert.equal(lift(`Copy-Item \u2013Destination:${s(other)}/n.md "${s(W)}"; Remove-Item ${V}; Remove-Item "${s(W)}"; cat ${O}`, root, [path.join(vault, 'n.md'), W]), null);
    assert.equal(lift(`rm ${V}\rcp ${X} ${V}; cat ${O}`), null);
  } finally {
    cleanup(root);
  }
});

test('a Korean file name still lifts as a copy, cp takes only -f, and a command name with a folder is not trusted', WINDOWS_ONLY, () => {
  const { root, other, repo, vault, s, lift } = copyFixture();
  const memo = path.join(vault, '메모.md');
  fs.writeFileSync(memo, 'memo\n');
  fs.writeFileSync(path.join(repo, '메모.md'), 'memo\n');
  const V = `"${s(vault)}/n.md"`;
  const R = `"${s(repo)}/n.md"`;
  try {
    assert.equal(lift(`rm "${s(vault)}/메모.md" && cp "${s(repo)}/메모.md" "${s(vault)}/메모.md"`, root, [memo]), 'copy');
    assert.equal(lift(`rm ${V}; cp -Path ${R} ${V}`), null);
    assert.equal(lift(`rm ${V}; cp -Force ${R} ${V}`), null);
    assert.equal(lift(`Remove-Item ${V}; Copy-Item -Path ${R} -Destination ${V}`), 'copy');
    assert.equal(lift(`Remove-Item ${V}; Copy-Item -f ${R} ${V}`), null);
    assert.equal(lift(`./cat "${s(other)}/n.md"; rm ${V}`), null);
    assert.equal(lift(`C:\\x\\cat.exe "${s(other)}/n.md"; rm ${V}`), null);
    assert.equal(lift(`rm ${V}; CAT.exe "${s(other)}/n.md"`), 'copy');
    assert.equal(lift(`/usr/bin/rm ${V}; cat "${s(other)}/n.md"`), null);
  } finally {
    cleanup(root);
  }
});

test('a hard link of another target, or of a file the command copies onto, is not a copy', WINDOWS_ONLY, () => {
  const { root, other, repo, sub, vault, s, lift } = copyFixture();
  const V = path.join(vault, 'n.md');
  const R = path.join(repo, 'n.md');
  const W = path.join(sub, 'n.md');
  fs.rmSync(W);
  fs.linkSync(R, W);
  const L = path.join(other, 'n.md');
  fs.rmSync(L);
  fs.linkSync(V, L);
  const X = `"${s(root)}/x.md"`;
  const q = (p: string) => `"${s(p)}"`;
  try {
    assert.equal(lift(`rm ${q(V)} ${q(W)}; cp ${X} ${q(W)}; cat ${q(R)}`, root, [V, W]), null);
    assert.equal(lift(`cp ${X} ${q(W)}; rm ${q(V)} ${q(W)}; cat ${q(R)}`, root, [V, W]), null);
    assert.equal(lift(`rm ${q(V)} ${q(W)}; cat ${q(R)}`, root, [V, W]), null);
    assert.deepEqual(fileRecovery(V, [R], [V, W]), { lift: null, note: null });
    assert.deepEqual(fileRecovery(V, [R], [V]), { lift: 'copy', copy: R });
    assert.equal(lift(`rm ${q(V)}; cat ${q(L)}`), 'copy');
    assert.equal(lift(`cp ${X} ${q(V)}; rm ${q(V)}; cat ${q(L)}`), null);
  } finally {
    cleanup(root);
  }
});

test('a quote glued to a word, a tilde other than ~/ and a POSIX path outside /<drive>/ leave no copy', WINDOWS_ONLY, () => {
  const { root, other, repo, vault, s, lift } = copyFixture();
  const V = `"${s(vault)}/n.md"`;
  const O = `"${s(other)}/n.md"`;
  for (const d of ['~USER', '~-']) write(path.join(root, d, 'n.md'), 'note\n');
  const rooted = `/${s(other).slice(3)}/n.md`;
  try {
    assert.equal(lift(`rm ${V}; cat'/s/x' ${O}`), null);
    assert.equal(lift(`rm ${V}; cat"/s/x" ${O}`), null);
    assert.equal(lift(`Remove-Item ${V}; cat'/s/y.ps1' ${O}`), null);
    assert.equal(lift(`rm'/s/x' ${V}; cat ${O}`), null);
    assert.equal(lift(`rm ${V}; cat "${s(other)}"/n.md`), null);
    assert.equal(lift(`rm ${V}; cat ~USER/n.md`), null);
    assert.equal(lift(`rm ${V}; cat ~-/n.md`), null);
    assert.equal(lift(`rm ${V}; cat "~/n.md"`), null);
    assert.equal(lift(`rm ${V}; cat ${rooted}`), null);
    assert.equal(lift(`rm ${V}; cat /tmp/n.md`), null);
    assert.equal(lift(`rm ${V} && cp "${s(repo)}/n.md" ${V}`), 'copy');
    assert.equal(lift(`rm ${V}; cat /${s(other)[0].toLowerCase()}/${s(other).slice(3)}/n.md`), 'copy');
    assert.equal(lift(`rm ${V}; cat ${O} ~`), 'copy');
  } finally {
    cleanup(root);
  }
});

test('under the Bash tool an unquoted backslash leaves no copy, while quoted backslash paths and PowerShell backslash paths still lift', WINDOWS_ONLY, () => {
  const { root, repo, vault, s, lift } = copyFixture();
  const here = path.join(root, 'n.md');
  fs.writeFileSync(here, 'note\n');
  fs.writeFileSync(path.join(root, '.n.md'), 'note\n');
  const V = path.join(vault, 'n.md');
  const R = path.join(repo, 'n.md');
  try {
    assert.equal(lift('rm n.md; cat .n.md; cp x.md .\\n.md', root, [here]), null);
    assert.equal(lift(`rm n.md; cat .n.md; cp x.md ${here}`, root, [here]), null);
    assert.equal(lift(`rm "${s(V)}" && cp ${R} "${s(V)}"`), null);
    assert.equal(lift(`rm "${V}" && cp "${R}" "${V}"`), 'copy');
    assert.equal(lift(`rm '${V}' && cp '${R}' '${V}'`), 'copy');
    assert.equal(lift(`Remove-Item ${V}; Copy-Item ${R} ${V}`, root, [V], 'PowerShell'), 'copy');
    assert.equal(lift('Remove-Item n.md; Get-Content .n.md; Copy-Item .\\.n.md .\\n.md', root, [here], 'PowerShell'), 'copy');
  } finally {
    cleanup(root);
  }
});

test('a tool other than PowerShell gets the stricter Bash backslash rule', WINDOWS_ONLY, () => {
  const { root, lift } = copyFixture();
  try {
    assert.equal(lift('rm vault\\n.md; cat repo\\n.md', root, undefined, 'PowerShell'), 'copy');
    assert.equal(lift('rm vault\\n.md; cat repo\\n.md', root, undefined, 'Bash'), null);
    assert.equal(lift('rm vault\\n.md; cat repo\\n.md', root, undefined, 'Other' as ShellTool), null);
  } finally {
    cleanup(root);
  }
});

test('a command that also deletes a passed-over path counts no copy, while git still lifts', WINDOWS_ONLY, () => {
  const { root, repo, vault, s, lift } = copyFixture();
  const command = `diff "${s(repo)}/n.md" "${s(vault)}/n.md" && rm -rf "${s(repo)}" && rm "${s(vault)}/n.md"`;
  try {
    assert.equal(lift(command, root, undefined, 'Bash', [{ shown: s(repo), why: 'temp' }]), null);
    const tracked: GitRunner = (args) => ({ status: 0, stdout: args[2] === 'ls-files' ? 'H n.md\0' : '', stderr: '' });
    const viaGit = recoverTargets([path.join(vault, 'n.md')], command, 'Bash', root, 'C:\\Users\\me', [{ shown: s(repo), why: 'build' }], () => false, tracked);
    assert.deepEqual(viaGit, [{ lift: 'git' }]);
  } finally {
    cleanup(root);
  }
});

test('git never takes optional locks, so a status beside another git command does not hold index.lock', () => {
  const env = gitEnv({ GIT_ICASE_PATHSPECS: '1' });
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.GIT_ICASE_PATHSPECS, '1');
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) assert.equal(name in env, false);
});
