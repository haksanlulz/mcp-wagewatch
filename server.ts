// mcp-wagewatch: MCP server over the U.S. Department of Labor
// Wage and Hour Division (WHD) enforcement dataset (WHISARD compliance actions).
//
// Data source: DOL Open Data API, dataset agency "WHD", endpoint "enforcement".
//   Base:   https://apiprod.dol.gov/v4
//   Query:  GET /get/WHD/enforcement/json?limit=..&offset=..&sort=..&sort_by=..&fields=..&filter_object=..
//   Auth:   X-API-KEY as a QUERY PARAMETER (the v4 API 401s the header form)
// The dataset holds every concluded WHD compliance action since FY2005: violations
// found, back wages agreed to pay, employees affected, and civil money penalties.
//
// This module normalizes the raw WHISARD column names (trade_nm, bw_atp_amt,
// ee_violtd_cnt, ...) into clean, documented tool outputs. See README.md for the
// field map and sources.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// API constants
// ---------------------------------------------------------------------------

const DOL_API = "https://apiprod.dol.gov/v4";
const WHD_AGENCY = "WHD";
const WHD_ENDPOINT = "enforcement";
/** Where to get a free DOL Open Data API key. */
const KEY_SIGNUP_URL = "https://dataportal.dol.gov/registration";
/** Descriptive User-Agent (DOL Open Data is a free public service; be identifiable). */
const UA = "mcp-wagewatch/1.0 (+https://github.com/haksanlulz/mcp-wagewatch)";
/** Minimum spacing between outbound API calls (polite throttle). */
const THROTTLE_MS = 150;
/** DOL API hard ceiling is 10,000 records / 5MB per request; we stay well under. */
const MAX_PAGE = 100;
const SUMMARY_CAP = 1000;

