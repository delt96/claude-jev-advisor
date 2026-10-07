# 띠 버튼과 단축키 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** context helper의 조언을 입력칸 위 띠의 버튼(클릭, `ctrl+x d`)으로 실행할 수 있게 하고, 하단 줄에 최근 요청에서 늘어난 양(`+38k`)을 보여 준다.

**Architecture:** 표시 문자열과 "띠에 무엇을 그릴지"는 Node 없는 순수 함수(`src/display/line.ts`)가 정한다. 띠 모양은 `src/mod/band.ts` 한 파일이 그리고, `src/mod/register.ts`는 상태(설정, 판단, 기준 크기, 처리한 판단)를 들고 hook을 연결한다. 단축키는 `install`이 `~/.claude/keybindings.json`에 엔진 동작 이름 하나를 묶어 두고, 버튼이 Button `action`으로 그 키를 빌린다.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 18, tsup, node:test + tsx, Claude Code 2.1.292 mod API(early access)

**Spec:** `docs/superpowers/specs/2026-10-07-band-buttons-design.md`

## Global Constraints

- mod 번들에 들어가는 파일(`src/display/line.ts`, `src/config-shape.ts`, `src/display/shortcut.ts`, `src/mod/band.ts`)은 `node:` 모듈을 import하지 않는다. `test/line.test.ts`의 Node 금지 테스트가 지킨다.
- 단축키 값은 `src/display/shortcut.ts` 한 곳에만 둔다: 키 `ctrl+x d`, 동작 `diff:back`, 영역 `DiffDialog`. Task 1 결과로 동작이나 영역이 바뀌면 그 파일과 그 값을 그대로 적은 테스트·README만 고친다.
- `statusline`과 `message` 표시 방식의 출력은 바뀌지 않는다(`adviceLine`을 `increase` 없이 부르면 지금과 같은 문자열).
- 띠의 모든 문자열에 U+FE0F(VS16)를 쓰지 않는다.
- 백업 이름: `~/.claude/backups/<파일 이름>.<YYYY-MM-DD-HHmmss>-before-claude-jev-advisor`, 같은 초에 있으면 `-2`, `-3`.
- 주석은 코드만 봐서는 알 수 없는 이유에만, 영어로 단다. 코드 재진술, 변경 이력, 섹션 구분선 주석 금지.
- 커밋 메시지는 저장소 관례(`feat(context): …`, `fix(rm): …`, `docs: …`, 영어 문장형)를 따르고 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 단다. 브랜치는 `feat/band-buttons`.
- 테스트는 `test/isolate-home.ts` 덕에 실제 홈 폴더를 건드리지 않는다. 테스트에서 `os.homedir()`를 직접 쓰지 않는다.

## Review Focus

1. **`/clear`를 누른 직후:** 2초 폴링을 기다리지 않고 띠가 바로 사라지고, 이전 세션의 판단으로 다시 나타나지 않아야 한다. → Task 3(꼬리), Task 5(띠) 테스트
2. **사용자가 `ctrl+x d`를 다른 철자(`Ctrl+X D`, `control+x d`)로 묶었거나 `null`로 풀어 둔 경우:** 이미 쓰는 키로 보고 건드리지 않아야 한다. → Task 6 테스트
3. **`keybindings.json`이 JSON이 아니거나, `bindings`가 배열이 아니거나, 최상위가 배열인 경우:** install은 성공하고 단축키만 "없음"으로 남으며, 파일은 그대로여야 한다. → Task 6, Task 7 테스트
4. **compact 버튼을 눌렀는데 거부되는 경우(대화가 짧음):** 이유가 toast로 뜨고, 그 판단의 띠는 다시 뜨지 않으며(계속 실패하는 버튼 방지), 처리 안 된 rejection이 없어야 한다. → Task 5 테스트
5. **compact가 30% 미만으로만 줄인 경우:** 크기 비교만으로는 이전 판단이 2초 뒤 폴링에서 다시 살아나니, 이미 처리한 판단은 숨겨야 한다. → Task 5 테스트

---

### Task 1: 확인 안 된 3가지 시험 (컨트롤러 + 사용자, 서브에이전트에 맡기지 않음)

사용자가 키를 눌러야 하는 시험이라 구현자에게 보내지 않는다. 컨트롤러가 사용자와 진행한다.

**Files:**
- Modify: `C:\Users\USER\AppData\Local\Temp\claude\C--workspace-claude-jev-advisor\021200d2-5ec3-4fa5-883c-e69862d110a2\scratchpad\jev-button-probe\hooks\register.tsx` (버릴 시험 mod)
- Create (시험 후 삭제): `~/.claude/keybindings.json`
- Modify: `docs/superpowers/specs/2026-10-07-band-buttons-design.md` (결과 기록)

- [ ] **Step 1: 시험 mod 수정**

`fill /clear` 버튼의 `action="app:cycleDiffBase"`를 `action="diff:back"`으로 바꾸고, `register` 안에 다음 두 hook을 추가한다.

```tsx
  on('turn.start', async ($, e, next) => {
    await log($, { event: 'turn.start', tokens: (await $.session.usage()).context.tokens })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await log($, { event: 'turn.complete', tokens: (await $.session.usage()).context.tokens })
    return result
  })
```

`claude plugin validate <시험 mod 폴더>`가 통과하는지 본다.

- [ ] **Step 2: `~/.claude/keybindings.json` 작성**

지금은 파일이 없다(2026-10-07 확인). 사용자에게 알리고 다음 내용으로 만든다.

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    { "context": "DiffDialog", "bindings": { "ctrl+x d": "diff:back" } }
  ]
}
```

- [ ] **Step 3: 사용자 시험**

사용자에게 부탁한다.
1. 이미 열린 시험 세션에서 입력칸을 비우고 `ctrl+x`, `d`를 누른다. `/clear`가 채워지면 즉시 적용된다는 뜻이다.
2. 안 되면 시험 세션을 닫고 같은 `claude --plugin-dir …` 명령으로 다시 띄워서 누른다. 그때 되면 새 세션부터 적용된다는 뜻이다.
3. 짧은 메시지를 두 번 보낸다.

- [ ] **Step 4: 로그 판독**

`scratchpad\probe-log.jsonl`에서 두 번째 `turn.start`의 `tokens`가 첫 번째 `turn.complete`의 `tokens`와 같으면(또는 아주 가까우면) `turn.start` 값이 요청 직전 크기라는 뜻이다.

- [ ] **Step 5: `diff:back`이 안 될 때**

2단계 모두 실패하면 Step 1·2를 `"Pane"` 영역의 `pane:previous`(기본 키 없음)로 바꿔 다시 시험한다. 이것도 안 되면 멈추고 사용자와 대안(`ctrl+x tab` → Enter만 쓰기)을 정한다.

- [ ] **Step 6: 정리**

`~/.claude/keybindings.json`을 지운다(원래 없던 파일). 그래야 Task 10에서 install이 처음부터 만드는 경로를 볼 수 있다. 시험 mod는 Task 10까지 둔다.

- [ ] **Step 7: 결과 기록과 커밋**

spec의 "아직 확인 안 한 것" 아래에 `## 확인 결과 (Task 1)` 절을 만들고 세 항목의 결과를 적는다. 동작이나 영역이 바뀌었으면 이 계획의 Task 4 `shortcut.ts` 값과 Task 6·7·9의 해당 문자열을 같은 값으로 고친다.

```bash
git add docs/superpowers
git commit -m "docs: record which keybinding action the band button can borrow and when usage is read"
```

---

### Task 2: 표시 문자열 — 증가량, 띠 판단, 하단 줄

**Files:**
- Modify: `src/display/line.ts`
- Test: `test/line.test.ts`

**Interfaces:**
- Produces:
  - `type LineInput = { size: number | null; threshold: number | null; judgment: Judgment | null; config: Config; increase?: number | null }`
  - `type BandAdvice = { kind: AdviceKind; remainingPct: number | null }`
  - `increaseSuffix(increase: number | null | undefined): string` — `' +38k'` 또는 `''`
  - `adviceQuestion(kind: AdviceKind, lang: Lang): string` — 명령어 없는 조언 문장
  - `bandAdvice(input: LineInput): BandAdvice | null` — 띠에 그릴 조언(없으면 null)
  - `modTail(input: LineInput): string` — mod 하단 줄 끝 문자열
  - `adviceLine(input: LineInput): string` — 지금과 같고, `increase`가 있으면 크기 바로 뒤에 붙음

- [ ] **Step 1: 실패하는 테스트 작성**

`test/line.test.ts`의 import를 바꾼다.

```ts
import { adviceKind, adviceLine, adviceQuestion, bandAdvice, increaseSuffix, modTail, parseState, usableJudgment, type ContextState, type Judgment } from '../src/display/line.js';
```

파일 끝(Node 금지 테스트 앞)에 추가한다.

