import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, addDays, workWindow, sessionsFor, SESSION_MIN, SESSION_MAX } from "../server/scheduler.js";

const TODAY = "2026-10-05"; // a Monday
const ALL_DAYS = { dailyCapMinutes: 240, workDays: [0, 1, 2, 3, 4, 5, 6], startBufferDays: 0 };
const A = (id, due, minutes, worked = 0) => ({ id, dueDate: due, adjustedMinutes: minutes, workedMinutes: worked, completed: false });
const items = (plan, id) => plan.days.flatMap((d) => d.items.filter((i) => i.assignmentId === id).map((i) => ({ ...i, date: d.date })));
const minutesFor = (plan, id) => items(plan, id).reduce((s, i) => s + i.minutes, 0);
const onDay = (plan, date, id) => plan.days.find((d) => d.date === date)?.items.find((i) => i.assignmentId === id)?.minutes || 0;
const totals = (plan) => plan.days.map((d) => d.total);
const day = (n) => addDays(TODAY, n);

test("addDays crosses month boundaries", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("sessions: whole up to an hour, otherwise 30–45 minute pieces", () => {
  assert.deepEqual(sessionsFor(45, true), [45]);
  assert.deepEqual(sessionsFor(60, true), [60]);
  assert.deepEqual(sessionsFor(60), [30, 30]);
  assert.deepEqual(sessionsFor(90), [45, 45]);
  for (const m of [61, 100, 137, 300, 1000]) {
    const parts = sessionsFor(m);
    assert.equal(parts.reduce((s, x) => s + x, 0), m);
    assert.ok(parts.every((x) => x >= SESSION_MIN && x <= SESSION_MAX), `${m} -> ${parts}`);
  }
});

test("a small assignment is done whole, in one sitting", () => {
  const plan = buildPlan([A("a", "2026-10-09T23:59", 45)], TODAY, ALL_DAYS);
  const got = items(plan, "a");
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].sessions, [45]);
  assert.equal(got[0].finishes, true);
});

test("light weeks get it done early instead of trickling", () => {
  const plan = buildPlan([A("a", "2026-10-15T23:59", 30)], TODAY, ALL_DAYS);
  assert.equal(onDay(plan, TODAY, "a"), 30);
});

test("it evens out the total per day, not each assignment", () => {
  // Four one-hour assignments due Thursday: one whole assignment a day,
  // instead of 15 minutes of each every day.
  const list = ["a", "b", "c", "d"].map((id) => A(id, "2026-10-08T23:59", 60));
  const plan = buildPlan(list, TODAY, ALL_DAYS);
  assert.deepEqual(totals(plan), [60, 60, 60, 60]);
  for (const d of plan.days) assert.equal(d.items.length, 1);
});

test("a big assignment is worked on in 30–45 minute sessions at an even pace", () => {
  const plan = buildPlan([A("a", "2026-10-08T23:59", 240)], TODAY, ALL_DAYS);
  assert.deepEqual(totals(plan), [60, 60, 60, 60]);
  for (const i of items(plan, "a")) assert.ok(i.sessions.every((x) => x >= SESSION_MIN && x <= SESSION_MAX), String(i.sessions));
});

test("one assignment at a time, earliest due first", () => {
  const plan = buildPlan([A("b", "2026-10-09T23:59", 90), A("a", "2026-10-07T23:59", 90)], TODAY, ALL_DAYS);
  const lastA = items(plan, "a").at(-1).date;
  const firstB = items(plan, "b")[0].date;
  assert.ok(lastA <= firstB, `a ends ${lastA}, b starts ${firstB}`);
  assert.equal(minutesFor(plan, "a"), 90);
  assert.equal(minutesFor(plan, "b"), 90);
});

test("something due soon makes the first days busier, then it evens out", () => {
  const plan = buildPlan([A("a", "2026-10-06T23:59", 120), A("b", "2026-10-14T23:59", 270)], TODAY, ALL_DAYS);
  assert.deepEqual([onDay(plan, day(0), "a"), onDay(plan, day(1), "a")], [60, 60]);
  const later = plan.days.slice(2);
  assert.equal(later.length, 8);
  for (const d of later) assert.ok(d.total >= 30 && d.total <= 45, `${d.date} has ${d.total}`);
});

test("buffer days finish the work early", () => {
  const plan = buildPlan([A("a", "2026-10-08T23:59", 120)], TODAY, { ...ALL_DAYS, startBufferDays: 1 });
  assert.equal(onDay(plan, "2026-10-08", "a"), 0);
  assert.equal(minutesFor(plan, "a"), 120);
});

