import path from 'node:path';
import { readConfig, type Config } from '../config.js';
import { appendLog } from '../context/files.js';
import { JEV_TIMEOUT_MS, callJev, jevKeys, readJevKey, withoutKeys, type FetchFn } from '../jev.js';
import { decideTool } from './dispatch.js';
import { candidateKind, gatherFacts, readSessionLog, realFactProbe, type Candidate, type FactProbe, type TargetFacts } from './facts.js';
import { askNote, lifts, noteText, passMessage, recoverMessage, rmJevRequest, type JudgedTarget, type Lifted } from './judge.js';
import type { GitRunner } from './git.js';
import { MAX_RECOVER_TARGETS, recoverTargets, type Recovery } from './recover.js';
import { realPowerShell, type PowerShellRunner } from './powershell.js';
import { askReason, hookOutput, type Probe, type RmTarget, type Skipped } from './targets.js';

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
  git?: GitRunner;
};

export const MAX_JEV_TARGETS = 5;
export const RM_LOG_COMMAND_CHARS = 2000;
export const RM_LOG_REASON_CHARS = 500;
// Claude Code lets the tool call run when a PreToolUse hook passes its 15-second limit, which would drop the ask: no
// PowerShell read starts after READ_BUDGET_MS (one already running ends within its 3-second limit) and leaves the
// command unread, and the Jev path gives up well before the limit and leaves the ask.
export const READ_BUDGET_MS = 9000;
export const FACTS_BUDGET_MS = 5000;
export const JEV_PATH_BUDGET_MS = 12000;
export const RECOVER_BUDGET_MS = 8000;
const MIN_JEV_MS = 1000;

type HookInput = {
  tool_name?: unknown;
  tool_input?: { command?: unknown; description?: unknown };
  cwd?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  tool_use_id?: unknown;
  agent_id?: unknown;
};
export type RmLogTarget = { shown: string; path: string | null; lift: 'git' | 'copy' | 'jev' | null; copy?: string; note?: string; kind?: Candidate; p?: number | null };
type LogDecision = { decision: 'none' | 'ask' | 'deny' | 'pass'; reason?: string; targets: RmLogTarget[]; jev?: Record<string, unknown>[] };
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

const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f]/g;

