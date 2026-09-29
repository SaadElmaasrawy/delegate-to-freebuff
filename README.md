# delegate-to-freebuff

A [Claude Code](https://claude.com/claude-code) skill + hook that hands an **approved plan** to
[freebuff](https://freebuff.com) automatically. Approve a plan in plan mode; a hidden terminal session
receives it and implements it, and Claude then reviews the result. Nobody types into freebuff.

> Unofficial. Not affiliated with or endorsed by Freebuff, Codebuff or Anthropic.

## Why

freebuff has no headless mode, so using it as the implementer normally means copy-pasting a brief into its
terminal by hand. Claude Code plans well and freebuff implements for free; this removes the manual step
between them.

## How it works

```
plan mode --you approve--> ExitPlanMode PostToolUse hook
                             |  saves the plan as .briefs/NN-slug.md in your repo
                             |  starts a detached dispatcher (one per repo, tasks run one at a time)
                             v
                      dispatcher
                        spawns `freebuff --cwd <repo>` in a hidden PTY   (fresh session per task)
                        waits for the TUI to settle, types: "Read .briefs/NN-slug.md and implement it exactly..."
                        waits for .briefs/NN-slug.done.md               (freebuff writes it as its last step)
                        closes that freebuff; exits after 2 idle minutes
                             |
Claude gets a "[freebuff handoff]" note from the hook: don't implement, wait for the report,
review `git diff`, run the plan's checks, queue a fix brief if needed.
```

If freebuff crashes, stalls or times out, the dispatcher writes a `status: blocked` report itself, so Claude
never waits forever. The plan is wrapped with rules: never `git commit`/`push`/`stash` (you or Claude commit
after review), run the verify steps, report honestly.

The only human step left is the normal plan approval inside Claude Code.

## Requirements

- Claude Code (CLI, desktop app or VS Code extension; all read `~/.claude`)
- [freebuff](https://freebuff.com) on your PATH and logged in: `npm i -g freebuff`, then `freebuff login`
- Node.js 20.11+

## Install

```bash
git clone https://github.com/<your-username>/delegate-to-freebuff.git
cd delegate-to-freebuff
node scripts/install.mjs
```

This copies the skill to `~/.claude/skills/delegate-to-freebuff`, runs `npm install` there (for
[`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty), which ships prebuilt binaries), and
adds one `PostToolUse` hook (matcher `ExitPlanMode`) to `~/.claude/settings.json`. The settings file is
backed up first, and the installer refuses to touch it if it isn't valid JSON. Claude Code picks up the edit
without a restart.

```bash
node scripts/install.mjs --dry-run              # preview, changes nothing
node scripts/install.mjs --uninstall            # remove the hook
node scripts/install.mjs --uninstall --purge    # also delete the installed skill folder
```

## Use

- **Automatic:** enter plan mode, approve the plan. Claude waits on freebuff and reviews.
- **Manual:** run `/delegate-to-freebuff`, or ask Claude to hand a task to freebuff.
- **Watch live (optional):** `node ~/.claude/skills/delegate-to-freebuff/scripts/fbq.mjs watch` in a terminal.
- **Off switch:** `node ~/.claude/skills/delegate-to-freebuff/scripts/fbq.mjs auto off` (or set `FREEBUFF_AUTO=0`).
  The hook is global, so it fires for every approved plan in every project, including plans that aren't code.

`fbq.mjs` commands: `status`, `handoff`, `add`, `wait`, `reviewed`, `tail`, `watch`, `dispatcher start|stop|status`,
`auto on|off`. See [SKILL.md](SKILL.md) for the review loop and troubleshooting. Every hook call is logged to
`~/.claude/delegate-to-freebuff.log`.

## Configuration

Environment variables, read by the dispatcher:

| Variable | Default | Meaning |
|---|---|---|
| `FB_BIN` | `freebuff` | freebuff command to run |
| `FB_IDLE_MIN` | `2` | dispatcher exits after this many idle minutes |
| `FB_TASK_TIMEOUT_MIN` | `60` | give up on a task after this long without a done report |
| `FB_STALL_MIN` | `10` | give up if freebuff prints nothing for this long (e.g. stuck on a prompt) |
| `FB_READY_MAX_S` | `25` | max wait for the freebuff TUI to settle before typing |
| `FB_TRUST_AGENTS` | unset | `1` passes `--trust-agents` to freebuff (see security) |
| `FREEBUFF_AUTO` | unset | `0` disables the hook, same as `fbq auto off` |

## Security and privacy

Read this before installing. The hook turns "approve a plan" into "an AI agent with shell and file access
runs on your machine".

- **Approving a plan is authorizing freebuff to carry it out**, unattended, in your repo. Read plans before
  approving them. Use `auto off` or uninstall if that isn't what you want.
- **Data leaves your machine through freebuff, not through this project.** The plan text, and whatever
  freebuff reads while working, are sent to freebuff's service under its own terms. Apart from the
  `npm install` the installer runs, the scripts here make no network calls of their own.
- **Claude credentials are not passed on.** The dispatcher strips `ANTHROPIC_*` and `CLAUDE*` variables from
  freebuff's environment. freebuff uses its own login.
- **Files written:** `.briefs/` in the repo (briefs, reports, terminal logs; added to `.git/info/exclude`, never
  to `.gitignore`), `~/.claude/delegate-to-freebuff.log`, and the settings hook. The installer writes the skill
  folder under `~/.claude/skills/` and edits `~/.claude/settings.json` (backup first); it touches nothing else.
- **`FB_TRUST_AGENTS=1`** makes freebuff load a repository's `.agents/` files and `mcp.json` without asking.
  Those can run commands. Enable it only for repositories you trust.
- Plan text is only ever written to a file, never interpolated into a shell command.

## Status and platform support

- **Tested on:** Windows 11, Node 24, freebuff 0.1.6, Claude Code 2.1.128. The 19 automated tests
  (`npm test`) cover the queue, the installer and the hook and dispatcher end to end against a fake freebuff.
  They also cover the crash and stall paths and a repo path containing a space.
- **Run against real freebuff:** a real plan went through the hook to a real freebuff session, which
  implemented it, skipped the plan's commit step and wrote its report. The hook was also run by Claude Code's
  actual hook runner with a real `ExitPlanMode` payload.
- **Not confirmed:** `PostToolUse` after a *real interactive approval*. Headless `claude -p` always auto-denies
  `ExitPlanMode`, so only the pre-approval event could be observed there. The
  [hooks docs](https://code.claude.com/docs/en/hooks) say `PostToolUse` fires only after a tool call succeeds,
  which for a plan means approved. If nothing appears in `~/.claude/delegate-to-freebuff.log` after you approve
  a plan, please open an issue with your Claude Code version and how you run it.
- **macOS / Linux:** the code has POSIX paths (no `cmd.exe`, `SIGTERM` instead of `taskkill`) but they have
  **not been run**. Reports and PRs welcome.
- **Limits:** tasks run one at a time per repo (they share a working tree). The live view is a raw replay of a
  full-screen TUI and `tail` is best-effort text. freebuff cannot answer its own login or trust prompts, so
  those show up as a stalled, blocked task after `FB_STALL_MIN`.

## Development

```bash
npm install
npm test        # ~30 s; needs no real freebuff and never touches your ~/.claude
```

Layout: `scripts/lib.mjs` (queue, plan-to-brief), `scripts/fbhost.mjs` (dispatcher),
`scripts/fbq.mjs` (CLI), `scripts/on-plan-approved.mjs` (hook), `scripts/install.mjs`, `SKILL.md`
(what Claude reads), `tests/`.

## License

[MIT](LICENSE)