test("due today or tomorrow with a buffer still schedules today", () => {
  const plan = buildPlan([A("a", "2026-10-05T23:59", 90), A("b", "2026-10-06T09:00", 60)], TODAY, { ...ALL_DAYS, startBufferDays: 1 });
  assert.equal(onDay(plan, TODAY, "a"), 90);
  assert.equal(onDay(plan, TODAY, "b"), 60);
});

test("respects the daily max", () => {
  const cap = { ...ALL_DAYS, dailyCapMinutes: 120 };
  // "a" (due tomorrow) fills today and tomorrow; "b" goes after.
  const plan = buildPlan([A("a", "2026-10-06T23:59", 240), A("b", "2026-10-09T23:59", 200)], TODAY, cap);
  for (const d of plan.days) assert.ok(d.total <= 120, `${d.date} has ${d.total}`);
  assert.equal(minutesFor(plan, "a"), 240);
  assert.equal(minutesFor(plan, "b"), 200);
  assert.equal(plan.atRisk.length, 0);
});

test("session sizes don't cause a false 'at risk' when the work just fits", () => {
  const plan = buildPlan([A("a", "2026-10-06T23:59", 100), A("b", "2026-10-06T23:59", 140)], TODAY, { ...ALL_DAYS, dailyCapMinutes: 120 });
  assert.deepEqual(totals(plan), [120, 120]);
  assert.equal(plan.atRisk.length, 0);
});

test("flags assignments that cannot fit", () => {
  const plan = buildPlan([A("a", "2026-10-06T23:59", 500)], TODAY, { ...ALL_DAYS, dailyCapMinutes: 120 });
  assert.deepEqual(plan.atRisk, [{ assignmentId: "a", overflowMinutes: 260 }]);
  assert.equal(minutesFor(plan, "a"), 500); // still fully scheduled, over the cap
});

test("overdue work lands on today", () => {
  const plan = buildPlan([A("a", "2026-10-01T23:59", 60)], TODAY, ALL_DAYS);
  assert.deepEqual(plan.overdue, ["a"]);
  assert.equal(onDay(plan, TODAY, "a"), 60);
});

test("only schedules on chosen study days", () => {
  // Mon..Sun window, only Tue/Thu allowed.
  const settings = { ...ALL_DAYS, workDays: [2, 4] };
  assert.deepEqual(workWindow("2026-10-11T23:59", TODAY, settings).days, ["2026-10-06", "2026-10-08"]);
  const plan = buildPlan([A("a", "2026-10-11T23:59", 150)], TODAY, settings);
  for (const i of items(plan, "a")) assert.ok(["2026-10-06", "2026-10-08"].includes(i.date), i.date);
  assert.equal(minutesFor(plan, "a"), 150);
});

test("time already worked reduces the remaining plan, but today's target stays stable", () => {
  const before = buildPlan([A("a", "2026-10-08T23:59", 240, 60)], TODAY, ALL_DAYS);
  assert.equal(minutesFor(before, "a"), 180); // 60 worked on earlier days

  // 30 of the 90 worked minutes happened today: plan as of this morning.
  const during = buildPlan([A("a", "2026-10-08T23:59", 240, 90)], TODAY, ALL_DAYS, { a: 30 });
  assert.equal(minutesFor(during, "a"), 180);
});

test("finishing early doesn't pull more work into today", () => {
  const list = [A("a", "2026-10-05T23:59", 60), A("b", "2026-10-07T23:59", 100)];
  const morning = buildPlan(list, TODAY, ALL_DAYS);
  assert.deepEqual(morning.days[0].items.map((i) => i.assignmentId), ["a"]);

  // "a" took 20 minutes instead of 60.
  const doneA = { ...list[0], completed: true, plannedMinutes: 60, workedMinutes: 20 };
  const after = buildPlan([doneA, list[1]], TODAY, ALL_DAYS, { a: 20 });
  assert.deepEqual(after.days[0].items.map((i) => [i.assignmentId, Boolean(i.done)]), [["a", true]]);
  assert.deepEqual(after.days.slice(1), morning.days.slice(1));
});

test("completed and finished assignments are skipped", () => {
  const plan = buildPlan([{ ...A("a", "2026-10-08T23:59", 60), completed: true }, A("b", "2026-10-08T23:59", 60, 60)], TODAY, ALL_DAYS);
  assert.equal(plan.days.flatMap((d) => d.items).length, 0);
});
