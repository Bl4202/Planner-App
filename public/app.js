// Study Planner frontend. Plain JS, no build step.

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let S = null; // latest state from the server

// ---------- dates & formatting ----------
const pad = (n) => String(n).padStart(2, "0");
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(day, n) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return localDay(d);
}
function fmtMin(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
function fmtTime(due) {
  const [, t = "23:59"] = String(due).split("T");
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}
function dueLabel(due) {
  const day = due.slice(0, 10);
  const today = S.today;
  const time = fmtTime(due);
  if (day < today) return { text: `Overdue · ${parseDay(day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, cls: "bad" };
  if (day === today) return { text: `Due today ${time}`, cls: "bad" };
  if (day === addDays(today, 1)) return { text: `Due tomorrow ${time}`, cls: "warn" };
  const d = parseDay(day);
  const within = d - parseDay(today) < 7 * 864e5;
  const label = within
    ? d.toLocaleDateString(undefined, { weekday: "short" })
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return { text: `Due ${label} ${time}`, cls: "" };
}
const course = (id) => S.courses.find((c) => c.id === id);
const assignment = (id) => S.assignments.find((a) => a.id === id);

// ---------- outline nodes ----------
// Collapsed/expanded state of parent bullets, remembered per browser.
const OPEN_KEY = "planner.open";
let openState = {};
try {
  openState = JSON.parse(localStorage.getItem(OPEN_KEY)) || {};
} catch {}
function setOpen(key, open) {
  openState[key] = open;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(openState));
  } catch {}
}

/** One bullet. Pass `children` (HTML) to make it a collapsible parent. */
function node({ key = "", name, note = "", children = "", open = true, cls = "", actions = "", bullet = "" }) {
  const parent = Boolean(children);
  const collapsed = parent && !(openState[key] ?? open);
  const dot =
    bullet ||
    (parent ? `<button class="bullet" data-toggle="${esc(key)}" aria-label="Expand or collapse"></button>` : `<span class="bullet"></span>`);
  return `<div class="node ${cls} ${collapsed ? "collapsed" : ""}">
    <div class="row">
      ${parent ? `<button class="toggle" data-toggle="${esc(key)}" tabindex="-1" aria-hidden="true"></button>` : ""}
      ${dot}
      <div class="content"><div class="name">${name}</div>${note ? `<div class="note">${note}</div>` : ""}</div>
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </div>
    ${parent ? `<div class="children">${children}</div>` : ""}
  </div>`;
}
const dotJoin = (parts) => parts.filter(Boolean).join(`<span class="sep">·</span>`);
const op = (label, attr, cls = "") => `<button class="op ${cls}" ${attr}>${label}</button>`;
function courseLabel(id) {
  const c = course(id);
  return c ? `<span class="course" style="--c:${esc(c.color)}">${esc(c.name)}</span>` : "";
}
function dueChip(due) {
  const d = dueLabel(due);
  return `<span class="date ${d.cls}">${d.text}</span>`;
}

function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------- API ----------
async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}today=${localDay()}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function act(method, path, body) {
  try {
    S = await api(method, path, body);
    render();
    return true;
  } catch (e) {
    toast(e.message, 5000);
    return false;
  }
}

// ---------- timer (survives refresh via localStorage) ----------
const TIMER_KEY = "planner.timer";
const timer = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(TIMER_KEY)) || null;
    } catch {
      return null;
    }
  },
  set(t) {
    try {
      t ? localStorage.setItem(TIMER_KEY, JSON.stringify(t)) : localStorage.removeItem(TIMER_KEY);
    } catch {}
  },
  elapsed(t = timer.get()) {
    if (!t) return 0;
    return t.accumulatedMs + (t.startedAt ? Date.now() - t.startedAt : 0);
  },
};

async function stopTimer({ log = true } = {}) {
  const t = timer.get();
  if (!t) return;
  const minutes = Math.round(timer.elapsed(t) / 60000);
  timer.set(null);
  document.title = "Study Planner";
  if (log && minutes >= 1 && assignment(t.assignmentId)) {
    await act("POST", `/api/assignments/${t.assignmentId}/sessions`, { minutes, date: localDay() });
    toast(`Logged ${fmtMin(minutes)} on ${assignment(t.assignmentId)?.title}`);
  } else {
    render();
  }
}

async function startTimer(id) {
  const cur = timer.get();
  if (cur?.assignmentId === id) return;
  if (cur) await stopTimer();
  timer.set({ assignmentId: id, startedAt: Date.now(), accumulatedMs: 0, goalNotified: false });
  render();
}

function togglePause() {
  const t = timer.get();
  if (!t) return;
  if (t.startedAt) {
    t.accumulatedMs += Date.now() - t.startedAt;
    t.startedAt = null;
  } else {
    t.startedAt = Date.now();
  }
  timer.set(t);
  renderTimer();
}

/** Today's target for an assignment (0 if not scheduled today). */
function todayTarget(id) {
  const day = S.plan.days[0];
  if (!day || day.date !== S.today) return 0;
  return day.items.find((i) => i.assignmentId === id)?.minutes || 0;
}
/** Minutes done today, including the running timer. */
function doneToday(id) {
  const t = timer.get();
  const live = t?.assignmentId === id ? timer.elapsed(t) / 60000 : 0;
  return (S.workedToday[id] || 0) + live;
}

function renderTimer() {
  const t = timer.get();
  const panel = $("#timer-panel");
  const a = t && assignment(t.assignmentId);
  if (!a) {
    if (t) timer.set(null);
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  panel.classList.toggle("paused", !t.startedAt);
  const ms = timer.elapsed(t);
  $("#timer-title").textContent = a.title;
  $("#timer-clock").textContent = fmtClock(ms);
  $("#timer-pause").textContent = t.startedAt ? "Pause" : "Resume";
  const target = todayTarget(a.id);
  const done = doneToday(a.id);
  $("#timer-goal").textContent = target
    ? done >= target
      ? `Today's goal met (${fmtMin(target)}). Keep going or stop here.`
      : `${fmtMin(target - done)} left of today's ${fmtMin(target)} goal`
    : `Working ahead. ${fmtMin(Math.max(0, a.adjustedMinutes - a.workedMinutes - ms / 60000))} left on this assignment`;
  document.title = `${t.startedAt ? "▶" : "⏸"} ${fmtClock(ms)} · ${a.title}`;

  if (target && done >= target && !t.goalNotified) {
    t.goalNotified = true;
    timer.set(t);
    toast(`Today's goal for "${a.title}" is done.`, 6000);
    try {
      if (Notification.permission === "granted") new Notification("Goal reached", { body: a.title });
    } catch {}
  }
}

// ---------- views ----------
function showView(name, replace = false) {
  if (!document.getElementById(`view-${name}`)) name = "today";
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
    if (b.dataset.view === name) $("#crumb").textContent = b.textContent;
  });
  document.body.classList.remove("nav-open");
  if (location.hash.slice(1) !== name) history[replace ? "replaceState" : "pushState"](null, "", `#${name}`);
  try {
    localStorage.setItem("planner.view", name);
  } catch {}
}
window.addEventListener("popstate", () => showView(location.hash.slice(1) || "today", true));

