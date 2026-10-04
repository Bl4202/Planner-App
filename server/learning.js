// Personalization: learn how long things take *you* compared to the estimates.
//
// Every estimated assignment can teach one ratio against its raw estimate
// (estimateMinutes):
//   - once it's finished: actualMinutes / estimateMinutes (the real thing)
//   - before that, if you typed your own time over the estimate:
//     manualMinutes / estimateMinutes (your correction)
// Finishing an assignment replaces its correction with the real time.
//
// We average those ratios per assignment type (plus a global one, and a
// per-course factor on top) and multiply future estimates by the result. So
// the first few times you fix the time by hand; after that the estimates
// arrive already fixed.

export const ALPHA = 0.3; // weight of the newest sample once there's some history
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 4;
export const MIN_SAMPLES = 2; // samples needed before a multiplier kicks in
export const COURSE_SHRINK = 2; // pseudo-samples pulling the course factor toward 1

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round5 = (x) => Math.max(5, Math.round(x / 5) * 5);

/**
 * What each assignment can teach us, oldest first. Times you set yourself
 * ("custom") have no estimate to compare against, so they don't count.
 */
function samples(assignments) {
  const out = [];
  for (const a of assignments) {
    if (a.source === "custom" || !(a.estimateMinutes > 0)) continue;
    if (a.completed && a.actualMinutes > 0) {
      out.push({ a, kind: "finished", ratio: a.actualMinutes / a.estimateMinutes, at: a.completedAt });
    } else if (!a.completed && a.manualMinutes > 0) {
      out.push({ a, kind: "corrected", ratio: a.manualMinutes / a.estimateMinutes, at: a.correctedAt || a.createdAt });
    }
  }
  return out.sort((x, y) => String(x.at).localeCompare(String(y.at)));
}

/**
 * Plain average of the first few ratios, then exponentially weighted so recent
 * work counts more. Each ratio is clamped so one bad entry (a forgotten timer)
 * can't swing everything.
 */
function average(ratios) {
  let m = 1;
  ratios.forEach((r, i) => {
    m += Math.max(ALPHA, 1 / (i + 1)) * (clamp(r, MIN_RATIO, MAX_RATIO) - m);
  });
  return clamp(m, MIN_RATIO, MAX_RATIO);
}

const counts = (list) => ({
  samples: list.length,
  finished: list.filter((s) => s.kind === "finished").length,
  corrected: list.filter((s) => s.kind === "corrected").length,
});

function groupBy(list, key) {
  const groups = {};
  for (const x of list) (groups[key(x)] ||= []).push(x);
  return Object.entries(groups);
}

/**
 * Returns { global, byType: {[type]: ...}, byCourse: {[courseId]: ...}, history }.
 * Each entry is {multiplier, samples, finished, corrected}; history lists what
 * was learned from, oldest first. Multipliers start at 1 (trust the estimate)
 * and drift as data comes in.
 */
export function computeMultipliers(assignments) {
  const all = samples(assignments);
  const summary = (list) => ({ multiplier: average(list.map((s) => s.ratio)), ...counts(list) });

  const byType = {};
  for (const [type, list] of groupBy(all, (s) => s.a.type || "other")) byType[type] = summary(list);
  const m = { global: summary(all), byType, byCourse: {} };

  // Per-course factor: what's left over after the type adjustment
  // ("Organic Chem always takes me longer"). Shrunk toward 1 when there are
  // few samples, so one bad week doesn't swing the whole course.
  for (const [courseId, list] of groupBy(all.filter((s) => s.a.courseId), (s) => s.a.courseId)) {
    const residual = average(list.map((s) => s.ratio / typeMultiplier(s.a.type, m)));
    const shrink = list.length / (list.length + COURSE_SHRINK);
    m.byCourse[courseId] = { multiplier: 1 + (residual - 1) * shrink, ...counts(list) };
  }

  m.history = all.map((s) => ({ assignmentId: s.a.id, kind: s.kind, ratio: s.ratio }));
  return m;
}

function typeMultiplier(type, multipliers) {
  const t = multipliers.byType[type || "other"];
  if (t && t.samples >= MIN_SAMPLES) return t.multiplier;
  const g = multipliers.global;
  if (g.samples >= MIN_SAMPLES) return 1 + (g.multiplier - 1) * 0.5;
  return 1;
}

/**
 * Multiplier to apply to an assignment of the given type (and course).
 * Uses the type's own history once it has enough samples, otherwise a
 * softened global multiplier (half-way between 1 and the global value).
 * A course factor stacks on top once that course has enough samples.
 */
export function multiplierFor(type, multipliers, courseId) {
  let m = typeMultiplier(type, multipliers);
  const c = courseId && multipliers.byCourse?.[courseId];
  if (c && c.samples >= MIN_SAMPLES) m *= c.multiplier;
  return clamp(m, MIN_RATIO, MAX_RATIO);
}

/** An estimate adjusted to your pace, rounded to 5 minutes. */
export function personalize(minutes, type, multipliers, courseId) {
  return round5(minutes * multiplierFor(type, multipliers, courseId));
}

/**
 * Sets the time the plan uses (adjustedMinutes) on every open assignment:
 * your own time if you typed one, otherwise the estimate adjusted to your
 * pace (also kept as suggestedMinutes). Mutates them; returns the multipliers.
 */
export function applyMultipliers(assignments) {
  const m = computeMultipliers(assignments);
  for (const a of assignments) {
    if (a.completed) continue;
    if (a.source === "custom") {
      // You set this time yourself; don't second-guess it.
      a.adjustedMinutes = a.estimateMinutes;
    } else {
      a.suggestedMinutes = personalize(a.estimateMinutes, a.type, m, a.courseId);
      a.adjustedMinutes = a.manualMinutes || a.suggestedMinutes;
    }
  }
  return m;
}
