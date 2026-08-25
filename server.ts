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

// Per-statute civil-money-penalty dollar columns. WHISARD has NO single total-CMP
// dollar field (cmp_assd_cnt is a COUNT of assessments), so a dollar total must be
// summed across the statute-level *_cmp_assd_amt columns below. Used to restrict
// the `fields` payload for back_wages_summary; the full-row tools scan every
// *_cmp_assd_amt key dynamically instead.
const CMP_AMOUNT_FIELDS = [
  "flsa_cmp_assd_amt",
  "mspa_cmp_assd_amt",
  "h1b_cmp_assd_amt",
  "fmla_cmp_assd_amt",
  "flsa_cl_cmp_assd_amt",
  "h2a_cmp_assd_amt",
  "osha_cmp_assd_amt",
  "eppa_cmp_assd_amt",
  "h1a_cmp_assd_amt",
  "crew_cmp_assd_amt",
  "flsa_hmwkr_cmp_assd_amt",
];

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
 * Run `fn` after all prior throttled calls, spacing each request START by
 * THROTTLE_MS. The returned promise settles as soon as `fn` does; the gap is
 * added to the queue for the NEXT call rather than padded onto this one. `fn`
 * runs on both settle paths so a prior rejection cannot stall the queue.
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

const HTTP_ATTEMPTS = Number(process.env.DOL_HTTP_ATTEMPTS ?? 3);
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
  let last: unknown;
  for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === HTTP_ATTEMPTS - 1 || !isRetryable(e)) break;
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
    // A 200 whose body is a non-null object with none of the known record arrays
    // is an API-level error envelope (e.g. {"status":"error","message":"quota
    // exceeded"}), NOT an empty result set. Failing open here would report a false
    // "0 cases" / "no wage-theft history", so reject it.
    throw new PermanentError(
      "DOL API returned an unrecognized response: " + JSON.stringify(json).slice(0, 300),
    );
  }
  return [];
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
const CACHE_TTL_MS = Number(process.env.DOL_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const CACHE_MAX = Number(process.env.DOL_CACHE_MAX ?? 300);
const cache = new Map<string, { at: number; rows: Row[] }>();

function cacheGet(key: string): Row[] | undefined {
  if (CACHE_TTL_MS <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key); // re-insert so Map order is LRU
  cache.set(key, hit);
  return hit.rows;
}

function cacheSet(key: string, rows: Row[]): void {
  if (CACHE_TTL_MS <= 0) return;
  cache.set(key, { at: Date.now(), rows });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
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

/** Validate + normalize a 2-letter state code, or throw. */
function normState(v: unknown): string {
  const s = str(v);
  if (!s || !/^[A-Za-z]{2}$/.test(s)) {
    throw new Error(`state must be a 2-letter code (e.g. "NY", "CA"); got: ${JSON.stringify(v)}`);
  }
  return s.toUpperCase();
}

/** Validate an optional ISO date (YYYY-MM-DD), or throw. */
function normDate(v: unknown, label: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD); got: ${JSON.stringify(v)}`);
  }
  return s;
}

/**
 * Escape SQL LIKE metacharacters so a user term matches literally. Backslash
 * first (it is the escape character), then the `%` and `_` wildcards.
 */
function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Build a name filter that matches the term against trade_nm OR legal_name. WHD
 * stores names uppercase and the endpoint's LIKE is case-sensitive, so the term
 * is uppercased defensively; LIKE metacharacters are escaped so a stray `%`/`_`
 * in the input matches literally instead of acting as a wildcard.
 */
function nameFilter(term: string): FilterObject {
  const like = `%${escapeLike(term.toUpperCase())}%`;
  return {
    or: [
      { field: "trade_nm", operator: "like", value: like },
      { field: "legal_name", operator: "like", value: like },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

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
          description: "Employer name or fragment to search for (e.g. \"tyson\", \"golden gate restaurant\").",
        },
        state: {
          type: "string",
          description: "Optional 2-letter state code to filter by (e.g. \"NY\").",
        },
        found_after: { type: "string", description: "Only cases whose findings ended on/after this ISO date (YYYY-MM-DD)." },
        found_before: { type: "string", description: "Only cases whose findings ended on/before this ISO date (YYYY-MM-DD)." },
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
        employer: { type: "string", description: "Employer name or fragment to search for." },
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
        found_after: { type: "string", description: "Only cases whose findings ended on/after this ISO date (YYYY-MM-DD)." },
        found_before: { type: "string", description: "Only cases whose findings ended on/before this ISO date (YYYY-MM-DD)." },
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
        found_after: { type: "string", description: "Only cases whose findings ended on/after this ISO date (YYYY-MM-DD)." },
        found_before: { type: "string", description: "Only cases whose findings ended on/before this ISO date (YYYY-MM-DD)." },
        limit: { type: "integer", description: `Max cases to return (1-${MAX_PAGE}, default 20).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "flagged_employers",
    description:
      "WHD cases carrying the dataset's FLSA repeat/willful violator flag, optionally in a state. " +
      "The flag values are WHD's own (per its data dictionary: R = repeat, W = willful, RW = both); " +
      "pass a different flag value to search another. Ordered by back wages.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: 'Optional 2-letter state code.' },
        flag: { type: "string", description: 'Flag value to match exactly (default "R"). WHD publishes R / W / RW.' },
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

/** Optional findings_end_date range conditions from found_after / found_before. */
function dateFilters(args: Row): FilterObject[] {
  const out: FilterObject[] = [];
  const after = normDate(args.found_after, "found_after");
  const before = normDate(args.found_before, "found_before");
  if (after) out.push({ field: "findings_end_date", operator: "gt", value: after });
  if (before) out.push({ field: "findings_end_date", operator: "lt", value: before });
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
    note: hasMore ? `More cases match than the ${limit} shown (largest back wages first); raise limit or narrow the query.` : undefined,
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
    cases: rows.map(normalizeCase),
  };
}

async function flaggedEmployers(args: Row): Promise<unknown> {
  const state = args.state != null && args.state !== "" ? normState(args.state) : null;
  const flag = str(args.flag) ?? "R";
  const limit = clampLimit(args.limit, 20);

  const parts: FilterObject[] = [{ field: "flsa_repeat_violator", operator: "eq", value: flag }];
  if (state) parts.push({ field: "st_cd", operator: "eq", value: state });

  const { rows, hasMore } = await pageWithProbe({ filter: andAll(parts), sort_by: "bw_atp_amt", sort: "desc" }, limit);
  return {
    query: { state, flag },
    count: rows.length,
    has_more: hasMore,
    note:
      "flsa_repeat_violator is WHD's own flag (its data dictionary publishes R = repeat, W = willful, " +
      "RW = both). The flag reflects WHD's characterization at case conclusion, not a court finding.",
    cases: rows.map(normalizeCase),
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

  const fields = [
    "case_id",
    "bw_atp_amt",
    "ee_violtd_cnt",
    "case_violtn_cnt",
    "findings_start_date",
    "findings_end_date",
    ...CMP_AMOUNT_FIELDS,
  ];
  const rows = await dolGet({ limit: cap, filter, fields });

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
    capped: rows.length >= cap,
    total_back_wages: Math.round(totalBackWages * 100) / 100,
    total_employees_affected: totalEmployees,
    total_civil_penalties: Math.round(totalPenalties * 100) / 100,
    earliest_findings_start: earliest,
    latest_findings_end: latest,
    note:
      "Aggregated client-side over matching cases (WHD data is one row per compliance action). " +
      "total_civil_penalties is the sum of statute-level civil money penalties. " +
      "capped=true means results hit max_cases and the totals are a floor.",
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
    note: hasMore ? `More cases match than the ${limit} shown (largest back wages first); raise limit or narrow the query.` : undefined,
    cases: rows.map(normalizeCase),
  };
}

async function caseDetail(args: Row): Promise<unknown> {
  const caseId = str(args.case_id);
  if (!caseId) throw new Error("case_id is required.");
  // case_id is numeric in WHISARD; send a number when it parses cleanly.
  const value: unknown = /^\d+$/.test(caseId) ? Number(caseId) : caseId;

  const rows = await dolGet({
    limit: 1,
    filter: { field: "case_id", operator: "eq", value },
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

/** Deepest-first scan for findings_end_date, so every result shape is covered. */
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
      key === "findings_end_date" && typeof value === "string" && value !== ""
        ? value
        : newestFindingsDate(value);
    if (found !== null && (max === null || found > max)) max = found;
  }
  return max;
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
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await handler((args ?? {}) as Row);
      return { content: [{ type: "text", text: JSON.stringify(withDataCurrency(result), null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
