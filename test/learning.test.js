import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMultipliers, multiplierFor, applyMultipliers, MIN_RATIO, MAX_RATIO } from "../server/learning.js";

let n = 0;
const nextTime = () => new Date(Date.UTC(2026, 9, 1) + ++n * 60000).toISOString();
const done = (type, est, actual) => ({
  type,
  estimateMinutes: est,
  actualMinutes: actual,
  completed: true,
  completedAt: nextTime(),
  source: "ai",
});
// Not finished yet, but you typed your own time over the estimate.
const corrected = (type, est, own) => ({
  type,
  estimateMinutes: est,
  manualMinutes: own,
  completed: false,
  correctedAt: nextTime(),
  source: "auto",
});

test("no history means no adjustment", () => {
  const m = computeMultipliers([]);
  assert.equal(multiplierFor("writing", m), 1);
});

test("needs two samples before a type multiplier applies", () => {
  const one = computeMultipliers([done("writing", 100, 50)]);
  assert.equal(multiplierFor("writing", one), 1);

  const two = computeMultipliers([done("writing", 100, 50), done("writing", 100, 50)]);
  assert.ok(multiplierFor("writing", two) < 1);
});

test("finishing early lowers and finishing late raises", () => {
  const fast = computeMultipliers([done("reading", 60, 30), done("reading", 60, 30), done("reading", 60, 30)]);
  const slow = computeMultipliers([done("coding", 60, 120), done("coding", 60, 120), done("coding", 60, 120)]);
  assert.ok(fast.byType.reading.multiplier < 1);
  assert.ok(slow.byType.coding.multiplier > 1);
});

test("multipliers are clamped", () => {
  const slow = Array.from({ length: 30 }, () => done("lab", 60, 6000));
  assert.equal(computeMultipliers(slow).byType.lab.multiplier, MAX_RATIO);
  const fast = Array.from({ length: 30 }, () => done("lab", 600, 1));
  assert.equal(computeMultipliers(fast).byType.lab.multiplier, MIN_RATIO);
});

test("falls back to a softened global multiplier for unseen types", () => {
  const m = computeMultipliers([done("writing", 100, 50), done("reading", 100, 50), done("writing", 100, 50)]);
  const g = m.global.multiplier;
  assert.ok(Math.abs(multiplierFor("project", m) - (1 + (g - 1) * 0.5)) < 1e-9);
});

test("course factor needs 2 samples, is shrunk, and stacks with the type", () => {
  const inCourse = (courseId, type, est, actual) => ({ ...done(type, est, actual), courseId });
  // Writing is on-estimate overall, but ORGO takes 1.6x.
  const base = [done("writing", 100, 100), done("writing", 100, 100), done("writing", 100, 100)];
  const one = computeMultipliers([...base, inCourse("orgo", "writing", 100, 160)]);
  assert.equal(multiplierFor("writing", one, "orgo"), multiplierFor("writing", one)); // 1 sample: ignored

  const two = computeMultipliers([...base, inCourse("orgo", "writing", 100, 160), inCourse("orgo", "writing", 100, 160)]);
  const withCourse = multiplierFor("writing", two, "orgo");
  assert.ok(withCourse > multiplierFor("writing", two), "course factor raises the estimate");
  assert.ok(two.byCourse.orgo.multiplier < 1.6, "shrunk toward 1");
  assert.ok(withCourse <= MAX_RATIO);
});

test("typing your own time teaches the estimator before the work is done", () => {
  const fixed = [corrected("writing", 200, 100), corrected("writing", 300, 150)];
  const fresh = { type: "writing", estimateMinutes: 240, completed: false, source: "auto" };
  applyMultipliers([...fixed, fresh]);
  assert.equal(fresh.adjustedMinutes, 120);
  assert.equal(fixed[0].adjustedMinutes, 100, "your own time is used as-is");
  assert.equal(fixed[0].suggestedMinutes, 100, "and the suggestion has caught up with it");
});

test("finishing an assignment replaces your correction with the real time", () => {
  const list = [corrected("reading", 100, 50), corrected("reading", 100, 50)];
  assert.equal(computeMultipliers(list).byType.reading.multiplier, 0.5);
  for (const a of list) Object.assign(a, { completed: true, actualMinutes: 100, completedAt: nextTime() });
  const r = computeMultipliers(list).byType.reading;
  assert.deepEqual([r.multiplier, r.finished, r.corrected], [1, 2, 0]);
});

test("times you set yourself (custom) don't teach the estimator", () => {
  const custom = () => ({ ...done("writing", 60, 120), source: "custom" });
  const m = computeMultipliers([custom(), custom()]);
  assert.equal(m.global.samples, 0);
  assert.equal(multiplierFor("writing", m), 1);
});

test("recent samples count more than old ones", () => {
  const m = computeMultipliers([
    ...Array.from({ length: 3 }, () => done("coding", 100, 200)),
    ...Array.from({ length: 4 }, () => corrected("coding", 100, 100)),
  ]);
  const plainMean = (3 * 2 + 4 * 1) / 7;
  assert.ok(m.byType.coding.multiplier < plainMean, `got ${m.byType.coding.multiplier}`);
});

test("after a couple of corrections, the estimate is what you'd have typed", () => {
  // You think writing takes 60% of the built-in estimate, and you fix any
  // estimate that's more than 10% off from that.
  const list = [];
  let fixes = 0;
  for (let i = 0; i < 10; i++) {
    const a = { type: "writing", estimateMinutes: 150 + i * 30, completed: false, source: "auto", createdAt: nextTime() };
    list.push(a);
    applyMultipliers(list);
    const wanted = a.estimateMinutes * 0.6;
    if (Math.abs(a.adjustedMinutes - wanted) > wanted * 0.1) {
      a.manualMinutes = Math.round(wanted / 5) * 5;
      a.correctedAt = nextTime();
      fixes++;
    }
  }
  assert.equal(fixes, 2);
});

test("convergence: a user who is 0.7x the estimates is learned within ~10%", () => {
  const history = [];
  const open = { type: "reading", estimateMinutes: 100, completed: false, source: "auto", courseId: "c1" };
  for (let i = 0; i < 6; i++) history.push({ ...done("reading", 100, 70), courseId: "c1" });
  applyMultipliers([...history, open]);
  assert.ok(Math.abs(open.adjustedMinutes - 70) <= 7, `adjusted to ${open.adjustedMinutes}`);
});

test("applyMultipliers adjusts open AI assignments but not custom ones", () => {
  const list = [
    done("writing", 100, 50),
    done("writing", 100, 50),
    { type: "writing", estimateMinutes: 120, completed: false, source: "ai" },
    { type: "writing", estimateMinutes: 120, completed: false, source: "custom" },
  ];
  applyMultipliers(list);
  assert.ok(list[2].adjustedMinutes < 120);
  assert.equal(list[2].adjustedMinutes % 5, 0);
  assert.equal(list[3].adjustedMinutes, 120);
});
