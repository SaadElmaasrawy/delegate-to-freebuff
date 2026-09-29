import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rm, tmp } from "./helpers.mjs";
import {
  addBrief, briefsDir, claimNext, dur, ensureBriefs, planTitle, planToBrief, queueOrder, slugify, stripAnsi, tasks, writeBlockedReport,
} from "../scripts/lib.mjs";

test("slugify and planTitle", () => {
  assert.equal(slugify("Add Greeting Module!"), "add-greeting-module");
  assert.equal(slugify("   "), "plan");
  assert.equal(slugify("x".repeat(80)).length, 40);
  assert.equal(planTitle("# Plan: Add hello.txt to repo\n\nbody"), "Add hello.txt to repo");
  assert.equal(planTitle("no heading here\nsecond"), "no heading here");
  assert.equal(planTitle(""), "plan");
});

test("planToBrief keeps the plan verbatim and forbids committing", () => {
  const plan = "# Plan: Do a thing\n\n1. Step one\n2. Commit it\n";
  const brief = planToBrief(plan);
  assert.match(brief, /^# Task: Do a thing/);
  assert.match(brief, /Never run `git commit`/);
  assert.ok(brief.includes("1. Step one\n2. Commit it"));
});

test("addBrief numbers tasks, appends the done-report section, rejects bad slugs", async () => {
  const repo = tmp();
  try {
    const a = await addBrief(repo, { slug: "first", body: "# A\n" });
    const b = await addBrief(repo, { slug: "second", body: "# B\n" });
    assert.deepEqual([a.id, a.position, b.id, b.position], ["01-first", 1, "02-second", 2]);
    const text = readFileSync(join(briefsDir(repo), "01-first.md"), "utf8");
    assert.match(text, /## Done report \(required\)/);
    assert.match(text, /\.briefs\/01-first\.done\.md/);
    await assert.rejects(addBrief(repo, { slug: "Bad Slug", body: "x" }), /kebab-case/);
    await assert.rejects(addBrief(repo, { slug: "", body: "x" }), /kebab-case/);
  } finally { rm(repo); }
});

test("front briefs jump the queue; claimNext is ordered and atomic", async () => {
  const repo = tmp();
  try {
    await addBrief(repo, { slug: "one", body: "1" });
    await addBrief(repo, { slug: "two", body: "2" });
    await addBrief(repo, { slug: "fix", body: "f", front: true });
    assert.deepEqual(queueOrder(tasks(briefsDir(repo))).map((t) => t.id), ["03-fix", "01-one", "02-two"]);

    const claims = await Promise.all([claimNext(repo, "t"), claimNext(repo, "t"), claimNext(repo, "t"), claimNext(repo, "t")]);
    const ids = claims.filter(Boolean).map((t) => t.id).sort();
    assert.deepEqual(ids, ["01-one", "02-two", "03-fix"], "each task claimed exactly once");
    assert.equal(claims.filter((c) => c === null).length, 1);
    assert.deepEqual(tasks(briefsDir(repo)).map((t) => t.state), ["working", "working", "working"]);
  } finally { rm(repo); }
});

test("task state follows the marker files; blocked reports are parsed", async () => {
  const repo = tmp();
  try {
    await addBrief(repo, { slug: "x", body: "x" });
    const dir = briefsDir(repo);
    const state = () => tasks(dir)[0];
    assert.equal(state().state, "queued");
    await claimNext(repo, "t");
    assert.equal(state().state, "working");
    writeBlockedReport(dir, "01-x", "boom", "some output");
    assert.equal(state().state, "done");
    assert.equal(state().doneStatus, "blocked");
    assert.match(readFileSync(join(dir, "01-x.done.md"), "utf8"), /reason: boom[\s\S]*some output/);
    // never overwrites a real report
    writeFileSync(join(dir, "01-x.done.md"), "status: done\n");
    writeBlockedReport(dir, "01-x", "late", "");
    assert.equal(state().doneStatus, "done");
    writeFileSync(join(dir, "01-x.reviewed"), "");
    assert.equal(state().state, "reviewed");
  } finally { rm(repo); }
});

test("ensureBriefs excludes .briefs/ from git exactly once, without touching .gitignore", () => {
  const repo = tmp();
  try {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), "# comment");
    ensureBriefs(repo);
    ensureBriefs(repo);
    const ex = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.equal(ex.split("\n").filter((l) => l.trim() === ".briefs/").length, 1);
    assert.ok(ex.startsWith("# comment\n"));
    assert.equal(existsSync(join(repo, ".gitignore")), false);
  } finally { rm(repo); }
});

test("stripAnsi and dur", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x1b[2J\r\n\n\n\nend"), "red ok\n\nend");
  assert.equal(dur(3000), "3 s");
  assert.equal(dur(600_000), "10 min");
});
