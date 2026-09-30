#!/usr/bin/env node
// PostToolUse hook for ExitPlanMode: fires only after the user approves the plan. Queues the plan as a brief.
//   confirm on (default): the brief is HELD and freebuff is not started; Claude is told to ask the user
//                         "have you finished all your edits?" and to release the task on yes.
//   confirm off:          starts the detached dispatcher at once (it runs freebuff in a hidden PTY and feeds it the plan).
// Either way Claude is told to wait and review instead of implementing. Must return fast; never blocks on freebuff.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FBQ, HOOK_LOG, addBrief, autoEnabled, confirmEnabled, freebuffInstalled, planTitle, planToBrief, repoRootOf, slugify, startDispatcher,
} from "./lib.mjs";

const log = (msg) => {
  try { mkdirSync(dirname(HOOK_LOG), { recursive: true }); appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
};
const reply = (additionalContext) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev?.hook_event_name || "PostToolUse", additionalContext } }));
  process.exit(0);
};

async function readStdin() {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) s += c;
  return s;
}

/** The plan text: tool_input.plan, else the file it was saved to, else the newest plan file from the last 5 minutes. */
function planText(ti) {
  if (typeof ti?.plan === "string" && ti.plan.trim()) return ti.plan;
  if (ti?.planFilePath && existsSync(ti.planFilePath)) return readFileSync(ti.planFilePath, "utf8");
  const plans = join(homedir(), ".claude", "plans");
  if (!existsSync(plans)) return "";
  const newest = readdirSync(plans).filter((f) => f.endsWith(".md")).map((f) => ({ f, t: statSync(join(plans, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return newest && Date.now() - newest.t < 5 * 60_000 ? readFileSync(join(plans, newest.f), "utf8") : "";
}

let ev;
try { ev = JSON.parse(await readStdin()); } catch { process.exit(0); }
if (ev.tool_name !== "ExitPlanMode") process.exit(0);
log(`ExitPlanMode ${ev.hook_event_name} session=${ev.session_id} cwd=${ev.cwd} keys=${Object.keys(ev.tool_input || {})}`);
if (!autoEnabled()) { log("auto handoff is OFF; leaving the plan to Claude"); process.exit(0); }

const plan = planText(ev.tool_input);
if (!plan.trim()) { log("no plan text found; skipping"); process.exit(0); }
if (!freebuffInstalled()) {
  log("freebuff not on PATH");
  reply("[freebuff handoff] Automatic handoff is on, but `freebuff` is not installed or not on PATH (npm i -g freebuff, then `freebuff login`). Nothing was queued. Tell the user, and implement the plan yourself only if they say so.");
}

const repo = repoRootOf(ev.cwd || process.cwd());
const hold = confirmEnabled();
try {
  const slug = slugify(planTitle(plan));
  const { id, position } = await addBrief(repo, { slug, body: planToBrief(plan), hold });
  const nn = id.slice(0, 2);
  const release = `node "${FBQ}" release ${nn} --cd "${repo}"`;

  // What Claude does once freebuff is running: wait, review, fix or accept.
  const afterStart = [
    `1. Run \`node "${FBQ}" wait ${nn} --cd "${repo}" --timeout-min 60\` with Bash run_in_background: true and wait for its notification (do not poll).`,
    "2. On DONE, treat the report as a claim, not proof: run `git status --short` and `git diff`, compare against the plan, and run the plan's verification commands yourself.",
    `3. If something is wrong, queue a fix brief that names the exact problems: \`node "${FBQ}" handoff --front --slug ${slug.slice(0, 30)}-fix --file <brief.md> --cd "${repo}"\`, then wait again. Do not fix it quietly yourself.`,
    `4. When it is good, run \`node "${FBQ}" reviewed ${nn} --cd "${repo}"\`, tell the user what changed and what you ran, and commit only if they ask.`,
    `Tell the user once, in one line, that the plan went to freebuff (live view: \`node "${FBQ}" watch --cd "${repo}"\` in a terminal).`,
  ];

  if (hold) {
    log(`queued ${id} ON HOLD in ${repo}; waiting for the user to confirm their edits are finished`);
    reply([
      `[freebuff handoff] The approved plan is queued for freebuff as task ${id} (brief: .briefs/${id}.md) but is ON HOLD: freebuff has NOT been started.`,
      "It edits files in this repo the moment it starts, and the user may still be editing files themselves.",
      "Do NOT implement the plan yourself and do NOT start freebuff yet. First ask the user, using AskUserQuestion (a plain question if that tool is unavailable):",
      '  Question: "Have you finished all your own edits? freebuff starts changing files in this repo the moment you say yes."',
      '  Options: "Yes, start freebuff" / "No, I\'m still editing"',
      `- Yes: run \`${release}\` and then:`,
      ...afterStart.map((l) => `    ${l}`),
      `- No: do not release. Tell the user in one line that the plan is held as task ${id} and to tell you when they are done (or run \`${release}\` themselves), then end your turn and do nothing else. When they later say they are done, run the release command and continue as above.`,
      "Never run `wait` while the task is held: it returns HELD immediately.",
    ].join("\n"));
  }

  const dispatcher = startDispatcher(repo);
  log(`queued ${id} (position ${position}) in ${repo}; dispatcher ${dispatcher}`);
  reply([
    `[freebuff handoff] The approved plan was queued for freebuff as task ${id} (brief: .briefs/${id}.md, position ${position}).`,
    `A hidden freebuff session ${dispatcher === "started" ? "was started" : "is already running"} and will receive the plan automatically; nobody needs to type anything.`,
    "Do NOT implement the plan yourself. Your job now is to wait for freebuff and review its work:",
    ...afterStart,
  ].join("\n"));
} catch (e) {
  log(`handoff failed: ${e.stack}`);
  reply(`[freebuff handoff] Automatic handoff failed: ${e.message}. Nothing was queued. Tell the user, and implement the plan yourself only if they say so.`);
}
