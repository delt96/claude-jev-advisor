import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, hookOutput } from '../src/rm/guard.js';

const PROJECT = 'C:\\workspace\\proj';
const TMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
const SCRATCH = 'C:/Users/me/AppData/Local/Temp/claude/C--workspace-proj/abc/scratchpad';

type RunOptions = { cwd?: string; exists?: (p: string) => boolean; ignored?: (p: string) => boolean };

function run(command: string, { cwd = PROJECT, exists = () => true, ignored = () => false }: RunOptions = {}) {
  const seen = { exists: [] as string[], ignored: [] as string[] };
  const probe = {
    exists: (p: string) => { seen.exists.push(p); return exists(p); },
    isIgnored: (p: string) => { seen.ignored.push(p); return ignored(p); },
  };
  const env = { TEMP: TMP, TMP, HOME: 'C:\\Users\\me', USERPROFILE: 'C:\\Users\\me' };
  const result = decide({ command, cwd, home: 'C:\\Users\\me', tmpdirs: [TMP], env, probe });
  return { result, seen };
}

const decision = (command: string, opts?: RunOptions) => run(command, opts).result?.decision ?? 'none';
const reason = (command: string, opts?: RunOptions) => run(command, opts).result?.reason ?? '';

test('commands without rm are left alone', () => {
  assert.equal(decision('ls -la && npm test'), 'none');
  assert.equal(decision('echo "rm -rf /"'), 'none');
  assert.equal(decision('grep -n "rm " src/a.ts'), 'none');
  assert.equal(decision('git rm -r --cached dist'), 'none');
  assert.equal(decision('npm rm left-pad'), 'none');
});

test('removing temp files is left alone', () => {
  assert.equal(decision(`rm -f ${SCRATCH}/a.txt`), 'none');
  assert.equal(decision('rm -rf /tmp/mcpchk'), 'none');
  assert.equal(decision('rm -f /c/Users/me/AppData/Local/Temp/foo.txt'), 'none');
  assert.equal(decision('rm -f "C:\\Users\\me\\AppData\\Local\\Temp\\x.txt"'), 'none');
  assert.equal(decision('rm -f /tmp/foo*.txt'), 'none');
});

test('removing the temp folder itself asks', () => {
  assert.equal(decision('rm -rf /tmp'), 'ask');
  assert.equal(decision(`rm -rf "${TMP}"`), 'ask');
});

test('wiping everything in the temp folder asks', () => {
  assert.equal(decision('rm -rf /tmp/*'), 'ask');
  assert.equal(decision('rm -rf "$TEMP"/*.*'), 'ask');
});

test('the SDD workspace under .superpowers counts as temp', () => {
  assert.equal(decision('rm -f .superpowers/sdd/2026-10-02-placeholder'), 'none');
  assert.equal(decision('rm -rf C:/workspace/proj/.superpowers/sdd/plan-a'), 'none');
});

test('removing a path that does not exist is left alone', () => {
  assert.equal(decision('rm -f build_red.log', { exists: () => false }), 'none');
});

test('removing an existing project file asks and names it', () => {
  assert.equal(decision('rm src/index.ts'), 'ask');
  assert.match(reason('rm src/index.ts'), /C:\\workspace\\proj\\src\\index\.ts/);
});

test('git-ignored build output is left alone', () => {
  const opts = { ignored: (p: string) => p.toLowerCase().includes('\\target') };
  assert.equal(decision('rm -rf target/surefire-reports', opts), 'none');
  assert.equal(decision('rm -rf target', opts), 'none');
});

test('a build-named folder that git tracks asks', () => {
  assert.equal(decision('rm -rf build', { ignored: () => false }), 'ask');
});

test('an ignored file outside build folders asks', () => {
  assert.equal(decision('rm -f .env', { ignored: () => true }), 'ask');
});

test('git is asked only for paths inside build folders', () => {
  const { seen } = run('rm -f .env src/a.ts', { ignored: () => true });
  assert.deepEqual(seen.ignored, []);
});

test('variables set to literal paths in the same command are followed', () => {
  assert.equal(decision(`S="${SCRATCH}"; rm -f $S/a.txt`), 'none');
  assert.equal(decision(`S="${SCRATCH}"; H="$S/iso-home"; rm -rf "$H"`), 'none');
  assert.equal(decision(`S=${SCRATCH} && cd "$S" && rm -f a.txt`), 'none');
  assert.equal(decision('export W=.superpowers/sdd/x; rm -f ${W}/a'), 'none');
  assert.equal(decision('D=/c/x; rm -f $D/a'), 'ask');
  assert.match(reason('D=/c/x; rm -f $D/a'), /C:\\x\\a/);
});

test('well-known environment variables are followed', () => {
  assert.equal(decision('rm -f "$TEMP/x.txt"'), 'none');
  assert.equal(decision('rm -rf $TMP/omb-head'), 'none');
  assert.equal(decision(`cd "$HOME/AppData/Local/Temp/claude/x/scratchpad" && rm -f approver.log`), 'none');
  assert.equal(decision('rm -f $HOME/notes.txt'), 'ask');
});

test('variables that cannot be worked out are denied with a literal-path hint', () => {
  for (const cmd of ['rm -rf ${OUT}', 'for f in a b; do rm $f; done', 'M=$(mktemp -d); rm -rf $M', 'S=/c/x rm -f $S/a', 'rm -rf ${OUT:-/tmp/x}']) {
    assert.equal(decision(cmd), 'deny', cmd);
    assert.match(reason(cmd), /literal/, cmd);
  }
});