function render() {
  if (!S) return;
  renderBanner();
  renderToday();
  renderAssignments();
  renderCourses();
  renderInsights();
  renderSettings();
  renderTimer();
}

function renderBanner() {
  const parts = [];
  for (const r of S.plan.atRisk) {
    const a = assignment(r.assignmentId);
    if (!a || S.plan.overdue.includes(a.id)) continue;
    parts.push(
      `<div class="callout"><b>"${esc(a.title)}" doesn't fit before it's due</b> at your daily max. ` +
        `It needs about ${fmtMin(r.overflowMinutes)} more than you have room for. Start it now or raise your daily max in Settings.</div>`,
    );
  }
  for (const id of S.plan.overdue) {
    const a = assignment(id);
    if (a) parts.push(`<div class="callout bad"><b>"${esc(a.title)}" is past due.</b> It's on today's list. Complete or delete it once it's handled.</div>`);
  }
  $("#banner").innerHTML = parts.join("");
}

const sessionList = (item) => item.sessions.map(fmtMin).join(" + ");

/** The next day after today the plan works on an assignment, e.g. "next: Wed". */
function nextPlanned(id) {
  const d = S.plan.days.find((x) => x.date > S.today && x.items.some((i) => i.assignmentId === id));
  if (!d) return "";
  return d.date === addDays(S.today, 1) ? "next: tomorrow" : `next: ${parseDay(d.date).toLocaleDateString(undefined, { weekday: "short" })}`;
}

