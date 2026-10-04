// Free, offline time estimator. Reads the pasted assignment text, finds the
// measurable things (word counts, pages, problems, sources...), and turns each
// into minutes using the RATES below. No API calls, deterministic.
//
// Output has the same shape as server/ai.js so the rest of the app doesn't care
// which one produced it. Learning (server/learning.js) then corrects for how
// fast *you* are, so the numbers only need to be consistent, not perfect.

import { TYPES } from "./ai.js";

// ---- tunable rates (minutes unless noted) ----
export const RATES = {
  writeWordsPerMin: 6, // drafting + revising + proofreading, ~360 words/hour
  wordsPerPageDouble: 275,
  wordsPerPageSingle: 500,
  perSource: 25, // find, skim and use one source
  writingSetup: 20,
  outline: 30,
  citations: 10,
  readPerPage: 2.5, // ~24 pages/hour with some notes
  pagesPerChapter: 25,
  readNotes: 15,
  perReadingQuestion: 8,
  perProblem: 12,
  proofFactor: 1.5,
  showWorkFactor: 1.2,
  problemSetup: 10,
  codeBase: 90,
  perRequirement: 25,
  codeTests: 40,
  codeWriteup: 30,
  postSetup: 15,
  perReply: 10,
  labBase: 90,
  perChapterStudy: 45,
  examDefault: 180,
  examFinalFactor: 1.4,
  projectBase: 300,
  perExtraDeliverable: 0.15,
  groupFactor: 0.1, // coordination overhead; the work itself is shared
  perSlide: 10,
  mediaFactor: 1.5, // pausing, rewinding, notes
};

const DEFAULTS = {
  writingWords: 800,
  readingPages: 30,
  problems: 8,
  postWords: 250,
  replies: 2,
  labWords: 600,
};

// ---- type classification ----
const KEYWORDS = {
  writing: [/\bessay\b/, /\bpaper\b/, /\breflection\b/, /\bresponse paper\b/, /\banalysis\b/, /\bthesis\b/, /\bargument/, /\bdraft\b/, /\bmemo\b/, /\bwords?\b/, /double[- ]spaced/, /\bwrite\b/, /\bmla\b|\bapa\b|\bchicago\b/],
  reading: [/\bread(?:ing)?\b/, /\bchapters?\b/, /\barticles?\b/, /\btextbook\b/, /\bpp?\.\s*\d/],
  "problem-set": [/problem set/, /\bproblems?\b/, /\bexercises?\b/, /\bsolve\b/, /\bcalculate\b/, /\bworksheet\b/, /\bproofs?\b/, /show your work/, /\bequations?\b/, /\bhomework \d/],
  coding: [/\bcode\b/, /\bprogram(?:ming)?\b/, /\bimplement/, /\bfunctions?\b/, /\balgorithm/, /\bpython\b|\bjava\b|\bc\+\+|\bjavascript\b|\brust\b/, /\bgithub\b|\brepo\b/, /unit tests?/, /\bcompile/],
  project: [/\bproject\b/, /\bpresentation\b/, /\bslides?\b/, /\bposter\b/, /\bgroup\b|\bteam\b/, /\bdeliverables?\b/, /\bprototype\b/, /\bportfolio\b/],
  "exam-prep": [/\bexam\b/, /\bmidterm\b/, /\bfinal\b/, /\bquiz\b/, /study guide/, /study for/, /\bstudy\b/],
  discussion: [/\bdiscussion\b/, /\bforum\b/, /initial post/, /\breply\b|\breplies\b/, /classmates?|\bpeers?\b/, /\bpost\b/],
  lab: [/\blab\b/, /\bexperiment\b/, /\bprocedure\b/, /data collection/, /\bspecimen\b/],
};
// Stronger phrases that settle it on their own.
const STRONG = {
  discussion: [/initial post/, /discussion (?:board|post|forum)|\bdiscussion\b/],
  lab: [/lab report/, /\blab \d/],
  "problem-set": [/problem set/],
  "exam-prep": [/study (?:for|guide)|\bexam\b|\bmidterm\b/],
  // A "Project 2" that says "implement ... in Python" is a coding assignment.
  coding: [/\bimplement\b/, /\b(?:python|java|c\+\+|javascript|typescript|rust|golang|matlab)\b/],
};
const COURSE_PRIORS = [
  [/^(cs|cse|cis|comp|info|ece|eecs)\b/i, "coding"],
  [/^(math|stat|phys|econ)\b/i, "problem-set"],
  [/^(eng|hist|phil|soc|psy|comm|wri|pol|lit)/i, "writing"],
];

