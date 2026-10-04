// Tiny JSON-file database. Everything lives in data/db.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PLANNER_DATA_DIR || path.join(here, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

export const DEFAULT_SETTINGS = {
  // "local" = free built-in estimator, "ai" = ask an AI model (needs an API key)
  estimator: "local",
  // which AI model "ai" mode asks: "claude" or "gemini"
  aiProvider: "claude",
  apiKey: "", // Anthropic
  geminiApiKey: "",
  dailyCapMinutes: 240,
  // 0 = Sunday ... 6 = Saturday
  workDays: [0, 1, 2, 3, 4, 5, 6],
  startBufferDays: 1,
};

function emptyDb() {
  return {
    courses: [],
    assignments: [],
    sessions: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

let db = null;

export function load() {
  if (db) return db;
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db = { ...emptyDb(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
  } catch {
    db = emptyDb();
  }
  return db;
}

export function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function newId() {
  return crypto.randomUUID();
}