// A failing log must not change what the hook prints.
function logDecision(home: string, at: Date, input: HookInput, tool: string, command: string, cwd: string, keys: string[], skipped: Skipped[], d: LogDecision): void {
  try {
    const clean = (text: string) => text.replace(CONTROL_CHARS, '');
    // Redact before cutting: a cut inside a key would leave its start for appendLog to miss.
    const cut = (text: string, max: number) => withoutKeys(text, keys).slice(0, max);
    appendLog(
      home,
      at,
      {
        helper: 'rm',
        event: 'pre_tool_use',
        sessionId: typeof input.session_id === 'string' ? input.session_id : null,
        ...(typeof input.agent_id === 'string' ? { agentId: input.agent_id } : {}),
        transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
        tool,
        ...(typeof input.tool_use_id === 'string' ? { toolUseId: input.tool_use_id } : {}),
        command: cut(command, RM_LOG_COMMAND_CHARS),
        cwd,
        decision: d.decision,
        ...(d.reason === undefined ? {} : { reason: cut(d.reason, RM_LOG_REASON_CHARS) }),
        targets: d.targets.map((t) => ({ ...t, shown: clean(t.shown), ...(t.note === undefined ? {} : { note: clean(t.note) }), ...(t.copy === undefined ? {} : { copy: clean(t.copy) }) })),
        skipped: skipped.map((s) => ({ shown: clean(s.shown), why: s.why })),
        ...(d.jev ? { jev: d.jev } : {}),
      },
      keys,
    );
  } catch {}
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
  const skipped: Skipped[] = [];
  const ctx = { cwd, home: deps.home, tmpdirs, env: deps.env, probe: deps.probe, skipped };
  const keys = jevKeys(deps.env, config.keyFile);
  const log = (d: LogDecision) => logDecision(deps.home, now(), input, tool, command, cwd, keys, skipped, d);
  const powershell = deps.powershell ?? realPowerShell(deps.env);
  const read: PowerShellRunner = (source) => (now().getTime() - started >= READ_BUDGET_MS ? Promise.resolve(null) : powershell(source));
  const result = await decideTool(tool, command, ctx, read);
  if (!result) {
    if (skipped.length > 0) log({ decision: 'none', targets: [] });
    return null;
  }
  const targets = result.targets ?? [];
  if (result.decision !== 'ask' || targets.length === 0 || targets.some((t) => t.path === null)) {
    log({ decision: result.decision, reason: result.reason, targets: targets.map((t) => ({ shown: t.shown, path: t.path, lift: null })) });
    return hookOutput(result);
  }
  const elapsed = () => now().getTime() - started;
  // Recovery can only lift an ask; a failure anywhere in it leaves the ask as the guard decided it.
  let recoveries: Recovery[] | null = null;
  if (config.rm.recoverable && targets.length <= MAX_RECOVER_TARGETS) {
    try {
      recoveries = recoverTargets(targets.map((t) => t.path as string), command, cwd, deps.home, () => elapsed() > RECOVER_BUDGET_MS, deps.git);
    } catch {
      recoveries = null;
    }
  }
  const recoveredAt = (i: number): Lifted | null => {
    const r = recoveries?.[i];
    if (!r || r.lift === null) return null;
    return { path: targets[i].path as string, lift: r.lift, ...(r.lift === 'copy' ? { copy: r.copy } : {}) };
  };
  const recovered = targets.flatMap((_, i) => recoveredAt(i) ?? []);
  const leftIdx = targets.flatMap((_, i) => (recoveredAt(i) ? [] : [i]));
  const remaining = leftIdx.map((i) => targets[i]);
  const noteOf = (i: number): string | null => {
    const r = recoveries?.[i];
    return r && r.lift === null && r.note ? noteText(config.lang, r.note) : null;
  };
  const logged = (judgedItems: JudgedTarget[] | null, jevLifts: boolean): RmLogTarget[] =>
    targets.map((t, i) => {
      const base = { shown: t.shown, path: t.path };
      const done = recoveredAt(i);
      if (done) return { ...base, lift: done.lift, ...(done.copy === undefined ? {} : { copy: done.copy }) };
      const item = judgedItems?.[leftIdx.indexOf(i)];
      const note = noteOf(i);
      return { ...base, lift: jevLifts && item ? 'jev' : null, ...(note === null ? {} : { note }), ...(item ? { kind: item.kind, p: item.p } : {}) };
    });
  if (remaining.length === 0) {
    log({ decision: 'pass', targets: logged(null, false) });
    return JSON.stringify({ systemMessage: recoverMessage(config.lang, recovered) });
  }
  let judged: Judged | null = null;
  const key = config.rm.jev ? readJevKey(deps.env, config.keyFile) : null;
  if (key) {
    try {
      judged = await judgeTargets(remaining, input, command, key, keys, config, deps, elapsed);
    } catch {
      judged = null;
    }
  }
  const pass = judged !== null && lifts(judged.items, config.rm.throwawayYes);
  if (judged && pass) {
    log({ decision: 'pass', targets: logged(judged.items, true), jev: judged.calls });
    const message = recovered.length === 0 ? passMessage(config.lang, judged.items) : recoverMessage(config.lang, [...recovered, ...judged.items.map((i): Lifted => ({ path: i.path, lift: 'jev', p: i.p ?? 0 }))]);
    return JSON.stringify({ systemMessage: message });
  }
  const notes = leftIdx.flatMap((i) => {
    const note = noteOf(i);
    return note === null ? [] : [` · ${remaining.length > 1 ? `${path.win32.basename(targets[i].path as string)}: ` : ''}${note}`];
  });
  const reason = `${askReason(remaining)}${notes.join('')}${judged ? askNote(config.lang, judged.items) : ''}`;
  log({ decision: 'ask', reason, targets: logged(judged?.items ?? null, false), ...(judged ? { jev: judged.calls } : {}) });
  return hookOutput({ ...result, reason });
}