/** One assignment on the Today page: `item` is today's plan for it, if it has one. */
function itemHtml(a, { item = null, done = 0 } = {}) {
  if (item?.done) return node({ name: esc(a.title), note: dotJoin([courseLabel(a.courseId), "finished today"]), cls: "completed" });
  const running = timer.get()?.assignmentId === a.id;
  const target = item?.minutes || 0;
  const met = target && done >= target;
  // What's left after today's share, counted from this morning.
  const after = Math.max(0, a.adjustedMinutes - a.workedMinutes + (S.workedToday[a.id] || 0) - target);
  const note = dotJoin([
    courseLabel(a.courseId),
    item ? (met ? `today's ${fmtMin(target)} done` : `${fmtMin(done)} of ${fmtMin(target)} today`) : "",
    item?.sessions.length > 1 ? `sessions: ${sessionList(item)}` : "",
    item ? (item.finishes ? "finishes it" : `${fmtMin(after)} more on later days`) : `${fmtMin(after)} left`,
    item ? "" : nextPlanned(a.id),
    running ? `<span class="live">timer running</span>` : "",
  ]);
  return node({
    name: `${esc(a.title)} ${dueChip(a.dueDate)}`,
    note,
    cls: `${met ? "met" : ""} ${running ? "running" : ""}`,
    actions: (running ? "" : op("Start", `data-start="${a.id}"`)) + op("Complete", `data-done="${a.id}"`),
  });
}

function renderToday() {
  const todayDate = parseDay(S.today);
  $("#today-date").textContent = todayDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  const day = S.plan.days[0]?.date === S.today ? S.plan.days[0] : { items: [], total: 0 };
  let target = 0;
  let done = 0;
  for (const i of day.items) {
    target += i.minutes;
    done += i.done ? i.minutes : Math.min(i.minutes, doneToday(i.assignmentId));
  }
  const left = target - done;

  if (!target) {
    $("#today-left").textContent = "Nothing scheduled today";
    const next = S.plan.days.find((d) => d.total > 0);
    $("#today-sub").textContent = next
      ? `Next work day: ${parseDay(next.date).toLocaleDateString(undefined, { weekday: "long" })} (${fmtMin(next.total)})`
      : S.assignments.some((a) => !a.completed)
        ? ""
        : "Add assignments and the planner will schedule them for you.";
  } else if (left <= 0.5) {
    const worked = S.assignments.reduce((sum, a) => sum + doneToday(a.id), 0);
    $("#today-left").textContent = "Done for today";
    $("#today-sub").textContent = `You put in ${fmtMin(worked)} today. Anything more is working ahead.`;
  } else {
    $("#today-left").textContent = `${fmtMin(left)} left`;
    $("#today-sub").textContent = `${day.items.length} assignment${day.items.length === 1 ? "" : "s"} planned today`;
  }
  $("#today-bar").parentElement.classList.toggle("hidden", !target);
  $("#today-bar").style.width = target ? `${Math.min(100, (done / target) * 100)}%` : "0%";
  $("#today-bar").parentElement.classList.toggle("done", target > 0 && left <= 0.5);
  $("#today-progress-label").textContent = target ? `${fmtMin(done)} of ${fmtMin(target)} done` : "";

  // Onboarding
  const ob = $("#onboarding");
  if (!S.courses.length || !S.assignments.length) {
    ob.innerHTML = `<div class="tree">${node({
      key: "onboarding",
      name: "<b>Getting started</b>",
      note: "Setup takes about a minute.",
      children:
        node({ name: `<a data-goto="courses">Add your courses</a>`, cls: S.courses.length ? "completed" : "" }) +
        node({ name: `<a data-add>Add an assignment</a> and paste in the instructions from Canvas`, cls: S.assignments.length ? "completed" : "" }),
    })}</div>`;
  } else ob.innerHTML = "";

  const scheduled = new Set(day.items.map((i) => i.assignmentId));
  const list = day.items
    .map((i) => [i, assignment(i.assignmentId)])
    .filter(([, a]) => a)
    .map(([i, a]) => itemHtml(a, { item: i, done: doneToday(a.id) }));

  const ahead = S.assignments
    .filter((a) => !a.completed && !scheduled.has(a.id))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);
  if (ahead.length) {
    list.push(
      node({
        key: "ahead",
        name: "Work ahead",
        note: "Not scheduled today",
        open: !list.length,
        cls: "group",
        children: ahead.map((a) => itemHtml(a)).join(""),
      }),
    );
  }
  $("#today-list").innerHTML = list.length ? list.join("") : `<div class="empty">No open assignments.</div>`;

  renderUpcoming();
}

function renderUpcoming() {
  const cap = S.settings.dailyCapMinutes || 0;
  const days = S.plan.days.filter((d) => d.date > S.today && d.date <= addDays(S.today, 14) && d.total > 0);
  $("#upcoming").innerHTML = days.length
    ? days
        .map((d, n) => {
          const dd = parseDay(d.date);
          const lbl =
            d.date === addDays(S.today, 1)
              ? "Tomorrow"
              : dd.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
          const items = d.items
            .map((i) => {
              const a = assignment(i.assignmentId);
              const time = i.sessions.length > 1 ? `${fmtMin(i.minutes)} (${sessionList(i)})` : fmtMin(i.minutes);
              return node({
                name: `${esc(a?.title)}<span class="inline-meta">${dotJoin([courseLabel(a?.courseId), time, i.finishes ? "finishes it" : ""])}</span>`,
              });
            })
            .join("");
          return node({
            key: `day:${d.date}`,
            name: `${lbl}<span class="inline-meta">${fmtMin(d.total)}${cap && d.total >= cap ? " (full)" : ""}</span>`,
            open: n < 3,
            children: items,
          });
        })
        .join("")
    : `<div class="empty">Nothing scheduled for the next two weeks.</div>`;
}

