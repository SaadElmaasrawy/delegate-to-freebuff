// Shared helpers for delegate-to-freebuff: the per-repo queue in <repo>/.briefs/, dispatcher liveness,
// and turning an approved plan into a brief. Node built-ins only.
//
// Files in .briefs/:
//   NN-slug.md           the brief (queued until claimed)
//   NN-slug.front        marker: jump the queue (fix briefs)
//   NN-slug.working      claimed: {at, by, pid}
//   NN-slug.done.md      done report (written by freebuff, or by the dispatcher when freebuff fails)
//   NN-slug.reviewed     reviewed by the orchestrator
//   NN-slug.pty.log      raw terminal output of the freebuff run for that task
//   .dispatcher.json     dispatcher lock + heartbeat: {pid, ptyPid, state, task, at}
//   .dispatcher.log      dispatcher event log
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = dirname(fileURLToPath(import.meta.url));
export const FBQ = join(SCRIPTS, "fbq.mjs");
export const FBHOST = join(SCRIPTS, "fbhost.mjs");
export const AUTO_FILE = join(homedir(), ".claude", "delegate-to-freebuff.json");
export const HOOK_LOG = join(homedir(), ".claude", "delegate-to-freebuff.log");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();
export const briefsDir = (repo) => join(repo, ".briefs");

export function repoRootOf(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return resolve(out.trim());
  } catch {
    return resolve(cwd);
  }
}

export function ensureBriefs(repo) {
  const dir = briefsDir(repo);
  mkdirSync(dir, { recursive: true });
  // keep .briefs/ out of git without touching .gitignore
  const infoDir = join(repo, ".git", "info");
  if (existsSync(infoDir)) {
    const exclude = join(infoDir, "exclude");
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!/^\.briefs\/?\s*$/m.test(cur)) writeFileSync(exclude, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + ".briefs/\n");
  }
  return dir;
}

export async function withLock(dir, fn) {
  const lock = join(dir, ".lock");
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      // a lock older than 30s is from a crashed process
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (i > 200) throw new Error("could not acquire .briefs/.lock");
      await sleep(50);
    }
  }
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// ---------- tasks ----------

export function tasks(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const has = (f) => names.includes(f);
  return names
    .map((f) => f.match(/^(\d{2,})-(.+)\.md$/))
    .filter((m) => m && !m[2].endsWith(".done"))
    .map((m) => {
      const id = `${m[1]}-${m[2]}`;
      const state = has(`${id}.reviewed`) ? "reviewed"
        : has(`${id}.done.md`) ? "done"
          : has(`${id}.working`) ? "working" : "queued";
      let doneStatus = null;
      if (state === "done" || state === "reviewed") {
        const s = readFileSync(join(dir, `${id}.done.md`), "utf8").match(/status:\s*(\w+)/i);
        doneStatus = s ? s[1].toLowerCase() : "unknown";
      }
      return { nn: m[1], id, state, front: has(`${id}.front`), doneStatus };
    })
    .sort((a, b) => a.nn.localeCompare(b.nn));
}

export const queueOrder = (list) => list.filter((t) => t.state === "queued")
  .sort((a, b) => (b.front - a.front) || a.nn.localeCompare(b.nn));

export function findTask(dir, ref) {
  const r = String(ref ?? "");
  const t = tasks(dir).find((x) => x.nn === r || x.id === r || x.nn === r.padStart(2, "0"));
  if (!t) throw new Error(`no task ${r} in ${dir}`);
  return t;
}

export function doneSection(id) {
  return [
    "",
    "## Done report (required)",
    `As your very last step, create the file \`.briefs/${id}.done.md\` containing:`,
    "- `status: done` or `status: blocked`",
    "- files changed (paths)",
    "- verify commands you ran and whether each passed",
    "- anything you skipped, guessed, or could not do",
    "Write it even if you are blocked. Do not create it before the work is finished.",
    "",
  ].join("\n");
}

/** Queue a brief. Returns { id, position }. The done-report instructions are appended here. */
export async function addBrief(repo, { slug, body, front = false }) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("slug must be kebab-case (a-z, 0-9, -)");
  const dir = ensureBriefs(repo);
  const id = await withLock(dir, async () => {
    const max = tasks(dir).reduce((m, t) => Math.max(m, parseInt(t.nn, 10)), 0);
    const id = `${String(max + 1).padStart(2, "0")}-${slug}`;
    if (front) writeFileSync(join(dir, `${id}.front`), "");
    // write-then-rename so the dispatcher never claims a half-written brief
    writeFileSync(join(dir, `${id}.md.tmp`), body.replace(/\s+$/, "\n") + doneSection(id));
    renameSync(join(dir, `${id}.md.tmp`), join(dir, `${id}.md`));
    return id;
  });
  return { id, position: queueOrder(tasks(dir)).findIndex((t) => t.id === id) + 1 };
}

