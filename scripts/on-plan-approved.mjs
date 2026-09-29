#!/usr/bin/env node
// PostToolUse hook for ExitPlanMode: fires only after the user approves the plan. Queues the plan as a
// brief, starts the detached dispatcher (which runs freebuff in a hidden PTY and feeds it the plan), and
// tells Claude to wait and review instead of implementing. Must return fast; it never blocks on freebuff.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FBQ, HOOK_LOG, addBrief, autoEnabled, freebuffInstalled, planTitle, planToBrief, repoRootOf, slugify, startDispatcher,
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
try {
  const { id, position } = await addBrief(repo, { slug: slugify(planTitle(plan)), body: planToBrief(plan) });
  const dispatcher = startDispatcher(repo);
  const nn = id.slice(0, 2);
  log(`queued ${id} (position ${position}) in ${repo}; dispatcher ${dispatcher}`);
  reply([
    `[freebuff handoff] The approved plan was queued for freebuff as task ${id} (brief: .briefs/${id}.md, position ${position}).`,
    `A hidden freebuff session ${dispatcher === "started" ? "was started" : "is already running"} and will receive the plan automatically; nobody needs to type anything.`,
    "Do NOT implement the plan yourself. Your job now is to wait for freebuff and review its work:",
    `1. Run \`node "${FBQ}" wait ${nn} --cd "${repo}" --timeout-min 60\` with Bash run_in_background: true and wait for its notification (do not poll).`,
    "2. On DONE, treat the report as a claim, not proof: run `git status --short` and `git diff`, compare against the plan, and run the plan's verification commands yourself.",
    `3. If something is wrong, queue a fix brief that names the exact problems: \`node "${FBQ}" handoff --front --slug ${slugify(planTitle(plan)).slice(0, 30)}-fix --file <brief.md> --cd "${repo}"\`, then wait again. Do not fix it quietly yourself.`,
    `4. When it is good, run \`node "${FBQ}" reviewed ${nn} --cd "${repo}"\`, tell the user what changed and what you ran, and commit only if they ask.`,
    `Tell the user once, in one line, that the plan went to freebuff (live view: \`node "${FBQ}" watch --cd "${repo}"\` in a terminal).`,
  ].join("\n"));
} catch (e) {
  log(`handoff failed: ${e.stack}`);
  reply(`[freebuff handoff] Automatic handoff failed: ${e.message}. Nothing was queued. Tell the user, and implement the plan yourself only if they say so.`);
}