function renderAssignments() {
  const open = S.assignments.filter((a) => !a.completed).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const atRisk = new Set(S.plan.atRisk.map((r) => r.assignmentId));
  const running = timer.get()?.assignmentId;
  $("#assignment-list").innerHTML = open
    .map((a) => {
      const personal =
        a.source === "custom"
          ? `your time: ${fmtMin(a.estimateMinutes)}`
          : a.manualMinutes
            ? `your time: ${fmtMin(a.manualMinutes)} (est. ${fmtMin(a.estimateMinutes)})`
            : a.adjustedMinutes !== a.estimateMinutes
              ? `<span title="Estimate adjusted to your pace">est. ${fmtMin(a.estimateMinutes)} → ${fmtMin(a.adjustedMinutes)} for you</span>`
              : `est. ${fmtMin(a.estimateMinutes)}`;
      return node({
        name: `${esc(a.title)} ${dueChip(a.dueDate)}`,
        note: dotJoin([
          courseLabel(a.courseId),
          `<span class="tag">#${esc(a.type)}</span>`,
          personal,
          a.workedMinutes ? `${fmtMin(a.workedMinutes)} logged` : "",
          atRisk.has(a.id) ? `<span class="flag-bad">at risk</span>` : "",
          running === a.id ? `<span class="live">timer running</span>` : "",
        ]),
        cls: running === a.id ? "running" : "",
        actions:
          (running === a.id ? "" : op("Start", `data-start="${a.id}"`)) +
          op("Complete", `data-done="${a.id}"`) +
          op("Edit", `data-edit="${a.id}"`) +
          op("Delete", `data-del="${a.id}"`, "danger"),
      });
    })
    .join("");

  const done = S.assignments.filter((a) => a.completed).sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  $("#completed-list").innerHTML = done.length
    ? node({
        key: "completed",
        name: `Completed<span class="inline-meta">${done.length}</span>`,
        open: false,
        cls: "group",
        children: done
          .map((a) =>
            node({
              name: esc(a.title),
              note: dotJoin([courseLabel(a.courseId), `took ${fmtMin(a.actualMinutes)} (est. ${fmtMin(a.estimateMinutes)})`]),
              cls: "completed",
              actions: op("Reopen", `data-reopen="${a.id}"`) + op("Delete", `data-del="${a.id}"`, "danger"),
            }),
          )
          .join(""),
      })
    : "";
}

function renderCourses() {
  $("#course-list").innerHTML = S.courses
    .map((c) => {
      const n = S.assignments.filter((a) => a.courseId === c.id && !a.completed).length;
      return node({
        bullet: `<span class="bullet swatch-wrap"><input type="color" class="swatch" value="${esc(c.color)}" data-color="${c.id}" title="Change color" /></span>`,
        name: `<input class="inline-input" value="${esc(c.name)}" data-rename="${c.id}" aria-label="Course name" />`,
        note: `${n} open assignment${n === 1 ? "" : "s"}`,
        actions: op("Delete", `data-delcourse="${c.id}"`, "danger"),
      });
    })
    .join("");
}

