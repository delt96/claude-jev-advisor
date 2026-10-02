# claude-jev-advisor

Unofficial helpers for [Claude Code](https://claude.com/claude-code), installed as command hooks in `~/.claude/settings.json`. Planned helpers use [TypeSafe](https://typesafe.ai) Jev for their judgments.

Not affiliated with Anthropic or TypeSafe.

| Helper | What it does | Status |
|---|---|---|
| `rm` | Asks before a Bash `rm` deletes real files. Lets temp files through and refuses an `rm` whose targets it cannot work out. | Available (Windows only) |
| `context` | Suggests when to `/compact` or `/clear`, based on conversation size and a Jev judgment at the end of each turn. | Planned |

## Requirements

- Node.js 18 or later
- Claude Code
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
claude-jev-advisor install
```

`install` first copies `~/.claude/settings.json` to `~/.claude/backups/settings.json.<YYYY-MM-DD-HHmmss>-before-claude-jev-advisor`. If a backup from the same second already exists, it adds `-2`, `-3` and so on instead of overwriting it. It then adds or replaces only this package's hook entries. Running it again changes nothing.

New hooks reach Claude Code sessions started after the install. Turning a helper on or off applies at once, even to open sessions.

## Commands

| Command | What it does |
|---|---|
| `claude-jev-advisor install [rm] [--lang ko\|en] [--key-file <path>] [--display mod\|statusline\|message]` | Registers the hooks (backs up `settings.json` first) and switches the helpers on |
| `claude-jev-advisor uninstall [rm]` | Removes this package's hook entries from `settings.json` |
| `claude-jev-advisor on [rm]` / `off [rm]` | Switches helpers on or off without touching `settings.json` |
| `claude-jev-advisor status` | Shows what is registered, what is on, and any hook that points to a missing file |
| `claude-jev-advisor help` | Prints the usage |

If you leave out the helper names, the command applies to all helpers. `--lang`, `--key-file` and `--display` are saved in the config for the upcoming `context` helper. The `rm` helper does not use them yet.

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

If the hook fails in any way, it prints nothing and exits 0, so it never blocks the Bash call.

`install rm` also replaces an older personal hook at `~/.claude/hooks/rm-guard/rm-guard.mjs` if one is registered. Its files are left in place.

## Uninstall

npm does not run uninstall scripts, so remove the hooks before removing the package:

```bash
claude-jev-advisor uninstall
npm rm -g @delt/claude-jev-advisor
```

If the package is removed first, the hook entries point to a missing file. The Bash calls still run, but the rm check is off. To clean up, reinstall the package and run `claude-jev-advisor uninstall`, or delete the entries from `settings.json` by hand.

## Files

| Path | Contents |
|---|---|
| `~/.claude/claude-jev-advisor/config.json` | Switches and settings. A missing or broken file reads as the defaults. A value of the wrong type falls back to its default, so only `"enabled": false` turns a helper off. |
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

## Development

```bash
npm ci
npm test          # node:test via tsx; tests use temporary home folders, never the real ~/.claude
npm run typecheck
npm run build     # dist/cli.js and dist/rm-hook.js
```

## License

MIT
