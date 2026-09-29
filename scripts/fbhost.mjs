// Dispatcher: runs queued briefs through freebuff, one fresh freebuff PTY per task, with nobody typing.
// usage: node fbhost.mjs --cd <repo>
// Started detached by the ExitPlanMode hook / `fbq handoff`; exits after FB_IDLE_MIN minutes with an empty queue.
//
// Per task: spawn `freebuff --cwd <repo>` in a hidden PTY -> wait for the TUI to settle -> type a one-line
// prompt pointing at .briefs/<id>.md -> wait for .briefs/<id>.done.md -> close that freebuff.
// If freebuff dies, stalls or times out, the dispatcher writes a `status: blocked` done report itself so
// `fbq wait` never hangs.
//
// Env knobs: FB_IDLE_MIN (2) FB_TASK_TIMEOUT_MIN (60) FB_STALL_MIN (10) FB_READY_MAX_S (25)
//            FB_TRUST_AGENTS=1 (pass --trust-agents) FB_BIN (freebuff command)
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, createWriteStream, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  briefsDir, claimNext, dispatcherInfo, dur, isPidAlive, now, queueOrder, readDispatcher, sleep, stripAnsi, tasks, writeBlockedReport,
} from "./lib.mjs";

const win = process.platform === "win32";
const i = process.argv.indexOf("--cd");
const repo = resolve(i > 0 ? process.argv[i + 1] : process.cwd());
const dir = briefsDir(repo);
const lockFile = join(dir, ".dispatcher.json");
const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const IDLE_MS = num("FB_IDLE_MIN", 2) * 60_000;
const TASK_TIMEOUT_MS = num("FB_TASK_TIMEOUT_MIN", 60) * 60_000;
const STALL_MS = num("FB_STALL_MIN", 10) * 60_000;
const READY_MAX_MS = num("FB_READY_MAX_S", 25) * 1000;
const READY_QUIET_MS = 2500; // TUI counts as ready after this long without output
const READY_MIN_MS = 3000;

const log = (msg) => { try { appendFileSync(join(dir, ".dispatcher.log"), `[${now()}] ${msg}\n`); } catch {} };

let currentId = null;
let currentPty = null;
const state = () => ({ pid: process.pid, ptyPid: currentPty?.pid ?? null, state: currentId ? "working" : "idle", task: currentId, at: now() });

function acquire() {
  for (let n = 0; n < 3; n++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(fd, JSON.stringify(state()));
      closeSync(fd);
      return true;
    } catch (e) { if (e.code !== "EEXIST") throw e; }
    if (dispatcherInfo(dir).alive) return false;
    rmSync(lockFile, { force: true }); // stale lock from a dead dispatcher
  }
  return false;
}

function release() {
  const d = readDispatcher(dir);
  if (d && d.pid === process.pid) rmSync(lockFile, { force: true });
}

const heartbeat = setInterval(() => { try { writeFileSync(lockFile, JSON.stringify(state())); } catch {} }, 5000);

function killTree(p) {
  try { if (win) execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  try { p.kill(); } catch {}
}

// freebuff has its own login; don't hand it this Claude session's credentials.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_|CLAUDE)/i.test(k)) env[k] = v;
  return env;
}

const doneExists = (id) => { try { return statSync(join(dir, `${id}.done.md`)).size > 0; } catch { return false; } };