export function classify(title, instructions, course) {
  const t = String(title || "").toLowerCase();
  const body = String(instructions || "").toLowerCase();
  const scores = Object.fromEntries(TYPES.map((x) => [x, 0]));

  for (const [type, pats] of Object.entries(KEYWORDS)) {
    for (const p of pats) {
      if (p.test(t)) scores[type] += 3;
      const hits = (body.match(new RegExp(p.source, "g")) || []).length;
      scores[type] += Math.min(hits, 3) * 0.7;
    }
  }
  for (const [type, pats] of Object.entries(STRONG)) {
    for (const p of pats) if (p.test(t) || p.test(body)) scores[type] += 2;
  }
  for (const [re, type] of COURSE_PRIORS) if (re.test(String(course || "").trim())) scores[type] += 0.5;

  const ranked = Object.entries(scores).filter(([k]) => k !== "other").sort((a, b) => b[1] - a[1]);
  return ranked[0][1] >= 1.4 ? ranked[0][0] : "other";
}

// ---- signal extraction ----
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function normalize(text) {
  return String(text || "")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b(?!\s+of\b)/gi, (w) => String(NUMWORDS[w.toLowerCase()]))
    .replace(/(\d),(\d{3})/g, "$1$2");
}

const mid = (a, b) => (b ? (Number(a) + Number(b)) / 2 : Number(a));

export function extractSignals(rawText) {
  const text = normalize(rawText);
  const lower = text.toLowerCase();
  const s = { instructionWords: (text.match(/\S+/g) || []).length };

  // word counts, e.g. "1500 words", "500-750 words"
  const words = [...lower.matchAll(/(\d+)\s*(?:[-–]|to)?\s*(\d+)?\s*[- ]?words?\b/g)].map((m) => mid(m[1], m[2])).filter((n) => n >= 25);
  if (words.length) s.words = words;

  // "5 pages", "3-4 page"
  const pg = lower.match(/(\d+(?:\.\d+)?)\s*(?:[-–]|to)?\s*(\d+(?:\.\d+)?)?[\s-]*pages?\b/);
  if (pg) s.pageCount = mid(pg[1], pg[2]);
  s.singleSpaced = /single[- ]spaced/.test(lower);

  // reading page ranges "pp. 45-72", "pages 45 to 72"
  const range = lower.match(/(?:pp?\.|pages?)\s*(\d+)\s*(?:[-–]|to|through)\s*(\d+)/);
  if (range && Number(range[2]) >= Number(range[1])) s.readPages = Number(range[2]) - Number(range[1]) + 1;

  // chapters 3-5, chapters 3 and 4
  const ch = lower.match(/chapters?\s+(\d+)(?:\s*(?:[-–]|to|through|and|&)\s*(\d+))?/);
  if (ch) s.chapters = ch[2] ? Math.max(1, Math.abs(Number(ch[2]) - Number(ch[1])) + 1) : 1;

  // problems / questions
  const counts = [];
  const pr = lower.match(/(?:problems?|questions?|exercises?)\s+(\d+)\s*(?:[-–]|to|through)\s*(\d+)/);
  if (pr) counts.push(Number(pr[2]) - Number(pr[1]) + 1);
  for (const m of lower.matchAll(/(\d+)\s+(?:[a-z-]+\s+)?(?:problems|questions|exercises)\b/g)) counts.push(Number(m[1]));
  const nums = [...text.matchAll(/^\s*(?:q(?:uestion)?\s*)?(\d{1,2})[.):]/gim)].map((m) => Number(m[1]));
  const lettered = (text.match(/^\s*[a-z][.)]\s+\S/gim) || []).length;
  if (nums.length >= 2) counts.push(Math.max(...nums));
  if (lettered >= 2 && !nums.length) counts.push(lettered);
  const best = counts.filter((n) => n > 0 && n < 200);
  if (best.length) s.problems = Math.max(...best);

  // sources
  const src = lower.match(/(\d+)\s+(?:[a-z-]+\s+){0,2}(?:sources|references|citations)\b/);
  if (src) s.sources = Number(src[1]);

  // discussion replies
  const rep = lower.match(/repl(?:y|ies)\s+to\s+(?:at least\s+)?(\d+)/) || lower.match(/(\d+)\s+(?:replies|responses|classmates|peers)\b/);
  if (rep) s.replies = Number(rep[1]);

  // video / audio minutes
  const med = lower.match(/(\d+)\s*[- ]?(min|minutes?|hours?|hrs?)\s+(?:video|lecture|podcast|recording|documentary)/) || lower.match(/(?:watch|view|listen)[^.\n]{0,40}?(\d+)\s*[- ]?(min|minutes?|hours?|hrs?)\b/);
  if (med) s.mediaMinutes = Number(med[1]) * (/^h/.test(med[2]) ? 60 : 1);

  const sl = lower.match(/(\d+)\s*[- ]?slides?\b/);
  if (sl) s.slides = Number(sl[1]);

  s.proofs = /\bproofs?\b|\bprove\b/.test(lower);
  s.showWork = /show (?:all )?(?:your )?(?:work|steps)/.test(lower);
  s.group = /\bgroup\b|\bteam\b|\bpartners?\b/.test(lower);
  s.outline = /\boutline\b|\bproposal\b|\brough draft\b|\bfirst draft\b|annotated bibliography/.test(lower);
  s.citationStyle = /\bapa\b|\bmla\b|\bchicago\b|\bcite\b|\bcitations?\b/.test(lower);
  s.tests = /unit tests?|\btest cases?\b|write tests/.test(lower);
  s.writeup = /readme|write-?up|\breport\b|\breflection\b/.test(lower);
  s.final = /\bfinal\b|\bcumulative\b|\bcomprehensive\b/.test(lower);
  s.deliverables = ["presentation", "report", "poster", "video", "paper", "demo", "prototype", "slides", "code", "website"].filter((d) => lower.includes(d)).length;
  return s;
}

