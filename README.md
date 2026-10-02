# claude-jev-advisor

Unofficial helpers for [Claude Code](https://claude.com/claude-code), installed as command hooks in `~/.claude/settings.json`. They use [TypeSafe](https://typesafe.ai) Jev for judgments that need to understand the conversation.

Not affiliated with Anthropic or TypeSafe.

| Helper | What it does | Systems |
|---|---|---|
| `context` | At the end of each turn, suggests `/compact` or `/clear` when the conversation is large and the work has reached a stopping point. Shown at the end of Claude Code's bottom row. | Any |
| `rm` | Asks before a Bash `rm` deletes real files. Lets temp files through and refuses an `rm` whose targets it cannot work out. | Windows |

## Requirements

- Node.js 18 or later
- Claude Code (the bottom-row display uses Claude Code mods, an early-access feature that may change between releases)
- A TypeSafe API key for the `context` helper, in `TYPESAFE_API_KEY` or in a key file (`--key-file`)
- Windows for the `rm` helper. On other systems `install` skips it and says why.

## Install

The package is not on npm yet. Install it from source:

```bash
git clone https://github.com/delt96/claude-jev-advisor.git
cd claude-jev-advisor
npm ci
npm run build
npm pack
npm i -g ./delt-claude-jev-advisor-0.1.0.tgz
```

Then register the hooks:

```bash
claude-jev-advisor install --key-file C:/path/to/jev-key.env
```

The key file holds a line `TYPESAFE_API_KEY=...`. Only its path is saved, never the key.

`install` first copies `~/.claude/settings.json` to `~/.claude/backups/settings.json.<YYYY-MM-DD-HHmmss>-before-claude-jev-advisor`. If a backup from the same second already exists, it adds `-2`, `-3` and so on instead of overwriting it. It then adds or replaces only this package's entries. Running it again changes nothing.

New hooks and the display reach Claude Code sessions started after the install. Turning a helper on or off applies at once, even to open sessions.

## Commands

| Command | What it does |
|---|---|
| `claude-jev-advisor install [rm] [context] [--lang ko\|en] [--key-file <path>] [--display mod\|statusline\|message]` | Registers the hooks (backs up `settings.json` first) and switches the helpers on |
| `claude-jev-advisor uninstall [rm] [context]` | Removes this package's hooks and display from `settings.json` |
| `claude-jev-advisor on [rm] [context]` / `off [rm] [context]` | Switches helpers on or off without touching `settings.json` |
| `claude-jev-advisor status` | Shows what is registered and on, the display, whether a key is set, the thresholds and the last judgment |
| `claude-jev-advisor help` | Prints the usage |

If you leave out the helper names, the command applies to all helpers. The display is set up when `context` is installed; run `claude-jev-advisor install context --display <mode>` to switch it.

## The context helper

When a turn ends, a `Stop` hook reads the size of the conversation from the session transcript. From 100k tokens it asks Jev two questions about the last three requests and the last reply:

- has the work asked for reached a natural stopping point?
- is the goal behind it finished, with nothing left to do next?

The answer is saved for the display. The hook never adds anything to the conversation, so Claude does not see it and it costs no Claude tokens.

| Situation | Shown |
|---|---|
| Under 100k, or no judgment (no key, Jev unreachable) | `52k` |
| Work in progress | `🟢 312k` |
| Goal finished (from 100k) | `🟡 312k 새롭게 시작하는 건 어떠세요? /clear` |
| Work unit finished (from 200k) | `🟡 312k 지금까지 정리하고 이어가는 건 어떠세요? /compact` |
| Within 20% of auto-compact | `🔴 790k 18%`, followed by the advice when there is one |

With `--lang en` the advice reads `Start fresh? /clear`, `Wrap up what you have and continue? /compact` and `When this work is done, wrap up and continue? /compact`.

`/clear` is suggested only when Jev is confident the goal is finished; when in doubt it suggests `/compact`. `/compact` waits until 200k because compacting a smaller conversation costs more than it saves. The suggestion is hidden while a new request runs, and a judgment made before a `/compact` is dropped.

| `--display` | Where |
|---|---|
| `mod` (default) | At the end of the bottom row, after `⏵⏵ … mode on`. A small Claude Code mod in the package's `mod/` folder draws it. The mod is listed in `env.CLAUDE_CODE_PLUGIN_DIRS` and told the data folder through `pluginConfigs`. |
| `statusline` | Claude Code's status line, the row above the bottom row. An existing status line of yours keeps running first, with our text after it, and is put back when you switch away or uninstall. No red zone, because the auto-compact threshold is not known there. |
| `message` | A `Stop says: …` line in the transcript when there is advice. Claude does not see it. No red zone. |

## The rm helper

It runs before every Bash tool call (`PreToolUse`, matcher `Bash`, 15-second timeout) and looks only at `rm`, `rmdir` and `xargs`.

| Target | Result |
|---|---|
| Inside `%TEMP%`/`%TMP%` or `/tmp` | No decision. Claude Code's normal permission handling applies. |
| A path with a `.superpowers` folder in it | No decision |
| A path that does not exist | No decision |
| A git-ignored path inside a build folder (`target`, `build`, `dist`, `out`, `node_modules`, `coverage`, `__pycache__`, `.pytest_cache`, `.gradle`, `.next`, `.nuxt`, `.turbo`, `.cache`, `bin`, `obj`) | No decision |
| Any other existing file or folder | `ask`, with the reason `실제 파일 삭제: <paths>` ("deleting real files") |
| A target it cannot work out | `deny`, with a hint to rewrite the command using literal paths |

A target cannot be worked out when it uses:

- shell variables, other than literal assignments in the same command and `TEMP`, `TMP`, `TMPDIR`, `HOME`, `USERPROFILE` and `PWD`
- command substitution
- `xargs` feeding `rm`
- brace expansion
- a wildcard in a folder name
- a `cd` to such a path earlier in the command

`install rm` also replaces an older personal hook at `~/.claude/hooks/rm-guard/rm-guard.mjs` if one is registered. Its files are left in place.

If a hook of this package fails in any way, it prints nothing and exits 0, so it never blocks Claude Code.

## Uninstall

npm does not run uninstall scripts, so remove the hooks before removing the package:

```bash
claude-jev-advisor uninstall
npm rm -g @delt/claude-jev-advisor
```

If the package is removed first, the hook entries point to a missing file. Claude Code keeps running, but the helpers are off. To clean up, reinstall the package and run `claude-jev-advisor uninstall`, or delete the entries from `settings.json` by hand.

## Files

| Path | Contents |
|---|---|
| `~/.claude/claude-jev-advisor/config.json` | Switches and settings. A missing or broken file reads as the defaults. A value of the wrong type falls back to its default, so only `"enabled": false` turns a helper off. |
| `~/.claude/claude-jev-advisor/state/<session>.json` | The last judgment of each open session, read by the display. Removed when the session ends. |
| `~/.claude/claude-jev-advisor/log/YYYY-MM.jsonl` | One line per judgment: the size, what was sent to Jev (parts of your conversation), the answers and the result. Never the key. |
| `~/.claude/claude-jev-advisor/statusline-before.json` | Your own status line while `--display statusline` is in use |
| `~/.claude/backups/settings.json.*-before-claude-jev-advisor` | Copies of `settings.json` from before each change |

Default config:

```json
{
  "lang": "ko",
  "keyFile": null,
  "display": "mod",
  "context": { "enabled": true, "minTokens": 100000, "compactMinTokens": 200000, "redRemainingPct": 20, "unitDoneYes": 0.7, "goalDoneYes": 0.8 },
  "rm": { "enabled": true, "jev": true, "throwawayYes": 0.8, "maxDirFiles": 50 }
}
```

`minTokens` is where judging starts, `compactMinTokens` where `/compact` is suggested, `redRemainingPct` where the red zone starts, and `unitDoneYes` / `goalDoneYes` are the Jev probabilities needed for "unit finished" and "goal finished". The `rm.jev` settings are reserved for a later version.

## Development

```bash
npm ci
npm test          # node:test via tsx; tests use temporary home folders and never call Jev
npm run typecheck
npm run build     # dist/*.js and mod/hooks/register.js
```

## License

MIT