/** Atomically claim the next queued task, or null. */
export async function claimNext(repo, by) {
  const dir = briefsDir(repo);
  return withLock(dir, async () => {
    const t = queueOrder(tasks(dir))[0];
    if (!t) return null;
    const fd = openSync(join(dir, `${t.id}.working`), "wx");
    writeFileSync(fd, JSON.stringify({ at: now(), by, pid: process.pid }));
    closeSync(fd);
    return t;
  });
}

export function writeBlockedReport(dir, id, reason, extra = "") {
  const f = join(dir, `${id}.done.md`);
  if (existsSync(f)) return;
  writeFileSync(f, [
    `# Done report: ${id} (written by the dispatcher, not by freebuff)`,
    "",
    "- status: blocked",
    `- reason: ${reason}`,
    "- Inspect the changes with `git status` / `git diff`; the work may be partly done.",
    `- Raw terminal output: .briefs/${id}.pty.log (node fbq.mjs tail)`,
    extra ? `\n## Last terminal output (ANSI stripped)\n\n${extra}\n` : "",
  ].join("\n"));
}

// ---------- dispatcher ----------

export const isPidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

export function readDispatcher(dir) {
  const f = join(dir, ".dispatcher.json");
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; }
  }
  return null;
}

export function dispatcherInfo(dir) {
  const d = readDispatcher(dir);
  if (!d) return { alive: false, detail: "not running" };
  const ageS = Math.round((Date.now() - Date.parse(d.at)) / 1000);
  const alive = isPidAlive(d.pid) && ageS < 30;
  if (!alive) return { alive: false, detail: `stale (pid ${d.pid}, last heartbeat ${ageS}s ago)`, ...d };
  return { alive: true, detail: d.state === "working" ? `working on ${d.task}` : "idle", ...d };
}

/** Start the dispatcher detached unless one is alive. Returns "running" | "started". */
export function startDispatcher(repo) {
  if (dispatcherInfo(briefsDir(repo)).alive) return "running";
  ensureBriefs(repo);
  const child = spawn(process.execPath, [FBHOST, "--cd", repo], { cwd: repo, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return "started";
}

// ---------- plan -> brief ----------

export function planTitle(plan) {
  const h = plan.match(/^#{1,3}\s+(.+)$/m);
  const line = (h ? h[1] : plan.split(/\r?\n/).find((l) => l.trim()) || "plan").replace(/^plan\s*[:\-–—]\s*/i, "").trim();
  return line.slice(0, 100) || "plan";
}

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "plan";
}

export function planToBrief(plan) {
  return [
    `# Task: ${planTitle(plan)}`,
    "",
    "You are implementing an approved plan in this repository. You have seen nothing of the conversation",
    "that produced it: the plan below is your complete instruction.",
    "",
    "## Rules",
    "- Implement the plan exactly. Do not add features, refactors or cleanups it does not ask for.",
    "- Never run `git commit`, `git push`, `git stash`, `git reset` or `git checkout -- .`. If the plan lists a",
    "  commit step, skip it: the reviewer commits after reviewing.",
    "- Run the plan's verification steps (tests, lint, build) and report the real results, pass or fail.",
    "- If part of the plan cannot be done or looks wrong, do the rest and say so in the done report.",
    "  Use `status: blocked` if the core goal is not met.",
    "",
    "## Plan",
    "",
    plan.trim(),
    "",
  ].join("\n");
}

// ---------- misc ----------

export function autoEnabled() {
  if (process.env.FREEBUFF_AUTO === "0") return false;
  try { return JSON.parse(readFileSync(AUTO_FILE, "utf8")).auto !== false; } catch { return true; }
}

export function setAuto(on) {
  mkdirSync(dirname(AUTO_FILE), { recursive: true });
  writeFileSync(AUTO_FILE, JSON.stringify({ auto: on }, null, 2) + "\n");
}

/** Is the freebuff command (FB_BIN, default `freebuff`) available? */
export function freebuffInstalled() {
  const bin = process.env.FB_BIN || "freebuff";
  if (/[\\/]/.test(bin)) return existsSync(bin);
  try { execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
}

/** "45 s" under a minute, "12 min" otherwise. */
export const dur = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** Strip terminal escape sequences and collapse blank lines. */
export function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=! ]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>78cMDEHN]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}
