import path from 'node:path';
import { readConfig, type Config } from '../config.js';
import { appendLog } from '../context/files.js';
import { JEV_TIMEOUT_MS, callJev, jevKeys, readJevKey, withoutKeys, type FetchFn } from '../jev.js';
import { decideTool } from './dispatch.js';
import { candidateKind, gatherFacts, readSessionLog, realFactProbe, type Candidate, type FactProbe, type TargetFacts } from './facts.js';
import { askNote, lifts, passMessage, rmJevRequest, type JudgedTarget } from './judge.js';
import { realPowerShell, type PowerShellRunner } from './powershell.js';
import { hookOutput, type Probe, type RmTarget } from './targets.js';

export type RmHookDeps = {
  home: string;
  env: Record<string, string | undefined>;
  tmpdir: string;
  cwd: string;
  probe: Probe;
  facts?: FactProbe;
  fetchFn?: FetchFn;
  now?: () => Date;
  powershell?: PowerShellRunner;
};

export const MAX_JEV_TARGETS = 5;
// Claude Code lets the tool call run when a PreToolUse hook passes its 15-second limit, which would drop the ask: no
// PowerShell read starts after READ_BUDGET_MS (one already running ends within its 3-second limit) and leaves the
// command unread, and the Jev path gives up well before the limit and leaves the ask.
export const READ_BUDGET_MS = 9000;
export const FACTS_BUDGET_MS = 5000;
export const JEV_PATH_BUDGET_MS = 12000;
const MIN_JEV_MS = 1000;

type HookInput = {
  tool_name?: unknown;
  tool_input?: { command?: unknown; description?: unknown };
  cwd?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
};
type Judged = { items: JudgedTarget[]; calls: Record<string, unknown>[] };

async function judgeTargets(targets: RmTarget[], input: HookInput, command: string, key: string, keys: string[], config: Config, deps: RmHookDeps, elapsed: () => number): Promise<Judged | null> {
  if (targets.length === 0 || targets.length > MAX_JEV_TARGETS || targets.some((t) => t.path === null)) return null;
  if (typeof input.transcript_path !== 'string') return null;
  const session = readSessionLog(input.transcript_path);
  if (!session) return null;
  const found: { target: RmTarget; facts: TargetFacts; kind: Candidate }[] = [];
  for (const target of targets) {
    if (elapsed() > FACTS_BUDGET_MS) return null;
    const facts = gatherFacts(target.path as string, session, deps.facts ?? realFactProbe, config.rm.maxDirFiles);
    const kind = facts ? candidateKind(facts, session.startedAt) : null;
    if (!facts || !kind) return null;
    found.push({ target, facts, kind });
  }
  const timeoutMs = Math.min(JEV_TIMEOUT_MS, JEV_PATH_BUDGET_MS - elapsed());
  if (timeoutMs < MIN_JEV_MS) return null;
  const description = typeof input.tool_input?.description === 'string' ? input.tool_input.description : '';
  const answered = await Promise.all(
    found.map(async ({ kind, facts }) => {
      const request = rmJevRequest(kind, facts, command, description, (text) => withoutKeys(text, keys));
      return { request, result: await callJev(request, { key, fetchFn: deps.fetchFn, timeoutMs }) };
    }),
  );
  return {
    items: found.map(({ target, kind }, i) => {
      const { result } = answered[i];
      const p = 'error' in result ? null : result.answers.ok;
      return { path: target.path as string, shown: target.shown, kind, p: typeof p === 'number' ? p : null };
    }),
    calls: answered.map(({ request, result }) => ({ state: request.state, ...result })),
  };
}

export async function runRmHook(raw: string, deps: RmHookDeps): Promise<string | null> {
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const config = readConfig(deps.home);
  if (!config.rm.enabled) return null;
  const input = JSON.parse(raw) as HookInput | null;
  if (typeof input !== 'object' || input === null) return null;
  const command = input.tool_input?.command;
  const tool = input.tool_name;
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof command !== 'string') return null;
  const tmpdirs = [...new Set([deps.tmpdir, deps.env.TEMP, deps.env.TMP].filter((t): t is string => Boolean(t)).map((t) => path.win32.resolve(t)))];
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : deps.cwd;
  const ctx = { cwd, home: deps.home, tmpdirs, env: deps.env, probe: deps.probe };
  const powershell = deps.powershell ?? realPowerShell(deps.env);
  const read: PowerShellRunner = (source) => (now().getTime() - started >= READ_BUDGET_MS ? Promise.resolve(null) : powershell(source));
  const result = await decideTool(tool, command, ctx, read);
  if (!result) return null;
  if (result.decision !== 'ask' || !result.targets || !config.rm.jev) return hookOutput(result);
  const key = readJevKey(deps.env, config.keyFile);
  if (!key) return hookOutput(result);
  const keys = jevKeys(deps.env, config.keyFile);
  // Jev can only lift an ask; any failure on the way leaves the ask exactly as the guard decided it.
  let judged: Judged | null = null;
  try {
    judged = await judgeTargets(result.targets, input, command, key, keys, config, deps, () => now().getTime() - started);
  } catch {
    judged = null;
  }
  if (!judged) return hookOutput(result);
  const pass = lifts(judged.items, config.rm.throwawayYes);
  try {
    appendLog(
      deps.home,
      now(),
      {
        helper: 'rm',
        event: 'pre_tool_use',
        sessionId: typeof input.session_id === 'string' ? input.session_id : null,
        transcriptPath: input.transcript_path,
        tool,
        command,
        cwd,
        decision: pass ? 'pass' : 'ask',
        targets: judged.items,
        jev: judged.calls,
      },
      keys,
    );
  } catch {}
  if (pass) return JSON.stringify({ systemMessage: passMessage(config.lang, judged.items) });
  return hookOutput({ ...result, reason: `${result.reason}${askNote(config.lang, judged.items)}` });
}
