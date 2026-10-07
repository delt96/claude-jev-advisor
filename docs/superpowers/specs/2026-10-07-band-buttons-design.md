# 입력칸 위 띠: 조언 버튼과 단축키 — 설계

- 날짜: 2026-10-07
- 브랜치: `feat/band-buttons`
- 대상 버전: 0.4.0

## 목표

context helper의 조언(🟡/🔴 `/compact`·`/clear`)을 읽기만 하는 문구에서 **누르면 실행되는 버튼**으로 바꾼다. 조언이 있을 때만 입력칸 바로 위 띠(`AbovePrompt`)에 버튼 하나를 그리고, 클릭이나 `ctrl+x d`로 누른다. 하단 줄 끝에는 크기와 함께 **최근 요청에서 늘어난 양**(`+38k`)을 보여 준다.

## 시험 mod로 확인한 사실 (Claude Code 2.1.292)

시험 mod(버림): scratchpad `jev-button-probe`, 별도 세션에서 `--plugin-dir`로 띄워 확인했다.

| 확인한 것 | 결과 |
|---|---|
| `$.command.run({ command: "clear" })` | 내장 `/clear`가 돈다. `session.end`가 `reason: "clear"`로 오고, `session.start`는 다시 오지 않는다(문서와 같음) |
| `$.session.compact()` | `/compact`와 같다. 대화가 짧으면 `Not enough messages to compact.`, 턴 중이면 `a turn is running …`으로 거부된다 |
| 부르는 플러그인 자신의 `session.compact` hook | 자기 호출에는 불리지 않는다(문서와 같음) |
| Button `action="app:cycleDiffBase"` | diff 패널을 열지 않은 상태에서 입력칸의 `ctrl+x b`가 버튼을 눌렀다 |
| `PromptHint`의 `tail` | 문자열만 받는다. 버튼은 `AbovePrompt` 띠에만 그릴 수 있다 |

## 아직 확인 안 한 것 (구현 1단계에서 시험 mod로 확인)

1. `keybindings.json`에 `DiffDialog` 영역의 `"ctrl+x d": "diff:back"`을 넣고 버튼에 `action="diff:back"`을 주면 입력칸의 `ctrl+x d`가 버튼을 누르는가. 안 되면 기본 키가 없고 평소 엔진 처리기가 떠 있지 않은 다른 동작 이름으로 바꾼다.
2. `keybindings.json`을 고친 뒤 이미 열린 세션에도 바로 적용되는가. 새 세션부터라면 install 출력에 그렇게 적는다.
3. `turn.start` 시점의 `$.session.usage()` 토큰 수가 요청 직전 크기인가.

## 확인 결과 (Task 1, 2026-10-07)

시험 mod의 `fill /clear` 버튼에 `action="diff:back"`을 주고, `~/.claude/keybindings.json`에 `DiffDialog` 영역의 `"ctrl+x d": "diff:back"`을 넣어 시험했다.

1. **`ctrl+x d` → 버튼:** 된다. 입력칸에서 `ctrl+x d`를 누르면 버튼이 눌려 `/clear`가 채워졌다(로그에 세 번 기록). 동작 이름과 영역은 바꾸지 않는다.
2. **이미 열린 세션에 바로 적용되는지:** 확인 못 함. 파일을 쓸 때 열린 시험 세션이 없었고, 시험은 그 뒤에 새로 띄운 세션에서 했다. install 출력은 이미 "advice button은 다음 새 세션부터"라고 안내하므로 그대로 둔다.
3. **`turn.start` 시점의 크기:** 요청 직전 크기다. 두 번째 요청의 `turn.start`가 첫 번째 요청의 `turn.complete`와 같았다(54849). `/clear` 바로 뒤 첫 요청의 `turn.start`에서는 토큰 수가 없어서, 그 요청에는 증가량이 표시되지 않는다.

## 기능 요구 (고정)

### 상황별 표시 (`display: "mod"`일 때)