// WHISARD has NO single total-CMP dollar field (cmp_assd_cnt is a COUNT of
// assessments), so a dollar total is summed across the statute-level
// *_cmp_assd_amt columns. That rule has exactly one owner — the pattern in
// totalCivilPenalties, which scans whatever the row carries. A hardcoded list
// of the eleven column names used to sit here as well, restricting
// back_wages_summary's `fields` payload; see that tool for why it is gone.

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Read the DOL API key from the environment, or throw a clear setup error. */
function apiKey(): string {
  const key = process.env.DOL_API_KEY?.trim();
  if (!key) {
    throw new Error(
      `DOL_API_KEY is not set. Get a free key at ${KEY_SIGNUP_URL} and set DOL_API_KEY in your environment.`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Throttled fetch queue (serialize calls, >=150ms apart)
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` after all prior throttled calls, leaving at least THROTTLE_MS
 * between one call SETTLING and the next one starting.
 *
 * Say it that way round, because it is not start-to-start spacing: the gap is
 * chained onto the previous call's settle, so the real interval between two
 * request starts is upstream latency plus THROTTLE_MS. That is the
 * conservative direction against a shared free federal API and it is the
 * intent — but a scan whose mock answers instantly cannot tell the two apart,
 * and this docstring claimed the stricter property for a while on the strength
 * of one. The returned promise settles as soon as `fn` does, so a caller never
 * waits out the gap. `fn` runs on both settle paths, so a prior rejection
 * cannot stall the queue.
 */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => new Promise((r) => setTimeout(r, THROTTLE_MS)),
    () => new Promise((r) => setTimeout(r, THROTTLE_MS)),
  );
  return run;
}

// ---------------------------------------------------------------------------
// Low-level API access
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FilterNode {
  field: string;
  operator: "eq" | "neq" | "gt" | "lt" | "in" | "not_in" | "like";
  value: unknown;
}
type FilterObject = FilterNode | { and: FilterObject[] } | { or: FilterObject[] };

interface QueryParams {
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
  sort_by?: string;
  fields?: string[];
  filter?: FilterObject;
}

/** Pull the record array out of the DOL response envelope, defensively. */
// DOL's endpoint is public and shared, so a 429 or a 5xx is a "come back", not a
// verdict. Ported from mcp-housing, which learned this the expensive way: with no
// retry, most sweeps came back PARTIAL and a downstream baseline never advanced.
//
// Retried: 429, 5xx, and transport errors. NOT retried: other 4xx -- a bad filter
// or a rejected key is our mistake, and repeating it just spends the budget to be
// told twice. Note 204 is NOT an error here at all (see dolGet): DOL answers an
// empty body for a zero-match filter, which is a real answer.
//
// Each attempt re-enters throttled(), so the spacing floor holds across retries,
// and RETRY_DEADLINE_MS bounds total wall-clock because an MCP client has its own
// call timeout.
class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// A response we understood well enough to know it will not improve: a non-JSON
// body, or a shape this code does not recognise. Usually a rejected key, which
// answers identically however many times it is asked.
class PermanentError extends Error {}

/**
 * Read an integer tuning knob from the environment, or fall back to the
 * documented default and say so on stderr.
 *
 * `Number(process.env.X ?? default)` put nothing between an operator's typo and
 * the code. DOL_HTTP_ATTEMPTS=abc made the attempt ceiling NaN, so `attempt <
 * NaN` was false on the first pass, the retry loop never ran, and withRetry
 * threw its uninitialised `last` — which a real MCP call rendered as the text
 * "Error: undefined". DOL_HTTP_ATTEMPTS=0 reached the same dead loop. A NaN
 * cache TTL is worse than either: this server's MUST NEVER is stale data
 * presented as current, and `Date.now() - at > NaN` is false forever, so the
 * cache would never expire.
 *
 * Read at USE time, not at import: a module-level const cannot be exercised by a
 * test without reloading the module, and a knob nothing can test is a knob
 * nothing has tested. The warning is emitted once per distinct bad value so a
 * long-lived server does not repeat itself, and it goes to stderr because stdout
 * is the MCP transport.
 */
const warnedEnv = new Set<string>();
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    const seen = `${name}=${raw}`;
    if (!warnedEnv.has(seen)) {
      warnedEnv.add(seen);
      console.error(
        `mcp-wagewatch: ignoring ${name}=${JSON.stringify(raw)} (expected a whole number >= ${min}); using ${fallback}.`,
      );
    }
    return fallback;
  }
  return n;
}

/** Exported for tests: the warn-once memo must not leak between cases. */
export function resetEnvWarnings(): void {
  warnedEnv.clear();
}

const DEFAULT_HTTP_ATTEMPTS = 3;
/** Total attempts per request, >= 1 (1 disables retrying). */
const httpAttempts = () => envInt("DOL_HTTP_ATTEMPTS", DEFAULT_HTTP_ATTEMPTS, 1);
const RETRY_BACKOFF_MS = [500, 2000];
const RETRY_DEADLINE_MS = 40_000;
const HTTP_TIMEOUT_MS = 15_000;

function isRetryable(e: unknown): boolean {
  if (e instanceof PermanentError) return false;
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  return true; // transport error or abort
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const attempts = httpAttempts(); // read once: the ceiling cannot move mid-loop
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === attempts - 1 || !isRetryable(e)) break;
      const backoff = RETRY_BACKOFF_MS[attempt] ?? 2000;
      if (Date.now() - started + backoff + HTTP_TIMEOUT_MS > RETRY_DEADLINE_MS) break;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}

function extractRows(json: unknown): Row[] {
  if (Array.isArray(json)) return json as Row[];
  if (json && typeof json === "object") {
    const obj = json as Row;
    for (const key of ["data", "records", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as Row[];
    }
  }
  // Anything that is not an array and carries no known record array is an answer
  // this code does not understand: an error envelope ({"status":"error",
  // "message":"quota exceeded"}), a bare JSON string, a number, or a literal
  // null. Reading ANY of them as an empty result set reports a false "0 cases" /
  // "no wage-theft history", so reject rather than fail open.
  //
  // The object case was rejected here from the start and the rest fell through a
  // trailing `return []`, which is the same fail-open one type away: a 200
  // carrying `null` or `"quota exceeded"` rendered as count 0 plus the
  // name-retry hint, isError undefined.
  //
  // A genuinely empty answer never reaches this function: dolGetOnce returns []
  // for a 204 or an empty body before JSON.parse is called.
  throw new PermanentError(
    "DOL API returned an unrecognized response: " + JSON.stringify(json).slice(0, 300),
  );
}

/**
 * DOL's filter engine 500s on numeric JSON values ("There was a server error
 * querying the dataset") and only accepts strings — verified live 2026-08-23
 * with {value: 0} failing and {value: "0"} succeeding. Coerce every leaf
 * value at serialization time so no call site can reintroduce the bug.
 */
function stringifyFilterValues(node: FilterObject): FilterObject {
  if ("and" in node) return { and: node.and.map(stringifyFilterValues) };
  if ("or" in node) return { or: node.or.map(stringifyFilterValues) };
  return { ...node, value: Array.isArray(node.value) ? node.value.map(String) : String(node.value) };
}

/** Execute one GET against the WHD/enforcement endpoint and return raw rows. */
// DOL's WHD enforcement dataset is a record of CONCLUDED cases, so a repeat
// query inside a session is asking about history that has already happened. A
// day is a conservative TTL against a dataset that updates in batches.
//
// In memory, LRU-bounded, successful reads only -- caching an error would pin a
// transient failure for the life of the process. DOL_CACHE_TTL_MS=0 disables it.
//
// Keyed on the query params, deliberately NOT on the request URL: the API key
// rides in the query string (see dolGetOnce), and a cache key built from the URL
// would put the key in a Map that error messages and debug dumps can reach.
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX = 300;
/** Entry lifetime in ms; 0 disables the cache. Validated (see envInt). */
const cacheTtlMs = () => envInt("DOL_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS, 0);
/** Entries kept before the oldest is evicted, >= 1. */
const cacheMax = () => envInt("DOL_CACHE_MAX", DEFAULT_CACHE_MAX, 1);
const cache = new Map<string, { at: number; rows: Row[] }>();

function cacheGet(key: string): Row[] | undefined {
  const ttl = cacheTtlMs();
  if (ttl <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key); // re-insert so Map order is LRU
  cache.set(key, hit);
  return hit.rows;
}

/**
 * Total cached ROWS across all entries, the second ceiling.
 *
 * Entry count alone stopped bounding memory when back_wages_summary dropped its
 * `fields` projection: one entry is now up to max_cases+1 WHOLE WHISARD rows, a
 * row is ~2.8 KB across 110 columns (measured 2026-09-14), so a single default
 * aggregate entry is ~2.8 MB of JSON and DOL_CACHE_MAX's default of 300 put the
 * ceiling near 840 MB -- in a stdio process whose whole job is to stay up.
 * 20,000 rows is ~56 MB of JSON, and twenty full aggregate answers.
 */
const CACHE_MAX_ROWS = 20_000;

function cacheSet(key: string, rows: Row[]): void {
  if (cacheTtlMs() <= 0) return;
  cache.set(key, { at: Date.now(), rows });
  const max = cacheMax();
  let rowTotal = 0;
  for (const entry of cache.values()) rowTotal += entry.rows.length;
  // Evict on whichever ceiling bites first, but never the entry just written:
  // a single oversized answer is still served from cache within its own call.
  while (cache.size > max || (cache.size > 1 && rowTotal > CACHE_MAX_ROWS)) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    rowTotal -= cache.get(oldest.value)?.rows.length ?? 0;
    cache.delete(oldest.value);
  }
}

/** Exported for tests: a cache that cannot be cleared makes the suite order-dependent. */
export function clearDolCache(): void {
  cache.clear();
}

async function dolGet(params: QueryParams): Promise<Row[]> {
  const key = JSON.stringify(params);
  const hit = cacheGet(key);
  if (hit) return hit;
  const rows = await withRetry(() => dolGetOnce(params));
  cacheSet(key, rows);
  return rows;
}

async function dolGetOnce(params: QueryParams): Promise<Row[]> {
  const key = apiKey();
  const url = new URL(`${DOL_API}/get/${WHD_AGENCY}/${WHD_ENDPOINT}/json`);
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.offset != null) url.searchParams.set("offset", String(params.offset));
  if (params.sort) url.searchParams.set("sort", params.sort);
  if (params.sort_by) url.searchParams.set("sort_by", params.sort_by);
  if (params.fields?.length) url.searchParams.set("fields", params.fields.join(","));
  if (params.filter) url.searchParams.set("filter_object", JSON.stringify(stringifyFilterValues(params.filter)));
  // Auth: the DOL v4 API accepts the key ONLY as a query parameter — the
  // X-API-KEY header form answers 401 (verified live 2026-08-23; this code
  // originally assumed header-only auth for log hygiene, and the live rung
  // proved the API rejects it). Consequence to know about: the key rides the
  // URL, so anything that logs full request URLs sees it. Error messages from
  // this module never include the URL.
  url.searchParams.set("X-API-KEY", key);
  const res = await throttled(() =>
    fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }),
  );
  const text = await res.text();

  // DOL answers HTTP 204 WITH AN EMPTY BODY for a zero-match filter (verified
  // live 2026-08-23: three shapes all 204/len=0). That is the single most
  // load-bearing answer this dataset gives — "no concluded case found" — and
  // an empty body must parse as an empty result set, not die as non-JSON.
  if (res.status === 204 || (res.ok && text.trim() === "")) return [];

  if (!res.ok) {
    throw new HttpError(`DOL API request failed (HTTP ${res.status}): ${text.slice(0, 300).trim()}`, res.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Auth failures come back as a plain-text sentence (e.g. "The API key is
    // either incorrect or missing..."), sometimes with a 200. Surface it clearly.
    throw new PermanentError(`DOL API returned a non-JSON response: ${text.slice(0, 300).trim()}`);
  }
  return extractRows(json);
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Coerce an API value to a number (API may return numeric fields as strings). */
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Coerce an API value to a trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Sum every statute-level *_cmp_assd_amt column present on a row. */
function totalCivilPenalties(row: Row): number | null {
  let sum = 0;
  let found = false;
  for (const [k, v] of Object.entries(row)) {
    if (/_cmp_assd_amt$/i.test(k)) {
      const n = num(v);
      if (n != null) {
        sum += n;
        found = true;
      }
    }
  }
  return found ? sum : null;
}

/**
 * Derive which labor statutes a case was cited under, from the *_violtn_cnt
 * columns and their sibling back-wage / employee / penalty columns. Only
 * statutes with a non-zero signal are returned. Powers case_detail.
 */
function statuteBreakdown(row: Row): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const key of Object.keys(row)) {
    const m = /^(.+)_violtn_cnt$/.exec(key);
    if (!m) continue;
    const prefix = m[1];
    if (prefix === "case") continue; // case_violtn_cnt is the grand total, not a statute

    const violations = num(row[key]);
    const backWages = num(row[`${prefix}_bw_atp_amt`] ?? row[`${prefix}_bw_amt`]);
    const employees = num(row[`${prefix}_ee_atp_cnt`] ?? row[`${prefix}_ee_cnt`]);
    const penalty = num(row[`${prefix}_cmp_assd_amt`]);

    if ([violations, backWages, employees, penalty].some((x) => x != null && x !== 0)) {
      out.push({
        statute: prefix.toUpperCase(),
        violations,
        back_wages: backWages,
        employees_affected: employees,
        civil_penalty: penalty,
      });
    }
  }
  return out;
}

/** Normalize one WHISARD row into a clean case record (list view). */
function normalizeCase(row: Row): Record<string, unknown> {
  return {
    case_id: str(row.case_id),
    employer: str(row.trade_nm) ?? str(row.legal_name),
    legal_name: str(row.legal_name),
    location: {
      street: str(row.street_addr_1_txt),
      city: str(row.cty_nm),
      state: str(row.st_cd),
      zip: str(row.zip_cd),
    },
    naics_code: str(row.naic_cd),
    naics_description: str(row.naics_code_description),
    findings_start_date: str(row.findings_start_date),
    findings_end_date: str(row.findings_end_date),
    back_wages: num(row.bw_atp_amt),
    civil_penalties: totalCivilPenalties(row),
    employees_affected: num(row.ee_violtd_cnt),
    violations: num(row.case_violtn_cnt),
  };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function clampLimit(v: unknown, fallback: number): number {
  const n = num(v);
  if (n == null) return fallback;
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(n)));
}

/**
 * Every 2-letter code `st_cd` can legitimately carry: the 50 states, DC, and
 * the US territories.
 *
 * Source, so this list is not a remembered one: the Census Bureau's canonical
 * FIPS/USPS reference https://www2.census.gov/geo/docs/reference/state.txt
 * (STUSAB column, fetched 2026-09-14) -- 57 codes, 50 states + DC + AS, GU, MP,
 * PR, UM, VI.
 *
 * And it is the dataset's domain too, measured rather than assumed: the whole
 * list as one `not_in` filter answers HTTP 204 (2026-09-14), so no WHISARD row
 * carries an st_cd outside it. That probe was shown red-capable first -- the
 * same filter with "NY" removed returns NY rows -- because a 204 is also what a
 * broken filter looks like.
 *
 * It is checked here rather than sent because `{st_cd eq "ZZ"}` is a legal
 * filter that DOL answers 204, which this server renders as count 0 under the
 * note that an empty result means no concluded published case was found -- the
 * confident-zero shape, reached by getting two characters wrong. A caseworker
 * who types NU for NV or MI for MN reads "no wage enforcement published here"
 * rather than "that is not a state". Unlike the LIKE case problem this domain
 * is closed, so the typo can be refused instead of answered.
 */
const STATE_CODES = new Set(
  ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND " +
    "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR UM VI").split(" "),
);

/** Validate + normalize a 2-letter state code, or throw. */
function normState(v: unknown): string {
  const s = str(v);
  if (!s || !/^[A-Za-z]{2}$/.test(s)) {
    throw new Error(`state must be a 2-letter code (e.g. "NY", "CA"); got: ${JSON.stringify(v)}`);
  }
  const code = s.toUpperCase();
  if (!STATE_CODES.has(code)) {
    throw new Error(
      `state ${JSON.stringify(code)} is not a US state, DC, or a US territory. Nothing was queried -- an ` +
        'unknown code is a legal filter that answers count 0, which reads as "no enforcement published here".',
    );
  }
  return code;
}

/** Validate an optional ISO date (YYYY-MM-DD) that is also a real date, or throw. */
function normDate(v: unknown, label: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD); got: ${JSON.stringify(v)}`);
  }
  // The shape is not the calendar. shiftIsoDate goes through Date.UTC, which
  // ROLLS an out-of-range component over instead of rejecting it: "2024-01-99"
  // becomes 2024-04-08 and "0000-00-00" becomes 1899-11-30, silently, while the
  // query echo still reports what was typed. A rolled-over bound also walks
  // straight through the order check in dateFilters, which compares the RAW
  // strings: "2024-01-99" sorts before "2024-02-01", so that pair built
  // `gt 2024-04-07T23:59:59 AND lt 2024-02-02T00:00:00` -- the unsatisfiable
  // filter that check exists to refuse, answered 204 and rendered as a clean
  // count 0. Require the date to survive a UTC round trip: that is the only
  // cheap test that no rollover happened.
  const [y, m, d] = s.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() + 1 !== m || at.getUTCDate() !== d) {
    throw new Error(
      `${label} is not a real calendar date: ${JSON.stringify(v)}. Nothing was queried -- a rolled-over date ` +
        'would answer "no cases found" for a window you did not ask for.',
    );
  }
  return s;
}

