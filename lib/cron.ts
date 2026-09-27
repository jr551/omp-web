/**
 * A small, self-contained standard 5-field cron evaluator.
 *
 * Fields (in order): minute hour day-of-month month day-of-week.
 * Supported syntax per field:
 *   - `*`            every value
 *   - `?`            treated as `*` (unspecified), and never counts as a restriction
 *   - `a`            a single value
 *   - `a,b,c`        a list of values / sub-expressions
 *   - `a-b`          an inclusive range
 *   - `* /n`         a step over the whole range (written without the space)
 *   - `a-b/n`        a step over a range
 *   - `* /n` etc.    steps combine with ranges and `*`
 *
 * Day-of-week accepts 0-7 where both 0 and 7 mean Sunday. When BOTH the
 * day-of-month and day-of-week fields are restricted (neither `*`/`?`), a date
 * matches if EITHER field matches — the standard Vixie-cron OR semantics.
 *
 * No external dependency; used by the Routines scheduler.
 */

export interface CronField {
  /** Set of allowed integer values for this field. */
  values: Set<number>;
  /** True when the field constrains matching (not `*` and not `?`). */
  restricted: boolean;
}

export interface CronSpec {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export interface CronParseError {
  error: string;
}

interface FieldRange {
  name: string;
  min: number;
  max: number;
}

const FIELD_RANGES: FieldRange[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function parseInteger(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  return Number(token);
}

/** Parse one comma-free sub-expression: a wildcard, single value, range, or step. */
function parseFieldPart(part: string, range: FieldRange): Set<number> | { error: string } {
  const [rangePart, stepPart, ...rest] = part.split("/");
  if (rest.length > 0) return { error: `invalid step in "${part}"` };

  let step = 1;
  if (stepPart !== undefined) {
    const parsedStep = parseInteger(stepPart);
    if (parsedStep === null || parsedStep < 1) return { error: `invalid step "${stepPart}" in "${part}"` };
    step = parsedStep;
  }

  let start = range.min;
  let end = range.max;

  if (rangePart === "*" || rangePart === "?") {
    // Wildcard bounds; step (if any) applies across the whole range.
  } else if (rangePart.includes("-")) {
    const [lowToken, highToken, ...extra] = rangePart.split("-");
    if (extra.length > 0) return { error: `invalid range "${rangePart}"` };
    const low = parseInteger(lowToken);
    const high = parseInteger(highToken);
    if (low === null || high === null) return { error: `invalid range "${rangePart}"` };
    if (low < range.min || high > range.max || low > high) {
      return { error: `range "${rangePart}" out of bounds for ${range.name} (${range.min}-${range.max})` };
    }
    start = low;
    end = high;
  } else {
    const single = parseInteger(rangePart);
    if (single === null) return { error: `invalid value "${rangePart}" in ${range.name}` };
    if (single < range.min || single > range.max) {
      return { error: `value "${single}" out of bounds for ${range.name} (${range.min}-${range.max})` };
    }
    // A single value with no step is exactly that value.
    if (stepPart === undefined) return new Set([single]);
    // `a/n` steps from the single value up to the field maximum (cron behavior).
    start = single;
    end = range.max;
  }

  const values = new Set<number>();
  for (let value = start; value <= end; value += step) values.add(value);
  if (values.size === 0) return { error: `"${part}" matches no values for ${range.name}` };
  return values;
}

function parseField(token: string, range: FieldRange): CronField | { error: string } {
  const trimmed = token.trim();
  if (trimmed.length === 0) return { error: `empty ${range.name} field` };
  const restricted = trimmed !== "*" && trimmed !== "?";

  const values = new Set<number>();
  for (const part of trimmed.split(",")) {
    const parsed = parseFieldPart(part.trim(), range);
    if ("error" in parsed && parsed.error !== undefined) return { error: parsed.error };
    for (const value of parsed as Set<number>) values.add(value);
  }

  // Normalize day-of-week so both 0 and 7 mean Sunday.
  if (range.name === "day-of-week" && (values.has(0) || values.has(7))) {
    values.add(0);
    values.add(7);
  }

  return { values, restricted };
}

/** Parse a 5-field cron expression, or return `{ error }`. */
export function parseCron(expr: string): CronSpec | CronParseError {
  if (typeof expr !== "string") return { error: "cron expression must be a string" };
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return { error: `expected 5 cron fields, got ${fields.length}` };
  }

  const parsed: CronField[] = [];
  for (let index = 0; index < FIELD_RANGES.length; index += 1) {
    const field = parseField(fields[index], FIELD_RANGES[index]);
    if ("error" in field && (field as CronParseError).error !== undefined) {
      return { error: (field as CronParseError).error };
    }
    parsed.push(field as CronField);
  }

  return {
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
  };
}

/** Whether a given local Date matches the parsed cron spec. */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.has(date.getMinutes())) return false;
  if (!spec.hour.values.has(date.getHours())) return false;
  if (!spec.month.values.has(date.getMonth() + 1)) return false;

  const domMatch = spec.dayOfMonth.values.has(date.getDate());
  const dowMatch = spec.dayOfWeek.values.has(date.getDay());

  // Standard cron OR semantics: when both DOM and DOW are restricted, either one
  // matching is enough. Otherwise a `*` field always matches and they AND.
  if (spec.dayOfMonth.restricted && spec.dayOfWeek.restricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isFullRange(field: CronField, range: FieldRange): boolean {
  if (field.restricted) return false;
  return field.values.size === range.max - range.min + 1;
}

function describeStepField(token: string, singular: string): string | null {
  const trimmed = token.trim();
  if (trimmed === "*" || trimmed === "?") return `every ${singular}`;
  const match = /^\*\/(\d+)$/.exec(trimmed);
  if (!match) return null;
  const step = Number(match[1]);
  return step === 1 ? `every ${singular}` : `every ${step} ${singular}s`;
}

/**
 * A human-readable summary for the UI, e.g. "Every day at 09:00".
 * Handles the common cases precisely and falls back to a compact description.
 */
export function describeCron(expr: string): string {
  const spec = parseCron(expr);
  if ("error" in spec && (spec as CronParseError).error !== undefined) {
    return `Invalid schedule: ${(spec as CronParseError).error}`;
  }
  const cron = spec as CronSpec;
  const fields = expr.trim().split(/\s+/);
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = fields;

  const minuteEvery = describeStepField(minuteToken, "minute");
  if (minuteEvery && hourToken === "*" && domToken === "*" && monthToken === "*"
    && (dowToken === "*" || dowToken === "?")) {
    return capitalize(minuteEvery);
  }

  const hourEvery = describeStepField(hourToken, "hour");
  if (minuteToken === "0" && hourEvery && domToken === "*" && monthToken === "*"
    && (dowToken === "*" || dowToken === "?")) {
    return capitalize(hourEvery);
  }

  // A single minute + single hour is a specific time of day.
  const singleMinute = cron.minute.values.size === 1 ? [...cron.minute.values][0] : null;
  const singleHour = cron.hour.values.size === 1 ? [...cron.hour.values][0] : null;

  let timePhrase: string;
  if (singleMinute !== null && singleHour !== null) {
    timePhrase = `at ${pad2(singleHour)}:${pad2(singleMinute)}`;
  } else if (singleMinute !== null && isFullRange(cron.hour, FIELD_RANGES[1])) {
    timePhrase = `at ${pad2(singleMinute)} minutes past every hour`;
  } else {
    timePhrase = `at ${summarizeValues(cron.minute, "minute")} ${summarizeValues(cron.hour, "hour")}`.trim();
  }

  const dowSpecified = dowToken !== "*" && dowToken !== "?";
  const domSpecified = domToken !== "*" && domToken !== "?";
  const monthSpecified = monthToken !== "*" && monthToken !== "?";

  const dayParts: string[] = [];
  if (dowSpecified) {
    const days = [...cron.dayOfWeek.values].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
    dayParts.push(`on ${days.map((day) => DAY_NAMES[day]).join(", ")}`);
  }
  if (domSpecified) {
    dayParts.push(`on day ${[...cron.dayOfMonth.values].sort((a, b) => a - b).join(", ")} of the month`);
  }
  if (monthSpecified) {
    const months = [...cron.month.values].sort((a, b) => a - b).map((month) => MONTH_NAMES[month - 1]);
    dayParts.push(`in ${months.join(", ")}`);
  }

  const when = dayParts.length > 0 ? dayParts.join(" ") : "every day";
  return capitalize(`${timePhrase} ${when}`.trim());
}

function summarizeValues(field: CronField, label: string): string {
  const sorted = [...field.values].sort((a, b) => a - b);
  if (sorted.length <= 4) return `${label} ${sorted.join(",")}`;
  return `${label}s ${sorted[0]}-${sorted[sorted.length - 1]}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** Convenience: true when `expr` parses without error. */
export function isValidCron(expr: string): boolean {
  const spec = parseCron(expr);
  return !("error" in spec && (spec as CronParseError).error !== undefined);
}