```ts
test('the increase follows the size, rounded to whole k, and shows only when the conversation grew', () => {
  assert.equal(increaseSuffix(null), '');
  assert.equal(increaseSuffix(undefined), '');
  assert.equal(increaseSuffix(499), '');
  assert.equal(increaseSuffix(500), ' +1k');
  assert.equal(increaseSuffix(38000), ' +38k');
  assert.equal(increaseSuffix(-5000), '');
  const grown = (size: number, judgment: Judgment | null) => adviceLine({ size, threshold: T, judgment, config: DEFAULT_CONFIG, increase: 38000 });
  assert.equal(grown(52000, null), '52k +38k');
  assert.equal(grown(312000, WORKING), '🟢 312k +38k');
  assert.equal(grown(312000, COMPACT), '🟡 312k +38k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(grown(790000, CLEAR), '🔴 790k +38k 18% · 새롭게 시작하는 건 어떠세요? /clear');
});

test('bandAdvice names the button for advice that can be acted on now', () => {
  const band = (size: number | null, judgment: Judgment | null) => bandAdvice({ size, threshold: T, judgment, config: DEFAULT_CONFIG });
  assert.equal(band(null, CLEAR), null);
  assert.equal(band(249000, CLEAR), null);
  assert.equal(band(312000, null), null);
  assert.equal(band(312000, WORKING), null);
  assert.deepEqual(band(312000, COMPACT), { kind: 'compact', remainingPct: null });
  assert.deepEqual(band(312000, CLEAR), { kind: 'clear', remainingPct: null });
  assert.deepEqual(band(790000, CLEAR), { kind: 'clear', remainingPct: 18 });
  assert.deepEqual(band(790000, COMPACT), { kind: 'compact', remainingPct: 18 });
  assert.equal(band(790000, WORKING), null);
  assert.equal(band(790000, null), null);
  const later = { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, compactMinTokens: 400000 } };
  assert.equal(bandAdvice({ size: 312000, threshold: T, judgment: COMPACT, config: later }), null);
});

test('with a band the tail keeps the size and the increase; without one it is the full line', () => {
  const tail = (size: number, judgment: Judgment | null) => modTail({ size, threshold: T, judgment, config: DEFAULT_CONFIG, increase: 38000 });
  assert.equal(tail(312000, COMPACT), '312k +38k');
  assert.equal(tail(312000, CLEAR), '312k +38k');
  assert.equal(tail(790000, CLEAR), '790k +38k');
  assert.equal(tail(312000, WORKING), '🟢 312k +38k');
  assert.equal(tail(790000, WORKING), '🔴 790k +38k 18% · 작업이 끝나면 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(modTail({ size: null, threshold: T, judgment: CLEAR, config: DEFAULT_CONFIG }), '');
});

test('adviceQuestion is the advice without its command, in the configured language', () => {
  assert.equal(adviceQuestion('clear', 'ko'), '새롭게 시작하는 건 어떠세요?');
  assert.equal(adviceQuestion('compact', 'en'), 'Wrap up what you have and continue?');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/line.test.ts`
Expected: FAIL — `increaseSuffix`, `bandAdvice`, `modTail`, `adviceQuestion`이 export되지 않음

- [ ] **Step 3: 구현**

`src/display/line.ts` 전체를 다음으로 바꾼다. `usableJudgment`와 `parseState`는 지금과 같고, `PHRASES`는 `QUESTIONS`와 `COMMANDS`로 나뉜다.

```ts
import type { Config, Lang } from '../config-shape.js';

export type Judgment = { phase: 'working' | 'unit_done'; clear: boolean };
export type AdviceKind = 'clear' | 'compact';
export type ContextState = { sessionId: string; at: number; size: number | null; judgment: Judgment | null };
export type LineInput = { size: number | null; threshold: number | null; judgment: Judgment | null; config: Config; increase?: number | null };
export type BandAdvice = { kind: AdviceKind; remainingPct: number | null };

export const STALE_SIZE_RATIO = 0.7;

type Advice = AdviceKind | 'compactLater';

const QUESTIONS: Record<Lang, Record<Advice, string>> = {
  ko: {
    clear: '새롭게 시작하는 건 어떠세요?',
    compact: '지금까지 정리하고 이어가는 건 어떠세요?',
    compactLater: '작업이 끝나면 정리하고 이어가는 건 어떠세요?',
  },
  en: {
    clear: 'Start fresh?',
    compact: 'Wrap up what you have and continue?',
    compactLater: 'When this work is done, wrap up and continue?',
  },
};

const COMMANDS: Record<Advice, string> = { clear: '/clear', compact: '/compact', compactLater: '/compact' };

const phrase = (lang: Lang, advice: Advice) => `${QUESTIONS[lang][advice]} ${COMMANDS[advice]}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function adviceQuestion(kind: AdviceKind, lang: Lang): string {
  return QUESTIONS[lang][kind];
}

export function formatSize(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function remainingPct(size: number, threshold: number): number {
  return Math.max(0, Math.round(((threshold - size) / threshold) * 100));
}

export function adviceKind(size: number | null, judgment: Judgment | null, config: Config): AdviceKind | null {
  if (size === null || size < config.context.minTokens || !judgment || judgment.phase === 'working') return null;
  if (judgment.clear) return 'clear';
  return size >= config.context.compactMinTokens ? 'compact' : null;
}

export function increaseSuffix(increase: number | null | undefined): string {
  if (increase === null || increase === undefined) return '';
  const k = Math.round(increase / 1000);
  return k > 0 ? ` +${k}k` : '';
}

function redRemaining(size: number, threshold: number | null, config: Config): number | null {
  if (threshold === null || threshold <= 0 || size < threshold * (1 - config.context.redRemainingPct / 100)) return null;
  return remainingPct(size, threshold);
}

export function adviceLine({ size, threshold, judgment, config, increase }: LineInput): string {
  if (size === null) return '';
  const k = `${formatSize(size)}${increaseSuffix(increase)}`;
  const counted = size >= config.context.minTokens ? judgment : null;
  const red = redRemaining(size, threshold, config);
  if (red !== null) {
    const head = `🔴 ${k} ${red}%`;
    if (!counted) return head;
    if (counted.phase === 'working') return `${head} · ${phrase(config.lang, 'compactLater')}`;
    return `${head} · ${phrase(config.lang, counted.clear ? 'clear' : 'compact')}`;
  }
  if (!counted) return k;
  const kind = adviceKind(size, counted, config);
  return kind ? `🟡 ${k} ${phrase(config.lang, kind)}` : `🟢 ${k}`;
}

export function bandAdvice({ size, threshold, judgment, config }: LineInput): BandAdvice | null {
  if (size === null) return null;
  const counted = size >= config.context.minTokens ? judgment : null;
  if (!counted || counted.phase === 'working') return null;
  const red = redRemaining(size, threshold, config);
  if (red !== null) return { kind: counted.clear ? 'clear' : 'compact', remainingPct: red };
  const kind = adviceKind(size, counted, config);
  return kind ? { kind, remainingPct: null } : null;
}

export function modTail(input: LineInput): string {
  if (input.size === null) return '';
  return bandAdvice(input) ? `${formatSize(input.size)}${increaseSuffix(input.increase)}` : adviceLine(input);
}

export function usableJudgment(state: ContextState | null, liveSize: number | null, turnStartedAt: number): Judgment | null {
  if (!state || !state.judgment || state.at < turnStartedAt) return null;
  if (liveSize !== null && state.size !== null && liveSize < state.size * STALE_SIZE_RATIO) return null;
  return state.judgment;
}

export function parseState(raw: unknown): ContextState | null {
  if (!isRecord(raw) || typeof raw.sessionId !== 'string' || typeof raw.at !== 'number') return null;
  const j = raw.judgment;
  const judgment: Judgment | null =
    isRecord(j) && (j.phase === 'working' || j.phase === 'unit_done') && typeof j.clear === 'boolean' ? { phase: j.phase, clear: j.clear } : null;
  return { sessionId: raw.sessionId, at: raw.at, size: typeof raw.size === 'number' ? raw.size : null, judgment };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck`
Expected: 모두 PASS. 기존 `adviceLine` 테스트(statusline·message·status·report가 쓰는 문자열)는 바뀌지 않아야 한다.

- [ ] **Step 5: 커밋**

```bash
git add src/display/line.ts test/line.test.ts
git commit -m "feat(display): show the size increase after the size and tell which advice the band can act on"
```

---

### Task 3: mod — 요청별 증가량과 세션 종료 처리

**Files:**
- Modify: `src/mod/register.ts`
- Test: `test/mod-register.test.ts`

**Interfaces:**
- Consumes: `adviceLine(input: LineInput)` with `increase` (Task 2)
- Produces: `register`가 `session.end` hook을 건다. 모듈 변수 `baseline: number | null`(요청 시작 때 크기)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/mod-register.test.ts`의 `harness`가 돌려주는 객체에 `end`를 추가한다(`turnStart` 다음 줄).

```ts
    end: async () => hooks.get('session.end')?.hook($, { reason: 'clear', sessionId: 'sess-1' }, async () => 'engine'),
```

기존 테스트 `a new request hides the old judgment until a newer one is saved`의 마지막 단언을 바꾼다.

```ts
  assert.equal(await h.tail(), '🟢 330k +18k');
```

새 테스트를 추가한다.

```ts
test('the tail adds what the current request has added, and keeps it until the next request', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 300000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '300k');
  await h.turnStart();
  assert.equal(await h.tail(), '300k');
  h.live.tokens = 338000;
  await h.tick();
  assert.equal(await h.tail(), '338k +38k');
});

test('an increase under half a k, or a shrink after /compact, is not shown', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 300000, threshold: 967000 });
  await h.start();
  await h.turnStart();
  h.live.tokens = 300400;
  assert.equal(await h.tail(), '300k');
  h.live.tokens = 120000;
  assert.equal(await h.tail(), '120k');
});

test('the end of a session, as /clear ends it, drops the increase and the judgment before the poller runs again', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG };
  const h = harness({ files, tokens: 300000, threshold: 967000 });
  await h.start();
  await h.turnStart();
  files[STATE_FILE] = state(2000, 330000, { phase: 'working', clear: false });
  h.live.tokens = 330000;
  await h.tick();
  assert.equal(await h.tail(), '🟢 330k +30k');
  const before = h.invalidations();
  assert.equal(await h.end(), 'engine');
  assert.equal(h.invalidations(), before + 1);
  assert.equal(await h.tail(), '330k');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/mod-register.test.ts`
Expected: FAIL — 꼬리에 `+38k`가 없고, `end()`가 `undefined`를 돌려줌

- [ ] **Step 3: 구현**

`src/mod/register.ts`에서 `register` 안의 변수 선언에 다음 줄을 추가한다(`let seen = '';` 위).

```ts
  let baseline: number | null = null;
```

`turn.start` hook을 다음으로 바꾼다.

```ts
  on('turn.start', async ($, e, next) => {
    baseline = null;
    try {
      turnStartedAt = await $.clock.now();
      baseline = await liveSize($);
      $.ui.invalidate('ui.render');
    } catch {}
    return next(e);
  });
```

`turn.complete` hook 다음에 `session.end` hook을 추가한다. `/clear` 뒤에는 `session.start`가 다시 오지 않는다(설계 전 시험 mod로 확인). 그래서 여기서 지운다.

```ts
  // After /clear the engine raises no session.start, so the old session's values are dropped here.
  on('session.end', async ($, e, next) => {
    baseline = null;
    state = null;
    seen = '';
    try {
      $.ui.invalidate('ui.render');
    } catch {}
    return next(e);
  });
```

`ui.render`(`PromptHint`) hook 안의 `tail = adviceLine(...)` 줄을 다음 두 줄로 바꾼다.

```ts
        const increase = baseline !== null && size !== null ? size - baseline : null;
        tail = adviceLine({ size, threshold, judgment: usableJudgment(state, size, turnStartedAt), config: current, increase });
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck`
Expected: 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/mod/register.ts test/mod-register.test.ts
git commit -m "feat(context): show how much the current request has added, and drop it and the judgment when the session ends"
```

---

### Task 4: 띠 그리기 — 단축키 상수, 설정 값, `band.ts`

**Files:**
- Create: `src/display/shortcut.ts`
- Create: `src/mod/band.ts`
- Modify: `src/config-shape.ts`
- Modify: `src/mod/claude-code.d.ts`
- Test: `test/mod-band.test.ts` (새 파일), `test/config.test.ts`, `test/line.test.ts`

**Interfaces:**
- Consumes: `BandAdvice`, `adviceQuestion` (Task 2)
- Produces:
  - `src/display/shortcut.ts`: `SHORTCUT_CHORD = 'ctrl+x d'`, `SHORTCUT_ACTION = 'diff:back'`, `SHORTCUT_CONTEXT = 'DiffDialog'`, `shortcutLabel(chord: string): string`(`'ctrl+x d'` → `'^X d'`)
  - `Config.shortcut: string | null` (기본 `null`)
  - `src/mod/band.ts`: `type BandElements = { Box: unknown; Text: unknown; Button: unknown }`, `type BandInput = { advice: BandAdvice; config: Config; onPress: () => void }`, `drawBand(ui: BandElements, input: BandInput): unknown`
  - 전역 `h(type, props, ...children)` 선언(`src/mod/claude-code.d.ts`)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/mod-band.test.ts`를 만든다.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { adviceQuestion, type AdviceKind, type BandAdvice } from '../src/display/line.js';
import { SHORTCUT_ACTION, shortcutLabel } from '../src/display/shortcut.js';
import { drawBand } from '../src/mod/band.js';

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
Object.assign(globalThis, {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children: children.flat() }),
});