function renderInsights() {
  const m = S.multipliers;
  const describe = (v, than = "the estimates") => {
    if (v.samples < 2) return `<span class="muted">learning, ${2 - v.samples} more to go</span>`;
    const pct = Math.round(Math.abs(v.multiplier - 1) * 100);
    if (pct < 5) return `<span class="flag-good">right on ${than}</span>`;
    return v.multiplier < 1
      ? `<span class="flag-good">~${pct}% faster than ${than}</span>`
      : `<span class="flag-warn">~${pct}% slower than ${than}</span>`;
  };
  const row = (label, v, than) =>
    node({
      name: `${label}<span class="inline-meta">${describe(v, than)}</span>`,
      note: dotJoin([v.finished ? `${v.finished} finished` : "", v.corrected ? `${v.corrected} corrected` : "", `×${v.multiplier.toFixed(2)}`]),
    });
  $("#insights").innerHTML = m.global.samples
    ? row("<b>Overall</b>", m.global) +
      Object.entries(m.byType)
        .sort((a, b) => b[1].samples - a[1].samples)
        .map(([type, v]) => row(`#${esc(type)}`, v))
        .join("") +
      Object.entries(m.byCourse)
        .filter(([id]) => course(id))
        .map(([id, v]) => row(courseLabel(id), v, "your usual pace"))
        .join("")
    : `<div class="empty">Finish an assignment, or change an estimate to your own time, and your pace shows up here.</div>`;

  const history = [...m.history].reverse().slice(0, 30);
  $("#history").innerHTML = history.length
    ? history
        .map(({ assignmentId, kind, ratio }) => {
          const a = assignment(assignmentId);
          const cls = ratio <= 0.9 ? "flag-good" : ratio >= 1.1 ? "flag-warn" : "";
          return node({
            name: `${esc(a.title)}<span class="inline-meta"><span class="${cls}">×${ratio.toFixed(2)}</span></span>`,
            note: dotJoin([
              courseLabel(a.courseId),
              `<span class="tag">#${esc(a.type)}</span>`,
              `estimated ${fmtMin(a.estimateMinutes)}`,
              kind === "finished" ? `took ${fmtMin(a.actualMinutes)}` : `you set ${fmtMin(a.manualMinutes)} (not done yet)`,
            ]),
          });
        })
        .join("")
    : `<div class="empty">Nothing yet.</div>`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let settingsRendered = false;
function renderSettings() {
  const s = S.settings;
  const saved = "A key is saved. Leave blank to keep it.";
  $("#key-status").textContent = s.hasApiKey ? saved : "Get one at console.anthropic.com.";
  $("#gemini-key-status").textContent = s.hasGeminiKey ? saved : "Get one free at aistudio.google.com/apikey.";
  if (settingsRendered) return; // don't clobber what the user is typing
  settingsRendered = true;
  const choice = s.estimator === "ai" ? (s.aiProvider === "gemini" ? "gemini" : "claude") : "local";
  const mode = document.querySelector(`input[name="estimator"][value="${choice}"]`);
  mode.checked = true;
  syncKeyRow();
  $("#set-cap").value = (s.dailyCapMinutes / 60).toString();
  $("#set-buffer").value = s.startBufferDays;
  $("#set-days").innerHTML = DAY_NAMES.map(
    (n, i) => `<label><input type="checkbox" value="${i}" ${s.workDays.includes(i) ? "checked" : ""}/> ${n}</label>`,
  ).join("");
}

function selectedEstimator() {
  return document.querySelector('input[name="estimator"]:checked')?.value || "local";
}
function syncKeyRow() {
  $("#key-row").classList.toggle("hidden", selectedEstimator() !== "claude");
  $("#gemini-key-row").classList.toggle("hidden", selectedEstimator() !== "gemini");
}

// ---------- add / edit assignment dialog ----------
let editingId = null;
let lastEstimate = null; // {minutes: raw estimate, adjustedMinutes: adjusted to your pace, type, ...}
let minutesTouched = false; // user typed their own minutes; keep them (the planner learns from them)
let typeTouched = false; // user picked the type; estimate with it instead of guessing
const aiMode = () => S.settings.estimator === "ai";
const aiName = () => (S.settings.aiProvider === "gemini" ? "Gemini" : "Claude");

function fillCourseSelect(selected) {
  $("#a-course").innerHTML =
    S.courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("") + `<option value="">(no course)</option>`;
  $("#a-course").value = selected;
}

/** Minutes the user set over the estimate, or 0 if the field holds the estimate. */
function ownMinutes() {
  const typed = Number($("#a-minutes").value);
  return minutesTouched && lastEstimate && typed > 0 ? typed : 0;
}

function showEstimate(est = lastEstimate) {
  const box = $("#estimate-box");
  if (!est || $("#a-custom").checked) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const by =
    est.method !== "ai" ? "Built-in estimate" : est.provider === "gemini" ? "Gemini estimate" : est.provider === "claude" ? "Claude estimate" : "AI estimate";
  const steps = (est.breakdown || []).map((b) => `<li>${esc(b.step)} <span class="muted">(${fmtMin(b.minutes)})</span></li>`).join("");
  const own = ownMinutes();
  box.innerHTML = `${est.notice ? `<div class="notice">${esc(est.notice)}</div>` : ""}
    <div class="estimate-head"><span class="big">${fmtMin(est.adjustedMinutes)}</span>
      <span class="muted small">${dotJoin([by, est.confidence ? `${esc(est.confidence)} confidence` : ""])}</span></div>
    ${est.adjustedMinutes !== est.minutes ? `<div class="muted small">${by} ${fmtMin(est.minutes)}, adjusted to your pace.</div>` : ""}
    ${est.reasoning ? `<div>${esc(est.reasoning)}</div>` : ""}
    ${steps ? `<ul>${steps}</ul>` : ""}
    ${est.localMinutes ? `<div class="muted small">Built-in estimate for comparison: ${fmtMin(est.localMinutes)}</div>` : ""}
    <div class="muted small" style="margin-top:6px">${
      own
        ? `You set ${fmtMin(own)}. The planner will learn from that.` +
          (own !== est.adjustedMinutes ? ` <a data-use-estimate>Use ${fmtMin(est.adjustedMinutes)} instead</a>` : "")
        : "If this looks off, change the time. The planner learns from your changes."
    }</div>`;
}

function syncCustomMode() {
  $("#a-estimate").classList.toggle("hidden", $("#a-custom").checked || !aiMode());
  showEstimate();
}

function estimateRequest() {
  return {
    courseId: $("#a-course").value,
    title: $("#a-title").value,
    dueDate: $("#a-due").value,
    instructions: $("#a-instructions").value,
    type: typeTouched ? $("#a-type").value : undefined,
  };
}

/** Show a new estimate and fill in whatever the user hasn't set themselves. */
function setEstimate(est) {
  lastEstimate = est;
  if (!typeTouched) $("#a-type").value = est.type;
  if (!minutesTouched) $("#a-minutes").value = est.adjustedMinutes;
  showEstimate();
}

// Built-in mode: re-estimate as you type/paste (it's free and instant).
let liveTimer = null;
let liveSeq = 0; // only the newest request may update the form
let livePending = null;
function liveEstimate() {
  if (aiMode() || $("#a-custom").checked) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => (livePending = refreshEstimate()), 300);
}
async function refreshEstimate() {
  liveTimer = null;
  const seq = ++liveSeq;
  if (!$("#a-title").value.trim() && !$("#a-instructions").value.trim()) {
    lastEstimate = null;
    return showEstimate();
  }
  try {
    const est = await api("POST", "/api/estimate", { ...estimateRequest(), mode: "local" });
    if (seq === liveSeq && !$("#a-custom").checked) setEstimate(est);
  } catch {}
}
/** Before saving, make sure the estimate matches what's in the form. */
async function settleEstimate() {
  if (liveTimer) {
    clearTimeout(liveTimer);
    livePending = refreshEstimate();
  }
  await livePending;
}