async function runTask(t) {
  currentId = t.id;
  log(`task ${t.id}: starting freebuff`);
  const ptyLog = createWriteStream(join(dir, `${t.id}.pty.log`));
  let tail = "";
  let firstData = 0;
  let lastData = Date.now();
  let exited = null;

  const bin = process.env.FB_BIN || "freebuff";
  const fbArgs = ["--cwd", repo, ...(process.env.FB_TRUST_AGENTS === "1" ? ["--trust-agents"] : [])];
  const p = pty.spawn(win ? (process.env.ComSpec || "cmd.exe") : bin, win ? ["/c", bin, ...fbArgs] : fbArgs, {
    name: "xterm-256color", cols: 140, rows: 40, cwd: repo, env: cleanEnv(),
  });
  currentPty = p;
  const startedAt = Date.now();
  p.onData((d) => { if (!firstData) firstData = Date.now(); lastData = Date.now(); ptyLog.write(d); tail = (tail + d).slice(-20_000); });
  p.onExit((e) => { exited = e; });

  let reason = null;

  // 1. wait for the TUI to settle before typing
  while (!exited && Date.now() - startedAt < READY_MAX_MS) {
    if (firstData && Date.now() - lastData >= READY_QUIET_MS && Date.now() - startedAt >= READY_MIN_MS) break;
    await sleep(200);
  }
  if (exited) {
    reason = `freebuff exited (code ${exited.exitCode}) during startup`;
  } else {
    log(`task ${t.id}: TUI ready after ${Date.now() - startedAt} ms (first output at ${firstData ? firstData - startedAt : "never"} ms); typing prompt`);
    // 2. type the one-line prompt, then Enter
    p.write(`Read .briefs/${t.id}.md and implement it exactly. Never run git commit, git push or git stash. Finish by writing .briefs/${t.id}.done.md as the last section of the brief says.`);
    await sleep(700);
    p.write("\r");

    // 3. wait for the done report
    const sentAt = Date.now();
    for (;;) {
      if (doneExists(t.id)) { await sleep(2500); break; } // grace: let freebuff finish writing
      if (exited) { reason = `freebuff exited (code ${exited.exitCode}) without writing a done report`; break; }
      if (Date.now() - sentAt > TASK_TIMEOUT_MS) { reason = `timed out after ${dur(TASK_TIMEOUT_MS)} without a done report`; break; }
      if (Date.now() - lastData > STALL_MS) { reason = `no terminal output for ${dur(STALL_MS)} (freebuff may be stuck on a prompt it cannot answer)`; break; }
      await sleep(1000);
    }
  }

  killTree(p);
  currentPty = null;
  ptyLog.end();
  if (reason && !doneExists(t.id)) {
    writeBlockedReport(dir, t.id, reason, stripAnsi(tail).slice(-2500));
    log(`task ${t.id}: BLOCKED - ${reason}`);
  } else {
    log(`task ${t.id}: done report found; freebuff closed`);
  }
  currentId = null;
}

function shutdown(why) {
  log(`shutting down: ${why}`);
  clearInterval(heartbeat);
  if (currentPty) killTree(currentPty);
  if (currentId && !doneExists(currentId)) writeBlockedReport(dir, currentId, `dispatcher stopped (${why}) before freebuff finished`);
  release();
  process.exit(0);
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => shutdown(s));

let pty;
try {
  ({ default: pty } = await import("@lydell/node-pty"));
} catch (e) {
  log(`cannot load @lydell/node-pty (${e.message}). Run: npm install --omit=dev  in the skill folder (${join(import.meta.dirname, "..")})`);
  process.exit(1);
}

if (!existsSync(dir) || !acquire()) { log("another dispatcher is running (or .briefs missing); exiting"); process.exit(0); }
log(`dispatcher started (pid ${process.pid}) for ${repo}`);

// A task claimed by a dispatcher that has since died is orphaned: report it instead of leaving `wait` hanging.
for (const t of tasks(dir).filter((x) => x.state === "working")) {
  try {
    const by = JSON.parse(readFileSync(join(dir, `${t.id}.working`), "utf8"));
    if (by.by === "dispatcher" && !isPidAlive(by.pid)) writeBlockedReport(dir, t.id, "the dispatcher running this task died; the work may be partly done");
  } catch {}
}

let idleSince = Date.now();
for (;;) {
  const t = await claimNext(repo, "dispatcher");
  if (t) {
    try { await runTask(t); } catch (e) { currentId = null; writeBlockedReport(dir, t.id, `dispatcher error: ${e.message}`); log(`task ${t.id}: ERROR ${e.stack}`); }
    idleSince = Date.now();
    continue;
  }
  if (Date.now() - idleSince > IDLE_MS) {
    // Release first, then look once more, so a task queued during the exit window is not stranded.
    release();
    if (queueOrder(tasks(dir)).length && acquire()) { idleSince = Date.now(); continue; }
    break;
  }
  await sleep(1000);
}
clearInterval(heartbeat);
log("idle; dispatcher exiting");