test('a variable reassigned from a substitution is no longer trusted', () => {
  assert.equal(decision(`S=${SCRATCH}; S=$(pwd); rm -f $S/a`), 'deny');
});

test('command substitution targets are denied', () => {
  assert.equal(decision('rm -rf $(echo /tmp/x)'), 'deny');
  assert.equal(decision('rm -rf `cat list.txt`'), 'deny');
});

test('xargs rm is denied', () => {
  assert.equal(decision('find . -name "*.tmp" | xargs rm -f'), 'deny');
});

test('a wildcard in a folder name is denied', () => {
  assert.equal(decision('rm -f src/*/a.txt'), 'deny');
});

test('brace expansion is denied', () => {
  assert.equal(decision('rm -f a.{txt,log}'), 'deny');
});

test('a wildcard in the file name outside temp asks', () => {
  assert.equal(decision('rm -f src/*.bak'), 'ask');
});

test('relative targets follow a literal cd', () => {
  assert.equal(decision(`cd "${SCRATCH}/draft-g/cc" && rm -rf src && python stubs.py`), 'none');
  assert.equal(decision('cd src && rm a.ts'), 'ask');
  assert.match(reason('cd src && rm a.ts'), /C:\\workspace\\proj\\src\\a\.ts/);
});

test('relative targets after cd to an unknown path are denied', () => {
  assert.equal(decision('cd $UNKNOWN && rm -rf src'), 'deny');
  assert.equal(decision('cd - && rm a'), 'deny');
  assert.equal(decision('D=/c/x; cd $D && rm -rf src'), 'ask');
});

test('a cd inside a subshell does not leak out', () => {
  assert.equal(decision('(cd /tmp && rm -rf x); rm -f a.txt'), 'ask');
});

test('heredoc bodies are not read as commands', () => {
  assert.equal(decision("python - <<'PY'\nimport os\nos.system('rm -rf /')\nPY\necho done"), 'none');
  assert.equal(decision('cat <<EOF > notes.txt\nrm src/a.ts\nEOF'), 'none');
});

test('a here-string is not mistaken for a heredoc', () => {
  assert.equal(decision('grep x <<<word\nrm src/a.ts'), 'ask');
});

test('rm is recognized behind wrappers and paths', () => {
  for (const cmd of ['/bin/rm src/a.ts', '\\rm src/a.ts', 'command rm src/a.ts', 'sudo rm -f src/a.ts', 'timeout 30 rm src/a.ts', 'env A=1 rm src/a.ts', 'X=1 rm src/a.ts']) {
    assert.equal(decision(cmd), 'ask', cmd);
  }
});

test('rmdir is classified like rm', () => {
  assert.equal(decision('rmdir emptydir'), 'ask');
  assert.equal(decision('rmdir /tmp/emptydir'), 'none');
});

test('options and -- are not targets', () => {
  assert.equal(decision('rm -rf -- -weird'), 'ask');
  assert.match(reason('rm -rf -- -weird'), /-weird/);
  assert.equal(decision('rm -f'), 'none');
});

test('redirections are not targets', () => {
  assert.equal(decision('rm -f /tmp/a 2>/dev/null'), 'none');
  assert.equal(decision('rm -f /tmp/a >/dev/null 2>&1'), 'none');
  assert.equal(decision('rm -f /tmp/a &>/dev/null'), 'none');
});

test('home paths and unknown POSIX paths ask', () => {
  assert.equal(decision('rm -f ~/notes.txt'), 'ask');
  assert.match(reason('rm -f ~/notes.txt'), /C:\\Users\\me\\notes\.txt/);
  assert.equal(decision('rm -f /usr/local/x'), 'ask');
});

test('mixed temp and real targets ask about the real ones only', () => {
  assert.equal(decision('rm -f /tmp/a.txt src/b.ts'), 'ask');
  assert.match(reason('rm -f /tmp/a.txt src/b.ts'), /src\\b\.ts/);
  assert.doesNotMatch(reason('rm -f /tmp/a.txt src/b.ts'), /a\.txt/);
});

test('an unresolvable target wins over a real one', () => {
  assert.equal(decision('rm -f src/b.ts $X'), 'deny');
});

test('comments are ignored', () => {
  assert.equal(decision('echo hi # rm src/a.ts'), 'none');
});

test('a long list of real targets is shortened in the reason', () => {
  const cmd = `rm ${Array.from({ length: 8 }, (_, i) => `f${i}.txt`).join(' ')}`;
  assert.equal(decision(cmd), 'ask');
  assert.match(reason(cmd), /외 5개/);
});

test('hookOutput wraps a decision for PreToolUse', () => {
  const out = JSON.parse(hookOutput({ decision: 'ask', reason: 'r' }));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r' } });
});

test('an ask carries every real target, with a path only where one file or folder is meant', () => {
  const r = run('rm -rf src/a.ts /opt/x "C:/workspace/proj/logs"/*.log', { exists: () => true });
  assert.equal(r.result?.decision, 'ask');
  assert.deepEqual(r.result?.targets, [
    { shown: 'C:\\workspace\\proj\\src\\a.ts', path: 'C:\\workspace\\proj\\src\\a.ts' },
    { shown: '/opt/x', path: null },
    { shown: 'C:\\workspace\\proj\\logs\\*.log', path: null },
  ]);
  assert.equal(run('rm -rf $(echo x)').result?.targets, undefined);
});

test('a wildcard right under a drive root is shown with one separator', () => {
  assert.equal(reason('rm -f /c/*.log'), '실제 파일 삭제: C:\\*.log');
});
