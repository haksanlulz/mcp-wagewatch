// mcp-wagewatch: MCP server over the U.S. Department of Labor
// Wage and Hour Division (WHD) enforcement dataset (WHISARD compliance actions).
//
// Data source: DOL Open Data API, dataset agency "WHD", endpoint "enforcement".
//   Base:   https://apiprod.dol.gov/v4
//   Query:  GET /get/WHD/enforcement/json?limit=..&offset=..&sort=..&sort_by=..&fields=..&filter_object=..&X-API-KEY=..
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
    throw new Error(
      "DOL API returned an unrecognized response: " + JSON.stringify(json).slice(0, 300),
    );
  }
  return [];
}

/** Execute one GET against the WHD/enforcement endpoint and return raw rows. */
async function dolGet(params: QueryParams): Promise<Row[]> {
  const key = apiKey();
  const url = new URL(`${DOL_API}/get/${WHD_AGENCY}/${WHD_ENDPOINT}/json`);
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.offset != null) url.searchParams.set("offset", String(params.offset));
  if (params.sort) url.searchParams.set("sort", params.sort);
  if (params.sort_by) url.searchParams.set("sort_by", params.sort_by);
  if (params.fields?.length) url.searchParams.set("fields", params.fields.join(","));
  if (params.filter) url.searchParams.set("filter_object", JSON.stringify(params.filter));
  // Auth is header-only: the key rides the X-API-KEY request header below and is
  // never written into the URL/query string, so it cannot leak into request logs.
  const res = await throttled(() =>
    fetch(url, {
      headers: { "X-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }),
  );
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`DOL API request failed (HTTP ${res.status}): ${text.slice(0, 300).trim()}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Auth failures come back as a plain-text sentence (e.g. "The API key is
    // either incorrect or missing..."), sometimes with a 200. Surface it clearly.
    throw new Error(`DOL API returned a non-JSON response: ${text.slice(0, 300).trim()}`);
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
        limit: { type: "integer", description: `Max cases to return (1-${MAX_PAGE}, default 20).` },
      },
      required: ["state"],
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

async function employerViolations(args: Row): Promise<unknown> {
  const employer = str(args.employer);
  if (!employer) throw new Error("employer is required.");
  const limit = clampLimit(args.limit, 20);

  const name = nameFilter(employer);
  const filter: FilterObject = args.state
    ? { and: [name, { field: "st_cd", operator: "eq", value: normState(args.state) }] }
    : name;

  const rows = await dolGet({ limit, filter, sort_by: "bw_atp_amt", sort: "desc" });
  return {
    query: { employer, state: args.state ? normState(args.state) : null },
    count: rows.length,
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

  const rows = await dolGet({
    limit,
    filter: { and: parts },
    sort_by: "bw_atp_amt",
    sort: "desc",
  });
  return {
    query: { state, naics: naics ?? null },
    count: rows.length,
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
  case_detail: caseDetail,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-wagewatch", version: "1.0.0" },
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
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