const UI = { Box: 'Box', Text: 'Text', Button: 'Button' };
const KINDS: AdviceKind[] = ['compact', 'clear'];

function nodes(tree: unknown): Node[] {
  if (typeof tree !== 'object' || tree === null) return [];
  const node = tree as Node;
  return [node, ...node.children.flatMap(nodes)];
}

function words(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (typeof tree !== 'object' || tree === null) return '';
  const node = tree as Node;
  const label = typeof node.props.label === 'string' ? node.props.label : '';
  return label + node.children.map(words).join('');
}

const draw = (advice: BandAdvice, config: Config = DEFAULT_CONFIG, onPress = () => {}) => drawBand(UI, { advice, config, onPress });
const buttons = (tree: unknown) => nodes(tree).filter((n) => n.type === 'Button');

test('the band holds the advice question and one button for the advised command', () => {
  for (const kind of KINDS) {
    const tree = draw({ kind, remainingPct: null });
    const all = buttons(tree);
    assert.equal(all.length, 1);
    assert.ok(String(all[0]?.props.label).includes(`/${kind}`));
    assert.ok(words(tree).includes(adviceQuestion(kind, 'ko')));
  }
  assert.ok(words(draw({ kind: 'clear', remainingPct: null }, { ...DEFAULT_CONFIG, lang: 'en' })).includes('Start fresh?'));
});

test('compact and clear bands differ by more than the question and the command, since one shortcut presses either', () => {
  const rest = (kind: AdviceKind) => words(draw({ kind, remainingPct: null })).replace(adviceQuestion(kind, 'ko'), '').replace(`/${kind}`, '');
  assert.notEqual(rest('compact'), rest('clear'));
});

test('the red zone shows the percent left', () => {
  assert.ok(words(draw({ kind: 'compact', remainingPct: 18 })).includes('18%'));
  assert.equal(words(draw({ kind: 'compact', remainingPct: null })).includes('%'), false);
});

test('the shortcut is bound and shown only when install recorded one', () => {
  const none = draw({ kind: 'compact', remainingPct: null });
  assert.equal(buttons(none)[0]?.props.action, undefined);
  assert.equal(words(none).includes('^X'), false);
  const bound = draw({ kind: 'compact', remainingPct: null }, { ...DEFAULT_CONFIG, shortcut: 'ctrl+x d' });
  assert.equal(buttons(bound)[0]?.props.action, SHORTCUT_ACTION);
  assert.ok(words(bound).includes(shortcutLabel('ctrl+x d')));
});

test('pressing the button runs the handler it was given', () => {
  let pressed = 0;
  const tree = draw({ kind: 'clear', remainingPct: null }, DEFAULT_CONFIG, () => {
    pressed += 1;
  });
  (buttons(tree)[0]?.props.onPress as () => void)();
  assert.equal(pressed, 1);
});

test('no string in the band uses U+FE0F, which terminals draw at the wrong width', () => {
  for (const kind of KINDS) {
    for (const remainingPct of [null, 18]) {
      for (const lang of ['ko', 'en'] as const) {
        assert.equal(words(draw({ kind, remainingPct }, { ...DEFAULT_CONFIG, lang, shortcut: 'ctrl+x d' })).includes('\uFE0F'), false);
      }
    }
  }
});

