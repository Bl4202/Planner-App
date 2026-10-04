import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, save, newId } from "./store.js";
import { buildPlan } from "./scheduler.js";
import { applyMultipliers, computeMultipliers, personalize } from "./learning.js";
import { estimateAssignment, EstimateError, PROVIDERS, providerKey, TYPES } from "./ai.js";
import { estimateLocal } from "./estimator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const isDue = (s) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(s));
const toMinutes = (v) => Math.max(0, Math.round(Number(v) || 0));

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function workedMinutes(db, assignmentId, onDay) {
  return db.sessions
    .filter((s) => s.assignmentId === assignmentId && (!onDay || s.date === onDay))
    .reduce((sum, s) => sum + s.minutes, 0);
}

/** Everything the UI needs in one payload. */
function state(today) {
  const db = load();
  for (const a of db.assignments) a.workedMinutes = workedMinutes(db, a.id);
  const multipliers = applyMultipliers(db.assignments);

  const workedToday = Object.fromEntries(db.assignments.map((a) => [a.id, workedMinutes(db, a.id, today)]));
  const plan = buildPlan(db.assignments, today, db.settings, workedToday);

  const { apiKey, geminiApiKey, ...settings } = db.settings;
  return {
    today,
    courses: db.courses,
    assignments: db.assignments,
    workedToday,
    plan,
    multipliers,
    types: TYPES,
    settings: {
      ...settings,
      hasApiKey: Boolean(providerKey({ ...db.settings, aiProvider: "claude" })),
      hasGeminiKey: Boolean(providerKey({ ...db.settings, aiProvider: "gemini" })),
    },
  };
}

const todayOf = (req) => (isDay(req.query.today) ? req.query.today : localToday());
const reply = (req, res) => res.json(state(todayOf(req)));

function findAssignment(req, res) {
  const a = load().assignments.find((x) => x.id === req.params.id);
  if (!a) res.status(404).json({ error: "Assignment not found" });
  return a;
}

// ---- state ----
app.get("/api/state", reply);

// ---- courses ----
app.post("/api/courses", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Course name is required" });
  load().courses.push({ id: newId(), name, color: req.body.color || "#4f7cff" });
  save();
  reply(req, res);
});

app.put("/api/courses/:id", (req, res) => {
  const c = load().courses.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Course not found" });
  if (req.body.name?.trim()) c.name = req.body.name.trim();
  if (req.body.color) c.color = req.body.color;
  save();
  reply(req, res);
});

app.delete("/api/courses/:id", (req, res) => {
  const db = load();
  const gone = new Set(db.assignments.filter((a) => a.courseId === req.params.id).map((a) => a.id));
  db.courses = db.courses.filter((c) => c.id !== req.params.id);
  db.assignments = db.assignments.filter((a) => !gone.has(a.id));
  db.sessions = db.sessions.filter((s) => !gone.has(s.assignmentId));
  save();
  reply(req, res);
});

// ---- time estimate (does not save anything) ----
// Free local estimator by default. In "ai" mode Claude or Gemini is asked too, and the
// local estimate is the fallback if that fails.
// `minutes` is the raw estimate; `adjustedMinutes` is scaled by what the
// planner has learned about you, and is the number the form shows.
app.post("/api/estimate", async (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.body.courseId);
  const picked = TYPES.includes(req.body.type) ? req.body.type : undefined; // type chosen in the form
  const input = { course: course?.name, title: req.body.title, dueDate: req.body.dueDate, instructions: req.body.instructions, type: picked };
  const local = estimateLocal(input);
  const m = computeMultipliers(db.assignments);
  const forYou = (est) => {
    const type = picked || est.type;
    return { ...est, type, adjustedMinutes: personalize(est.minutes, type, m, course?.id) };
  };
  const wantAi = req.body.mode ? req.body.mode === "ai" : db.settings.estimator === "ai";
  if (!wantAi) return res.json(forYou(local));

  const provider = db.settings.aiProvider === "gemini" ? "gemini" : "claude";
  const apiKey = providerKey(db.settings);
  if (!apiKey) {
    const name = provider === "gemini" ? "Gemini" : "Anthropic";
    return res.json({ ...forYou(local), notice: `No ${name} API key set, so this is the free built-in estimate.` });
  }
  try {
    const ai = forYou(await estimateAssignment(input, { provider, apiKey }));
    res.json({ ...ai, method: "ai", localMinutes: personalize(local.minutes, ai.type, m, course?.id) });
  } catch (err) {
    console.error("[estimate]", err);
    const why = err instanceof EstimateError ? err.message : "The AI request failed.";
    res.json({ ...forYou(local), notice: `${why} Showing the free built-in estimate instead.` });
  }
});

