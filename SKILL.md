---
name: delegate-to-freebuff
description: >-
  Hand an approved plan (or any bounded coding task) to freebuff automatically: queue it, run freebuff in
  a hidden terminal that receives the plan with no human typing, then review the diff yourself. A hook
  fires this when the user approves a plan in plan mode. Use when you see a "[freebuff handoff]" note
  after ExitPlanMode, when the user says to send/hand/delegate the plan or a task to freebuff, or when the
  active rules name freebuff as the implementer. DO NOT USE for trivial edits you may make directly, or
  when the user wants you to write the code yourself.
compatibility: Needs `freebuff` on PATH (npm i -g freebuff, then `freebuff login`) and Node 20.11+.
---

# delegate-to-freebuff

You are the **orchestrator**; freebuff is the **implementer**. freebuff has no headless mode, so a
background **dispatcher** runs it in a hidden terminal (PTY), types a one-line prompt into it, and closes
it when the task's done report appears. One fresh freebuff session per task, so its context never bloats.
Nobody types into freebuff. State lives in `<repo>/.briefs/` (kept out of git via `.git/info/exclude`).

`FBQ` below = `node "<skill-dir>/scripts/fbq.mjs"` (`<skill-dir>` = the folder holding this file). Always
pass `--cd "<abs repo path>"`.

## A. Automatic path (the normal case)

The `ExitPlanMode` hook fires after the user approves a plan. It queues the plan, starts the dispatcher, and
injects a `[freebuff handoff]` note into your context naming the task id and the exact commands. When you
see that note:

1. **Do not implement the plan yourself.**
2. Run `FBQ wait NN --cd "<repo>" --timeout-min 60` with Bash `run_in_background: true`. You get one
   notification when the report exists. Don't poll. `wait` restarts a dead dispatcher on its own.
3. Tell the user, once and in one line, that the plan went to freebuff.
4. Review (section C).

If the plan was approved but there is **no** `[freebuff handoff]` note (hook not installed, or auto is
off) and the user wants freebuff to do it, do the manual path.

## B. Manual path (any task, or when the hook didn't fire)

1. Write the plan/brief to a temp file (your scratchpad). It must stand alone — freebuff has seen nothing
   of this conversation. Cover: goal, exact files to touch (and not to touch), what to change, constraints
   (framework quirks, conventions), and the real verify commands. `handoff` adds the "never commit" rules
   and done-report instructions; don't duplicate them.
2. `FBQ handoff --cd "<repo>" --file <temp file> [--slug kebab-slug] [--front]` — queues it and starts the
   dispatcher if needed. `--front` jumps the queue (fix briefs). Use `add` instead to queue without starting.
3. `FBQ wait NN ...` in the background, as above.

Keep each brief to one bounded task: freebuff runs on a small daily Freebucks allowance.

## C. Review — the report is a claim, not proof

1. `status: blocked` → read why. A report "written by the dispatcher" means freebuff crashed, stalled, or
   timed out; check `FBQ tail --cd "<repo>"` and `git status` (work may be partly done), then queue a fix or ask
   the user.
2. `git status --short` and `git diff` against the plan: every requested change present, nothing outside
   the plan's files, nothing committed (`git log -1` unchanged). Several queued tasks share one working
   tree, so attribute changes by the files each brief names.
3. Run the plan's verify commands yourself.
4. Problems → `FBQ handoff --front --slug <slug>-fix --file <fix brief>` naming exact problems (file, line,
   expected vs actual), then wait again. Don't quietly fix it yourself, except a trivial one-liner.
5. Good → `FBQ reviewed NN --cd "<repo>"`, tell the user what changed and what you ran. Commit only if the
   user asks.

## Controls

| Command | What it does |
|---|---|
| `FBQ status --cd R` | dispatcher state, queue, every task's state |
| `FBQ tail --cd R` | last freebuff terminal output (ANSI stripped, best effort) + dispatcher log |
| `FBQ watch --cd R` | live replay of freebuff's terminal — the user can run this in a VS Code terminal to watch |
| `FBQ dispatcher start\|stop\|status --cd R` | control the background dispatcher |
| `FBQ auto on\|off` | global switch for the automatic hook (also `FREEBUFF_AUTO=0` in the environment) |

## Troubleshooting

- Nothing happened after approving a plan: `~/.claude/delegate-to-freebuff.log` records every hook call. No
  entry → hook not installed (`node scripts/install.mjs`) or the extension doesn't fire it; `FBQ auto` shows
  the switch.
- Task blocked, "no terminal output for 10 min": freebuff is probably sitting on a prompt it can't answer
  (login expired → run `freebuff login`; or a repo with `.agents/` files asking for trust). For the trust
  prompt set `FB_TRUST_AGENTS=1` — only for repos whose `.agents/` and `mcp.json` you trust.
- "cannot load @lydell/node-pty" in `.briefs/.dispatcher.log`: run `npm install --omit=dev` in the skill folder.
- Timeouts: `FB_TASK_TIMEOUT_MIN` (60), `FB_STALL_MIN` (10), `FB_IDLE_MIN` (2, dispatcher exit when idle).
- Never commit `.briefs/`. Never kill freebuff by hand while a task runs; use `dispatcher stop`.