| 상황 | 띠 | 하단 줄 끝 |
|---|---|---|
| 250k 미만, 판단 없음 | 없음 | `52k +12k` |
| 작업 진행 중 | 없음 | `🟢 312k +38k` |
| compact 권함 | compact 조언 문구 + compact 버튼 | `312k +38k` |
| clear 권함 | clear 조언 문구 + clear 버튼 | `312k +38k` |
| 🔴 + compact/clear 권함 | 🔴 남은 % + 해당 조언 문구 + 해당 버튼 | `790k +38k` |
| 🔴 + 작업 중, 또는 판단 없음 | 없음 | 지금 문자열에 증가량만 끼움 (`🔴 790k +38k 18% · …`) |

- 증가량은 어느 경우든 크기 바로 뒤에 붙는다.
- "권함"은 지금 `adviceKind()`와 `usableJudgment()`가 정하는 그대로다. 판단 로직은 바꾸지 않는다.
- 띠가 나올 때 하단 줄에서는 색 표시와 조언 문구를 빼고 크기와 증가량만 남긴다.
- `statusline`과 `message` 표시 방식은 바꾸지 않는다.

### 띠

- 다음이 모두 참일 때만 그린다. 하나라도 아니면 `next(e)`로 넘긴다.
  - `config.display === "mod"`, `config.context.enabled`
  - 권함이 있다(compact 또는 clear)
  - `e.props.isWorking`이 false, `e.props.hasSurvey`가 false
- 버튼은 **권하는 쪽 하나만** 그린다.
- 누르면:
  - compact: `$.session.compact()`. 거부되면 그 이유를 `$.ui.toast`로 보여 준다.
  - clear: `$.command.run({ command: "clear" })`. 바로 실행한다(입력칸 채우기 없음).
- `config.shortcut`이 있으면 버튼에 `action="diff:back"`을 주고, 단축키(`^X d`)를 화면에 보여 준다. 없으면 둘 다 하지 않는다. 그때도 클릭과 `ctrl+x tab` → Enter로는 누를 수 있다.
- compact 버튼과 clear 버튼은 한눈에 구분돼야 한다(아이콘 등). 같은 단축키가 그때 떠 있는 버튼을 누르기 때문이다.
- ko/en 두 언어를 지원한다(`config.lang`).

### 증가량

- `turn.start`에서 그때 크기를 기준값으로 기록한다.
- 요청 진행 중에는 지금 크기 − 기준값을 보여 준다. 지금 있는 2초 갱신 주기를 그대로 쓴다.
- `turn.complete` 뒤에는 그 요청의 최종 증가량을 다음 `turn.start`까지 보여 준다.
- 증가량이 0k 이하로 반올림되면(compact 등으로 줄었을 때 포함) 숨긴다.
- `session.end`(`/clear` 포함)에서 기준값과 증가량을 지운다. `/clear` 뒤에는 `session.start`가 오지 않기 때문이다.
- mod가 다시 로드되면 다음 요청까지 증가량이 없어도 된다(모듈 변수에 둔다).

## install과 `keybindings.json`

`install context`(`--display mod`일 때)가 다음을 한다.

1. `~/.claude/keybindings.json`이 있으면 `~/.claude/backups/keybindings.json.<YYYY-MM-DD-HHmmss>-before-claude-jev-advisor`로 백업한다. 같은 초에 이미 있으면 `-2`, `-3`을 붙인다(`settings.json` 백업과 같은 규칙).
2. 파일이 없으면 `$schema`(`https://www.schemastore.org/claude-code-keybindings.json`)와 `$docs`(`https://code.claude.com/docs/en/keybindings`), 빈 `bindings`로 만든다.
3. `context: "DiffDialog"` 블록에 `"ctrl+x d": "diff:back"`을 넣는다. 블록이 없으면 만들고, 다른 항목은 건드리지 않는다. 저장은 임시 파일에 쓴 뒤 이름을 바꾼다.
4. 어느 영역에서든 `ctrl+x d`가 이미 다른 동작에 묶여 있으면 덮어쓰지 않고 건너뛴다. 그리고 "단축키 없이 설치됨, 버튼은 클릭이나 `ctrl+x tab` → Enter로 누름"이라고 출력한다.
5. 결과를 `config.json`의 `shortcut`에 남긴다: 넣었으면 `"ctrl+x d"`, 건너뛰었으면 `null`.
6. 같은 버전으로 다시 실행하면 아무것도 바뀌지 않는다.

되돌리기:

- `uninstall context`, 그리고 `--display statusline|message`로 바꾸는 install은 우리 줄을 지운다. 단, 값이 여전히 `"ctrl+x d": "diff:back"`일 때만 지운다. 비게 된 `DiffDialog` 블록도 지우고, 파일은 남긴다. `shortcut`은 `null`로 둔다.
- `status`에 단축키 상태를 한 줄 넣는다(설치됨 / 충돌로 건너뜀 / 없음).

## 디자인 (구현자 재량)

띠의 모양은 구현자(Codex 예정)가 정하고, 실제 세션에서 보고 고친다. 위 "기능 요구"만 지키면 된다.

- 정할 수 있는 것: 띠의 배치와 간격, 여러 줄 사용 여부, 구분자, 강조와 흐림(`variant`, `dimColor`, `bold` 등), 마우스를 올렸을 때 모양, 아이콘 선택, 🔴 남은 %를 보여 주는 방식, 단축키를 버튼 이름에 넣을지 옆에 둘지, 좁은 터미널에서의 처리. 띠 안의 문구도 의미가 같으면 다듬어도 된다. 다만 `statusline`·`message`가 쓰는 `PHRASES`와 따로 놀지 않게 한다.
- 지켜야 할 제약:
  - 터미널 surface의 요소(`Box`, `Text`, `Button` 등 `$.ui.resolve(e)`가 주는 것)만 쓴다.
  - 보이지 않는 변형 문자(U+FE0F, VS16)가 붙는 이모지는 쓰지 않는다. 터미널에서 폭이 어긋난다.
  - 띠는 버튼 하나 기준으로 짧게 둔다. 띠가 있는 동안 입력칸이 밀려 올라간다.
- 결과물: 구현과 함께, 각 상황(compact 권함 / clear 권함 / 🔴 + 권함, ko·en)에서 띠가 어떻게 보이는지 텍스트 모형을 남긴다. 사용자가 실제 세션에서 보고 고칠 점을 주면 반영한다.

## 바꾸지 않는 것

- Jev 판단 로직과 `Stop` hook(context helper), rm helper
- `statusline`과 `message` 표시 방식
- 하단 줄 끝 표시 방식(`PromptHint`의 `tail`). 내용만 위 표대로 바뀐다.

## 테스트

- mod 단위 테스트(`test/mod-register.test.ts`처럼 가짜 `$`):
  - 표의 각 상황에서 띠가 나오고 숨는지, 하단 줄 끝 문자열
  - `isWorking`, `hasSurvey`, 다른 표시 방식, helper 꺼짐일 때 띠 없음
  - 버튼을 누르면 `session.compact()` / `command.run({ command: "clear" })`가 불림. compact가 거부되면 toast
  - `shortcut`이 있을 때만 `action="diff:back"`과 단축키 표시
  - 증가량: 기준값, 진행 중 갱신, 끝난 뒤 최종값, 줄었을 때 숨김, `session.end` 뒤 초기화
- install 테스트(임시 홈 폴더): `keybindings.json` 생성, 병합, 충돌 시 건너뜀, 다시 실행해도 그대로, 백업, uninstall과 표시 방식 전환 때 우리 줄만 제거, `shortcut` 기록
- `npm run typecheck`, `npm test`, `npm run build` 뒤 `claude plugin validate mod`
- 실제 세션 확인(사용자가 누름): 띠, 클릭, `ctrl+x d`, compact, clear, 증가량

## 손댈 것으로 예상되는 파일

- `src/mod/register.ts`: 띠 hook, 증가량, 버튼 동작
- `src/mod/claude-code.d.ts`: 새로 쓰는 API 선언(`ui.resolve`, `ui.toast`, `session.compact`, `command.run`, `h`, 띠 props)
- `src/display/line.ts`: 하단 줄 문자열 변형, 증가량 표기
- `src/config-shape.ts`: `shortcut`
- `src/install.ts`, 새 `src/display/keybindings.ts`, `src/settings-file.ts`(백업 이름 일반화), `src/status.ts`
- `tsup.config.ts`: mod를 JSX로 쓰면 `jsxFactory: "h"` 설정
- `README.md`, `package.json`, `mod/.claude-plugin/plugin.json`(0.4.0)
- 테스트: `test/mod-register.test.ts`, `test/line.test.ts`, `test/install*.test.ts`, `test/status*.test.ts`