test('shortcutLabel writes ctrl as a caret', () => {
  assert.equal(shortcutLabel('ctrl+x d'), '^X d');
  assert.equal(shortcutLabel('ctrl+x ctrl+k'), '^X ^K');
});
```

`test/config.test.ts`의 config import에 `normalizeConfig`와 `configToSave`를 추가하고(`import { DEFAULT_CONFIG, configToSave, normalizeConfig, readConfig, updateConfig, writeConfig, type Config } from '../src/config.js';`) 테스트를 추가한다.

```ts
test('the shortcut install recorded is read back, an empty or wrong value reads as none, and none is not saved', () => {
  assert.equal(normalizeConfig({ shortcut: 'ctrl+x d' }).shortcut, 'ctrl+x d');
  assert.equal(normalizeConfig({ shortcut: '' }).shortcut, null);
  assert.equal(normalizeConfig({ shortcut: 3 }).shortcut, null);
  assert.equal(normalizeConfig({}).shortcut, null);
  assert.equal('shortcut' in configToSave(DEFAULT_CONFIG), false);
  assert.equal(configToSave({ ...DEFAULT_CONFIG, shortcut: 'ctrl+x d' }).shortcut, 'ctrl+x d');
});
```

`test/line.test.ts`의 Node 금지 테스트 파일 목록을 바꾼다.

```ts
  for (const file of ['src/display/line.ts', 'src/config-shape.ts', 'src/display/shortcut.ts', 'src/mod/band.ts']) {
```

그 테스트 이름도 `'the code the mod bundle uses imports nothing from Node'`로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `npm test`
Expected: FAIL — `src/display/shortcut.ts`, `src/mod/band.ts` 없음, `shortcut` 없음

- [ ] **Step 3: 구현**

`src/display/shortcut.ts`:

```ts
export const SHORTCUT_CHORD = 'ctrl+x d';
// Claude Code lets a mod Button take the chord of an engine action whose own handler is not mounted;
// diff:back has no key of its own and is handled only while the diff dialog is open.
export const SHORTCUT_ACTION = 'diff:back';
export const SHORTCUT_CONTEXT = 'DiffDialog';

export function shortcutLabel(chord: string): string {
  return chord
    .split(' ')
    .map((stroke) => stroke.replace(/^ctrl\+(.)$/, (_match, key: string) => `^${key.toUpperCase()}`))
    .join(' ');
}
```

`src/config-shape.ts`:
- `Config` 타입: `export type Config = { lang: Lang; keyFile: string | null; display: Display; shortcut: string | null; context: ContextConfig; rm: RmConfig };`
- `DEFAULT_CONFIG`에 `display: 'mod',` 다음 줄로 `shortcut: null,`
- `normalizeConfig` 반환 객체의 `display: …` 다음 줄에 `shortcut: typeof r.shortcut === 'string' && r.shortcut !== '' ? r.shortcut : null,`

`src/mod/claude-code.d.ts` 끝(`declare module` 블록 밖)에 추가한다.

```ts
declare function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
```

`src/mod/band.ts`:

```ts
import type { Config } from '../config-shape.js';
import { adviceQuestion, type AdviceKind, type BandAdvice } from '../display/line.js';
import { SHORTCUT_ACTION, shortcutLabel } from '../display/shortcut.js';

export type BandElements = { Box: unknown; Text: unknown; Button: unknown };
export type BandInput = { advice: BandAdvice; config: Config; onPress: () => void };

const ICONS: Record<AdviceKind, string> = { compact: '📦', clear: '🧹' };

export function drawBand(ui: BandElements, { advice, config, onPress }: BandInput): unknown {
  const { Box, Text, Button } = ui;
  const head = advice.remainingPct === null ? '🟡' : `🔴 ${advice.remainingPct}% ·`;
  const children: unknown[] = [
    h(Text, null, `${head} ${adviceQuestion(advice.kind, config.lang)} `),
    h(Button, {
      key: `jev-${advice.kind}`,
      label: `${ICONS[advice.kind]} /${advice.kind}`,
      variant: 'primary',
      onPress,
      ...(config.shortcut ? { action: SHORTCUT_ACTION } : {}),
    }),
  ];
  if (config.shortcut) children.push(h(Text, { dimColor: true }, ` ${shortcutLabel(config.shortcut)}`));
  return h(Box, null, ...children);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck`
Expected: 모두 PASS. `typecheck`가 `shortcut`이 빠진 `Config` 리터럴을 찾으면 그 자리에 `shortcut: null`을 넣는다.

- [ ] **Step 5: 커밋**

```bash
git add src/display/shortcut.ts src/mod/band.ts src/config-shape.ts src/mod/claude-code.d.ts test/mod-band.test.ts test/config.test.ts test/line.test.ts
git commit -m "feat(context): draw the advice band with one button and record the shortcut install bound"
```

---

### Task 5: mod — 띠 연결, 버튼 동작, 처리한 판단 숨기기

**Files:**
- Modify: `src/mod/register.ts`
- Modify: `src/mod/claude-code.d.ts`
- Test: `test/mod-register.test.ts`

**Interfaces:**
- Consumes: `bandAdvice`, `modTail` (Task 2), `drawBand`, `BandElements` (Task 4), `Config.shortcut` (Task 4)
- Produces: `register`가 `ui.render` `{ component: 'AbovePrompt' }` hook을 건다

- [ ] **Step 1: 실패하는 테스트 작성**

`test/mod-register.test.ts` 맨 위 타입과 상수 부분을 다음으로 바꾼다(`CONFIG_FILE`, `STATE_FILE`, `state`는 그대로).

```ts
type AnyFn = (...args: any[]) => any;
type Fail = { usage?: boolean; now?: boolean; read?: 'throw' | 'object'; compact?: string };
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };

Object.assign(globalThis, {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children: children.flat() }),
});

function buttonOf(tree: unknown): Node | undefined {
  if (typeof tree !== 'object' || tree === null) return undefined;
  const node = tree as Node;
  if (node.type === 'Button') return node;
  for (const child of node.children) {
    const found = buttonOf(child);
    if (found) return found;
  }
  return undefined;
}
```

`harness` 안에서:
- `on`을 matcher의 `component`까지 key로 쓰게 바꾼다.

```ts
  const on = (event: string, a: unknown, b?: unknown) => {
    const matcher = b === undefined ? null : a;
    const component = (matcher as { component?: string } | null)?.component;
    hooks.set(component ? `${event}:${component}` : event, { matcher, hook: (b ?? a) as AnyFn });
  };
```

- `const fail` 다음에 추가한다.

```ts
  const toasts: string[] = [];
  const calls = { compact: 0, run: [] as unknown[] };
```

- `$.session`에 `usage` 다음으로 추가한다.

```ts
      compact: async () => {
        calls.compact += 1;
        if (fail.compact) throw new Error(fail.compact);
        return {};
      },
```

- `$`에 `command`를 추가한다.

```ts
    command: {
      run: async (args: unknown) => {
        calls.run.push(args);
        return { text: '' };
      },
    },
```

- `$.ui`를 다음으로 바꾼다.

```ts
    ui: {
      invalidate: () => {
        invalidations += 1;
      },
      toast: (text: string) => {
        toasts.push(text);
      },
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
    },
```

- 돌려주는 객체에 `toasts`, `calls`를 넣고, `tail`의 `hooks.get('ui.render')`를 `hooks.get('ui.render:PromptHint')`로 바꾸고, 다음 둘을 추가한다.

```ts
    band: async (props: Record<string, unknown> = {}) => {
      const e = { props: { hasSurvey: false, isWorking: false, maxRows: 20, ...props } };
      return hooks.get('ui.render:AbovePrompt')?.hook($, e, async () => 'engine');
    },
    press: async (tree: unknown) => {
      (buttonOf(tree)?.props.onPress as () => void)();
      await settle();
      await settle();
    },
```

기존 테스트를 고친다.
- `the render hook targets the PromptHint row`: `h.hooks.get('ui.render:PromptHint')?.matcher`
- `the tail shows the saved judgment for this session`을 다음으로 바꾼다.

```ts
test('the saved judgment for this session shows as a band, and the tail keeps the size', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'unit_done', clear: true }) }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '312k');
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/clear'));
});
```

- `a new request hides the old judgment until a newer one is saved`의 앞부분을 다음으로 바꾼다(마지막 `'🟢 330k +18k'`는 그대로).

```ts
  await h.start();
  assert.equal(await h.tail(), '312k');
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/compact'));
  h.setNow(5000);
  assert.equal(await h.turnStart(), 'engine');
  assert.equal(await h.tail(), '312k');
  assert.equal(await h.band(), 'engine');
```

- `a headless session starts no poller and draws nothing` 끝에 `assert.equal(await h.band(), 'engine');`

새 테스트를 추가한다.

```ts
const COMPACT_STATE = state(900, 312000, { phase: 'unit_done', clear: false });
const CLEAR_STATE = state(900, 312000, { phase: 'unit_done', clear: true });

test('the band hook targets the row above the prompt', () => {
  const h = harness({ files: {} });
  assert.deepEqual(h.hooks.get('ui.render:AbovePrompt')?.matcher, { component: 'AbovePrompt' });
});

test('no band while a turn runs, a survey is up, the work goes on, or another display or a switched-off helper is set', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.band({ isWorking: true }), 'engine');
  assert.equal(await h.band({ hasSurvey: true }), 'engine');
  const working = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'working', clear: false }) }, tokens: 312000, threshold: 967000 });
  await working.start();
  assert.equal(await working.band(), 'engine');
  const others: Config[] = [{ ...DEFAULT_CONFIG, display: 'statusline' }, { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, enabled: false } }];
  for (const config of others) {
    const other = harness({ files: { [CONFIG_FILE]: config, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
    await other.start();
    assert.equal(await other.band(), 'engine');
  }
});

test('pressing compact compacts, and the band stays away for that judgment even when the poller reads it again', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  await h.press(await h.band());
  assert.equal(h.calls.compact, 1);
  assert.equal(await h.band(), 'engine');
  h.live.tokens = 260000;
  await h.tick();
  assert.equal(await h.band(), 'engine');
  assert.equal(await h.tail(), '260k');
});

test('pressing clear runs /clear', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  await h.press(await h.band());
  assert.deepEqual(h.calls.run, [{ command: 'clear' }]);
});

test('a refused compact is shown as a toast and its button does not come back', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE }, tokens: 312000, threshold: 967000, fail: { compact: 'Not enough messages to compact.' } });
  await h.start();
  await h.press(await h.band());
  assert.deepEqual(h.toasts, ['/compact: Not enough messages to compact.']);
  assert.equal(await h.band(), 'engine');
});

test('a newer judgment brings the band back after one was acted on', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  await h.press(await h.band());
  files[STATE_FILE] = state(1500, 320000, { phase: 'unit_done', clear: true });
  h.live.tokens = 320000;
  await h.tick();
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/clear'));
});