/** Levenshtein distance. Small inputs only — it exists to suggest a near-miss key. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** The closest accepted argument name, if it is close enough to be a typo. */
function nearestArg(key: string, accepted: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Scale with the length of what was typed: one edit is a typo in a short name,
  // three is still a typo in a long one, and neither makes "bogus_param" a
  // misspelling of "limit".
  return bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : null;
}

/**
 * Reject arguments the tool does not declare.
 *
 * Every inputSchema carries additionalProperties:false, but the low-level Server
 * does not validate against inputSchema — it hands the arguments object to the
 * handler as-is — so an unknown key was dropped without a word. A caller who
 * typed `found_afer` got a full-history answer they believed was date-limited,
 * with the query echo honestly reporting found_after: null. Verified end to end
 * before this guard existed: top_cases {state:"NY", found_afer:"2024-01-01",
 * bogus_param:12345} returned 20 cases and no error.
 */
function validateArgs(toolName: string, accepted: string[], args: Row): void {
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
  if (unknown.length === 0) return;
  const described = unknown.map((k) => {
    const near = nearestArg(k, accepted);
    return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
  });
  throw new Error(
    `${toolName} does not accept ${described.join(", ")}. ` +
      `Accepted arguments: ${accepted.join(", ")}. Nothing was queried.`,
  );
}