## 디자인 결과 (Task 8)

평소 한 줄이며, 아래 `[ … ]`는 terminal primary Button의 chrome이다. 상태·질문과 실행 그룹 사이는 두 칸, 그룹 안은 한 칸이다. 🔴 예시는 남은 18%이며 두 권고 모두 같은 배치를 쓴다.

| 상황 | 언어 | 단축키 없음 | 단축키 있음 |
|---|---|---|---|
| compact | ko | `🟡 지금까지 정리하고 이어가는 건 어떠세요?  [ 📦 /compact ]` | `🟡 지금까지 정리하고 이어가는 건 어떠세요?  [ 📦 /compact ] ^X d` |
| clear | ko | `🟡 새롭게 시작하는 건 어떠세요?  [ 🧹 /clear ]` | `🟡 새롭게 시작하는 건 어떠세요?  [ 🧹 /clear ] ^X d` |
| 🔴 compact | ko | `🔴 18% 지금까지 정리하고 이어가는 건 어떠세요?  [ 📦 /compact ]` | `🔴 18% 지금까지 정리하고 이어가는 건 어떠세요?  [ 📦 /compact ] ^X d` |
| 🔴 clear | ko | `🔴 18% 새롭게 시작하는 건 어떠세요?  [ 🧹 /clear ]` | `🔴 18% 새롭게 시작하는 건 어떠세요?  [ 🧹 /clear ] ^X d` |
| compact | en | `🟡 Wrap up what you have and continue?  [ 📦 /compact ]` | `🟡 Wrap up what you have and continue?  [ 📦 /compact ] ^X d` |
| clear | en | `🟡 Start fresh?  [ 🧹 /clear ]` | `🟡 Start fresh?  [ 🧹 /clear ] ^X d` |
| 🔴 compact | en | `🔴 18% Wrap up what you have and continue?  [ 📦 /compact ]` | `🔴 18% Wrap up what you have and continue?  [ 📦 /compact ] ^X d` |
| 🔴 clear | en | `🔴 18% Start fresh?  [ 🧹 /clear ]` | `🔴 18% Start fresh?  [ 🧹 /clear ] ^X d` |

선택과 이유:

- 한 줄 우선, 테두리·세로 여백 없음: 띠가 입력칸을 밀어 올리는 높이를 줄인다.
- 상태·질문과 실행 그룹을 두 칸으로 구분: 장식 구분자 없이 읽는 부분과 누르는 부분을 구분한다.
- 📦 /compact와 🧹 /clear 유지: 정리해 이어가기와 새로 시작하기를 명령 이름을 읽기 전에도 구분한다.
- primary 버튼 유지: terminal의 accent 색과 대괄호로 클릭 가능한 주 행동을 강조한다.
- 🔴 남은 %를 굵게 표시하고 기존 가운데 점 제거: 긴 한국어에서도 경고를 짧고 선명하게 둔다.
- 단축키를 버튼 바로 뒤 흐린 글자로 표시: 버튼 이름을 간결하게 두고 보조 입력 수단을 같은 그룹에 둔다.
- 버튼 그룹에 고유 key와 hover bold 지정: 허용된 hover scope 안에서 강조하고, 직접 포인터·포커스 반전은 엔진에 맡긴다.
- 좁은 폭에서는 실행 그룹 전체를 다음 줄로 넘김: 버튼과 단축키가 떨어지지 않으며 질문만 truncate-end로 축약한다. 한글의 두 칸 폭 계산은 엔진 레이아웃에 맡긴다.

좁은 폭의 의도된 예시(실제 줄바꿈·말줄임 위치는 엔진이 결정):

```text
🔴 18% 지금까지 정리하고 이어가는 건…
[ 📦 /compact ] ^X d

🟡 Start fresh?
[ 🧹 /clear ]
```

실제 terminal surface의 폭별 배치·색·hover는 이 작업 환경에서 확인할 수 없다. 사용자 세션에서 확인 후 조정한다. 실행 그룹 자체보다 좁은 폭의 terminal은 완전한 표시를 보장하지 않는다.
