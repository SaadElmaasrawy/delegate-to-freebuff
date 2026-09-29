// End-to-end: the real hook handler and the real dispatcher (hidden PTY), with a fake freebuff.
// Needs `npm install` first (node-pty). Uses a private HOME, so ~/.claude is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { SCRIPTS, fakeFreebuffShim, isolatedEnv, rm, run, tmp, until } from "./helpers.mjs";

const HOOK = join(SCRIPTS, "on-plan-approved.mjs");
const FBQ = join(SCRIPTS, "fbq.mjs");
const FBHOST = join(SCRIPTS, "fbhost.mjs");
const PLAN = "# Plan: Add greeting\n\n1. Create greet.js\n2. Commit it\n";
const payload = (cwd, over = {}) => JSON.stringify({
  session_id: "t", cwd, hook_event_name: "PostToolUse", tool_name: "ExitPlanMode", tool_input: { plan: PLAN }, tool_use_id: "x", ...over,
});

/** A sandbox: private HOME, a repo dir (optionally with a space in its path), a fake freebuff shim. */
function sandbox({ repoName = "repo" } = {}) {
  const root = tmp();
  const home = join(root, "home");
  const repo = join(root, repoName);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(repo);
  const shim = fakeFreebuffShim(root);
  const briefs = join(repo, ".briefs");
  const done = (id) => join(briefs, `${id}.done.md`);
  const finish = async () => {
    // let the detached dispatcher exit (it removes its lock) before deleting its cwd
    await until(() => !existsSync(join(briefs, ".dispatcher.json")), { timeout: 30_000, what: "dispatcher exit" }).catch(() => {});
    rm(root);
  };
  return { root, home, repo, shim, briefs, done, finish, env: (extra) => isolatedEnv(home, { FB_BIN: shim, ...extra }) };
}

test("hook ignores tools other than ExitPlanMode", async () => {
  const s = sandbox();
  try {
    const r = await run(HOOK, [], { env: s.env(), input: payload(s.repo, { tool_name: "Bash" }) });
    assert.deepEqual([r.code, r.stdout], [0, ""]);
    assert.equal(existsSync(s.briefs), false);
  } finally { await s.finish(); }
});

test("hook stays silent and queues nothing when auto is off", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.home, ".claude", "delegate-to-freebuff.json"), JSON.stringify({ auto: false }));
    const r = await run(HOOK, [], { env: s.env(), input: payload(s.repo) });
    assert.deepEqual([r.code, r.stdout], [0, ""]);
    assert.equal(existsSync(s.briefs), false);
  } finally { await s.finish(); }
});

test("hook stays silent when the payload has no plan and there is no saved plan file", async () => {
  const s = sandbox();
  try {
    const r = await run(HOOK, [], { env: s.env(), input: payload(s.repo, { tool_input: {} }) });
    assert.deepEqual([r.code, r.stdout], [0, ""]);
    assert.equal(existsSync(s.briefs), false);
  } finally { await s.finish(); }
});

test("hook tells Claude, and queues nothing, when freebuff is missing", async () => {
  const s = sandbox();
  try {
    const r = await run(HOOK, [], { env: s.env({ FB_BIN: "definitely-not-a-real-command-xyz" }), input: payload(s.repo) });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /not installed/);
    assert.equal(existsSync(s.briefs), false);
  } finally { await s.finish(); }
});

test("plan approval -> queued -> fake freebuff gets the prompt typed into a hidden PTY -> done -> closed -> dispatcher exits",
  { timeout: 90_000 }, async () => {
    const s = sandbox({ repoName: "repo with space" }); // real project paths often contain spaces
    try {
      const r = await run(HOOK, [], { env: s.env(), input: payload(s.repo) });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      assert.equal(out.hookEventName, "PostToolUse");
      assert.match(out.additionalContext, /\[freebuff handoff\].*01-add-greeting/s);
      assert.match(out.additionalContext, /Do NOT implement the plan yourself/);

      const brief = readFileSync(join(s.briefs, "01-add-greeting.md"), "utf8");
      assert.match(brief, /Never run `git commit`/);
      assert.ok(brief.includes("1. Create greet.js"));

      await until(() => existsSync(s.done("01-add-greeting")) && readFileSync(s.done("01-add-greeting"), "utf8").length > 0,
        { timeout: 45_000, what: "done report" });
      const report = readFileSync(s.done("01-add-greeting"), "utf8");
      assert.match(report, /status: done/);
      assert.match(report, /fake freebuff saw: Read \.briefs\/01-add-greeting\.md/, "the prompt was typed into the PTY and submitted");

      await until(() => !existsSync(join(s.briefs, ".dispatcher.json")), { timeout: 30_000, what: "dispatcher exit" });
      const log = readFileSync(join(s.briefs, ".dispatcher.log"), "utf8");
      assert.match(log, /done report found; freebuff closed/);
      assert.match(log, /idle; dispatcher exiting/);

      const status = await run(FBQ, ["status", "--cd", s.repo], { env: s.env() });
      assert.match(status.stdout, /dispatcher: STOPPED/);
      assert.match(status.stdout, /01-add-greeting: done \[done\]/);
    } finally { await s.finish(); }
  });

test("a freebuff that dies at startup yields a blocked report instead of a hang", { timeout: 60_000 }, async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "brief.md"), "# Boom\n");
    const add = await run(FBQ, ["add", "--slug", "boom", "--file", join(s.root, "brief.md"), "--cd", s.repo], { env: s.env() });
    assert.match(add.stdout, /queued 01-boom/);
    // start the dispatcher directly: `handoff` would refuse because the command doesn't exist
    spawn(process.execPath, [FBHOST, "--cd", s.repo], { env: s.env({ FB_BIN: "definitely-not-a-real-command-xyz" }), stdio: "ignore", windowsHide: true }).unref();
    await until(() => existsSync(s.done("01-boom")), { timeout: 30_000, what: "blocked report" });
    const report = readFileSync(s.done("01-boom"), "utf8");
    assert.match(report, /status: blocked/);
    assert.match(report, /written by the dispatcher/);
    const w = await run(FBQ, ["wait", "01", "--cd", s.repo, "--timeout-min", "0.5"], { env: s.env() });
    assert.match(w.stdout, /^DONE 01-boom/);
  } finally { await s.finish(); }
});

test("a freebuff that goes silent without a report is reported as stalled", { timeout: 60_000 }, async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "brief.md"), "# Stall\n");
    await run(FBQ, ["add", "--slug", "stall", "--file", join(s.root, "brief.md"), "--cd", s.repo], { env: s.env() });
    const started = await run(FBQ, ["dispatcher", "start", "--cd", s.repo], { env: s.env({ FAKE_FB_MODE: "silent", FB_STALL_MIN: "0.05" }) });
    assert.match(started.stdout, /started/);
    await until(() => existsSync(s.done("01-stall")), { timeout: 40_000, what: "stall report" });
    const report = readFileSync(s.done("01-stall"), "utf8");
    assert.match(report, /status: blocked/);
    assert.match(report, /no terminal output for 3 s/);
  } finally { await s.finish(); }
});
