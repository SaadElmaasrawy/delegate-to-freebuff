#!/usr/bin/env node
// Installs the skill into ~/.claude/skills/delegate-to-freebuff and registers the ExitPlanMode hook in
// ~/.claude/settings.json. Idempotent. Works for the Claude Code CLI, desktop app and VS Code extension
// (they all read the same ~/.claude).
//
//   node scripts/install.mjs                 install / update
//   node scripts/install.mjs --uninstall     remove the hook (add --purge to delete the skill folder too)
//   node scripts/install.mjs --dry-run       show what would change, touch nothing
// Test overrides: --skills-dir <dir>  --settings <file>  --no-npm
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = resolve(opt("skills-dir") || join(homedir(), ".claude", "skills"));
const TARGET = join(SKILLS, "delegate-to-freebuff");
const SETTINGS = resolve(opt("settings") || join(homedir(), ".claude", "settings.json"));
const dry = flag("dry-run");
const HOOK_SCRIPT = join(TARGET, "scripts", "on-plan-approved.mjs").replace(/\\/g, "/");
const HOOK_CMD = `node "${HOOK_SCRIPT}"`;
const isOurs = (h) => typeof h?.command === "string" && /delegate-to-freebuff[\\/]+scripts[\\/]+on-plan-approved\.mjs/.test(h.command);

const say = (m) => console.log(dry ? `[dry-run] ${m}` : m);

function loadSettings() {
  if (!existsSync(SETTINGS)) return {};
  const txt = readFileSync(SETTINGS, "utf8");
  try { return JSON.parse(txt); } catch (e) { console.error(`Cannot parse ${SETTINGS} (${e.message}); not touching it. Fix the JSON first.`); process.exit(1); }
}

function saveSettings(s) {
  if (dry) return;
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (existsSync(SETTINGS)) {
    const bak = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writeFileSync(bak, readFileSync(SETTINGS));
    console.log(`backed up settings -> ${bak}`);
  }
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}

function withoutOurs(settings) {
  const post = settings.hooks?.PostToolUse;
  if (!Array.isArray(post)) return settings;
  const kept = post
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (kept.length) settings.hooks.PostToolUse = kept; else delete settings.hooks.PostToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

if (flag("uninstall")) {
  const s = withoutOurs(loadSettings());
  saveSettings(s);
  say(`removed the ExitPlanMode hook from ${SETTINGS}`);
  if (flag("purge")) { if (!dry) rmSync(TARGET, { recursive: true, force: true }); say(`deleted ${TARGET}`); }
  process.exit(0);
}

// 1. copy the skill
if (resolve(SRC) !== resolve(TARGET)) {
  say(`copy skill -> ${TARGET}`);
  if (!dry) {
    mkdirSync(TARGET, { recursive: true });
    for (const f of ["SKILL.md", "README.md", "LICENSE", "package.json", "package-lock.json"]) if (existsSync(join(SRC, f))) cpSync(join(SRC, f), join(TARGET, f));
    cpSync(join(SRC, "scripts"), join(TARGET, "scripts"), { recursive: true, filter: (p) => basename(p) !== "node_modules" });
  }
}

// 2. dependencies (node-pty has prebuilt binaries, no compiler needed)
if (!flag("no-npm")) {
  say("npm install --omit=dev (node-pty)");
  if (!dry) execSync("npm install --omit=dev --no-audit --no-fund", { cwd: TARGET, stdio: "inherit" });
}

// 3. register the hook
const s = withoutOurs(loadSettings());
s.hooks ??= {};
s.hooks.PostToolUse ??= [];
s.hooks.PostToolUse.push({ matcher: "ExitPlanMode", hooks: [{ type: "command", command: HOOK_CMD, timeout: 30 }] });
saveSettings(s);
say(`registered PostToolUse hook (matcher ExitPlanMode) in ${SETTINGS}`);
say(`command: ${HOOK_CMD}`);
say("Claude Code picks up settings.json edits automatically; no restart needed. Turn it off any time with:");
say(`  node "${join(TARGET, "scripts", "fbq.mjs").replace(/\\/g, "/")}" auto off`);