function openAssignmentDialog(id = null) {
  editingId = id;
  const a = id ? assignment(id) : null;
  clearTimeout(liveTimer);
  liveTimer = null;
  liveSeq++; // ignore estimates still in flight from the last time the dialog was open
  lastEstimate =
    a && a.source !== "custom"
      ? {
          minutes: a.estimateMinutes,
          adjustedMinutes: a.suggestedMinutes,
          type: a.type,
          reasoning: a.reasoning,
          breakdown: a.breakdown,
          confidence: a.confidence,
          method: a.source === "ai" ? "ai" : "local",
        }
      : null;
  minutesTouched = Boolean(a?.manualMinutes); // keep a time you set yourself
  typeTouched = Boolean(a); // keep the saved type
  $("#a-estimate").textContent = `${a ? "Re-estimate" : "Estimate"} with ${aiName()}`;
  $("#assignment-dialog-title").textContent = a ? "Edit assignment" : "Add assignment";
  fillCourseSelect(a ? a.courseId || "" : S.courses[0]?.id || "");
  $("#a-title").value = a?.title || "";
  $("#a-due").value = a?.dueDate || `${addDays(localDay(), 7)}T23:59`;
  $("#a-instructions").value = a?.instructions || "";
  $("#a-custom").checked = a?.source === "custom";
  $("#a-minutes").value = a?.adjustedMinutes ?? "";
  $("#a-type").innerHTML = S.types.map((t) => `<option ${t === (a?.type || "other") ? "selected" : ""}>${t}</option>`).join("");
  $("#a-error").textContent = "";
  syncCustomMode();
  $("#assignment-dialog").showModal();
  $("#a-title").focus();
}

async function runEstimate() {
  $("#a-error").textContent = "";
  if (!$("#a-title").value.trim() && !$("#a-instructions").value.trim()) {
    $("#a-error").textContent = "Add a title or paste the instructions first.";
    return false;
  }
  const btn = $("#a-estimate");
  const save = $("#a-save");
  const label = btn.textContent;
  btn.disabled = save.disabled = true;
  btn.textContent = "Estimating...";
  try {
    const est = await api("POST", "/api/estimate", estimateRequest());
    liveSeq++; // this one wins over any live estimate still in flight
    minutesTouched = false;
    setEstimate(est);
    return true;
  } catch (e) {
    $("#a-error").textContent = `${e.message} You can also tick "Set the time myself".`;
    return false;
  } finally {
    btn.disabled = save.disabled = false;
    btn.textContent = label;
  }
}

