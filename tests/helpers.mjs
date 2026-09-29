import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPTS = join(ROOT, "scripts");
export const FAKE = join(ROOT, "tests", "fake-freebuff.mjs");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tmp = (prefix = "dbf-") => mkdtempSync(join(tmpdir(), prefix));
export const rm = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };

export async function until(fn, { timeout = 30_000, every = 250, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(every);
  }
}

/** A `freebuff` command that runs fake-freebuff.mjs. Returns its path (for FB_BIN). */
export function fakeFreebuffShim(dir) {
  if (process.platform === "win32") {
    const p = join(dir, "fake-freebuff.cmd");
    writeFileSync(p, `@echo off\r\nnode "${FAKE}" %*\r\n`);
    return p;
  }
  const p = join(dir, "fake-freebuff");
  writeFileSync(p, `#!/bin/sh\nexec node "${FAKE}" "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

// Environment with a private HOME so tests never touch the real ~/.claude, and no FB_ or FREEBUFF_ variables leaking in.
export function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, FB_IDLE_MIN: "0.05" };
  for (const k of Object.keys(env)) if (/^(FB_(?!IDLE_MIN)|FREEBUFF_)/.test(k)) delete env[k];
  return { ...env, ...extra };
}

/** Run `node <script> ...args`, resolve {code, stdout, stderr}. */
export function run(script, args = [], { env = process.env, input, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
