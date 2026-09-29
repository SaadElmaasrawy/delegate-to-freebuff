import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS, rm, run, tmp } from "./helpers.mjs";

const INSTALL = join(SCRIPTS, "install.mjs");
const OTHER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] };
const SETTINGS = { permissions: { allow: ["Bash(ls)"] }, hooks: { PostToolUse: [OTHER_HOOK], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } };

const setup = () => {
  const dir = tmp();
  const skills = join(dir, "skills");
  const settings = join(dir, "settings.json");
  mkdirSync(skills);
  writeFileSync(settings, JSON.stringify(SETTINGS, null, 2));
  const args = (...more) => ["--skills-dir", skills, "--settings", settings, "--no-npm", ...more];
  const read = () => JSON.parse(readFileSync(settings, "utf8"));
  const ours = (s) => (s.hooks?.PostToolUse ?? []).filter((g) => g.hooks.some((h) => /on-plan-approved\.mjs/.test(h.command)));
  return { dir, skills, settings, args, read, ours };
};

test("install copies the skill, registers the hook, keeps everything else, and backs up", async () => {
  const t = setup();
  try {
    const r = await run(INSTALL, t.args());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const target = join(t.skills, "delegate-to-freebuff");
    for (const f of ["SKILL.md", "LICENSE", "package.json", "scripts/fbq.mjs", "scripts/fbhost.mjs", "scripts/lib.mjs", "scripts/on-plan-approved.mjs"]) {
      assert.ok(existsSync(join(target, f)), `${f} copied`);
    }
    const s = t.read();
    assert.equal(t.ours(s).length, 1);
    assert.equal(t.ours(s)[0].matcher, "ExitPlanMode");
    assert.deepEqual(s.permissions, SETTINGS.permissions);
    assert.deepEqual(s.hooks.Stop, SETTINGS.hooks.Stop);
    assert.ok(s.hooks.PostToolUse.some((g) => g.matcher === "Bash"), "unrelated PostToolUse hook kept");
    assert.ok(readdirSync(t.dir).some((f) => f.startsWith("settings.json.bak-")), "backup written");
  } finally { rm(t.dir); }
});

test("install is idempotent", async () => {
  const t = setup();
  try {
    await run(INSTALL, t.args());
    await run(INSTALL, t.args());
    assert.equal(t.ours(t.read()).length, 1);
  } finally { rm(t.dir); }
});

test("--dry-run changes nothing", async () => {
  const t = setup();
  try {
    const before = readFileSync(t.settings, "utf8");
    const r = await run(INSTALL, t.args("--dry-run"));
    assert.equal(r.code, 0);
    assert.equal(readFileSync(t.settings, "utf8"), before);
    assert.equal(existsSync(join(t.skills, "delegate-to-freebuff")), false);
    assert.deepEqual(readdirSync(t.dir).sort(), ["settings.json", "skills"]);
  } finally { rm(t.dir); }
});

test("--uninstall removes only our hook; --purge also deletes the skill folder", async () => {
  const t = setup();
  try {
    await run(INSTALL, t.args());
    await run(INSTALL, t.args("--uninstall"));
    const s = t.read();
    assert.equal(t.ours(s).length, 0);
    assert.deepEqual(s, SETTINGS, "settings restored to the original content");
    assert.ok(existsSync(join(t.skills, "delegate-to-freebuff")), "skill kept without --purge");
    await run(INSTALL, t.args("--uninstall", "--purge"));
    assert.equal(existsSync(join(t.skills, "delegate-to-freebuff")), false);
  } finally { rm(t.dir); }
});

test("refuses to touch a settings.json it cannot parse", async () => {
  const t = setup();
  try {
    writeFileSync(t.settings, "{ not json");
    const r = await run(INSTALL, t.args());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Cannot parse/);
    assert.equal(readFileSync(t.settings, "utf8"), "{ not json");
  } finally { rm(t.dir); }
});
