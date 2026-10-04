import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateLocal, extractSignals, classify } from "../server/estimator.js";

const est = (course, title, instructions) => estimateLocal({ course, title, instructions });
const inRange = (m, lo, hi) => assert.ok(m >= lo && m <= hi, `expected ${lo}-${hi}, got ${m}`);

test("essay with word range and sources", () => {
  const e = est("ENG 101", "Argumentative Essay", "Write a 1,500-2,000 word argumentative essay. Use at least four scholarly sources, cited in MLA format.");
  assert.equal(e.type, "writing");
  assert.equal(e.confidence, "high");
  inRange(e.minutes, 300, 600);
});

test("problem set uses the problem range and show-your-work", () => {
  const e = est("MATH 221", "Homework 5", "Complete problems 1-15 from section 3.2. Show all your work.");
  assert.equal(e.type, "problem-set");
  inRange(e.minutes, 150, 300);
});

test("reading chapters with numbered questions", () => {
  const e = est("HIST 110", "Week 6 Reading", "Read chapters 7 and 8 of the textbook and answer:\n1. Why did the war begin?\n2. Who benefited?\n3. What changed?");
  assert.equal(e.type, "reading");
  inRange(e.minutes, 100, 240);
});

test("discussion post with replies", () => {
  const e = est("PSY 100", "Discussion 4", "Initial post of at least 250 words responding to the prompt. Then reply to two classmates.");
  assert.equal(e.type, "discussion");
  inRange(e.minutes, 45, 120);
});

test("a 'Project' that is really code is classified as coding", () => {
  const e = est("CS 1301", "Project 2", "Implement an inventory system in Python.\n1. Add items\n2. Remove items\n3. Search\n4. Save\n5. Load\nInclude unit tests and a README.");
  assert.equal(e.type, "coding");
  inRange(e.minutes, 180, 420);
});

test("lab report uses page count", () => {
  const e = est("BIO 201", "Lab 3 report", "Write a lab report (3-4 pages, double-spaced) on the enzyme experiment.");
  assert.equal(e.type, "lab");
  inRange(e.minutes, 180, 360);
});

test("exam prep scales with chapters", () => {
  const e = est("CHEM 101", "Midterm", "Study for the midterm covering chapters 1 through 5.");
  assert.equal(e.type, "exam-prep");
  inRange(e.minutes, 180, 300);
});

test("group presentation", () => {
  const e = est("COMM 200", "Group presentation", "With your group, create a 12 slide presentation and a short report.");
  assert.equal(e.type, "project");
  inRange(e.minutes, 300, 720);
});

test("media time is added", () => {
  const e = est("ENG 101", "Response", "Watch the 45 minute documentary and write a 500 word response.");
  assert.ok(e.breakdown.some((b) => /45m of media/.test(b.step)));
});

test("vague one-liner gets a low-confidence default", () => {
  const e = est("ART 100", "Sketch", "Do it.");
  assert.equal(e.confidence, "low");
  inRange(e.minutes, 15, 120);
});

test("signal extraction: ranges, pages, number words", () => {
  assert.deepEqual(extractSignals("500-750 words").words, [625]);
  assert.equal(extractSignals("a 5 page paper").pageCount, 5);
  assert.equal(extractSignals("read pp. 45-72").readPages, 28);
  assert.equal(extractSignals("use three sources").sources, 3);
  assert.equal(extractSignals("reply to at least 2 peers").replies, 2);
});

test("pages convert to words (single vs double spaced)", () => {
  const dbl = est("ENG", "Paper", "Write a 4 page paper, double-spaced.");
  const sgl = est("ENG", "Paper", "Write a 4 page paper, single-spaced.");
  assert.ok(sgl.minutes > dbl.minutes);
});

test("course name nudges the type when the text is ambiguous", () => {
  assert.equal(classify("Assignment 3", "Complete the assignment.", "CS 2110"), "other");
  assert.equal(classify("Assignment 3", "Implement the functions.", "CS 2110"), "coding");
});

test("a type you pick replaces the guess", () => {
  const input = { course: "ENG 101", title: "Essay", instructions: "Write 800 words." };
  assert.equal(estimateLocal(input).type, "writing");
  const picked = estimateLocal({ ...input, type: "discussion" });
  assert.equal(picked.type, "discussion");
  assert.match(picked.reasoning, /^Estimated as a discussion post\./);
  assert.equal(estimateLocal({ ...input, type: "nonsense" }).type, "writing");
});

test("deterministic: same input, same output", () => {
  const input = ["ENG 101", "Essay", "Write 1000 words using 3 sources."];
  assert.deepEqual(est(...input), est(...input));
});

test("breakdown sums to the total (within rounding)", () => {
  const e = est("ENG 101", "Essay", "Write 1200 words with 5 sources in APA. Submit an outline.");
  const sum = e.breakdown.reduce((s, b) => s + b.minutes, 0);
  assert.ok(Math.abs(sum - e.minutes) <= 5);
});
