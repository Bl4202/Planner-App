// Scheduling. First work out how much to do each day so your total workload
// is as even as possible while everything still gets done before it's due.
// Then fill each day with whole assignments, earliest due first. Anything
// that needs more than an hour is worked on in 30–45 minute sessions, so you
// do one or two things a day instead of a slice of everything.
//
// Dates are plain local "YYYY-MM-DD" strings; due dates are "YYYY-MM-DDTHH:mm".
// All day math is done in UTC so DST changes can't shift a day.

export const WHOLE_MAX = 60; // an assignment needing at most this is done in one sitting (minutes)
export const SESSION_MIN = 30; // bigger ones are worked on in sessions of 30–45 minutes
export const SESSION_MAX = 45;
const MIN_PIECE = 15; // in a crunch, the shortest bit worth squeezing into an earlier day

export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekday(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayOf(due) {
  return String(due).slice(0, 10);
}

function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Days an assignment may be worked on, from today up to its last work day. */
export function workWindow(dueDate, today, settings) {
  const dueDay = dayOf(dueDate);
  if (dueDay < today) return { days: [today], overdue: true };

  let last = addDays(dueDay, -(settings.startBufferDays || 0));
  if (last < today) last = today;
  const all = dayRange(today, last);
  const workDays = settings.workDays?.length ? settings.workDays : [0, 1, 2, 3, 4, 5, 6];
  const preferred = all.filter((d) => workDays.includes(weekday(d)));
  return { days: preferred.length ? preferred : all, overdue: false };
}

/**
 * Split a day's work on one assignment into sessions: one sitting for a whole
 * small assignment (or anything under an hour), otherwise 30–45 minute pieces.
 */
export function sessionsFor(minutes, whole = false) {
  if (minutes < 2 * SESSION_MIN || (whole && minutes <= WHOLE_MAX)) return [minutes];
  const n = Math.ceil(minutes / SESSION_MAX);
  const base = Math.floor(minutes / n / 5) * 5;
  const parts = Array(n).fill(base);
  for (let i = 0, left = minutes - base * n; left > 0; i++, left -= 5) parts[i] += Math.min(5, left);
  return parts;
}

/**
 * How much of an assignment to do today: the amount closest to `want` (what's
 * left of today's share) that fits in `room`. A small assignment is all or
 * nothing. A big one can stop anywhere that splits into whole sessions, both
 * today's part and what's left: 30–45 minutes, or 60+ (two or more sessions).
 * In between is too long for one session and too short for two.
 */
const splits = (x) => (x >= SESSION_MIN && x <= SESSION_MAX) || x >= 2 * SESSION_MIN;
function portion(remaining, want, room, divisible) {
  let best = 0;
  const consider = (x) => {
    if (x > room) return;
    const d = Math.abs(x - want) - Math.abs(best - want);
    if (d < 0 || (d === 0 && x > best)) best = x;
  };
  consider(remaining);
  if (divisible) {
    for (let x = SESSION_MIN; x <= Math.min(remaining - SESSION_MIN, room); x += 5) {
      if (splits(x) && splits(remaining - x)) consider(x);
    }
  }
  return best;
}

/**
 * Build a plan.
 * @param assignments  assignments with {id, dueDate, adjustedMinutes, workedMinutes, completed, plannedMinutes}
 * @param today        "YYYY-MM-DD"
 * @param settings     {dailyCapMinutes, workDays, startBufferDays}
 * @param workedToday  {[assignmentId]: minutes already logged today}
 * @returns {days: [{date, total, items:[{assignmentId, minutes, sessions, finishes, done?}]}], atRisk: [{assignmentId, overflowMinutes}], overdue: [id]}
 */
export function buildPlan(assignments, today, settings, workedToday = {}) {
  const cap = settings.dailyCapMinutes > 0 ? settings.dailyCapMinutes : Infinity;

  // What's left on each assignment as of this morning (so today's plan stays
  // put while you work), and the days it can be worked on.
  const jobs = [];
  const overdue = [];
  for (const a of assignments) {
    const before = (a.workedMinutes || 0) - (workedToday[a.id] || 0); // worked on earlier days
    if (a.completed) {
      // Finished today: it keeps its place in today's plan, so finishing early
      // doesn't pull more work into today.
      const left = Math.round((a.plannedMinutes ?? a.adjustedMinutes ?? 0) - before);
      if (workedToday[a.id] > 0 && left > 0) jobs.push({ a, remaining: left, days: new Set([today]), last: today, done: true });
      continue;
    }
    const remaining = Math.max(0, Math.round((a.adjustedMinutes || 0) - before));
    if (!remaining) continue;
    const win = workWindow(a.dueDate, today, settings);
    if (win.overdue) overdue.push(a.id);
    jobs.push({ a, remaining, days: new Set(win.days), last: win.days.at(-1), divisible: remaining > WHOLE_MAX });
  }
  // Earliest deadline first (finished ones on top); for the same deadline, quick ones first.
  jobs.sort(
    (x, y) =>
      x.last.localeCompare(y.last) ||
      Number(Boolean(y.done)) - Number(Boolean(x.done)) ||
      String(x.a.dueDate).localeCompare(String(y.a.dueDate)) ||
      x.remaining - y.remaining ||
      String(x.a.id).localeCompare(String(y.a.id)),
  );

  const dates = dayRange(today, jobs.reduce((m, j) => (j.last > m ? j.last : m), today));
  // Days the open work can use. Work finished today on a day off still shows,
  // but doesn't change the pace for everything else.
  const usable = dates.map((d) => jobs.some((j) => !j.done && j.days.has(d)));
  const counts = (j) => !j.done || usable[0];

  // 1) The pace for each day. The busiest stretch (most work due per day
  //    available) sets the pace for its days, then the same again for what's
  //    left after it: the most even split that still meets every deadline.
  //    At least one session a day while there's work, so light weeks finish
  //    early instead of trickling.
  const dueBy = dates.map(() => 0);
  for (const j of jobs) if (counts(j)) dueBy[dates.indexOf(j.last)] += j.remaining;
  const pace = dates.map(() => 0);
  for (let s = 0; s < dates.length; ) {
    let end = -1;
    let best = 0;
    for (let e = s, work = 0, days = 0; e < dates.length; e++) {
      work += dueBy[e];
      days += usable[e] ? 1 : 0;
      if (work > 0 && days > 0 && work / days >= best) {
        end = e;
        best = work / days;
      }
    }
    if (end < 0) break;
    for (let t = s; t <= end; t++) if (usable[t]) pace[t] = Math.max(best, SESSION_MIN);
    s = end + 1;
  }

  // 2) Fill the days in order, earliest deadline first, until each has its
  //    share. An assignment's last possible day takes whatever is left of it.
  const plan = dates.map(() => new Map()); // day -> Map(job -> minutes)
  const left = new Map(jobs.map((j) => [j, j.remaining]));
  let target = 0; // even share so far
  let planned = 0;
  dates.forEach((date, t) => {
    target += pace[t];
    let total = 0;
    for (const j of jobs) {
      const r = left.get(j);
      if (!r || !j.days.has(date)) continue;
      const x = date >= j.last ? r : portion(r, target - planned, cap - total, j.divisible);
      if (!x) break;
      plan[t].set(j, x);
      left.set(j, r - x);
      if (counts(j)) planned += x;
      total += x;
    }
  });

  // 3) Work that had to land on a day over your daily max: move what fits into
  //    earlier days that still have room. Whatever is left over is "at risk".
  const totalOn = (t) => [...plan[t].values()].reduce((s, x) => s + x, 0);
  for (let t = 1; t < dates.length; t++) {
    for (const j of [...plan[t].keys()].reverse()) {
      for (let s = t - 1; s >= 0 && !j.done && plan[t].has(j); s--) {
        const over = totalOn(t) - cap;
        if (over <= 0) break;
        const move = Math.min(over, cap - totalOn(s), plan[t].get(j));
        if (!j.days.has(dates[s]) || move <= 0 || (move < MIN_PIECE && !plan[s].has(j))) continue;
        plan[s].set(j, (plan[s].get(j) || 0) + move);
        plan[t].set(j, plan[t].get(j) - move);
        if (!plan[t].get(j)) plan[t].delete(j);
      }
    }
  }

  // Merge into days of {assignmentId, minutes, sessions}, and total up what
  // went over the daily max for each assignment.
  const lastDay = new Map();
  plan.forEach((m, t) => m.forEach((_, j) => lastDay.set(j, t)));
  const overflow = new Map();
  const days = dates.map((date, t) => {
    let total = 0;
    const items = [...plan[t]].map(([j, minutes]) => {
      const over = Math.max(0, Math.min(minutes, total + minutes - cap));
      total += minutes;
      if (over && !j.done) overflow.set(j.a.id, (overflow.get(j.a.id) || 0) + over);
      const item = { assignmentId: j.a.id, minutes, sessions: sessionsFor(minutes, !j.divisible), finishes: lastDay.get(j) === t };
      if (j.done) item.done = true;
      return item;
    });
    return { date, total, items };
  });
  while (days.length > 1 && !days.at(-1).items.length) days.pop();

  const atRisk = [...overflow].map(([assignmentId, overflowMinutes]) => ({ assignmentId, overflowMinutes }));
  return { days, atRisk, overdue };
}
