import { readConfig } from '../config.js';
import { adviceKind, adviceLine, type ContextState, type Judgment } from '../display/line.js';
import { callJev, jevKeys, readJevKey, withoutKeys, type FetchFn } from '../jev.js';
import { appendLog, removeState, writeState } from './files.js';
import { backgroundTypes, busyInBackground, jevRequest, judgmentFrom } from './judge.js';
import { readTranscript, type TranscriptFacts } from './transcript.js';

export type ContextEvent = 'stop' | 'session-end';
export type ContextHookDeps = {
  home: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
};

export const REPLY_WAIT_MS = 3000;
export const REPLY_POLL_MS = 100;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readFacts(transcriptPath: string, reply: string, clean: (text: string) => string): TranscriptFacts {
  try {
    return readTranscript(transcriptPath, reply, undefined, clean);
  } catch {
    return { size: null, requests: [], replySeen: false };
  }
}

// The Stop hook can run before the turn's last reply is in the transcript (seen on first turns), which would
// leave the size unknown or one reply old; a short wait for that reply usually gets the current size.
async function factsAfterReply(transcriptPath: string | null, reply: string, clean: (text: string) => string, sleep: (ms: number) => Promise<void>) {
  if (!transcriptPath) return { size: null, requests: [], replySeen: false, waitedMs: 0 };
  for (let waitedMs = 0; ; waitedMs += REPLY_POLL_MS) {
    const facts = readFacts(transcriptPath, reply, clean);
    if (facts.replySeen || waitedMs >= REPLY_WAIT_MS) return { ...facts, waitedMs };
    await sleep(REPLY_POLL_MS);
  }
}

export async function runContextHook(event: ContextEvent, raw: string, deps: ContextHookDeps): Promise<string | null> {
  const config = readConfig(deps.home);
  if (!config.context.enabled) return null;
  const input = JSON.parse(raw) as Record<string, unknown> | null;
  if (typeof input !== 'object' || input === null || typeof input.session_id !== 'string') return null;
  const sessionId = input.session_id;
  if (event === 'session-end') {
    removeState(deps.home, sessionId);
    appendLog(deps.home, deps.now(), { helper: 'context', event: 'session_end', sessionId, reason: typeof input.reason === 'string' ? input.reason : null });
    return null;
  }
  if (input.stop_hook_active === true) return null;
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  const reply = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  // The key is taken out before any text is cut, or a cut through the key would leave part of it in the request and the log.
  const keys = jevKeys(deps.env, config.keyFile);
  const clean = (text: string) => withoutKeys(text, keys);
  const { size, requests, replySeen, waitedMs } = await factsAfterReply(transcriptPath, reply, clean, deps.sleep ?? pause);
  const background = backgroundTypes(input.background_tasks);
  let judgment: Judgment | null = null;
  let reason: string | null = null;
  let jev: Record<string, unknown> | null = null;
  if (size === null) {
    reason = 'unknown_size';
  } else if (size < config.context.minTokens) {
    reason = 'below_min';
  } else if (busyInBackground(background)) {
    reason = 'background_tasks';
    judgment = { phase: 'working', clear: false };
  } else {
    const key = readJevKey(deps.env, config.keyFile);
    if (!key) {
      reason = 'no_key';
    } else {
      const request = jevRequest(requests, clean(reply));
      const result = await callJev(request, { key, fetchFn: deps.fetchFn });
      jev = { state: request.state, ...result };
      if ('error' in result) {
        reason = 'jev_error';
      } else {
        judgment = judgmentFrom(result.answers, config);
        if (!judgment) reason = 'jev_no_answer';
      }
    }
  }
  const at = deps.now();
  const state: ContextState = { sessionId, at: at.getTime(), size, judgment };
  try {
    writeState(deps.home, state);
  } catch {
    // A state that cannot be saved must not also lose the log line of a Jev call already made.
  }
  const advice = adviceKind(size, judgment, config);
  appendLog(deps.home, at, { helper: 'context', event: 'stop', sessionId, transcriptPath, size, replySeen, waitedMs, background, reason, judgment, advice, jev }, keys);
  if (config.display !== 'message' || !advice) return null;
  return JSON.stringify({ systemMessage: adviceLine({ size, threshold: null, judgment, config }) });
}
