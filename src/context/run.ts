import { readConfig } from '../config.js';
import { adviceLine, type ContextState, type Judgment } from '../display/line.js';
import { callJev, readJevKey, type FetchFn } from '../jev.js';
import { appendLog, removeState, writeState } from './files.js';
import { hasBackgroundTasks, jevRequest, judgmentFrom } from './judge.js';
import { readTranscript, type TranscriptFacts } from './transcript.js';

export type ContextEvent = 'stop' | 'session-end';
export type ContextHookDeps = { home: string; env: Record<string, string | undefined>; now: () => Date; fetchFn?: FetchFn };

const ADVICE = /\/(clear|compact)$/;

function factsOf(transcriptPath: string | null): TranscriptFacts {
  if (!transcriptPath) return { size: null, requests: [] };
  try {
    return readTranscript(transcriptPath);
  } catch {
    return { size: null, requests: [] };
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
  const { size, requests } = factsOf(transcriptPath);
  let judgment: Judgment | null = null;
  let reason: string | null = null;
  let jev: Record<string, unknown> | null = null;
  if (size === null) {
    reason = 'unknown_size';
  } else if (size < config.context.minTokens) {
    reason = 'below_min';
  } else if (hasBackgroundTasks(input.background_tasks)) {
    reason = 'background_tasks';
    judgment = { phase: 'working', clear: false };
  } else {
    const key = readJevKey(deps.env, config.keyFile);
    if (!key) {
      reason = 'no_key';
    } else {
      const request = jevRequest(requests, typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '');
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
  writeState(deps.home, state);
  appendLog(deps.home, at, { helper: 'context', event: 'stop', sessionId, transcriptPath, size, reason, judgment, jev });
  if (config.display !== 'message') return null;
  const line = adviceLine({ size, threshold: null, judgment, config });
  return ADVICE.test(line) ? JSON.stringify({ systemMessage: line }) : null;
}
