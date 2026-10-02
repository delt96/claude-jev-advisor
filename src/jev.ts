import fs from 'node:fs';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_TIMEOUT_MS = 8000;

export type JevQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };
export type JevRequest = { state: Record<string, unknown>; questions: Record<string, JevQuestion> };
export type JevAnswer = { answers: Record<string, number>; model: string | null; requestId: string | null; ms: number };
export type JevFailure = { error: string; requestId: string | null; ms: number };
export type JevResult = JevAnswer | JevFailure;
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

const KEY_PREFIX = 'TYPESAFE_API_KEY=';

export function readJevKey(env: Record<string, string | undefined>, keyFile: string | null): string | null {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!keyFile) return null;
  let text: string;
  try {
    text = fs.readFileSync(keyFile, 'utf8');
  } catch {
    return null;
  }
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.startsWith(KEY_PREFIX));
  const key = line?.slice(KEY_PREFIX.length).trim().replace(/^["']|["']$/g, '');
  return key || null;
}

export async function callJev(request: JevRequest, opts: { key: string; fetchFn?: FetchFn; timeoutMs?: number; now?: () => number }): Promise<JevResult> {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const limit = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  const redact = (text: string) => text.split(opts.key).join('[redacted]');
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    // Unlike AbortSignal.timeout, this timer keeps the hook process alive until Jev answers or the limit passes,
    // and the race below ends the call even when a fetch ignores the abort.
    timer = setTimeout(() => {
      const err = new Error(`Jev did not answer within ${limit} ms`);
      controller.abort(err);
      reject(err);
    }, limit);
  });
  let requestId: string | null = null;
  const exchange = (async () => {
    const res = await fetchFn(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', ...request }),
      signal: controller.signal,
    });
    requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id');
    return { res, text: await res.text() };
  })();
  exchange.catch(() => {});
  try {
    const { res, text } = await Promise.race([exchange, expired]);
    if (!res.ok) return { error: redact(`HTTP ${res.status}: ${text.slice(0, 300)}`), requestId, ms: now() - started };
    const body = JSON.parse(text) as { model?: unknown; answers?: Record<string, { noul?: unknown } | null> };
    const answers: Record<string, number> = {};
    for (const [id, answer] of Object.entries(body.answers ?? {})) {
      if (typeof answer?.noul === 'number') answers[id] = answer.noul;
    }
    return { answers, model: typeof body.model === 'string' ? body.model : null, requestId, ms: now() - started };
  } catch (err) {
    return { error: redact(String((err as Error)?.message ?? err)).slice(0, 300), requestId, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}
