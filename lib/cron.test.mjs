import assert from "node:assert/strict";
import test from "node:test";

import { cronMatches, describeCron, isValidCron, parseCron } from "./cron.ts";

function at(iso) {
  // Construct a local-time date; cron matches on local time.
  return new Date(iso);
}

test("parses a simple 5-field expression", () => {
  const spec = parseCron("0 9 * * *");
  assert.ok(!("error" in spec));
  assert.deepEqual([...spec.minute.values], [0]);
  assert.deepEqual([...spec.hour.values], [9]);
  assert.equal(spec.dayOfMonth.restricted, false);
  assert.equal(spec.dayOfWeek.restricted, false);
});

test("rejects wrong field counts and invalid tokens", () => {
  assert.ok("error" in parseCron(""));
  assert.ok("error" in parseCron("* * * *"));
  assert.ok("error" in parseCron("* * * * * *"));
  assert.ok("error" in parseCron("60 * * * *"));
  assert.ok("error" in parseCron("* 24 * * *"));
  assert.ok("error" in parseCron("* * 0 * *"));
  assert.ok("error" in parseCron("* * * 13 *"));
  assert.ok("error" in parseCron("* * * * 8"));
  assert.ok("error" in parseCron("abc * * * *"));
  assert.ok("error" in parseCron("5-2 * * * *"));
  assert.ok("error" in parseCron("*/0 * * * *"));
});

test("isValidCron mirrors parseCron", () => {
  assert.equal(isValidCron("0 9 * * *"), true);
  assert.equal(isValidCron("nope"), false);
});

test("matches an exact daily time", () => {
  const spec = parseCron("30 9 * * *");
  assert.equal(cronMatches(spec, at("2026-03-02T09:30:00")), true);
  assert.equal(cronMatches(spec, at("2026-03-02T09:31:00")), false);
  assert.equal(cronMatches(spec, at("2026-03-02T10:30:00")), false);
});

test("supports lists, ranges, and steps", () => {
  const list = parseCron("0,30 * * * *");
  assert.equal(cronMatches(list, at("2026-03-02T10:00:00")), true);
  assert.equal(cronMatches(list, at("2026-03-02T10:30:00")), true);
  assert.equal(cronMatches(list, at("2026-03-02T10:15:00")), false);

  const range = parseCron("0 9-17 * * *");
  assert.equal(cronMatches(range, at("2026-03-02T09:00:00")), true);
  assert.equal(cronMatches(range, at("2026-03-02T17:00:00")), true);
  assert.equal(cronMatches(range, at("2026-03-02T18:00:00")), false);

  const step = parseCron("*/15 * * * *");
  assert.equal(cronMatches(step, at("2026-03-02T10:00:00")), true);
  assert.equal(cronMatches(step, at("2026-03-02T10:15:00")), true);
  assert.equal(cronMatches(step, at("2026-03-02T10:45:00")), true);
  assert.equal(cronMatches(step, at("2026-03-02T10:20:00")), false);

  const rangeStep = parseCron("0-30/10 * * * *");
  assert.deepEqual([...rangeStep.minute.values].sort((a, b) => a - b), [0, 10, 20, 30]);
});

test("treats ? like * and never restricts", () => {
  const spec = parseCron("0 12 ? * ?");
  assert.equal(spec.dayOfMonth.restricted, false);
  assert.equal(spec.dayOfWeek.restricted, false);
  assert.equal(cronMatches(spec, at("2026-03-02T12:00:00")), true);
});

test("day-of-week accepts both 0 and 7 for Sunday", () => {
  const zero = parseCron("0 0 * * 0");
  const seven = parseCron("0 0 * * 7");
  // 2026-03-01 is a Sunday.
  assert.equal(cronMatches(zero, at("2026-03-01T00:00:00")), true);
  assert.equal(cronMatches(seven, at("2026-03-01T00:00:00")), true);
  assert.equal(cronMatches(zero, at("2026-03-02T00:00:00")), false);
});

test("OR semantics when both day-of-month and day-of-week are restricted", () => {
  // Run on the 15th OR on Mondays.
  const spec = parseCron("0 0 15 * 1");
  assert.equal(spec.dayOfMonth.restricted, true);
  assert.equal(spec.dayOfWeek.restricted, true);
  // 2026-03-15 is a Sunday -> matches by day-of-month.
  assert.equal(cronMatches(spec, at("2026-03-15T00:00:00")), true);
  // 2026-03-02 is a Monday -> matches by day-of-week.
  assert.equal(cronMatches(spec, at("2026-03-02T00:00:00")), true);
  // 2026-03-03 is a Tuesday, not the 15th -> no match.
  assert.equal(cronMatches(spec, at("2026-03-03T00:00:00")), false);
});

test("AND semantics when only one of DOM/DOW is restricted", () => {
  // Only Mondays (DOM is *).
  const spec = parseCron("0 0 * * 1");
  assert.equal(cronMatches(spec, at("2026-03-02T00:00:00")), true); // Monday
  assert.equal(cronMatches(spec, at("2026-03-03T00:00:00")), false); // Tuesday
});

test("month restriction", () => {
  const spec = parseCron("0 0 1 1 *");
  assert.equal(cronMatches(spec, at("2026-01-01T00:00:00")), true);
  assert.equal(cronMatches(spec, at("2026-02-01T00:00:00")), false);
});

test("describeCron produces readable summaries", () => {
  assert.equal(describeCron("0 9 * * *"), "At 09:00 every day");
  assert.equal(describeCron("*/5 * * * *"), "Every 5 minutes");
  assert.equal(describeCron("* * * * *"), "Every minute");
  assert.equal(describeCron("0 * * * *"), "Every hour");
  assert.match(describeCron("30 9 * * 1"), /Monday/);
  assert.match(describeCron("0 0 1 * *"), /day 1 of the month/);
  assert.match(describeCron("nope"), /Invalid schedule/);
});