// ---- assignments ----
function applyAssignmentFields(a, body) {
  if (body.courseId !== undefined) a.courseId = body.courseId || null;
  if (body.title !== undefined) a.title = String(body.title).trim() || "Untitled";
  if (body.dueDate !== undefined) {
    if (!isDue(body.dueDate)) throw new Error("Due date must look like YYYY-MM-DD or YYYY-MM-DDTHH:mm");
    a.dueDate = body.dueDate.length === 10 ? `${body.dueDate}T23:59` : body.dueDate;
  }
  if (body.instructions !== undefined) a.instructions = String(body.instructions);
  if (body.type !== undefined) a.type = TYPES.includes(body.type) ? body.type : "other";
  if (body.estimateMinutes !== undefined) a.estimateMinutes = Math.max(5, toMinutes(body.estimateMinutes));
  if (body.source !== undefined) a.source = ["custom", "ai", "auto"].includes(body.source) ? body.source : "auto";
  if (body.reasoning !== undefined) a.reasoning = String(body.reasoning);
  if (body.breakdown !== undefined) a.breakdown = Array.isArray(body.breakdown) ? body.breakdown : [];
  if (body.confidence !== undefined) a.confidence = body.confidence;
  // A time typed over the estimate. The plan uses it as-is, and the planner
  // learns from it (see learning.js). null clears it.
  if (body.manualMinutes !== undefined) {
    const own = body.manualMinutes ? Math.max(5, toMinutes(body.manualMinutes)) : 0;
    if (!own) {
      delete a.manualMinutes;
      delete a.correctedAt;
    } else if (own !== a.manualMinutes) {
      a.manualMinutes = own;
      a.correctedAt = new Date().toISOString();
    }
  }
  if (a.source === "custom") {
    delete a.manualMinutes; // a custom time is already yours (estimateMinutes)
    delete a.correctedAt;
  }
}

app.post("/api/assignments", (req, res) => {
  const a = {
    id: newId(),
    courseId: null,
    title: "Untitled",
    dueDate: null,
    instructions: "",
    type: "other",
    estimateMinutes: 60,
    source: "custom",
    reasoning: "",
    breakdown: [],
    completed: false,
    createdAt: new Date().toISOString(),
  };
  try {
    applyAssignmentFields(a, req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!a.dueDate) return res.status(400).json({ error: "Due date is required" });
  load().assignments.push(a);
  save();
  reply(req, res);
});

app.put("/api/assignments/:id", (req, res) => {
  const a = findAssignment(req, res);
  if (!a) return;
  try {
    applyAssignmentFields(a, req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  save();
  reply(req, res);
});

app.delete("/api/assignments/:id", (req, res) => {
  const db = load();
  db.assignments = db.assignments.filter((a) => a.id !== req.params.id);
  db.sessions = db.sessions.filter((s) => s.assignmentId !== req.params.id);
  save();
  reply(req, res);
});

// Log time worked (from the timer, or entered by hand).
app.post("/api/assignments/:id/sessions", (req, res) => {
  const a = findAssignment(req, res);
  if (!a) return;
  const minutes = toMinutes(req.body.minutes);
  if (minutes > 0) {
    load().sessions.push({
      id: newId(),
      assignmentId: a.id,
      minutes,
      date: isDay(req.body.date) ? req.body.date : todayOf(req),
      loggedAt: new Date().toISOString(),
    });
    save();
  }
  reply(req, res);
});

// Mark done with the real total time spent. This is what the app learns from.
app.post("/api/assignments/:id/complete", (req, res) => {
  const db = load();
  const a = findAssignment(req, res);
  if (!a) return;
  const worked = workedMinutes(db, a.id);
  const actual = req.body.actualMinutes !== undefined ? toMinutes(req.body.actualMinutes) : worked;
  // Record any time not captured by the timer as a session, so totals line up.
  if (actual > worked) {
    db.sessions.push({ id: newId(), assignmentId: a.id, minutes: actual - worked, date: todayOf(req), loggedAt: new Date().toISOString() });
  }
  // The time it was planned for, so it keeps its place in today's plan.
  applyMultipliers(db.assignments);
  a.plannedMinutes = a.adjustedMinutes;
  a.completed = true;
  a.completedAt = new Date().toISOString();
  a.actualMinutes = actual;
  save();
  reply(req, res);
});

app.post("/api/assignments/:id/reopen", (req, res) => {
  const a = findAssignment(req, res);
  if (!a) return;
  a.completed = false;
  delete a.completedAt;
  delete a.actualMinutes;
  delete a.plannedMinutes;
  save();
  reply(req, res);
});

// ---- settings ----
app.put("/api/settings", (req, res) => {
  const s = load().settings;
  const b = req.body;
  if (b.estimator !== undefined) s.estimator = b.estimator === "ai" ? "ai" : "local";
  if (PROVIDERS.includes(b.aiProvider)) s.aiProvider = b.aiProvider;
  if (b.apiKey !== undefined) s.apiKey = String(b.apiKey).trim();
  if (b.geminiApiKey !== undefined) s.geminiApiKey = String(b.geminiApiKey).trim();
  if (b.dailyCapMinutes !== undefined) s.dailyCapMinutes = toMinutes(b.dailyCapMinutes);
  if (Array.isArray(b.workDays)) s.workDays = b.workDays.map(Number).filter((d) => d >= 0 && d <= 6);
  if (b.startBufferDays !== undefined) s.startBufferDays = Math.min(14, toMinutes(b.startBufferDays));
  save();
  reply(req, res);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Study Planner running at http://localhost:${PORT}`);
});