/**
 * Shift an ISO date (YYYY-MM-DD) by whole days, in UTC so month and year
 * rollover are the calendar's problem and not this function's.
 */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * There is nothing to escape with: DOL's LIKE engine honours NO escape
 * character, so this passes the term through unchanged.
 *
 * Settled live 2026-09-14, six probes in one run against `trade_nm`, three
 * bare/escaped pairs in the same minute:
 *
 *   `%Kevin Misch%`   -> 200, case_id 1476714 + 1419247
 *   `%Kevin Misc\h%`  -> 204   (so `\h` is a literal backslash then h)
 *   `%Kevin_Misch%`   -> 200, both rows   (`_` IS a single-character wildcard)
 *   `%Kevin\_Misch%`  -> 204   (escaping it does not make it literal)
 *   `%Kevin%Misch%`   -> 200, both rows
 *   `%Kevin\%Misch%`  -> 204
 *
 * Every escaped form answers zero. So the escaping this function used to do
 * turned a term carrying `%`, `_` or `\` into a pattern hunting a literal
 * backslash — on this dataset the worst available answer, a confident "no cases
 * found", reached by a caller typing a character the docs called safe.
 *
 * Passing the metacharacter THROUGH over-matches instead: `_` widens to any one
 * character and `%` to any run. That is the recoverable direction — extra rows
 * arrive carrying their own employer names, so a caller can see them and narrow
 * — and it is the only direction available until DOL's filter_object exposes an
 * ESCAPE clause. Kept as a named function so the reason survives at the call
 * sites, and so that day has one place to change.
 */
function escapeLike(term: string): string {
  return term;
}

/**
 * Case variants of a search term, each wrapped as a `%term%` LIKE pattern.
 *
 * The endpoint's LIKE is case-SENSITIVE and WHISARD stores names MIXED-CASE.
 * Both halves verified live 2026-09-14: `{trade_nm like "%KEVIN MISCH%"}`
 * answers HTTP 204 (zero rows) while `"%Kevin Misch%"` answers HTTP 200 with
 * case_id 1476714 "Kevin Misch Excavating" and case_id 1419247; and of the 500
 * most recent rows by findings_end_date, 485 (97%) carry a mixed-case
 * `trade_nm`. So a single uppercased pattern answers "no cases found" for
 * almost every employer in the dataset, and a single raw-cased one would miss
 * the uppercase-stored remainder. Both cases go in the OR.
 *
 * Each variant is derived from the RAW term. Nothing is escaped on the way out
 * — see escapeLike for why there is no escape character to use.
 *
 * THREE VARIANTS ARE NOT EVERY VARIANT, and the gap is the caller's to know
 * about. A name stored with internal capitals — `ABC Plumbing`, `JBS USA`,
 * `McDonald's` — matches none of the three unless the term is typed in the
 * stored casing, because LIKE has no case-insensitive form and DOL exposes no
 * `ilike`. Nothing here can close that, so a zero-result name search says so in
 * its own answer (CASE_RETRY_HINT) rather than presenting as a clean record.
 */
function likeVariants(term: string): string[] {
  const title = term.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const out: string[] = [];
  for (const variant of [term, term.toUpperCase(), title]) {
    const like = `%${escapeLike(variant)}%`;
    if (!out.includes(like)) out.push(like);
  }
  return out;
}

/**
 * Build a name filter that matches the term against trade_nm OR legal_name, in
 * the three case variants above — not in every case variant, which LIKE cannot
 * do. A LIKE metacharacter in the caller's term rides through as a wildcard and
 * widens the search; escaping it is not an option DOL's engine offers, and
 * attempting it matched nothing (escapeLike). The widest form is a
 * 6-way `or` (2 fields x 3 variants); DOL's filter engine accepts it, alone and
 * nested inside an `and` beside a state filter (both verified live 2026-09-14).
 */
function nameFilter(term: string): FilterObject {
  const nodes: FilterObject[] = [];
  for (const field of ["trade_nm", "legal_name"]) {
    for (const like of likeVariants(term)) {
      nodes.push({ field, operator: "like", value: like });
    }
  }
  return { or: nodes };
}

