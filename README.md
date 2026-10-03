# claude-jev-advisor

Unofficial helpers for [Claude Code](https://claude.com/claude-code), installed as command hooks in `~/.claude/settings.json`. They use [TypeSafe](https://typesafe.ai) Jev for judgments that need to understand the conversation.

What is sent to TypeSafe's Jev API (`api.typesafe.ai`):

- `context`: your last three requests, each cut to its first 1,000 characters, and Claude's last reply, cut to its first and last 1,500 characters.
- `rm`: only for a delete it would otherwise ask about, and only when the target is a file this session made or a folder git ignores. It sends the path, the `rm` command and its description, up to three tool calls of this session that name the target (each cut to 600 characters), and for a folder up to ten of its file names.

Not affiliated with Anthropic or TypeSafe.

| Helper | What it does | Systems |
|---|---|---|
| `context` | At the end of each turn, suggests `/compact` or `/clear` when the conversation is large and the work has reached a stopping point. Shown at the end of Claude Code's bottom row. | Any |
| `rm` | Asks before a Bash `rm` deletes real files. Lets temp files through and refuses an `rm` whose targets it cannot work out. Jev can lift the ask for a test file this session made or a folder git ignores. | Windows |

## Requirements

- Node.js 18 or later
- Claude Code (the bottom-row display uses Claude Code mods, an early-access feature that may change between releases)
- A TypeSafe API key for the `context` helper and for the Jev check of the `rm` helper, in `TYPESAFE_API_KEY` or in a key file (`--key-file`). Without a key, `rm` asks about every real file.
- Windows for the `rm` helper. On other systems `install` skips it and says why.

## Install

```bash
npm i -g @delt/claude-jev-advisor
```

Then register the hooks:

```bash
claude-jev-advisor install
```

When the context helper is installed and no key is found, `install` asks for your TypeSafe API key. What you type is hidden. It checks the key with one small Jev call and saves it to `~/.claude/claude-jev-advisor/jev-key.env`. Press Enter to skip; `claude-jev-advisor key` asks again later. Instead of typing it, you can set `TYPESAFE_API_KEY`, or pass `--key-file <path>` to a file holding a line `TYPESAFE_API_KEY=...` (then only that path is saved). The key is never printed or logged. On Windows that file is protected by your user folder's permissions only.

Before it changes `~/.claude/settings.json`, `install` copies it to `~/.claude/backups/settings.json.<YYYY-MM-DD-HHmmss>-before-claude-jev-advisor`. If a backup from the same second already exists, it adds `-2`, `-3` and so on instead of overwriting it. It then adds or replaces only this package's entries. Running it again changes nothing.

The hooks also reach Claude Code sessions that are already open; the bottom-row display starts with the next new session. Turning a helper on or off applies at once, even to open sessions.

## Commands

| Command | What it does |
|---|---|
| `claude-jev-advisor install [rm] [context] [--lang ko\|en] [--key-file <path>] [--display mod\|statusline\|message]` | Registers the hooks (backs up `settings.json` first) and switches the helpers on |
| `claude-jev-advisor uninstall [rm] [context]` | Removes this package's hooks and display from `settings.json` |
| `claude-jev-advisor on [rm] [context]` / `off [rm] [context]` | Switches helpers on or off without touching `settings.json` |
| `claude-jev-advisor status` | Shows what is registered and on, the display, whether a key is set, the thresholds and the last judgment |
| `claude-jev-advisor report [--days 7]` | Lists the `/compact` and `/clear` advice shown and what followed it, and the deletions Jev let through |
| `claude-jev-advisor key` | Asks for the TypeSafe API key, checks it and saves it (needs an interactive terminal) |
| `claude-jev-advisor help` | Prints the usage |

If you leave out the helper names, the command applies to all helpers. The display is set up when `context` is installed; run `claude-jev-advisor install context --display <mode>` to switch it.

## The context helper

When a turn ends, a `Stop` hook reads the size of the conversation from the session transcript. If the turn's last reply is not in the transcript yet, it waits up to 3 seconds for it. From 250k tokens it asks Jev two questions about the last three requests and the last reply:

- has Claude finished or handed back the work asked for, so this is a natural break?
- does the reply close a whole stage of the work (a plan carried out and pushed, a release, a finished investigation, a design or plan saved as a document), so the next stage can start from the saved results?

The answer is saved for the display. Nothing is added to what Claude sees, so it costs no Claude tokens. If Jev does not answer within 8 seconds, only the size is shown. While a subagent or a workflow runs in the background, the turn counts as work in progress and Jev is not asked; background shells and monitors do not count.

| Situation | Shown |
|---|---|
| Under 250k, or no judgment (no key, Jev unreachable) | `52k` |
| Work in progress | `🟢 312k` |
| A whole stage closed (from 250k) | `🟡 312k 새롭게 시작하는 건 어떠세요? /clear` |
| Work finished, stage goes on (from 250k) | `🟡 312k 지금까지 정리하고 이어가는 건 어떠세요? /compact` |
| Within 20% of auto-compact | `🔴 790k 18%`, then ` · ` and the `/clear` or `/compact` advice above, or `작업이 끝나면 정리하고 이어가는 건 어떠세요? /compact` while the work is still going |

With `--lang en` the advice reads `Start fresh? /clear`, `Wrap up what you have and continue? /compact` and `When this work is done, wrap up and continue? /compact`.

Judging starts at 250k because a conversation passes 100k after a request or two, and compacting a small conversation costs more than it saves. If you set `compactMinTokens` above `minTokens`, finished work between the two stays green. The suggestion is hidden while a new request runs, and a judgment made before a `/compact` is dropped.

| `--display` | Where |
|---|---|
| `mod` (default) | At the end of the bottom row, after `⏵⏵ … mode on`. A small Claude Code mod in the package's `mod/` folder draws it. The mod is listed in `env.CLAUDE_CODE_PLUGIN_DIRS` and told the data folder through `pluginConfigs`. |
| `statusline` | Claude Code's status line, the row above the bottom row. An existing status line of yours keeps running first, with our text after it, and is put back when you switch away or uninstall. On Windows that command runs in Git Bash when it is installed and in PowerShell otherwise, as Claude Code runs it; it gets 2 seconds. No red zone, because the auto-compact threshold is not known there. |
| `message` | A `Stop says: …` line in the transcript when there is advice. Claude does not see it. No red zone. |

`claude-jev-advisor report` shows each piece of advice with the time, the session, the size, Jev's answers, the start of the last request and what followed: compacted or cleared within the next three requests, auto-compacted, or kept going.

## The rm helper

It runs before every Bash tool call (`PreToolUse`, matcher `Bash`, 15-second timeout) and looks only at `rm`, `rmdir` and `xargs`.

| Target | Result |
|---|---|
| Inside `%TEMP%`/`%TMP%` or `/tmp` | No decision. Claude Code's normal permission handling applies. |
| A path with a `.superpowers` folder in it | No decision |
| A path that does not exist | No decision |
| A git-ignored path inside a build folder (`target`, `build`, `dist`, `out`, `node_modules`, `coverage`, `__pycache__`, `.pytest_cache`, `.gradle`, `.next`, `.nuxt`, `.turbo`, `.cache`, `bin`, `obj`) | No decision |
| Any other existing file or folder | `ask`, with the reason `실제 파일 삭제: <paths>` ("deleting real files"), unless Jev lifts it (below) |
| A target it cannot work out | `deny`, with a hint to rewrite the command using literal paths |

A target cannot be worked out when it uses:

- shell variables, other than literal assignments in the same command and `TEMP`, `TMP`, `TMPDIR`, `HOME`, `USERPROFILE` and `PWD`
- command substitution
- `xargs` feeding `rm`
- brace expansion
- a wildcard in a folder name
- a `cd` to such a path earlier in the command

It does not see deletions made any other way:

- through the PowerShell tool (`Remove-Item` and its aliases). On Windows with Git Bash installed, Claude Code turns this tool on by default for claude.ai and Console accounts and uses PowerShell as its main shell, so many deletions go through it.
- through a nested shell: `sh -c`, `bash -c`, `powershell -Command`, `pwsh -c`, `cmd /c del`
- with other commands or programs, such as `find -delete`, `git clean` or a script that deletes files

What its decisions do depends on Claude Code's permission mode:

| Mode | `ask` | `deny` | No decision |
|---|---|---|---|
| `auto` | A prompt. The auto mode classifier can still block the call but cannot approve it on its own (Claude Code 2.1.211 or later). | Blocked | The classifier decides |
| `bypassPermissions` | A prompt. Claude Code's documentation does not say this; it was seen in a test on 2026-10-03. | Blocked | Runs |
| Other modes | A prompt (`dontAsk` refuses the call instead) | Blocked | Claude Code's normal permission handling |

### When Jev can lift the ask

The facts are checked by code; Jev only judges what the target is for. Jev is asked only when every target of the command is one of these (at most five):

| Target | Checked first | Jev is asked |
|---|---|---|
| A file or folder this session made | Not tracked by git; the first call of this session that names it created it: a Write that made a new file, or a shell command whose `>` redirect, `touch`, `mkdir` or `curl -o` makes it (deletes do not count, and a Read, an Edit or any other shell command first means it was already there); made after the session started; for a folder, every file inside too, and at most 50 files | Is it a throwaway made only to try something out? |
| A folder git ignores, outside the build folders above | It is a folder (a single ignored file such as `.env` still asks) | Is it generated output or a cache that is made again? |

When Jev answers 0.8 or more for every target, the hook makes no decision (the last column of the table above), and a line like `[jev-advisor] Jev가 이 세션의 시험 파일로 판단해 묻지 않고 지웁니다: out.json (0.93)` is shown. Otherwise the ask stays, with Jev's answer added: `실제 파일 삭제: …\out.json · Jev: 시험용 파일일 확률 0.42`. Without a key, when Jev fails, or with `"jev": false`, every real file asks as before. A `deny` is never sent to Jev.

`install rm` also replaces an older personal hook at `~/.claude/hooks/rm-guard/rm-guard.mjs` if one is registered. Its files are left in place.

If a hook of this package fails in any way, it prints nothing and exits 0, so it never blocks Claude Code. A failure during the Jev check of `rm` leaves the ask in place.

## Uninstall

npm does not run uninstall scripts, so remove the hooks before removing the package:

```bash
claude-jev-advisor uninstall
npm rm -g @delt/claude-jev-advisor
```

If the package is removed first, the hook entries point to a missing file. Claude Code keeps running, but the helpers are off. To clean up, reinstall the package and run `claude-jev-advisor uninstall`, or delete the entries from `settings.json` by hand.

A key saved by `install` or `key` stays in `~/.claude/claude-jev-advisor/jev-key.env`; delete that file if you no longer need it.

## Files

| Path | Contents |
|---|---|
| `~/.claude/claude-jev-advisor/config.json` | Switches and settings that differ from the defaults. A missing or broken file reads as the defaults. A value of the wrong type falls back to its default, so only `"enabled": false` turns a helper off. |
| `~/.claude/claude-jev-advisor/state/<session>.json` | The last judgment of each open session, read by the display. Removed when the session ends. |
| `~/.claude/claude-jev-advisor/log/YYYY-MM.jsonl` | One line per context judgment and per `rm` Jev check: the size or the command, what was sent to Jev (parts of your conversation), the answers and the result. Never the key. |
| `~/.claude/claude-jev-advisor/statusline-before.json` | Your own status line while `--display statusline` is in use |
| `~/.claude/claude-jev-advisor/jev-key.env` | Your TypeSafe API key, when you typed it in `install` or `key` |
| `~/.claude/backups/settings.json.*-before-claude-jev-advisor` | Copies of `settings.json` from before each change |

Defaults:

```json
{
  "lang": "ko",
  "keyFile": null,
  "display": "mod",
  "context": { "enabled": true, "minTokens": 250000, "compactMinTokens": 250000, "redRemainingPct": 20, "unitDoneYes": 0.6, "phaseDoneYes": 0.6 },
  "rm": { "enabled": true, "jev": true, "throwawayYes": 0.8, "maxDirFiles": 50 }
}
```

`minTokens` is where judging starts, `compactMinTokens` where `/compact` is suggested, `redRemainingPct` where the red zone starts, and `unitDoneYes` / `phaseDoneYes` are the Jev probabilities needed for "work finished" (`/compact`) and "stage closed" (`/clear`). For `rm`, `jev` switches the Jev check, `throwawayYes` is the probability needed to lift an ask, and `maxDirFiles` the most files a folder of this session may hold.

`config.json` keeps only the values you changed, with `"version": 2`. A config written by 0.1.x, which saved every value, has its old default thresholds (`minTokens` 100000, `compactMinTokens` 200000, `unitDoneYes` 0.7) read as unset, so the new defaults apply.

## Development

```bash
git clone https://github.com/delt96/claude-jev-advisor.git
cd claude-jev-advisor
npm ci
npm test          # node:test via tsx; tests use temporary home folders and never call Jev
npm run typecheck
npm run build     # dist/*.js and mod/hooks/register.js
```

## License

MIT