// ---- per-type time models ----
const round5 = (m) => Math.max(5, Math.round(m / 5) * 5);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1)).toString();

function model(type, s) {
  const steps = [];
  const used = []; // numeric signals that actually drove the estimate
  const add = (step, minutes) => {
    if (minutes > 0) steps.push({ step, minutes: round5(minutes) });
  };

  switch (type) {
    case "writing": {
      let words = s.words ? Math.max(...s.words) : null;
      if (words) used.push("words");
      else if (s.pageCount) {
        words = s.pageCount * (s.singleSpaced ? RATES.wordsPerPageSingle : RATES.wordsPerPageDouble);
        used.push("pages");
      }
      const n = Math.round(words || DEFAULTS.writingWords);
      add(`Draft and revise ~${n} words${words ? "" : " (length not stated, assumed)"}`, n / RATES.writeWordsPerMin);
      if (s.sources) {
        used.push("sources");
        add(`Find and use ${plural(s.sources, "source")}`, s.sources * RATES.perSource);
      }
      if (s.outline) add("Outline / draft stage", RATES.outline);
      if (s.citationStyle) add("Citations and formatting", RATES.citations);
      add("Read instructions and set up", RATES.writingSetup);
      break;
    }
    case "reading": {
      let pages = s.readPages;
      if (pages) used.push("pages");
      else if (s.chapters) {
        pages = s.chapters * RATES.pagesPerChapter;
        used.push("chapters");
      } else if (s.pageCount) {
        pages = s.pageCount;
        used.push("pages");
      }
      const n = Math.round(pages || DEFAULTS.readingPages);
      add(`Read ~${n} pages${pages ? "" : " (length not stated, assumed)"}`, n * RATES.readPerPage);
      if (s.problems) {
        used.push("questions");
        add(`Answer ${plural(s.problems, "question")}`, s.problems * RATES.perReadingQuestion);
      }
      add("Notes and review", RATES.readNotes);
      break;
    }
    case "problem-set": {
      const n = s.problems || DEFAULTS.problems;
      if (s.problems) used.push("problems");
      let per = RATES.perProblem;
      if (s.proofs) per *= RATES.proofFactor;
      if (s.showWork) per *= RATES.showWorkFactor;
      add(`Solve ${plural(n, "problem")} (~${fmt(Math.round(per))}m each${s.problems ? "" : ", count not stated"})`, n * per);
      add("Setup and checking", RATES.problemSetup);
      break;
    }
    case "coding": {
      const items = s.problems || 0;
      let base = RATES.codeBase;
      if (items) {
        used.push("requirements");
        add(`Implement ${plural(items, "requirement")}`, base + items * RATES.perRequirement);
      } else {
        add("Implement (scope not itemized)", base + Math.min(120, s.instructionWords / 8));
      }
      if (s.tests) add("Write tests", RATES.codeTests);
      if (s.writeup) add("Write-up / README", RATES.codeWriteup);
      break;
    }
    case "discussion": {
      const w = s.words ? s.words[0] : DEFAULTS.postWords;
      if (s.words) used.push("words");
      const replies = s.replies ?? DEFAULTS.replies;
      if (s.replies !== undefined) used.push("replies");
      add(`Write your post (~${Math.round(w)} words)`, w / RATES.writeWordsPerMin);
      add(`Reply to ${plural(replies, "classmate")}`, replies * RATES.perReply);
      add("Read the prompt and materials", RATES.postSetup);
      break;
    }
    case "lab": {
      let w = s.words ? Math.max(...s.words) : null;
      if (w) used.push("words");
      else if (s.pageCount) {
        w = s.pageCount * (s.singleSpaced ? RATES.wordsPerPageSingle : RATES.wordsPerPageDouble);
        used.push("pages");
      }
      add("Lab work and data", RATES.labBase);
      add(w ? `Write the report (~${Math.round(w)} words)` : "Write the report (length not stated)", (w || DEFAULTS.labWords) / RATES.writeWordsPerMin);
      break;
    }
    case "exam-prep": {
      let m;
      if (s.chapters) {
        used.push("chapters");
        m = s.chapters * RATES.perChapterStudy;
        add(`Study ${plural(s.chapters, "chapter")}`, m);
      } else {
        m = RATES.examDefault;
        add("Study for the exam (coverage not stated)", m);
      }
      if (s.final) add("Cumulative / final material", m * (RATES.examFinalFactor - 1));
      break;
    }
    case "project": {
      const extra = Math.max(0, s.deliverables - 1);
      if (extra) used.push("deliverables");
      const core = RATES.projectBase * (1 + RATES.perExtraDeliverable * extra);
      add(`Core project work${extra ? ` (${plural(extra + 1, "deliverable")})` : ""}`, core);
      let sub = core;
      if (s.slides) {
        used.push("slides");
        add(`Build ${plural(s.slides, "slide")}`, s.slides * RATES.perSlide);
        sub += s.slides * RATES.perSlide;
      }
      if (s.group) add("Group coordination", sub * RATES.groupFactor);
      break;
    }
    default: {
      add("General work", Math.min(120, Math.max(15, 30 + s.instructionWords / 40)));
    }
  }

  if (s.mediaMinutes) {
    used.push("media");
    add(`Watch / listen (${s.mediaMinutes}m of media)`, s.mediaMinutes * RATES.mediaFactor);
  }
  return { steps, used };
}