test('after the session ends the band is gone before the poller runs again', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.notEqual(await h.band(), 'engine');
  await h.end();
  assert.equal(await h.band(), 'engine');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/mod-register.test.ts`
Expected: FAIL — `ui.render:AbovePrompt` hook 없음, 꼬리에 조언 문구가 남음

- [ ] **Step 3: 구현**

`src/mod/claude-code.d.ts`의 `Engine` 타입을 다음으로 바꾼다.

```ts
  export type Engine = {
    session: {
      id(): Promise<string>;
      usage(args?: { breakdown?: 'summary' | 'full' }): Promise<{ context: { tokens?: number; window: number; breakdown?: { autoCompactThreshold?: number } } }>;
      compact(): Promise<{ skip?: unknown } | undefined>;
    };
    command: { run(args: { command: string }): Promise<unknown> };
    fs: { read(path: string): Promise<unknown> };
    clock: { now(): Promise<number>; every(ms: number, fn: () => void): unknown };
    ui: {
      invalidate(event: 'ui.render'): void;
      toast(text: string): void;
      resolve(e: HookEvent): { Box: unknown; Text: unknown; Button: unknown };
    };
  };
```

`src/mod/register.ts`:

import를 다음으로 바꾼다.

```ts
import type { Engine, On } from 'claude-code';
import { normalizeConfig, type Config } from '../config-shape.js';
import { bandAdvice, modTail, parseState, usableJudgment, type AdviceKind, type ContextState, type Judgment } from '../display/line.js';
import { drawBand } from './band.js';
```

`liveSize` 함수 다음에 추가한다.

```ts
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

`register` 안 변수 선언에 `let handledAt = -Infinity;`를 추가하고, 변수 선언 다음(첫 `on(...)` 위, 기존 주석 위)에 추가한다.

```ts
  const judgmentFor = (size: number | null): Judgment | null => (state && state.at <= handledAt ? null : usableJudgment(state, size, turnStartedAt));

  async function press($: Engine, kind: AdviceKind): Promise<void> {
    handledAt = state?.at ?? handledAt;
    try {
      $.ui.invalidate('ui.render');
      if (kind === 'compact') {
        const result = await $.session.compact();
        if (result?.skip) $.ui.toast('/compact: skipped by a hook');
      } else {
        await $.command.run({ command: 'clear' });
      }
    } catch (err) {
      try {
        $.ui.toast(`/${kind}: ${reason(err)}`);
      } catch {}
    }
  }
```

`PromptHint` hook 안의 `tail = adviceLine(...)` 줄을 다음으로 바꾼다.

```ts
        tail = modTail({ size, threshold, judgment: judgmentFor(size), config: current, increase });
```

파일 끝(`register`의 닫는 중괄호 앞)에 띠 hook을 추가한다.

```ts
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let band: unknown = null;
    try {
      const current = config;
      const props = e.props ?? {};
      if (current && current.context.enabled && current.display === 'mod' && props.isWorking !== true && props.hasSurvey !== true) {
        const size = await liveSize($);
        const advice = bandAdvice({ size, threshold, judgment: judgmentFor(size), config: current });
        if (advice) band = drawBand($.ui.resolve(e), { advice, config: current, onPress: () => void press($, advice.kind) });
      }
    } catch {
      band = null;
    }
    return band ?? next(e);
  });
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck && npm run build`
Expected: 모두 PASS, `mod/hooks/register.js` 생성

- [ ] **Step 5: mod 검증**

Run: `claude plugin validate mod`
Expected: `Validation passed`. hooks 목록에 `ui.render{component=AbovePrompt}`와 `session.end`가 있고, calls에 `$.session.compact`, `$.command.run`, `$.ui.toast`, `$.ui.resolve`가 있다.

- [ ] **Step 6: 커밋**

```bash
git add src/mod/register.ts src/mod/claude-code.d.ts test/mod-register.test.ts
git commit -m "feat(context): move advice that can be acted on into a band above the prompt with a button that runs it"
```

---

### Task 6: `keybindings.json` 읽고 쓰기

**Files:**
- Create: `src/display/keybindings.ts`
- Modify: `src/paths.ts`
- Modify: `src/settings-file.ts`
- Test: `test/keybindings.test.ts` (새 파일), `test/settings-file.test.ts`

**Interfaces:**
- Consumes: `SHORTCUT_CHORD`, `SHORTCUT_ACTION`, `SHORTCUT_CONTEXT` (Task 4)
- Produces:
  - `keybindingsPath(home: string): string` (`src/paths.ts`)
  - `backupName(now: Date, fileName = 'settings.json'): string`. `backupSettingsFile`는 백업 이름에 원본 파일 이름을 쓴다. `writeSettingsFile(file: string, settings: object)`
  - `type ShortcutInstall = { shortcut: string | null; takenBy: string | null; problem: string | null; backup: string | null }`
  - `type ShortcutState = 'present' | 'absent' | 'unreadable'`
  - `installShortcut(home: string, now: Date): ShortcutInstall` — 예외를 던지지 않는다
  - `removeShortcut(home: string, now: Date): { removed: boolean; backup: string | null }` — 예외를 던지지 않는다
  - `shortcutState(home: string): ShortcutState`
  - 순수 함수: `normalizeChord`, `parseKeybindings`, `newKeybindings`, `hasShortcut`, `shortcutTakenBy`, `withShortcut`, `withoutShortcut`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/settings-file.test.ts`의 `backupName stamps the local date and time` 테스트 끝에 추가한다.

```ts
  assert.equal(backupName(new Date(2026, 9, 2, 9, 5, 7), 'keybindings.json'), 'keybindings.json.2026-10-02-090507-before-claude-jev-advisor');
```

`test/keybindings.test.ts`를 만든다.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installShortcut, newKeybindings, normalizeChord, removeShortcut, shortcutState, shortcutTakenBy, withShortcut, withoutShortcut, type Keybindings } from '../src/display/keybindings.js';
import { backupsDir, keybindingsPath } from '../src/paths.js';

const NOW = new Date(2026, 9, 7, 10, 0, 0);
const OURS = { context: 'DiffDialog', bindings: { 'ctrl+x d': 'diff:back' } };
const CHAT = { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } };
const kb = (...bindings: unknown[]): Keybindings => ({ $schema: 'x', bindings });
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-kb-'));
function writeKb(home: string, text: string) {
  fs.mkdirSync(path.dirname(keybindingsPath(home)), { recursive: true });
  fs.writeFileSync(keybindingsPath(home), text);
}
const readKb = (home: string) => JSON.parse(fs.readFileSync(keybindingsPath(home), 'utf8'));

test('normalizeChord reads case, spacing and control as one chord', () => {
  assert.equal(normalizeChord('Ctrl+X D'), 'ctrl+x d');
  assert.equal(normalizeChord(' control+x   d '), 'ctrl+x d');
});

test('withShortcut adds our binding in a new DiffDialog block or beside the user ones, once', () => {
  assert.deepEqual(withShortcut(kb(CHAT)).bindings, [CHAT, OURS]);
  const diff = { context: 'DiffDialog', bindings: { left: 'diff:previousSource' } };
  assert.deepEqual(withShortcut(kb(diff)).bindings, [{ context: 'DiffDialog', bindings: { left: 'diff:previousSource', 'ctrl+x d': 'diff:back' } }]);
  const once = withShortcut(kb(CHAT));
  assert.equal(withShortcut(once), once);
});

test('the chord bound to anything else, in any block or spelling, is taken', () => {
  assert.equal(shortcutTakenBy(kb(CHAT)), null);
  assert.equal(shortcutTakenBy(kb(OURS)), null);
  assert.equal(shortcutTakenBy(kb({ context: 'Chat', bindings: { 'Ctrl+X D': 'chat:stash' } })), 'Chat: chat:stash');
  assert.equal(shortcutTakenBy(kb({ context: 'DiffDialog', bindings: { 'ctrl+x d': 'diff:dismiss' } })), 'DiffDialog: diff:dismiss');
  assert.equal(shortcutTakenBy(kb({ context: 'Global', bindings: { 'ctrl+x d': null } })), 'Global: null');
});

test('withoutShortcut takes out only our binding and a DiffDialog block it emptied', () => {
  assert.deepEqual(withoutShortcut(kb(CHAT, OURS)).bindings, [CHAT]);
  const shared = { context: 'DiffDialog', bindings: { left: 'diff:previousSource', 'ctrl+x d': 'diff:back' } };
  assert.deepEqual(withoutShortcut(kb(shared)).bindings, [{ context: 'DiffDialog', bindings: { left: 'diff:previousSource' } }]);
  const changed = kb({ context: 'DiffDialog', bindings: { 'ctrl+x d': 'diff:dismiss' } });
  assert.equal(withoutShortcut(changed), changed);
});

test('installShortcut creates keybindings.json with the schema and the docs link when there is none', () => {
  const home = tempHome();
  assert.deepEqual(installShortcut(home, NOW), { shortcut: 'ctrl+x d', takenBy: null, problem: null, backup: null });
  assert.deepEqual(readKb(home), { ...newKeybindings(), bindings: [OURS] });
});

test('installShortcut backs up an existing file, keeps its entries, and changes nothing the second time', () => {
  const home = tempHome();
  const original = JSON.stringify({ bindings: [CHAT] }, null, 2);
  writeKb(home, original);
  const first = installShortcut(home, NOW);
  assert.equal(first.backup, path.join(backupsDir(home), 'keybindings.json.2026-10-07-100000-before-claude-jev-advisor'));
  assert.equal(fs.readFileSync(first.backup as string, 'utf8'), original);
  assert.deepEqual(readKb(home), { bindings: [CHAT, OURS] });
  assert.deepEqual(installShortcut(home, NOW), { shortcut: 'ctrl+x d', takenBy: null, problem: null, backup: null });
});

test('installShortcut leaves a taken chord and a file it cannot use exactly as they were', () => {
  const texts = [JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+x d': 'chat:stash' } }] }), '{ not json', '{"bindings": {}}', '[]'];
  for (const text of texts) {
    const home = tempHome();
    writeKb(home, text);
    const r = installShortcut(home, NOW);
    assert.equal(r.shortcut, null, text);
    assert.equal(r.backup, null, text);
    assert.ok(r.takenBy || r.problem, text);
    assert.equal(fs.readFileSync(keybindingsPath(home), 'utf8'), text);
    assert.equal(fs.existsSync(backupsDir(home)), false, text);
  }
});

test('removeShortcut takes out our binding after a backup, and leaves anything else alone', () => {
  const home = tempHome();
  writeKb(home, JSON.stringify({ bindings: [CHAT, OURS] }));
  const r = removeShortcut(home, NOW);
  assert.equal(r.removed, true);
  assert.ok(r.backup);
  assert.deepEqual(readKb(home), { bindings: [CHAT] });
  assert.deepEqual(removeShortcut(home, NOW), { removed: false, backup: null });
  assert.deepEqual(removeShortcut(tempHome(), NOW), { removed: false, backup: null });
  const broken = tempHome();
  writeKb(broken, '{ not json');
  assert.deepEqual(removeShortcut(broken, NOW), { removed: false, backup: null });
});

test('shortcutState tells present, absent and unreadable apart', () => {
  const home = tempHome();
  assert.equal(shortcutState(home), 'absent');
  installShortcut(home, NOW);
  assert.equal(shortcutState(home), 'present');
  writeKb(home, '{ not json');
  assert.equal(shortcutState(home), 'unreadable');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/keybindings.test.ts test/settings-file.test.ts`
Expected: FAIL — 모듈 없음, `backupName`이 두 번째 인자를 무시함

- [ ] **Step 3: 구현**

`src/paths.ts`에 추가한다.

```ts
export const keybindingsPath = (home: string) => path.join(claudeDir(home), 'keybindings.json');
```

`src/settings-file.ts`:
- `backupName`을 `export function backupName(now: Date, fileName = 'settings.json'): string`으로 바꾸고, 반환 줄을 `` return `${fileName}.${stamp}-before-claude-jev-advisor`; ``로 바꾼다.
- `backupSettingsFile` 안의 `const baseName = backupName(now);`를 `const baseName = backupName(now, path.basename(file));`로 바꾼다.
- `writeSettingsFile`의 시그니처를 `export function writeSettingsFile(file: string, settings: object): void`로 바꾼다.

`src/display/keybindings.ts`:

```ts
import fs from 'node:fs';
import { backupsDir, keybindingsPath } from '../paths.js';
import { backupSettingsFile, readSettingsFile, writeSettingsFile } from '../settings-file.js';
import { SHORTCUT_ACTION, SHORTCUT_CHORD, SHORTCUT_CONTEXT } from './shortcut.js';

export const KEYBINDINGS_SCHEMA = 'https://www.schemastore.org/claude-code-keybindings.json';
export const KEYBINDINGS_DOCS = 'https://code.claude.com/docs/en/keybindings';

export type Keybindings = { bindings: unknown[]; [key: string]: unknown };
export type ShortcutInstall = { shortcut: string | null; takenBy: string | null; problem: string | null; backup: string | null };
export type ShortcutState = 'present' | 'absent' | 'unreadable';
type Block = { context: string; bindings: Record<string, unknown>; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlock(value: unknown): value is Block {
  return isRecord(value) && typeof value.context === 'string' && isRecord(value.bindings);
}

// A user binding spelled another way may still be the same chord to Claude Code, so every spelling counts as taken.
export function normalizeChord(chord: string): string {
  return chord
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((stroke) => stroke.split('+').map((key) => (key === 'control' ? 'ctrl' : key)).join('+'))
    .join(' ');
}

function chordKey(block: Block): string | null {
  const target = normalizeChord(SHORTCUT_CHORD);
  return Object.keys(block.bindings).find((key) => normalizeChord(key) === target) ?? null;
}

function isOurs(block: Block): boolean {
  const key = chordKey(block);
  return block.context === SHORTCUT_CONTEXT && key !== null && block.bindings[key] === SHORTCUT_ACTION;
}

export function parseKeybindings(raw: unknown): Keybindings | null {
  return isRecord(raw) && Array.isArray(raw.bindings) ? (raw as Keybindings) : null;
}

export function newKeybindings(): Keybindings {
  return { $schema: KEYBINDINGS_SCHEMA, $docs: KEYBINDINGS_DOCS, bindings: [] };
}

export function hasShortcut(kb: Keybindings): boolean {
  return kb.bindings.some((b) => isBlock(b) && isOurs(b));
}

export function shortcutTakenBy(kb: Keybindings): string | null {
  for (const b of kb.bindings) {
    if (!isBlock(b) || isOurs(b)) continue;
    const key = chordKey(b);
    if (key !== null) return `${b.context}: ${String(b.bindings[key])}`;
  }
  return null;
}

export function withShortcut(kb: Keybindings): Keybindings {
  if (hasShortcut(kb)) return kb;
  const bindings = [...kb.bindings];
  const at = bindings.findIndex((b) => isBlock(b) && b.context === SHORTCUT_CONTEXT);
  if (at === -1) {
    bindings.push({ context: SHORTCUT_CONTEXT, bindings: { [SHORTCUT_CHORD]: SHORTCUT_ACTION } });
  } else {
    const block = bindings[at] as Block;
    bindings[at] = { ...block, bindings: { ...block.bindings, [SHORTCUT_CHORD]: SHORTCUT_ACTION } };
  }
  return { ...kb, bindings };
}

export function withoutShortcut(kb: Keybindings): Keybindings {
  if (!hasShortcut(kb)) return kb;
  const bindings: unknown[] = [];
  for (const b of kb.bindings) {
    if (!isBlock(b) || !isOurs(b)) {
      bindings.push(b);
      continue;
    }
    const key = chordKey(b) as string;
    const { [key]: _ours, ...rest } = b.bindings;
    if (Object.keys(rest).length) bindings.push({ ...b, bindings: rest });
  }
  return { ...kb, bindings };
}

function readKeybindings(file: string): Keybindings | null | 'missing' {
  if (!fs.existsSync(file)) return 'missing';
  return parseKeybindings(readSettingsFile(file));
}

export function installShortcut(home: string, now: Date): ShortcutInstall {
  const none = (takenBy: string | null, problem: string | null): ShortcutInstall => ({ shortcut: null, takenBy, problem, backup: null });
  const file = keybindingsPath(home);
  try {
    const read = readKeybindings(file);
    if (read === null) return none(null, 'it holds no "bindings" list');
    const kb = read === 'missing' ? newKeybindings() : read;
    if (hasShortcut(kb)) return { shortcut: SHORTCUT_CHORD, takenBy: null, problem: null, backup: null };
    const takenBy = shortcutTakenBy(kb);
    if (takenBy) return none(takenBy, null);
    const backup = backupSettingsFile(file, backupsDir(home), now);
    writeSettingsFile(file, withShortcut(kb));
    return { shortcut: SHORTCUT_CHORD, takenBy: null, problem: null, backup };
  } catch (err) {
    return none(null, (err as Error).message);
  }
}

export function removeShortcut(home: string, now: Date): { removed: boolean; backup: string | null } {
  const file = keybindingsPath(home);
  try {
    const read = readKeybindings(file);
    if (read === 'missing' || read === null || !hasShortcut(read)) return { removed: false, backup: null };
    const backup = backupSettingsFile(file, backupsDir(home), now);
    writeSettingsFile(file, withoutShortcut(read));
    return { removed: true, backup };
  } catch {
    return { removed: false, backup: null };
  }
}

export function shortcutState(home: string): ShortcutState {
  try {
    const read = readKeybindings(keybindingsPath(home));
    if (read === null) return 'unreadable';
    return read !== 'missing' && hasShortcut(read) ? 'present' : 'absent';
  } catch {
    return 'unreadable';
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck`
Expected: 모두 PASS(기존 settings 백업 테스트 포함)

- [ ] **Step 5: 커밋**

```bash
git add src/display/keybindings.ts src/paths.ts src/settings-file.ts test/keybindings.test.ts test/settings-file.test.ts
git commit -m "feat(context): add and remove the ctrl+x d line in keybindings.json, leaving taken chords and unreadable files alone"
```

---

### Task 7: install, uninstall, CLI 출력, status 연결

**Files:**
- Modify: `src/install.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/status.ts`
- Test: `test/install-context.test.ts`, `test/cli.test.ts`, `test/status-context.test.ts`

**Interfaces:**
- Consumes: `installShortcut`, `removeShortcut`, `shortcutState`, `ShortcutInstall` (Task 6), `SHORTCUT_CHORD` (Task 4), `Config.shortcut` (Task 4)
- Produces: `InstallResult.shortcut: ShortcutInstall | null`, `uninstall(...)` 결과의 `shortcut: { removed: boolean; backup: string | null } | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/install-context.test.ts`의 paths import에 `keybindingsPath`를 추가하고, 상수 아래에 다음을 둔다.

```ts
const OURS = { context: 'DiffDialog', bindings: { 'ctrl+x d': 'diff:back' } };
const readKb = (home: string) => JSON.parse(fs.readFileSync(keybindingsPath(home), 'utf8'));
function writeKb(home: string, value: unknown) {
  fs.mkdirSync(path.dirname(keybindingsPath(home)), { recursive: true });
  fs.writeFileSync(keybindingsPath(home), JSON.stringify(value));
}
```

테스트를 추가한다.

```ts
test('install context with the mod display binds ctrl+x d and records it', () => {
  const home = tempHome();
  const r = install(opts(home));
  assert.deepEqual(r.shortcut, { shortcut: 'ctrl+x d', takenBy: null, problem: null, backup: null });
  assert.deepEqual(readKb(home).bindings, [OURS]);
  assert.equal(readConfig(home).shortcut, 'ctrl+x d');
});

test('a chord the user already uses is kept, and the shortcut is recorded as none', () => {
  const home = tempHome();
  writeKb(home, { bindings: [{ context: 'Chat', bindings: { 'ctrl+x d': 'chat:stash' } }] });
  const before = fs.readFileSync(keybindingsPath(home), 'utf8');
  const r = install(opts(home));
  assert.deepEqual(r.installed, ['context']);
  assert.equal(r.shortcut?.takenBy, 'Chat: chat:stash');
  assert.equal(readConfig(home).shortcut, null);
  assert.equal(fs.readFileSync(keybindingsPath(home), 'utf8'), before);
});

test('a keybindings.json that is not JSON does not stop install', () => {
  const home = tempHome();
  fs.mkdirSync(path.dirname(keybindingsPath(home)), { recursive: true });
  fs.writeFileSync(keybindingsPath(home), '{ not json');
  const r = install(opts(home));
  assert.deepEqual(r.installed, ['context']);
  assert.ok(r.shortcut?.problem);
  assert.equal(readConfig(home).shortcut, null);
  assert.equal(fs.readFileSync(keybindingsPath(home), 'utf8'), '{ not json');
});

test('switching away from the mod display and uninstalling take out only our binding', () => {
  const home = tempHome();
  const chat = { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } };
  writeKb(home, { bindings: [chat] });
  install(opts(home));
  install(opts(home, { display: 'statusline' }));
  assert.deepEqual(readKb(home).bindings, [chat]);
  assert.equal(readConfig(home).shortcut, null);
  install(opts(home, { display: 'mod' }));
  assert.deepEqual(readKb(home).bindings, [chat, OURS]);
  const r = uninstall({ home, features: ['context'], now: NOW });
  assert.equal(r.shortcut?.removed, true);
  assert.deepEqual(readKb(home).bindings, [chat]);
  assert.equal(readConfig(home).shortcut, null);
});

test('installing rm alone leaves keybindings.json alone', () => {
  const home = tempHome();
  install(opts(home, { features: ['rm'] }));
  assert.equal(fs.existsSync(keybindingsPath(home)), false);
});
```

`test/cli.test.ts`에 추가한다.

```ts
test('install prints the shortcut it bound, and uninstall says it took it out', async () => {
  const r = await cli(['install', 'context']);
  assert.equal(r.code, 0);
  assert.match(r.out, /shortcut: ctrl\+x d presses the advice button/);
  const u = await cli(['uninstall', 'context'], r.home);
  assert.match(u.out, /removed the ctrl\+x d shortcut from keybindings\.json/);
});
```

`test/status-context.test.ts`의 paths import(없으면 새로)에 `keybindingsPath`를 넣고 추가한다.

```ts
test('the mod display lists its shortcut, and says when keybindings.json lost it', () => {
  const home = installedHome();
  assert.ok(statusLines(home, {}).includes('  shortcut: ctrl+x d'));
  fs.rmSync(keybindingsPath(home));
  assert.ok(statusLines(home, {}).includes('  shortcut: ctrl+x d (missing from keybindings.json - run "claude-jev-advisor install context")'));
  assert.equal(statusLines(installedHome('message'), {}).some((l) => l.startsWith('  shortcut:')), false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test`
Expected: FAIL — `r.shortcut` 없음, keybindings.json 없음, 출력에 shortcut 줄 없음

- [ ] **Step 3: 구현**

`src/install.ts`:
- import 추가: `import { installShortcut, removeShortcut, type ShortcutInstall } from './display/keybindings.js';`
- `InstallResult`에 `shortcut: ShortcutInstall | null;` 추가
- `install()`의 `forgetStatusLineBefore(opts.home, next);` 다음에 추가한다.

```ts
  let shortcut: ShortcutInstall | null = null;
  if (display === 'mod') shortcut = installShortcut(opts.home, opts.now);
  else if (display !== null) removeShortcut(opts.home, opts.now);
```

- `updateConfig` 안 객체에 `display: …` 다음 줄로 `shortcut: shortcut ? shortcut.shortcut : display !== null ? null : c.shortcut,`
- 반환에 `shortcut` 추가: `return { settingsFile: file, backup, installed, skipped, replacedLegacyRmGuard, display, shortcut };`
- `uninstall`의 반환 타입에 `shortcut: { removed: boolean; backup: string | null } | null` 추가하고, `forgetStatusLineBefore(opts.home, next);` 다음에 추가한다.

```ts
  let shortcut: { removed: boolean; backup: string | null } | null = null;
  if (opts.features.includes('context')) {
    shortcut = removeShortcut(opts.home, opts.now);
    if (readConfig(opts.home).shortcut !== null) updateConfig(opts.home, (c) => ({ ...c, shortcut: null }));
  }
  return { settingsFile: file, backup, removed, shortcut };
```

`src/cli/run.ts`:
- import 추가: `import type { ShortcutInstall } from '../display/keybindings.js';`, `import { SHORTCUT_CHORD } from '../display/shortcut.js';`
- 파일 안 최상위(`runCli` 위)에 추가한다.

```ts
function shortcutLine(s: ShortcutInstall): string {
  if (s.shortcut) return `shortcut: ${s.shortcut} presses the advice button above the prompt (~/.claude/keybindings.json)`;
  const why = s.takenBy ? `${SHORTCUT_CHORD} is already bound (${s.takenBy})` : `keybindings.json: ${s.problem}`;
  return `shortcut: none - ${why}; press the button with a click, or ctrl+x tab then Enter`;
}
```

- install 분기에서 `if (r.backup) io.out(...)` 다음에 추가한다.

```ts
        if (r.shortcut) io.out(shortcutLine(r.shortcut));
        if (r.shortcut?.backup) io.out(`backup: ${r.shortcut.backup}`);
```

- 같은 분기의 mod 안내 문구를 `'Hooks apply right away, also in open Claude Code sessions; the bottom-row display and the advice button start with the next new session.'`으로 바꾼다. Task 1에서 `keybindings.json`이 새 세션부터만 적용된다고 나왔어도 이 문구로 충분하다.
- uninstall 분기에서 `if (r.backup) io.out(...)` 다음에 추가한다.

```ts
        if (r.shortcut?.removed) io.out(`removed the ${SHORTCUT_CHORD} shortcut from keybindings.json`);
        if (r.shortcut?.backup) io.out(`backup: ${r.shortcut.backup}`);
```

`src/status.ts`:
- import 추가: `import { shortcutState } from './display/keybindings.js';`
- `contextLines` 위에 추가한다.

```ts
function shortcutLine(home: string, config: Config): string {
  if (!config.shortcut) return '  shortcut: none (press the button with a click, or ctrl+x tab then Enter)';
  const state = shortcutState(home);
  if (state === 'present') return `  shortcut: ${config.shortcut}`;
  const why = state === 'unreadable' ? 'keybindings.json cannot be read' : 'missing from keybindings.json';
  return `  shortcut: ${config.shortcut} (${why} - run "claude-jev-advisor install context")`;
}
```

- `contextLines`에서 `lines` 배열을 만든 직후에 `if (config.display === 'mod') lines.splice(1, 0, shortcutLine(home, config));`

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck`
Expected: 모두 PASS(기존 install·cli·status 테스트 포함)

- [ ] **Step 5: 커밋**

```bash
git add src/install.ts src/cli/run.ts src/status.ts test/install-context.test.ts test/cli.test.ts test/status-context.test.ts
git commit -m "feat(context): bind the advice shortcut on install, take it out on uninstall or a display switch, and show it in status"
```

---

### Task 8: 띠 디자인 (구현자 재량 — 사용자 요청: Codex)

사용자가 이 task를 Codex에 맡기길 원했다. 기능은 이미 Task 4·5에서 동작하고, 이 task는 모양만 다듬는다.

**Files:**
- Modify: `src/mod/band.ts` (주 대상)
- May modify: `src/display/line.ts`의 `QUESTIONS` 문구(바꾸면 모든 표시 방식에 반영되므로 `test/line.test.ts`, `test/mod-register.test.ts`의 해당 문자열도 함께 고친다)
- Test: `test/mod-band.test.ts`
- Modify: `docs/superpowers/specs/2026-10-07-band-buttons-design.md` (결과 모형 기록)

**Interfaces:**
- Consumes: `drawBand(ui: BandElements, input: BandInput): unknown`의 시그니처는 그대로 둔다(`register.ts`가 부른다).

- [ ] **Step 1: 사용할 수 있는 요소와 속성 확인**

이 빌드의 API 타입은 설치된 mod 옆에 엔진이 써 둔 `C:/Users/USER/AppData/Roaming/npm/node_modules/@delt/claude-jev-advisor/mod/.claude-plugin/types/claude-code/index.d.ts`에 있다. `export type BoxProps`, `export type TextProps`, `export type ButtonProps`를 찾아 읽는다(색, 굵게, 흐림, 간격, 테두리, `hover`, `variant` 등). 터미널 surface에서 그려지는 것만 쓴다.

- [ ] **Step 2: 디자인**

spec의 "디자인 (구현자 재량)" 절을 지키면서 `src/mod/band.ts`를 고친다. 정할 수 있는 것은 배치와 간격, 여러 줄 여부, 구분자, 강조와 흐림, 마우스를 올렸을 때 모양, 아이콘, 🔴 남은 % 표기, 단축키 표기 위치, 좁은 터미널 처리다. 고정은 버튼 하나, 권하는 쪽만, `onPress`, `config.shortcut`일 때만 `action`과 단축키 표시, U+FE0F 금지다. `hover`를 쓰면 감싸는 `Box`에 `key`가 있어야 한다(없으면 엔진이 그 트리를 거부한다).

- [ ] **Step 3: 테스트**

Run: `npm test && npm run typecheck && npm run build && claude plugin validate mod`
Expected: 모두 PASS. `test/mod-band.test.ts`의 기존 단언은 약하게 바꾸지 않는다. 새 구조에 맞는 단언(예: 단축키 표기 위치)은 추가해도 된다.

- [ ] **Step 4: 모형 기록**

spec 끝에 `## 디자인 결과 (Task 8)` 절을 만들고, compact 권함 / clear 권함 / 🔴 + 권함 × ko·en × 단축키 있음·없음의 띠를 텍스트 모형으로 적는다. 바꾼 선택마다 이유를 한 줄씩 단다.

- [ ] **Step 5: 커밋**

```bash
git add src/mod/band.ts test/mod-band.test.ts docs/superpowers/specs/2026-10-07-band-buttons-design.md
git commit -m "feat(context): give the advice band its look"
```

(`QUESTIONS`를 바꿨으면 `src/display/line.ts`와 해당 테스트도 함께 add한다.)

---

### Task 9: README, 버전 0.4.0, 패키지 파일 목록

**Files:**
- Modify: `README.md`
- Modify: `package.json`, `package-lock.json` (버전)
- Modify: `mod/.claude-plugin/plugin.json`
- Modify: `.gitignore`

- [ ] **Step 1: 버전**

Run: `npm version 0.4.0 --no-git-tag-version`
그리고 `mod/.claude-plugin/plugin.json`의 `"version"`을 `"0.4.0"`, `"description"`을 `"Bottom-row compact/clear advice and an advice button from @delt/claude-jev-advisor (unofficial)"`로 바꾼다.

- [ ] **Step 2: 엔진이 mod 옆에 쓰는 타입 폴더를 커밋·배포에서 빼기**

mod를 `--plugin-dir`이나 `CLAUDE_CODE_PLUGIN_DIRS`로 읽으면 엔진이 `mod/.claude-plugin/types/`를 쓴다. `.gitignore`에 `mod/.claude-plugin/types/` 한 줄을 추가한다. `package.json`의 `"files"`에서 `"mod"`를 `"mod/.claude-plugin/plugin.json"`, `"mod/hooks"` 두 줄로 바꾼다.

Run: `npm run build && npm pack --dry-run`
Expected: 목록에 `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/hooks/register.js`가 있고 `mod/.claude-plugin/types`는 없다.

- [ ] **Step 3: README 수정**

1. 요구 사항 줄(`- Claude Code (the bottom-row display uses Claude Code mods, …)`)을 `- Claude Code (the bottom-row display and the advice button use Claude Code mods, an early-access feature that may change between releases)`로 바꾼다.
2. `settings.json` 백업 문단 끝에 다음 문장을 붙인다: `With the mod display it also binds ctrl+x d in ~/.claude/keybindings.json (see the context helper below), backing that file up the same way first.` (`ctrl+x d`, 경로는 코드 서식)
3. `The hooks also reach Claude Code sessions that are already open; the bottom-row display starts with the next new session.`을 `…; the bottom-row display and the advice button start with the next new session.`으로 바꾼다.
4. 명령 표의 `status` 설명을 `Shows what is registered and on, the display, the shortcut, whether a key is set, the thresholds and the last judgment`로 바꾼다.
5. context helper의 상황 표를 다음으로 바꾸고, 표 바로 위에 `With the mod display (the default):`를 둔다.

```markdown
| Situation | Bottom row | Above the prompt |
|---|---|---|
| Under 250k, or no judgment (no key, Jev unreachable) | `52k +12k` | |
| Work in progress | `🟢 312k +38k` | |
| A whole stage closed (from 250k) | `312k +38k` | `🟡 새롭게 시작하는 건 어떠세요?` and a `/clear` button |
| Work finished, stage goes on (from 250k) | `312k +38k` | `🟡 지금까지 정리하고 이어가는 건 어떠세요?` and a `/compact` button |
| Within 20% of auto-compact, with one of the two above | `790k +38k` | `🔴 18%`, the advice and its button |
| Within 20% of auto-compact otherwise | `🔴 790k +38k 18%`, then ` · 작업이 끝나면 정리하고 이어가는 건 어떠세요? /compact` while the work is still going | |
```

6. 그 표 다음에 문단을 추가한다.

```markdown
`+38k` is how much the conversation grew in the last request, counted from when it was sent. It is left out when the conversation did not grow, for example after a `/compact`. The `statusline` and `message` displays show the whole advice on one line instead, without the increase: `🟡 312k 새롭게 시작하는 건 어떠세요? /clear` and so on.

The button runs `/compact` or `/clear` at once; a `/clear` can be undone with `/resume`. Click it, press `ctrl+x d`, or press `ctrl+x tab` and then Enter. It is not drawn while a request runs or while Claude Code waits for your answer to a question, and once pressed it stays away until Jev judges a newer reply. A refused `/compact` (too few messages, for example) shows the reason in a toast.

`install` writes the shortcut to `~/.claude/keybindings.json` as `"ctrl+x d": "diff:back"` in the `DiffDialog` block. Claude Code lets a mod's button take the key of one of its own actions while that action is not in use; `diff:back` has no key of its own and works only inside the diff dialog, where `ctrl+x d` keeps doing that. If `ctrl+x d` is already bound in your file, or the file cannot be read, `install` leaves the file alone and says so, and the button is pressed with a click or `ctrl+x tab`. Press `d` without `ctrl`: `ctrl+d` is Claude Code's exit key. `uninstall context` and switching to another display take the line out again if it is still ours.
```

7. `--display` 표의 `mod` 줄을 `At the end of the bottom row, after ⏵⏵ … mode on, and advice that can be acted on in a band above the prompt with a button. A small Claude Code mod in the package's mod/ folder draws both. …`(나머지 문장은 그대로, 코드 서식 유지)로 바꾼다.
8. 파일 표에 두 줄을 추가한다.

```markdown
| `~/.claude/keybindings.json` | The `ctrl+x d` line, with the `mod` display |
| `~/.claude/backups/keybindings.json.*-before-claude-jev-advisor` | Copies of `keybindings.json` from before each change |
```

9. Defaults JSON에 `"display": "mod",` 다음 줄로 `"shortcut": null,`을 넣고, 그 아래 설명 문단 끝에 `` `shortcut` is set by `install`: the key it bound, or `null` when it bound none. ``를 붙인다.

Task 1에서 동작이나 영역이 바뀌었으면 6번 문단의 `"ctrl+x d": "diff:back"`, `DiffDialog`, `diff:back` 설명을 그 값으로 고친다.

- [ ] **Step 4: 확인**

Run: `npm test && npm run typecheck && npm run build && claude plugin validate mod`
Expected: 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add README.md package.json package-lock.json mod/.claude-plugin/plugin.json .gitignore
git commit -m "docs: describe the advice button, the ctrl+x d shortcut and the size increase, version 0.4.0"
```

---

### Task 10: 실제 세션 확인 (컨트롤러 + 사용자, 서브에이전트에 맡기지 않음)

사용자가 버튼을 누르고 화면을 봐야 한다. 사용자 전역 설치를 이 브랜치 빌드로 바꾸므로 시작 전에 사용자에게 허락을 받는다.

- [ ] **Step 1: 브랜치 빌드 설치**

Run: `npm run build && npm pack && npm i -g ./delt-claude-jev-advisor-0.4.0.tgz && claude-jev-advisor install context`
Expected: `shortcut: ctrl+x d presses the advice button …` 출력, `~/.claude/keybindings.json` 생성.
되돌리기(필요할 때): `git switch main && npm run build && npm pack && npm i -g ./delt-claude-jev-advisor-0.3.0.tgz && claude-jev-advisor install context`

- [ ] **Step 2: 띠가 뜨게 하는 임시 설정**

`~/.claude/claude-jev-advisor/config.json`의 `context`에 `"minTokens": 20000, "compactMinTokens": 20000`을 넣는다(원래 값은 기록해 둔다). 🔴 모양도 볼 때는 `"redRemainingPct": 99`를 추가한다.

- [ ] **Step 3: 사용자 확인**

새 터미널에서 새 세션을 열고 사용자에게 부탁한다.
1. 짧은 작업 하나를 시키고 끝까지 기다린다. Jev가 "끝남"으로 보면 🟡 compact 띠가 뜬다. 하단 줄 끝에 `+Nk`가 보이는지도 본다.
2. `ctrl+x d`로 compact한다. 띠가 사라지고 하단 줄이 줄어드는지 본다.
3. clear 띠: 다음 턴이 끝난 뒤 컨트롤러가 `~/.claude/claude-jev-advisor/state/`에서 가장 최근 파일의 `judgment`를 `{"phase":"unit_done","clear":true}`로, `at`을 지금 시각(ms)으로 고친다. 2초 안에 🧹 clear 띠가 뜨면 클릭해서 대화가 비는지 본다.
4. (선택) `redRemainingPct: 99`로 🔴 띠 모양을 본다.
5. 디자인 의견을 받는다. 고칠 점이 있으면 `src/mod/band.ts`를 고치고(Task 8 방식) Step 1부터 다시 한다.

- [ ] **Step 4: 정리**

`config.json`의 임시 값을 원래대로 돌린다. 시험 mod 폴더(scratchpad `jev-button-probe`)는 지워도 된다. 결과(확인한 것과 못 한 것)를 사용자에게 보고한다.