/**
 * What a zero-result NAME search has to say for itself.
 *
 * The three case variants cover a name stored as typed, uppercased or
 * title-cased, and miss one stored with internal capitals. That residue is
 * invisible from the outside — it arrives as `count: 0`, which on this dataset
 * reads as "no wage theft here" — so the one place it can be named is the empty
 * answer itself. A state or date query does not carry this note; only a name
 * search can hit the case problem.
 */
const CASE_RETRY_HINT =
  "No case matched this name. DOL's name matching is case-SENSITIVE and WHISARD stores names mixed-case; " +
  "this search already tried the term as typed, uppercased and title-cased. A name stored with internal " +
  "capitals (\"ABC Plumbing\", \"JBS USA\", \"McDonald's\") needs that exact capitalization, so retry in the " +
  "stored spelling, or with a shorter distinctive fragment, before reading this as no record.";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// One string per bound, shared by all three tools that take a date window, so
// the promise a caller reads cannot drift from the one the filter keeps. Both
// bounds are inclusive; dateFilters is where that is made true.
const FOUND_AFTER_DESC =
  "Only cases whose findings ended on or after this ISO date (YYYY-MM-DD). Inclusive: a case that ended on this exact date is included.";
const FOUND_BEFORE_DESC =
  "Only cases whose findings ended on or before this ISO date (YYYY-MM-DD). Inclusive: a case that ended on this exact date is included.";

// Likewise one string for the name caveat, shared by the two tools that search
// by name. DOL's LIKE is case-sensitive, this server tries three case variants,
// and a name stored with internal capitals still needs its own spelling — a
// caller who does not know that reads count 0 as a clean record.
const EMPLOYER_DESC_SUFFIX =
  " Matching is case-sensitive on DOL's side: the term is tried as typed, uppercased and title-cased, so a " +
  "name stored with internal capitals (\"ABC Plumbing\", \"JBS USA\") needs that exact capitalization. If " +
  "nothing matches, retry in the stored spelling or with a shorter distinctive fragment before concluding " +
  "there are no cases.";

