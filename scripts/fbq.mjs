#!/usr/bin/env node
/**
 * fbq — orchestrator CLI for delegate-to-freebuff. State lives in <repo>/.briefs/ (see lib.mjs).
 *
 *   status [--json]                     dispatcher state + every task's state
 *   handoff --file <plan.md> [--slug s] [--front] [--hold]
 *                                       queue a plan/brief and start the dispatcher if it isn't running;
 *                                       with --hold, queue it but do NOT start anything until `release`
 *   add --slug <s> --file <brief.md> [--front] [--hold]
 *                                       queue only (the dispatcher picks it up if it is running)
 *   release <NN>                        lift the hold on NN and start the dispatcher
 *   wait <NN> [--timeout-min 60]        block until NN has a done report (restarts a dead dispatcher;
 *                                       a held task returns HELD at once, exit code 3)
 *   reviewed <NN>                       mark NN reviewed
 *   tail [--lines 40]                   last terminal output of the freebuff run (ANSI stripped, best effort)
 *   watch                               live replay of the current freebuff terminal (run in a VS Code terminal)
 *   dispatcher start|stop|status        control the background dispatcher
 *   auto on|off|status                  switch the ExitPlanMode hook's automatic handoff (global)
 *   confirm on|off|status               on (default): the hook holds the plan and Claude asks "have you finished
 *                                       your edits?" before freebuff starts; off: start immediately (global)
 *
 * All repo commands take --cd <repo> (default: current directory).
 */
import { execFileSync } from "node:child_process";
import { existsSync, openSync, readSync, readdirSync, readFileSync, closeSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FBQ, addBrief, autoEnabled, briefsDir, confirmEnabled, dispatcherInfo, findTask, freebuffInstalled, now, planTitle, queueOrder,
  readDispatcher, releaseTask, setConfig, sleep, slugify, startDispatcher, stripAnsi, tasks,
} from "./lib.mjs";

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--front") out.front = true;
    else if (a === "--hold") out.hold = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const args = parse(process.argv.slice(2));
const cmd = args._[0];
const repo = resolve(args.cd || process.cwd());
const dir = briefsDir(repo);
const q = (p) => `"${p}"`;

function die(msg, code = 2) { console.log(msg); process.exit(code); }
const need = (v, usage) => { if (!v) die(`usage: ${usage}`); return v; };

function dispatcherLogTail(n = 8) {
  try { return readFileSync(join(dir, ".dispatcher.log"), "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return "(no .dispatcher.log)"; }
}

function newestPtyLog() {
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir).filter((f) => f.endsWith(".pty.log")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }));
  logs.sort((a, b) => b.t - a.t);
  return logs[0] ? join(dir, logs[0].f) : null;
}