async function saveAssignment(e) {
  e.preventDefault();
  if (!$("#a-title").value.trim()) return ($("#a-error").textContent = "Give it a title.");
  if (!$("#a-due").value) return ($("#a-error").textContent = "Pick a due date.");
  const hadTime = Boolean($("#a-minutes").value);
  await settleEstimate(); // make sure the estimate matches what's in the form

  // No time yet? Show an estimate first and let the user review it.
  if (!$("#a-custom").checked && !hadTime) {
    if (!$("#a-minutes").value) await runEstimate();
    return;
  }
  const minutes = Number($("#a-minutes").value);
  if (!minutes) return ($("#a-error").textContent = "Enter how many minutes it needs.");

  // Without an estimate (custom, or estimating failed) the time is simply yours.
  const est = $("#a-custom").checked ? null : lastEstimate;
  const body = {
    courseId: $("#a-course").value || null,
    title: $("#a-title").value,
    dueDate: $("#a-due").value,
    instructions: $("#a-instructions").value,
    type: $("#a-type").value,
    source: !est ? "custom" : est.method === "ai" ? "ai" : "auto",
    estimateMinutes: est ? est.minutes : minutes,
    manualMinutes: (est && ownMinutes()) || null,
    reasoning: est?.reasoning || "",
    breakdown: est?.breakdown || [],
    confidence: est?.confidence || null,
  };
  const ok = editingId ? await act("PUT", `/api/assignments/${editingId}`, body) : await act("POST", "/api/assignments", body);
  if (ok) {
    $("#assignment-dialog").close();
    toast(editingId ? "Saved" : "Added. It's in your plan.");
  }
}

// ---------- done dialog ----------
let doneId = null;
async function openDoneDialog(id) {
  // Log any running timer on this assignment first so the total is right.
  if (timer.get()?.assignmentId === id) await stopTimer();
  const a = assignment(id);
  if (!a) return;
  doneId = id;
  const planned =
    a.source === "custom"
      ? `You planned ${fmtMin(a.estimateMinutes)}`
      : a.manualMinutes
        ? `Estimated ${fmtMin(a.estimateMinutes)}, you set ${fmtMin(a.manualMinutes)}`
        : `Estimated ${fmtMin(a.estimateMinutes)}${a.adjustedMinutes !== a.estimateMinutes ? ` (${fmtMin(a.adjustedMinutes)} adjusted for you)` : ""}`;
  $("#done-text").innerHTML = `<b>${esc(a.title)}</b><br><span class="muted">${planned}. You've logged ${fmtMin(a.workedMinutes)}.</span>`;
  $("#done-minutes").value = a.workedMinutes || a.adjustedMinutes;
  $("#done-dialog").showModal();
  $("#done-minutes").select();
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button, a");
  if (!el) return;
  const d = el.dataset;
  if (d.toggle) {
    const collapsed = el.closest(".node").classList.toggle("collapsed");
    setOpen(d.toggle, !collapsed);
  } else if (d.view) showView(d.view);
  else if (d.goto) showView(d.goto);
  else if ("add" in d) openAssignmentDialog();
  else if ("useEstimate" in d) {
    minutesTouched = false;
    $("#a-minutes").value = lastEstimate.adjustedMinutes;
    showEstimate();
  }
  else if (d.start) {
    try {
      if (Notification.permission === "default") Notification.requestPermission();
    } catch {}
    startTimer(d.start);
  } else if (d.done) openDoneDialog(d.done);
  else if (d.edit) openAssignmentDialog(d.edit);
  else if (d.del) {
    const a = assignment(d.del);
    if (confirm(`Delete "${a?.title}"? Logged time for it is deleted too.`)) {
      if (timer.get()?.assignmentId === d.del) timer.set(null);
      act("DELETE", `/api/assignments/${d.del}`);
    }
  } else if (d.reopen) act("POST", `/api/assignments/${d.reopen}/reopen`);
  else if (d.delcourse) {
    const n = S.assignments.filter((a) => a.courseId === d.delcourse).length;
    if (confirm(`Delete ${course(d.delcourse)?.name}${n ? ` and its ${n} assignment${n === 1 ? "" : "s"}` : ""}?`)) {
      act("DELETE", `/api/courses/${d.delcourse}`);
    }
  }
});

document.addEventListener("change", (e) => {
  const d = e.target.dataset;
  if (d.color) act("PUT", `/api/courses/${d.color}`, { color: e.target.value });
  else if (d.rename) {
    const name = e.target.value.trim();
    if (name && name !== course(d.rename)?.name) act("PUT", `/api/courses/${d.rename}`, { name });
    else e.target.value = course(d.rename)?.name || "";
  }
});
// Course names are edited in place: Enter saves, Escape reverts.
document.addEventListener("keydown", (e) => {
  const id = e.target.dataset?.rename;
  if (!id) return;
  if (e.key === "Enter") e.target.blur();
  else if (e.key === "Escape") {
    e.target.value = course(id)?.name || "";
    e.target.blur();
  }
});