const TOOLS: Tool[] = [
  {
    name: "employer_violations",
    description:
      "Search WHD enforcement cases by employer name (matches trade name or legal name), optionally filtered to a state. Returns each case with location, findings dates, back wages, civil penalties, and employees affected. Ordered by back wages (largest first).",
    inputSchema: {
      type: "object",
      properties: {
        employer: {
          type: "string",
          description:
            "Employer name or fragment to search for (e.g. \"tyson\", \"golden gate restaurant\")." +
            EMPLOYER_DESC_SUFFIX,
        },
        state: {
          type: "string",
          description: "Optional 2-letter state code to filter by (e.g. \"NY\").",
        },
        found_after: { type: "string", description: FOUND_AFTER_DESC },
        found_before: { type: "string", description: FOUND_BEFORE_DESC },
        limit: {
          type: "integer",
          description: `Max cases to return (1-${MAX_PAGE}, default 20).`,
        },
      },
      required: ["employer"],
      additionalProperties: false,
    },
  },
  {
    name: "back_wages_summary",
    description:
      "Aggregate total back wages, employees affected, civil penalties, and case count for an employer-name and/or state query. Computed client-side over up to " +
      `${SUMMARY_CAP} matching cases. At least one of employer or state is required.`,
    inputSchema: {
      type: "object",
      properties: {
        employer: {
          type: "string",
          description: "Employer name or fragment to search for." + EMPLOYER_DESC_SUFFIX,
        },
        state: { type: "string", description: "2-letter state code (e.g. \"CA\")." },
        max_cases: {
          type: "integer",
          description: `Max cases to aggregate over (1-${SUMMARY_CAP}, default ${SUMMARY_CAP}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "violations_by_state",
    description:
      "Top WHD enforcement cases in a state (cases where a violation was found), ordered by back wages owed. Optionally filter to an industry by NAICS code prefix (e.g. \"72\" for accommodation and food services).",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "2-letter state code (e.g. \"TX\")." },
        naics: {
          type: "string",
          description: "Optional NAICS code prefix to filter industry (e.g. \"72\", \"722511\").",
        },
        found_after: { type: "string", description: FOUND_AFTER_DESC },
        found_before: { type: "string", description: FOUND_BEFORE_DESC },
        limit: { type: "integer", description: `Max cases to return (1-${MAX_PAGE}, default 20).` },
      },
      required: ["state"],
      additionalProperties: false,
    },
  },
  {
    name: "top_cases",
    description:
      "The largest WHD enforcement cases by back wages — nationally, in a state, and/or in a date " +
      "window. No employer name needed: use it to see what wage enforcement looks like in an " +
      "industry or region, or to find the biggest recent actions.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: 'Optional 2-letter state code (e.g. "NY").' },
        naics: { type: "string", description: 'Optional NAICS code prefix (e.g. "72" for accommodation and food services).' },
        found_after: { type: "string", description: FOUND_AFTER_DESC },
        found_before: { type: "string", description: FOUND_BEFORE_DESC },
        limit: { type: "integer", description: `Max cases to return (1-${MAX_PAGE}, default 20).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "flagged_employers",
    description:
      "WHD cases carrying the dataset's FLSA repeat/willful violator flag, optionally in a state. " +
      "The flag values are WHD's own (per its data dictionary: R = repeat, W = willful, RW = both). " +
      "R also returns RW cases and W also returns RW cases, so an employer flagged both appears in " +
      "either search. Ordered by back wages.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: 'Optional 2-letter state code.' },
        flag: {
          type: "string",
          description:
            'Which WHD flag to search: "R" (repeat, default) and "W" (willful) each also return the "RW" ' +
            '(both) cases; "RW" returns only cases flagged both. R, W and RW are the only accepted values.',
        },
        limit: { type: "integer", description: `Max cases to return (1-${MAX_PAGE}, default 20).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "case_detail",
    description:
      "Full record for one WHD enforcement case by its case id, including the per-statute breakdown (which labor laws were violated: FLSA, MSPA, H-1B, FMLA, Davis-Bacon, child labor, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The WHD case id (from employer_violations / violations_by_state results).",
        },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Optional findings_end_date range conditions from found_after / found_before.
 *
 * Both bounds are INCLUSIVE, which takes work: DOL's operator set is
 * eq/neq/gt/lt/in/not_in/like with no gte/lte, and findings_end_date is stored
 * as a full timestamp at midnight ("2024-06-16T00:00:00"). So a bare
 * `gt "2024-06-16"` drops every case that ended that day, and `lt` drops its own
 * day at the other end — a statute-of-limitations window one day narrower at
 * each end, with nothing in the answer saying so. Verified live 2026-09-14:
 * gt "2024-06-15" returns rows at 2024-06-16T00:00:00 as its earliest, and
 * gt "2024-06-16" returns 2024-06-17T00:00:00 as its earliest.
 *
 * Each bound is therefore pushed one day outward, to the instant just outside
 * the requested window, and the shift is applied here and only here.
 *
 * The bound ORDER is checked here too, for the same reason the shift exists: a
 * window whose bounds are the wrong way round cannot match anything, and an
 * unsatisfiable filter comes back from DOL looking exactly like a real absence.
 */
function dateFilters(args: Row): FilterObject[] {
  const out: FilterObject[] = [];
  const after = normDate(args.found_after, "found_after");
  const before = normDate(args.found_before, "found_before");
  // A transposed window builds a filter nothing can satisfy, and DOL answers it
  // HTTP 204 — which this server renders as a clean count 0 carrying the note
  // that no concluded published case was found. That is the same answer a real
  // absence gives, and on this dataset it reads as "no wage theft here". The
  // bound order is the only thing that can separate the two, so it is checked
  // rather than sent. Equal bounds are a one-day window and stay legal.
  if (after && before && after > before) {
    throw new Error(
      `found_after (${after}) is later than found_before (${before}); that window selects nothing. ` +
        "Swap the bounds — an empty answer here would read as \"no cases found\". Nothing was queried.",
    );
  }
  if (after) {
    out.push({ field: "findings_end_date", operator: "gt", value: `${shiftIsoDate(after, -1)}T23:59:59` });
  }
  if (before) {
    out.push({ field: "findings_end_date", operator: "lt", value: `${shiftIsoDate(before, 1)}T00:00:00` });
  }
  return out;
}

/** Combine filter parts into one FilterObject (1 part passes through bare). */
function andAll(parts: FilterObject[]): FilterObject {
  return parts.length === 1 ? parts[0] : { and: parts };
}

/**
 * Fetch one page of `limit` rows plus a probe row: requesting limit+1 and
 * showing limit makes truncation VISIBLE (has_more) without a second count
 * request. The audit found these list tools returning exactly `limit` rows
 * indistinguishable from a complete answer.
 */
async function pageWithProbe(params: Omit<QueryParams, "limit">, limit: number): Promise<{ rows: Row[]; hasMore: boolean }> {
  const rows = await dolGet({ ...params, limit: limit + 1 });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * The sentence a truncated page says, for every list tool.
 *
 * has_more is the machine-readable half and was always reported. The note is
 * the half a human -- or a model summarising the answer in prose -- actually
 * reads, and two of the four list tools did not emit it: top_cases had no
 * `note` key at all, and flagged_employers' note is a static flag-semantics
 * explanation that never varied with hasMore. So the same truncation was
 * spelled out on employer_violations and violations_by_state and silent on the
 * other two, which is exactly the inconsistency that teaches a caller the note
 * can be trusted to mention it.
 *
 * Two sentences, because "raise limit" stops being an instruction at the page
 * ceiling. clampLimit caps limit at MAX_PAGE and no tool exposes `offset`, so a
 * caller already at 100 who follows the advice and asks for 500 is silently
 * clamped back to 100 and handed the same note again. At the ceiling the only
 * thing that reaches the rest of the matches is a narrower query, and the note
 * is the one place a prose reader learns that.
 */
function truncationNote(limit: number): string {
  return limit >= MAX_PAGE
    ? `More cases match than the ${limit} shown (largest back wages first); ${MAX_PAGE} is this tool's page ceiling and there is no offset, so narrow the query -- by state, industry or date window -- to reach the rest.`
    : `More cases match than the ${limit} shown (largest back wages first); raise limit (up to ${MAX_PAGE}) or narrow the query.`;
}

async function employerViolations(args: Row): Promise<unknown> {
  const employer = str(args.employer);
  if (!employer) throw new Error("employer is required.");
  const limit = clampLimit(args.limit, 20);

  const parts: FilterObject[] = [nameFilter(employer)];
  if (args.state) parts.push({ field: "st_cd", operator: "eq", value: normState(args.state) });
  parts.push(...dateFilters(args));

  const { rows, hasMore } = await pageWithProbe({ filter: andAll(parts), sort_by: "bw_atp_amt", sort: "desc" }, limit);
  return {
    query: {
      employer,
      state: args.state ? normState(args.state) : null,
      found_after: str(args.found_after) ?? null,
      found_before: str(args.found_before) ?? null,
    },
    count: rows.length,
    has_more: hasMore,
    note: hasMore ? truncationNote(limit) : rows.length === 0 ? CASE_RETRY_HINT : undefined,
    cases: rows.map(normalizeCase),
  };
}

async function topCases(args: Row): Promise<unknown> {
  const state = args.state != null && args.state !== "" ? normState(args.state) : null;
  const naics = str(args.naics);
  const limit = clampLimit(args.limit, 20);

  const parts: FilterObject[] = [{ field: "case_violtn_cnt", operator: "gt", value: 0 }];
  if (state) parts.push({ field: "st_cd", operator: "eq", value: state });
  if (naics) parts.push({ field: "naic_cd", operator: "like", value: `${escapeLike(naics)}%` });
  parts.push(...dateFilters(args));

  const { rows, hasMore } = await pageWithProbe({ filter: andAll(parts), sort_by: "bw_atp_amt", sort: "desc" }, limit);
  return {
    query: {
      state,
      naics: naics ?? null,
      found_after: str(args.found_after) ?? null,
      found_before: str(args.found_before) ?? null,
    },
    count: rows.length,
    has_more: hasMore,
    note: hasMore ? truncationNote(limit) : undefined,
    cases: rows.map(normalizeCase),
  };
}

/**
 * Which stored flag values each requested flag searches. WHD publishes three
 * (R = repeat, W = willful, RW = both), and RW is a distinct literal: an `eq "R"`
 * filter matches the string "R" only, so it silently excluded every
 * repeat-AND-willful employer from the repeat search. Verified live 2026-09-14:
 * `eq "RW"` returns case_id 1461405 (Sam's Chevron, AZ) and case_id 1476714
 * (Kevin Misch Excavating, IN); `eq "W"` returns case_id 1594970 (Advanced
 * Information Systems, WA). DOL's operator set includes `in`, which accepts an
 * array value (live-verified, and stringifyFilterValues maps arrays elementwise).
 */
const FLAG_SEARCHES: Record<string, string[]> = {
  R: ["R", "RW"],
  W: ["W", "RW"],
  RW: ["RW"],
};

async function flaggedEmployers(args: Row): Promise<unknown> {
  const state = args.state != null && args.state !== "" ? normState(args.state) : null;
  const flag = (str(args.flag) ?? "R").toUpperCase();
  const matched = FLAG_SEARCHES[flag];
  if (!matched) {
    throw new Error(
      `flag must be one of R (repeat), W (willful) or RW (both repeat and willful); got: ${JSON.stringify(args.flag)}`,
    );
  }
  const limit = clampLimit(args.limit, 20);

  const parts: FilterObject[] = [{ field: "flsa_repeat_violator", operator: "in", value: matched }];
  if (state) parts.push({ field: "st_cd", operator: "eq", value: state });

  const { rows, hasMore } = await pageWithProbe({ filter: andAll(parts), sort_by: "bw_atp_amt", sort: "desc" }, limit);
  return {
    query: { state, flag, matched_flags: matched },
    count: rows.length,
    has_more: hasMore,
    note:
      (hasMore ? truncationNote(limit) + " " : "") +
      "flsa_repeat_violator is WHD's own flag (its data dictionary publishes R = repeat, W = willful, " +
      "RW = both). The flag reflects WHD's characterization at case conclusion, not a court finding. " +
      `flag="${flag}" searches ${matched.join(" and ")}, because RW is a separate stored value: an ` +
      "employer flagged both repeat and willful belongs in the repeat list and in the willful list.",
    // The flag itself rides each case HERE and nowhere else: it is the only
    // reason this tool exists, and without it a caller cannot tell R from RW
    // without one case_detail call per case. Deliberately not added to
    // normalizeCase -- the other list tools' shape is documented and stays put.
    cases: rows.map((row) => ({ ...normalizeCase(row), flsa_repeat_violator: str(row.flsa_repeat_violator) })),
  };
}

async function backWagesSummary(args: Row): Promise<unknown> {
  const employer = str(args.employer);
  const state = args.state != null && args.state !== "" ? normState(args.state) : null;
  if (!employer && !state) {
    throw new Error("Provide at least one of employer or state (summing the entire dataset is not supported).");
  }
  const cap = (() => {
    const n = num(args.max_cases);
    if (n == null) return SUMMARY_CAP;
    return Math.max(1, Math.min(SUMMARY_CAP, Math.floor(n)));
  })();

  const parts: FilterObject[] = [];
  if (employer) parts.push(nameFilter(employer));
  if (state) parts.push({ field: "st_cd", operator: "eq", value: state });
  const filter: FilterObject = parts.length === 1 ? parts[0] : { and: parts };

  // No `fields` projection. totalCivilPenalties scans every *_cmp_assd_amt key
  // on the row by design, and the README documents that one rule for all three
  // tools that report penalties — but this tool used to restrict the request to
  // an 11-name hardcoded list and then run that open-ended scan over the
  // truncated row. Two owners for one fact: the day WHD carries a statute
  // column the list does not name, this tool's total and case_detail's disagree
  // on the same case, silently and in the safe-looking direction.
  //
  // The list was the complete live set when it was written and still is (110
  // columns on a real row 2026-09-14, 11 of them *_cmp_assd_amt, all 11 named),
  // so nothing is under-counted today and nothing was: the defect is that the
  // list has to be maintained against a schema this code does not control.
  // Measured cost of dropping it, same day: an unprojected 1000-row page is
  // 2.8 MB in 3.7 s — inside DOL's 5 MB per-request ceiling and this server's
  // 15 s timeout — and every other tool here already fetches whole rows.
  //
  // cap + 1 is the same probe row every list tool uses for has_more. Without it
  // `capped` is true whenever the page is full, so a total whose true match
  // count is EXACTLY max_cases was published under a note calling it a floor —
  // on the one tool whose output is a dollar figure a caseworker cites. The
  // extra row is fetched and then dropped, never summed.
  //
  // Sorted like every list tool, and for this tool it changes the ANSWER rather
  // than the presentation. This was the only query here with no sort_by, so a
  // capped aggregate summed whatever order DOL happened to return, with two
  // consequences the `capped` note does not cover: the floor was built from an
  // arbitrary subset rather than from the largest cases, so it was weaker than
  // the strongest floor available; and latest_findings_end -- which is what
  // data_currency reports as newest_findings_end_date -- was the newest date in
  // that arbitrary subset, so a capped answer could state a vintage years older
  // than the newest matching case while the SPEC asserts an answer is exactly as
  // current as its newest row.
  const fetched = await dolGet({ limit: cap + 1, filter, sort_by: "bw_atp_amt", sort: "desc" });
  const rows = fetched.slice(0, cap);

  let totalBackWages = 0;
  let totalEmployees = 0;
  let totalPenalties = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const row of rows) {
    totalBackWages += num(row.bw_atp_amt) ?? 0;
    totalEmployees += num(row.ee_violtd_cnt) ?? 0;
    totalPenalties += totalCivilPenalties(row) ?? 0;
    const start = str(row.findings_start_date);
    const end = str(row.findings_end_date);
    if (start && (earliest == null || start < earliest)) earliest = start;
    if (end && (latest == null || end > latest)) latest = end;
  }

  return {
    query: { employer: employer ?? null, state },
    case_count: rows.length,
    capped: fetched.length > cap,
    total_back_wages: Math.round(totalBackWages * 100) / 100,
    total_employees_affected: totalEmployees,
    total_civil_penalties: Math.round(totalPenalties * 100) / 100,
    earliest_findings_start: earliest,
    latest_findings_end: latest,
    note:
      "Aggregated client-side over matching cases (WHD data is one row per compliance action). " +
      "total_civil_penalties is the sum of statute-level civil money penalties. " +
      "capped=true means results hit max_cases and the totals are a floor." +
      // A $0 total reads as an employer with no wage-theft history, which is the
      // most citable thing this tool produces and the worst thing to get wrong.
      (employer && rows.length === 0 ? " " + CASE_RETRY_HINT : ""),
  };
}

async function violationsByState(args: Row): Promise<unknown> {
  const state = normState(args.state);
  const naics = str(args.naics);
  const limit = clampLimit(args.limit, 20);

  const parts: FilterObject[] = [
    { field: "st_cd", operator: "eq", value: state },
    { field: "case_violtn_cnt", operator: "gt", value: 0 },
  ];
  if (naics) parts.push({ field: "naic_cd", operator: "like", value: `${escapeLike(naics)}%` });
  parts.push(...dateFilters(args));

  const { rows, hasMore } = await pageWithProbe({ filter: { and: parts }, sort_by: "bw_atp_amt", sort: "desc" }, limit);
  return {
    query: {
      state,
      naics: naics ?? null,
      found_after: str(args.found_after) ?? null,
      found_before: str(args.found_before) ?? null,
    },
    count: rows.length,
    has_more: hasMore,
    note: hasMore ? truncationNote(limit) : undefined,
    cases: rows.map(normalizeCase),
  };
}

async function caseDetail(args: Row): Promise<unknown> {
  const caseId = str(args.case_id);
  if (!caseId) throw new Error("case_id is required.");

  const rows = await dolGet({
    limit: 1,
    // A string, like every other filter value: DOL 500s on numeric ones
    // (stringifyFilterValues, verified live). A branch here that sent a number
    // when the id parsed cleanly had no effect and said the opposite.
    filter: { field: "case_id", operator: "eq", value: caseId },
  });
  if (rows.length === 0) {
    return { found: false, case_id: caseId };
  }
  const row = rows[0];
  return {
    found: true,
    ...normalizeCase(row),
    cmp_assessment_count: num(row.cmp_assd_cnt),
    flsa_repeat_violator: str(row.flsa_repeat_violator),
    statute_breakdown: statuteBreakdown(row),
  };
}

const HANDLERS: Record<string, (args: Row) => Promise<unknown>> = {
  employer_violations: employerViolations,
  back_wages_summary: backWagesSummary,
  violations_by_state: violationsByState,
  top_cases: topCases,
  flagged_employers: flaggedEmployers,
  case_detail: caseDetail,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * SPEC vintage-on-every-answer.
 *
 * WHD publishes CONCLUDED investigations, and it publishes them late. Two
 * distinct ways a reader gets burned, and the note has to cover both:
 *   - a 2019 case read as "this employer is violating right now";
 *   - an empty result read as "this employer is clean", when the real meaning
 *     is "WHD has not published a concluded investigation naming them".
 *
 * The vintage is computed from the records actually returned, never from the
 * clock. An answer is exactly as current as its newest row and no more; a
 * generated-on timestamp would assert the opposite and is the bug itself.
 */
const CURRENCY_NOTE =
  "WHD publishes concluded investigations on a lag. These are historical " +
  "enforcement records, not an employer's present compliance state, and an " +
  "empty result means no concluded published case was found — not that none exists.";

/**
 * Every key a result shape uses to carry a case's findings-end date.
 *
 * The list tools pass the raw column through as `findings_end_date`, but
 * back_wages_summary returns totals and no rows at all — its newest row leaves
 * as `latest_findings_end`. Scanning for the column name alone therefore
 * answered `newest_findings_end_date: null` on that tool over dated rows, which
 * is the SPEC's own failure on one of the six. Any future result shape that
 * names a findings-end date differently belongs in this list.
 */
const FINDINGS_END_KEYS = new Set(["findings_end_date", "latest_findings_end"]);

/** Deepest-first scan for a findings-end date, so every result shape is covered. */
function newestFindingsDate(node: unknown): string | null {
  if (Array.isArray(node)) {
    return node.reduce<string | null>((max, item) => {
      const found = newestFindingsDate(item);
      return found !== null && (max === null || found > max) ? found : max;
    }, null);
  }
  if (node === null || typeof node !== "object") return null;
  let max: string | null = null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // ISO-8601 sorts lexicographically, so string compare IS date compare.
    const found =
      FINDINGS_END_KEYS.has(key) && typeof value === "string" && value !== ""
        ? value
        : newestFindingsDate(value);
    if (found !== null && (max === null || found > max)) max = found;
  }
  return max;
}

/**
 * Strip the API key out of anything on its way to a caller.
 *
 * The key rides the QUERY STRING — the v4 API 401s the header form, verified
 * live — so "the token never enters the query string" is not a property this
 * code can have. The property it can have, and the one that actually protects
 * the key, is that no message leaving this module carries the request URL or
 * the key itself. This module never builds such a message, but it does surface
 * other people's: an upstream error body that echoes the request, or a
 * transport error whose message quotes the URL it was fetching. Both paths run
 * through the one catch below, so the scrub belongs there.
 */
function redactSecrets(message: string): string {
  const key = process.env.DOL_API_KEY?.trim();
  let out = message.replace(/([?&]X-API-KEY=)[^&\s"'<>]*/gi, "$1[redacted]");
  if (key) out = out.split(key).join("[redacted]");
  return out;
}

function withDataCurrency(result: unknown): unknown {
  const currency = {
    newest_findings_end_date: newestFindingsDate(result),
    note: CURRENCY_NOTE,
  };
  if (result === null || typeof result !== "object") return { result, data_currency: currency };
  if (Array.isArray(result)) return { results: result, data_currency: currency };
  return { ...(result as Record<string, unknown>), data_currency: currency };
}

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-wagewatch", version: "1.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    const tool = TOOLS.find((t) => t.name === name);
    if (!handler || !tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const given = (args ?? {}) as Row;
      validateArgs(name, Object.keys(tool.inputSchema.properties ?? {}), given);
      const result = await handler(given);
      return { content: [{ type: "text", text: JSON.stringify(withDataCurrency(result), null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${redactSecrets(message)}` }],
        isError: true,
      };
    }
  });

  return server;
}