function readTail(file, bytes) {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

async function main() {
  switch (cmd) {
    case "status": {
      const d = existsSync(dir) ? dispatcherInfo(dir) : { alive: false, detail: "no .briefs/ yet" };
      const list = tasks(dir);
      const order = queueOrder(list).map((t) => t.id);
      if (args.json) { console.log(JSON.stringify({ repo, dispatcher: d, queue: order, tasks: list }, null, 2)); return; }
      console.log(`dispatcher: ${d.alive ? "RUNNING" : "STOPPED"} (${d.detail})`);
      console.log(`auto handoff on plan approval: ${autoEnabled() ? "ON" : "OFF"}`);
      console.log(`ask before starting freebuff (confirm): ${confirmEnabled() ? "ON" : "OFF"}`);
      console.log(`queue: ${order.length ? order.join(", ") : "empty"}`);
      for (const t of list.filter((x) => x.state !== "reviewed")) {
        const extra = t.state === "queued" ? ` (position ${order.indexOf(t.id) + 1})`
          : t.state === "held" ? ` (HELD until the user has finished their edits; then: release ${t.nn})`
            : t.doneStatus ? ` [${t.doneStatus}] -> needs review` : "";
        console.log(`  ${t.id}: ${t.state}${extra}`);
      }
      return;
    }

    case "handoff":
    case "add": {
      const file = need(args.file, `${cmd} --file <plan-or-brief.md> [--slug kebab-slug] [--front] [--hold]${cmd === "add" ? " (--slug required)" : ""}`);
      if (!existsSync(file)) die(`file not found: ${file}`);
      const body = readFileSync(file, "utf8");
      if (!body.trim()) die(`file is empty: ${file}`);
      const slug = args.slug || (cmd === "handoff" ? slugify(planTitle(body)) : need(null, "add --slug <kebab-slug> --file <brief.md>"));
      const { id, position } = await addBrief(repo, { slug, body, front: !!args.front, hold: !!args.hold });
      console.log(args.hold ? `queued ${id} on HOLD (freebuff not started)` : `queued ${id} at position ${position}`);
      console.log(`brief: ${join(dir, id + ".md")}`);
      if (args.hold) {
        console.log(`held: nothing runs until: node ${q(FBQ)} release ${id.slice(0, 2)} --cd ${q(repo)}`);
      } else if (cmd === "handoff") {
        if (!freebuffInstalled()) die("freebuff is not installed or not on PATH (npm i -g freebuff, then `freebuff login`)", 1);
        console.log(`dispatcher: ${startDispatcher(repo) === "started" ? "started (hidden freebuff will receive the task automatically)" : "already running"}`);
        console.log(`next: node ${q(FBQ)} wait ${id.slice(0, 2)} --cd ${q(repo)} --timeout-min 60   (run in background)`);
      } else {
        console.log(`dispatcher: ${dispatcherInfo(dir).alive ? "running, will pick it up" : "STOPPED - run: dispatcher start"}`);
      }
      return;
    }

    case "wait": {
      const t = findTask(dir, need(args._[1], "wait <NN> [--timeout-min 60]"));
      const deadline = Date.now() + parseFloat(args["timeout-min"] || "60") * 60_000;
      let warned = false;
      while (Date.now() < deadline) {
        const done = join(dir, `${t.id}.done.md`);
        if (existsSync(done) && statSync(done).size > 0) {
          await sleep(1000); // let the writer finish
          console.log(`DONE ${t.id}`);
          console.log(readFileSync(done, "utf8"));
          return;
        }
        const cur = tasks(dir).find((x) => x.id === t.id);
        // A held task never starts by itself: waiting would hang. Tell the caller to release it first.
        if (cur?.state === "held") {
          console.log(`HELD ${t.id}: freebuff has not been started because the user may still be editing. Nothing to wait for yet.`);
          console.log(`When the user confirms their edits are finished, run: node ${q(FBQ)} release ${t.nn} --cd ${q(repo)}`);
          process.exit(3);
        }
        // Self-heal: a queued task with no dispatcher would wait forever.
        if (cur?.state === "queued" && !dispatcherInfo(dir).alive) {
          if (!warned) { console.log(`note: dispatcher was not running; restarting it for ${t.id}`); warned = true; }
          startDispatcher(repo);
        } else if (cur?.state === "working" && !dispatcherInfo(dir).alive && !warned) {
          console.log(`WORKER_OFFLINE: ${t.id} is claimed but the dispatcher is gone. Last log lines:\n${dispatcherLogTail()}`);
          warned = true;
        }
        await sleep(3000);
      }
      console.log(`TIMEOUT ${t.id}: no done report yet. dispatcher: ${dispatcherInfo(dir).detail}\n${dispatcherLogTail()}`);
      process.exit(1);
    }

    case "release": {
      const ref = need(args._[1], "release <NN>");
      const t = findTask(dir, ref);
      if (t.state !== "held") die(`${t.id} is not held (state: ${t.state}); nothing to release`, 1);
      if (!freebuffInstalled()) die("freebuff is not installed or not on PATH (npm i -g freebuff, then `freebuff login`); task left on hold", 1);
      releaseTask(repo, ref);
      console.log(`released ${t.id}`);
      console.log(`dispatcher: ${startDispatcher(repo) === "started" ? "started (hidden freebuff will receive the task automatically)" : "already running"}`);
      console.log(`next: node ${q(FBQ)} wait ${t.nn} --cd ${q(repo)} --timeout-min 60   (run in background)`);
      return;
    }

    case "reviewed": {
      const t = findTask(dir, need(args._[1], "reviewed <NN>"));
      writeFileSync(join(dir, `${t.id}.reviewed`), now());
      console.log(`reviewed ${t.id}`);
      return;
    }

    case "tail": {
      const f = newestPtyLog();
      if (!f) die("no freebuff run recorded yet (no .briefs/*.pty.log)");
      const n = parseInt(args.lines || "40", 10);
      console.log(`# ${f}`);
      console.log(stripAnsi(readTail(f, 60_000)).split("\n").filter((l) => l.trim()).slice(-n).join("\n"));
      console.log("\n# dispatcher log\n" + dispatcherLogTail());
      return;
    }

    case "watch": {
      const f = newestPtyLog();
      if (!f) die("no freebuff run recorded yet (no .briefs/*.pty.log)");
      process.stdout.write(`# replaying ${f}  (Ctrl+C to stop; the terminal is 140x40 in the hidden PTY)\n`);
      let pos = Math.max(0, statSync(f).size - 30_000);
      for (;;) {
        const size = statSync(f).size;
        if (size > pos) {
          const fd = openSync(f, "r");
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          closeSync(fd);
          process.stdout.write(buf);
          pos = size;
        }
        await sleep(500);
      }
    }

    case "dispatcher": {
      const sub = args._[1];
      if (sub === "start") {
        if (!freebuffInstalled()) die("freebuff is not installed or not on PATH", 1);
        console.log(`dispatcher: ${startDispatcher(repo)}`);
      } else if (sub === "stop") {
        const d = readDispatcher(dir);
        if (!d) die("dispatcher is not running", 0);
        for (const pid of [d.ptyPid, d.pid].filter(Boolean)) {
          try {
            if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
            else process.kill(pid, "SIGTERM");
          } catch {}
        }
        console.log(`stopped dispatcher pid ${d.pid}. A task it was running gets a blocked report on the next dispatcher start.`);
      } else {
        const d = dispatcherInfo(dir);
        console.log(`dispatcher: ${d.alive ? "RUNNING" : "STOPPED"} (${d.detail})`);
      }
      return;
    }

    case "auto": {
      const sub = args._[1];
      if (sub === "on" || sub === "off") setConfig({ auto: sub === "on" });
      console.log(`automatic handoff on plan approval: ${autoEnabled() ? "ON" : "OFF"}`);
      return;
    }

    case "confirm": {
      const sub = args._[1];
      if (sub === "on" || sub === "off") setConfig({ confirm: sub === "on" });
      console.log(`ask "finished your edits?" before freebuff starts: ${confirmEnabled() ? "ON" : "OFF"}`);
      return;
    }

    default:
      die("usage: fbq.mjs <status|handoff|add|release|wait|reviewed|tail|watch|dispatcher|auto|confirm> [--cd <repo>] ... (see header)");
  }
}

main().catch((e) => { console.log(`error: ${e.message}`); process.exit(1); });