$("#menu-btn").onclick = () => document.body.classList.toggle("nav-open");
$("#scrim").onclick = () => document.body.classList.remove("nav-open");
$("#a-cancel").onclick = () => $("#assignment-dialog").close();
$("#a-estimate").onclick = runEstimate;
$("#a-custom").onchange = () => {
  syncCustomMode();
  liveEstimate();
};
$("#a-title").oninput = liveEstimate;
$("#a-instructions").oninput = liveEstimate;
$("#a-course").onchange = liveEstimate;
$("#a-type").onchange = () => {
  typeTouched = true;
  liveEstimate();
};
$("#a-minutes").oninput = () => {
  // Typing the estimate itself back in isn't a correction.
  minutesTouched = Number($("#a-minutes").value) !== lastEstimate?.adjustedMinutes;
  showEstimate();
};
document.querySelectorAll('input[name="estimator"]').forEach((r) => (r.onchange = syncKeyRow));
$("#assignment-form").onsubmit = saveAssignment;

$("#done-cancel").onclick = () => $("#done-dialog").close();
$("#done-form").onsubmit = async (e) => {
  e.preventDefault();
  const minutes = Number($("#done-minutes").value);
  if (!(minutes > 0)) return;
  const a = assignment(doneId);
  const ok = await act("POST", `/api/assignments/${doneId}/complete`, { actualMinutes: minutes });
  if (ok) {
    $("#done-dialog").close();
    if (a.source === "custom") return toast("Completed.");
    const r = minutes / a.suggestedMinutes; // vs. what the planner expected for you
    toast(
      r < 0.9
        ? `Completed. Faster than expected, so future ${a.type} estimates will shrink.`
        : r > 1.1
          ? `Completed. It took longer than expected, so future ${a.type} estimates will grow.`
          : "Completed, right on the estimate.",
      5000,
    );
  }
};

$("#timer-pause").onclick = togglePause;
$("#timer-stop").onclick = () => stopTimer();
$("#timer-done").onclick = () => {
  const t = timer.get();
  if (t) openDoneDialog(t.assignmentId);
};

$("#course-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#course-name").value.trim();
  if (!name) return;
  if (await act("POST", "/api/courses", { name, color: $("#course-color").value })) {
    $("#course-name").value = "";
    // Suggest a different color for the next course.
    const palette = ["#4f7cff", "#e5484d", "#30a46c", "#f5a623", "#8e4ec6", "#12a594", "#e93d82", "#6e56cf"];
    $("#course-color").value = palette[S.courses.length % palette.length];
  }
};

$("#settings-form").onsubmit = async (e) => {
  e.preventDefault();
  const choice = selectedEstimator();
  const body = {
    estimator: choice === "local" ? "local" : "ai",
    ...(choice === "local" ? {} : { aiProvider: choice }),
    dailyCapMinutes: Math.round(Number($("#set-cap").value) * 60),
    startBufferDays: Number($("#set-buffer").value),
    workDays: [...document.querySelectorAll("#set-days input:checked")].map((i) => Number(i.value)),
  };
  if (!body.workDays.length) return toast("Pick at least one study day.");
  const key = $("#set-key").value.trim();
  if (key) body.apiKey = key;
  const geminiKey = $("#set-gemini-key").value.trim();
  if (geminiKey) body.geminiApiKey = geminiKey;
  if (await act("PUT", "/api/settings", body)) {
    $("#set-key").value = "";
    $("#set-gemini-key").value = "";
    toast("Settings saved. Your plan has been updated.");
  }
};

// Tick: update the clock every second, refresh the plan view periodically,
// and reload everything when the day rolls over.
let lastDay = localDay();
let ticks = 0;
setInterval(async () => {
  if (!S) return;
  if (localDay() !== lastDay) {
    lastDay = localDay();
    S = await api("GET", "/api/state");
    render();
    return;
  }
  renderTimer();
  if (timer.get()?.startedAt && ++ticks % 20 === 0) renderToday();
}, 1000);

// Boot
(async () => {
  let saved = null;
  try {
    saved = localStorage.getItem("planner.view");
  } catch {}
  showView(location.hash.slice(1) || saved || "today", true);
  try {
    S = await api("GET", "/api/state");
    render();
  } catch (e) {
    $("#banner").innerHTML = `<div class="callout bad">Couldn't reach the planner server: ${esc(e.message)}</div>`;
  }
})();