/**
 * Pass `type` to use a type you picked instead of guessing it.
 * @returns {{type, minutes, confidence, breakdown, reasoning, method:'local'}}
 */
export function estimateLocal({ course, title, instructions, type: picked }) {
  const type = TYPES.includes(picked) ? picked : classify(title, instructions, course);
  const signals = extractSignals(instructions);
  const { steps, used } = model(type, signals);

  const total = steps.reduce((sum, x) => sum + x.minutes, 0);
  const minutes = Math.max(10, Math.min(6000, round5(total)));
  const confidence = used.length >= 2 ? "high" : used.length === 1 ? "medium" : "low";

  const kind = {
    writing: "a writing assignment",
    reading: "a reading assignment",
    "problem-set": "a problem set",
    coding: "a coding assignment",
    project: "a project",
    "exam-prep": "exam prep",
    discussion: "a discussion post",
    lab: "a lab",
  }[type] || "general work";
  const LABELS = {
    words: "word count",
    pages: "page count",
    chapters: "chapters",
    sources: "number of sources",
    questions: "questions",
    problems: "number of problems",
    requirements: "listed requirements",
    replies: "required replies",
    deliverables: "deliverables",
    slides: "slide count",
    media: "video/audio length",
  };
  const names = [...new Set(used)].map((u) => LABELS[u] || u);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const basis = names.length ? ` Based on the ${list} in the instructions.` : "";
  const hint =
    confidence === "low" ? " The instructions didn't give much to measure, so this is a rough guess. Adjust it if you know better." : "";
  return {
    type,
    minutes,
    confidence,
    breakdown: steps,
    reasoning: `${TYPES.includes(picked) ? "Estimated as" : "Looks like"} ${kind}.${basis}${hint}`,
    method: "local",
  };
}
