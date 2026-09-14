import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, clearDolCache, resetEnvWarnings } from "../server.js";

// ---------------------------------------------------------------------------
// Fixtures: real WHISARD (WHD/enforcement) column names and response envelope.
// The DOL API wraps records in { "data": [ ... ] }.
//
// Dates carry the shape the API actually returns: a full timestamp at midnight,
// "2024-06-16T00:00:00", not a bare YYYY-MM-DD. The fixtures used to hold the
// bare form, which is why nothing in this file noticed that found_after and
// found_before were dropping their own day against real timestamps (WW-4).
// ---------------------------------------------------------------------------

const ROW_TYSON = {
  case_id: 1234567,
  trade_nm: "TYSON FOODS INC",
  legal_name: "TYSON FOODS INCORPORATED",
  street_addr_1_txt: "2200 DON TYSON PKWY",
  cty_nm: "SPRINGDALE",
  st_cd: "AR",
  zip_cd: "72762",
  naic_cd: "311615",
  naics_code_description: "Poultry Processing",
  case_violtn_cnt: 12,
  ee_violtd_cnt: 88,
  bw_atp_amt: 150000.5,
  cmp_assd_cnt: 2,
  flsa_violtn_cnt: 10,
  flsa_bw_atp_amt: 120000.5,
  flsa_ee_atp_cnt: 80,
  flsa_cmp_assd_amt: 5000,
  mspa_violtn_cnt: 2,
  mspa_bw_atp_amt: 30000,
  mspa_ee_atp_cnt: 8,
  mspa_cmp_assd_amt: 2500,
  flsa_repeat_violator: "R",
  findings_start_date: "2021-01-01T00:00:00",
  findings_end_date: "2022-01-01T00:00:00",
};

// Second row uses string numerics to exercise coercion, and a sparse schema.
const ROW_SMALL = {
  case_id: 7654321,
  trade_nm: "TYSON DELI LLC",
  legal_name: "TYSON DELI LLC",
  st_cd: "AR",
  case_violtn_cnt: 3,
  ee_violtd_cnt: "4",
  bw_atp_amt: "5000",
  flsa_cmp_assd_amt: "1000",
  findings_start_date: "2019-06-01T00:00:00",
  findings_end_date: "2019-12-01T00:00:00",
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let client: Client;
let fetchMock: ReturnType<typeof vi.fn>;

/** Build a fake fetch Response carrying a JSON body. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  };
}

/** Build a fake fetch Response carrying a raw (non-JSON) text body. */
function textResponse(text: string, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => text,
  };
}

/** The first URL passed to fetch, for asserting query construction. */
function lastUrl(): URL {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call[0] as URL;
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

/** Parse the JSON text payload out of a successful tool result. */
function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

// The response cache lives for the process; without this a value cached by one
// test is served to the next and the suite becomes order-dependent.
beforeEach(() => {
  clearDolCache();
  // The bad-env warning is emitted once per distinct value for the life of the
  // process; without this reset, whether a test SEES the warning depends on
  // which test ran first.
  resetEnvWarnings();
});

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  process.env.DOL_API_KEY = "test-key";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(() => {
  // Restore the real fetch and clear the mocked env key.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DOL_API_KEY;
  // Tuning knobs are read from the environment per call; a value left behind by
  // one test would silently retune the next.
  delete process.env.DOL_HTTP_ATTEMPTS;
  delete process.env.DOL_CACHE_TTL_MS;
  delete process.env.DOL_CACHE_MAX;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("lists exactly the six documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "back_wages_summary",
      "case_detail",
      "employer_violations",
      "flagged_employers",
      "top_cases",
      "violations_by_state",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("employer_violations", () => {
  it("returns normalized cases and sums per-statute civil penalties", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const res = await call("employer_violations", { employer: "tyson" });
    const body = payload(res);

    expect(body.count).toBe(1);
    const c = body.cases[0];
    expect(c.case_id).toBe("1234567");
    expect(c.employer).toBe("TYSON FOODS INC");
    expect(c.location).toEqual({
      street: "2200 DON TYSON PKWY",
      city: "SPRINGDALE",
      state: "AR",
      zip: "72762",
    });
    expect(c.back_wages).toBe(150000.5);
    expect(c.employees_affected).toBe(88);
    // 5000 (FLSA) + 2500 (MSPA)
    expect(c.civil_penalties).toBe(7500);
    expect(c.naics_description).toBe("Poultry Processing");
  });

  it("builds a case-variant trade_nm/legal_name LIKE filter, sorted by back wages", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "acme" });

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe("https://apiprod.dol.gov/v4/get/WHD/enforcement/json");
    const filter = JSON.parse(url.searchParams.get("filter_object")!);
    // DOL's LIKE is case-sensitive and WHISARD stores names mixed-case, so the
    // term rides in every case variant across both name columns.
    expect(filter).toEqual({
      or: [
        { field: "trade_nm", operator: "like", value: "%acme%" },
        { field: "trade_nm", operator: "like", value: "%ACME%" },
        { field: "trade_nm", operator: "like", value: "%Acme%" },
        { field: "legal_name", operator: "like", value: "%acme%" },
        { field: "legal_name", operator: "like", value: "%ACME%" },
        { field: "legal_name", operator: "like", value: "%Acme%" },
      ],
    });
    expect(url.searchParams.get("sort_by")).toBe("bw_atp_amt");
    expect(url.searchParams.get("sort")).toBe("desc");
  });

  it("sends the API key as a query parameter (the v4 API rejects the header form), with a timeout signal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "acme" });

    const lastCall = fetchMock.mock.calls.at(-1)!;
    const url = lastCall[0] as URL;
    const opts = lastCall[1] as any;
    // The key rides the QUERY STRING: the v4 API answers 401 to the header form
    // (verified live 2026-08-23). The comment that used to sit here said the
    // opposite of the assertion beneath it. What protects the key instead is the
    // redaction test below — no error message carries the URL or the key.
    expect(url.searchParams.get("X-API-KEY")).toBe("test-key");
    expect(opts.headers["X-API-KEY"]).toBeUndefined();
    // Outbound requests carry an abort/timeout signal.
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // DOL Open Data is a free public service: identify ourselves on every call,
    // the same contract the sibling civic servers honour. Asserted because a
    // missing UA is invisible to every other test in this file — it shipped
    // that way until 2026-07-29.
    expect(opts.headers["User-Agent"]).toMatch(/^mcp-wagewatch\/\d/);
  });

  it("never lets the request URL or the key reach a caller in an error", async () => {
    // Since the key must ride the query string, this is the property that
    // guards it. Two shapes, both of which surface someone else's message: an
    // upstream body that echoes the request, and a transport error that quotes
    // the URL it was fetching.
    process.env.DOL_API_KEY = "s3cr3t-dol-key-value";

    fetchMock.mockResolvedValue(
      textResponse(
        "rejected: https://apiprod.dol.gov/v4/get/WHD/enforcement/json?limit=21&X-API-KEY=s3cr3t-dol-key-value",
        { ok: false, status: 400 },
      ),
    );
    const echoed: any = await call("employer_violations", { employer: "acme" });
    expect(echoed.isError).toBe(true);
    expect(echoed.content[0].text).not.toContain("s3cr3t-dol-key-value");
    expect(echoed.content[0].text).toContain("[redacted]");

    clearDolCache();
    fetchMock.mockImplementation((url: URL) => {
      throw new Error(`connect ECONNREFUSED while requesting ${url.toString()}`);
    });
    const thrown: any = await call("employer_violations", { employer: "globex" });
    expect(thrown.isError).toBe(true);
    expect(thrown.content[0].text).not.toContain("s3cr3t-dol-key-value");
  });

  it("keeps the raw-cased term in the LIKE filter, not only an uppercased one", async () => {
    // The defect this pins: WHISARD stores 97% of names mixed-case and DOL's
    // LIKE is case-sensitive, so an uppercase-only pattern answered a confident
    // "no cases found" (live: "%KEVIN MISCH%" 204, "%Kevin Misch%" 200 x2 rows).
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "Tyson Foods" });

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    const values = filter.or.map((n: any) => n.value);
    expect(values).toContain("%Tyson Foods%"); // as typed — the stored shape
    expect(values).toContain("%TYSON FOODS%"); // and the uppercase-stored rows
    for (const field of ["trade_nm", "legal_name"]) {
      const perField = filter.or.filter((n: any) => n.field === field).map((n: any) => n.value);
      expect(perField).toContain("%Tyson Foods%");
      expect(perField).toContain("%TYSON FOODS%");
    }
  });

  it("title-cases a lowercase term so it matches mixed-case stored names", async () => {
    // A caseworker types "kevin misch"; WHISARD holds "Kevin Misch Excavating".
    // Neither the raw nor the uppercase variant matches that row.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "kevin misch" });

    const values = JSON.parse(lastUrl().searchParams.get("filter_object")!).or.map((n: any) => n.value);
    expect(values).toContain("%Kevin Misch%");
  });

  it("emits each case variant once, across both name columns", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "ACME" }); // raw === uppercase
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    // raw and upper collapse to one pattern, so 2 fields x 2 distinct variants.
    expect(filter.or).toHaveLength(4);
    expect(new Set(filter.or.map((n: any) => `${n.field}|${n.value}`)).size).toBe(4);
  });

  it("escapes LIKE metacharacters in the employer term so they match literally", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    // Input carries a backslash, percent, and underscore that must not act as wildcards.
    await call("employer_violations", { employer: "a_b%c\\d" });

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    // Every case variant is escaped: the case fold happens on the raw term and
    // escapeLike runs after it, so no variant can reintroduce a live wildcard.
    const values: string[] = filter.or.map((n: any) => n.value);
    expect(values).toContain("%a\\_b\\%c\\\\d%"); // raw
    expect(values).toContain("%A\\_B\\%C\\\\D%"); // uppercase
    for (const v of values) {
      expect(v.slice(1, -1)).not.toMatch(/(^|[^\\])[%_]/); // no unescaped wildcard inside
    }
  });

  it("AND-combines the name filter with a state filter", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "acme", state: "ny" });

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.and).toBeDefined();
    expect(filter.and[1]).toEqual({ field: "st_cd", operator: "eq", value: "NY" });
  });

  it("clamps limit to the page ceiling", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "acme", limit: 99999 });
    expect(lastUrl().searchParams.get("limit")).toBe("101"); // clamped 100 + the has_more probe row
  });

  it("returns isError when DOL_API_KEY is missing", async () => {
    delete process.env.DOL_API_KEY;
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("DOL_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles an empty result set cleanly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const body = payload(await call("employer_violations", { employer: "nonesuch" }));
    expect(body.count).toBe(0);
    expect(body.cases).toEqual([]);
  });

  it("surfaces a non-JSON auth error as isError", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse("The API key is either incorrect or missing from your query."),
    );
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("non-JSON");
  });

  it("surfaces an HTTP error status as isError, after exhausting retries", async () => {
    // A 5xx is retried (see withRetry), so the mock must answer every attempt.
    fetchMock.mockResolvedValue(textResponse("upstream boom", { ok: false, status: 500 }));
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a 4xx", async () => {
    // A rejected filter answers the same however many times it is asked.
    fetchMock.mockResolvedValue(textResponse("bad filter", { ok: false, status: 400 }));
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-JSON body, which is usually a rejected key", async () => {
    fetchMock.mockResolvedValue(textResponse("The API key is either incorrect or missing", { ok: true, status: 200 }));
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 error-object body instead of reading it as zero cases", async () => {
    // A 200 whose body is an error envelope (no data/records/results array) must
    // NOT read as an empty result set -- that would be a false "no wage-theft
    // history".
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "error", message: "quota exceeded" }));
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unrecognized response");
  });
});

describe("back_wages_summary", () => {
  it("aggregates back wages, employees, penalties, and case count", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson", state: "AR" }));

    expect(body.case_count).toBe(2);
    expect(body.total_back_wages).toBe(155000.5); // 150000.5 + 5000
    expect(body.total_employees_affected).toBe(92); // 88 + 4
    expect(body.total_civil_penalties).toBe(8500); // (5000+2500) + 1000
    // Echoed in the API's own timestamp shape: ISO-8601 sorts lexicographically,
    // so the min/max scan is a string compare and needs no parsing.
    expect(body.earliest_findings_start).toBe("2019-06-01T00:00:00");
    expect(body.latest_findings_end).toBe("2022-01-01T00:00:00");
  });

  it("requires at least one of employer or state", async () => {
    const res: any = await call("back_wages_summary", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/at least one/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags a total that hit max_cases as capped, because it is then a floor", async () => {
    // The aggregate form of this server's MUST NEVER: a truncated sum reads as
    // an employer's whole wage-theft history unless the answer says otherwise.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson", max_cases: 2 }));
    expect(body.case_count).toBe(2);
    expect(body.capped).toBe(true);
    expect(String(body.note)).toContain("the totals are a floor");
    expect(lastUrl().searchParams.get("limit")).toBe("2");
  });

  it("does not flag a total that came in under max_cases", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson", max_cases: 3 }));
    expect(body.case_count).toBe(2);
    expect(body.capped).toBe(false);
  });
});

describe("violations_by_state", () => {
  it("filters by state and violations-found, sorted by back wages", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const body = payload(await call("violations_by_state", { state: "ar" }));

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.and).toContainEqual({ field: "st_cd", operator: "eq", value: "AR" });
    expect(filter.and).toContainEqual({ field: "case_violtn_cnt", operator: "gt", value: "0" });
    expect(lastUrl().searchParams.get("sort_by")).toBe("bw_atp_amt");
    expect(body.count).toBe(1);
  });

  it("adds a NAICS prefix LIKE filter when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("violations_by_state", { state: "CA", naics: "72" });
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.and).toContainEqual({ field: "naic_cd", operator: "like", value: "72%" });
  });

  it("rejects an invalid state code with isError", async () => {
    const res: any = await call("violations_by_state", { state: "California" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/2-letter/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports has_more and the truncation note when a page is full", async () => {
    // The twin of this was pinned for employer_violations and not here, so a
    // state page of exactly `limit` rows could still read as the whole story.
    const rows = Array.from({ length: 21 }, (_, i) => ({
      case_id: String(i + 1),
      trade_nm: "ACME",
      st_cd: "NY",
      bw_atp_amt: "100",
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));
    const body = payload(await call("violations_by_state", { state: "NY", limit: 20 }));
    expect(lastUrl().searchParams.get("limit")).toBe("21"); // the probe row
    expect(body.count).toBe(20);
    expect(body.has_more).toBe(true);
    expect(String(body.note)).toContain("More cases match");
  });

  it("carries no truncation note when the state page is complete", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ case_id: "1", trade_nm: "ACME", st_cd: "NY", bw_atp_amt: "100" }]));
    const body = payload(await call("violations_by_state", { state: "NY", limit: 20 }));
    expect(body.has_more).toBe(false);
    expect(body.note).toBeUndefined();
  });
});

describe("top_cases", () => {
  it("filters by NAICS prefix, escaped so the term cannot act as a wildcard", async () => {
    // violations_by_state's identical path was pinned and this one was not.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { naics: "72" });
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.and).toContainEqual({ field: "naic_cd", operator: "like", value: "72%" });

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { naics: "7_2" });
    const escaped = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(escaped.and).toContainEqual({ field: "naic_cd", operator: "like", value: "7\\_2%" });
  });

  it("combines state, NAICS and a date window in one and-filter", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { state: "tx", naics: "722511", found_after: "2020-01-01" });
    const nodes = JSON.parse(lastUrl().searchParams.get("filter_object")!).and;
    expect(nodes).toContainEqual({ field: "st_cd", operator: "eq", value: "TX" });
    expect(nodes).toContainEqual({ field: "naic_cd", operator: "like", value: "722511%" });
    expect(nodes).toContainEqual({ field: "case_violtn_cnt", operator: "gt", value: "0" });
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "gt", value: "2019-12-31T23:59:59" });
  });
});

describe("case_detail", () => {
  it("returns the full record with a per-statute breakdown", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const body = payload(await call("case_detail", { case_id: "1234567" }));

    expect(body.found).toBe(true);
    expect(body.case_id).toBe("1234567");
    expect(body.cmp_assessment_count).toBe(2);
    expect(body.flsa_repeat_violator).toBe("R");

    const statutes = body.statute_breakdown.map((s: any) => s.statute);
    expect(statutes).toContain("FLSA");
    expect(statutes).toContain("MSPA");
    const flsa = body.statute_breakdown.find((s: any) => s.statute === "FLSA");
    expect(flsa.back_wages).toBe(120000.5);

    // case_id serializes as a STRING eq filter: DOL 500s on numeric values.
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter).toEqual({ field: "case_id", operator: "eq", value: "1234567" });
  });

  it("reports found=false when no case matches", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const body = payload(await call("case_detail", { case_id: "9999999" }));
    expect(body.found).toBe(false);
    expect(body.case_id).toBe("9999999");
  });
});

describe("unknown tool", () => {
  it("rejects with a protocol error", async () => {
    await expect(call("does_not_exist", {})).rejects.toThrow();
  });
});

describe("unknown arguments", () => {
  // Every inputSchema says additionalProperties:false, but the low-level Server
  // does not validate against inputSchema, so an unknown key used to be dropped
  // in silence: top_cases {state:"NY", found_afer:"2024-01-01"} answered with
  // full history and query.found_after: null, which reads as a date-limited
  // answer that happens to be wide.
  const MINIMAL: Array<[string, Record<string, unknown>]> = [
    ["employer_violations", { employer: "acme" }],
    ["back_wages_summary", { state: "NY" }],
    ["violations_by_state", { state: "NY" }],
    ["top_cases", {}],
    ["flagged_employers", {}],
    ["case_detail", { case_id: "1" }],
  ];

  it("covers every registered tool", async () => {
    const { tools } = await client.listTools();
    expect(MINIMAL.map(([n]) => n).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  for (const [tool, args] of MINIMAL) {
    it(`${tool} rejects an unknown key before any network call`, async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      const res: any = await call(tool, { ...args, bogus_param: 12345 });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("bogus_param");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("suggests the argument a near-miss was meant to be", async () => {
    const res: any = await call("top_cases", { state: "NY", found_afer: "2024-01-01" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("found_afer");
    expect(res.content[0].text).toContain('did you mean "found_after"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names every offending key and lists what the tool accepts", async () => {
    const res: any = await call("employer_violations", { employer: "acme", bogus_param: 1, stat: "NY" });
    const text = res.content[0].text;
    expect(text).toContain("bogus_param");
    expect(text).toContain('"stat" (did you mean "state"?)');
    for (const accepted of ["employer", "state", "found_after", "found_before", "limit"]) {
      expect(text).toContain(accepted);
    }
  });

  it("does not invent a suggestion for a key that resembles nothing", async () => {
    const res: any = await call("case_detail", { case_id: "1", xyzzy_plugh_frobozz: true });
    expect(res.content[0].text).toContain("xyzzy_plugh_frobozz");
    expect(res.content[0].text).not.toContain("did you mean");
  });

  it("lets the declared arguments through", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const res: any = await call("employer_violations", {
      employer: "acme",
      state: "NY",
      found_after: "2024-01-01",
      found_before: "2026-01-01",
      limit: 5,
    });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SPEC vintage-on-every-answer — operator-authored 2026-07-29
// ---------------------------------------------------------------------------

describe("SPEC vintage-on-every-answer", () => {
  // spec: vintage-on-every-answer
  // Given WHD enforcement data, which lags and records CONCLUDED investigations
  // When any tool returns a result
  // Then the result states how current the data is, so a reader cannot mistake
  //      a closed historical case for an employer's present state.
  // Operator's stated worst failure for this server: "stale data presented as current."
  it("every successful result states its data currency", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    const body = payload(await call("employer_violations", { employer: "Tyson" }));
    expect(body).toHaveProperty("data_currency");
    expect(String(body.data_currency.note).toLowerCase()).toContain("concluded");
  });

  it("reports the newest findings date actually present, not today", async () => {
    // ROW_TYSON ends 2022-01-01, ROW_SMALL ends 2019-12-01. The answer is only
    // as current as its newest record — saying otherwise is the whole failure.
    // Reported verbatim in the API's timestamp shape, not reformatted.
    fetchMock.mockResolvedValue(jsonResponse({ data: [ROW_SMALL, ROW_TYSON] }));
    const body = payload(await call("employer_violations", { employer: "x" }));
    expect(body.data_currency.newest_findings_end_date).toBe("2022-01-01T00:00:00");
  });

  it("says so plainly when a result set carries no dates at all", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const body = payload(await call("employer_violations", { employer: "nobody" }));
    expect(body.data_currency.newest_findings_end_date).toBeNull();
  });

  it("states a vintage on the aggregate tool, which returns no rows to scan", async () => {
    // back_wages_summary publishes totals, not cases: the only date in its
    // answer is latest_findings_end. A scanner that recognises the raw column
    // name alone reports null here over dated rows — the SPEC's exact failure,
    // on one of the six tools, and the other two vintage cases both drive
    // employer_violations so neither could see it.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_SMALL, ROW_TYSON] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson" }));
    expect(body.latest_findings_end).toBe("2022-01-01T00:00:00");
    expect(body.data_currency.newest_findings_end_date).toBe("2022-01-01T00:00:00");
  });
});


// ---------------------------------------------------------------------------
// 1.1.0: top_cases, flagged_employers, date filters, visible truncation
// ---------------------------------------------------------------------------

describe("wagewatch 1.1.0", () => {
  it("a 204 empty body is a zero-match answer, not an error (live DOL contract)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, text: async () => "" });
    const body = payload(await call("employer_violations", { employer: "zzqx nonexistent llc" }));
    expect(body.count).toBe(0);
    expect(body.has_more).toBe(false);
    // The absence-is-not-clean framing must ride the empty answer especially.
    expect(String(body.data_currency?.note)).toContain("empty result");
  });

  it("employer_violations requests limit+1 and reports has_more when truncated", async () => {
    // 21 rows come back for a limit of 20: exactly the case the audit flagged
    // as indistinguishable from a complete answer.
    const rows = Array.from({ length: 21 }, (_, i) => ({ case_id: String(i + 1), trade_nm: "ACME", bw_atp_amt: "100" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));
    const body = payload(await call("employer_violations", { employer: "acme", limit: 20 }));
    const url = lastUrl();
    expect(url.searchParams.get("limit")).toBe("21"); // the probe row
    expect(body.count).toBe(20);
    expect(body.has_more).toBe(true);
    expect(String(body.note)).toContain("More cases match");
  });

  it("a complete answer reports has_more false and carries no truncation note", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ case_id: "1", trade_nm: "ACME", bw_atp_amt: "100" }]));
    const body = payload(await call("employer_violations", { employer: "acme", limit: 20 }));
    expect(body.has_more).toBe(false);
    expect(body.note).toBeUndefined();
  });

  it("date filters ride findings_end_date as INCLUSIVE gt/lt filter nodes", async () => {
    // DOL has no gte/lte and findings_end_date is a midnight timestamp, so an
    // inclusive bound is expressed as the instant just outside it. A bare
    // gt "2024-01-01" would drop every case that ended on 2024-01-01 (live:
    // gt "2024-06-16" returns 2024-06-17T00:00:00 as its earliest row), and the
    // schema promises the day is included.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("violations_by_state", { state: "NY", found_after: "2024-01-01", found_before: "2026-01-01" });
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    const nodes = filter.and;
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "gt", value: "2023-12-31T23:59:59" });
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "lt", value: "2026-01-02T00:00:00" });
  });

  it("the inclusive shift is applied exactly once, on every tool that takes a window", async () => {
    for (const [tool, args] of [
      ["employer_violations", { employer: "acme" }],
      ["violations_by_state", { state: "NY" }],
      ["top_cases", {}],
    ] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await call(tool, { ...args, found_after: "2024-06-16", found_before: "2024-06-16" });
      const raw = lastUrl().searchParams.get("filter_object")!;
      const nodes = JSON.parse(raw).and;
      // One day out, not two: a second application would read 2024-06-14.
      expect(nodes).toContainEqual({ field: "findings_end_date", operator: "gt", value: "2024-06-15T23:59:59" });
      expect(nodes).toContainEqual({ field: "findings_end_date", operator: "lt", value: "2024-06-17T00:00:00" });
      // A single-day window still selects that day's rows rather than nothing.
      expect(nodes.filter((n: any) => n.field === "findings_end_date")).toHaveLength(2);
    }
  });

  it("the shift handles month, year and leap-day rollover", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { found_after: "2024-03-01", found_before: "2024-12-31" });
    const nodes = JSON.parse(lastUrl().searchParams.get("filter_object")!).and;
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "gt", value: "2024-02-29T23:59:59" }); // leap year
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "lt", value: "2025-01-01T00:00:00" }); // year rollover

    // The other two rollovers, one bound at a time: this pair used to ride on a
    // single TRANSPOSED window (after 2025-01-01, before 2023-02-28), which is
    // now refused as input — correctly, and it would have taken the arithmetic
    // coverage with it.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { found_after: "2025-01-01" });
    const nodes2 = JSON.parse(lastUrl().searchParams.get("filter_object")!).and;
    expect(nodes2).toContainEqual({ field: "findings_end_date", operator: "gt", value: "2024-12-31T23:59:59" }); // year rollover, backwards

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { found_before: "2023-02-28" });
    const nodes3 = JSON.parse(lastUrl().searchParams.get("filter_object")!).and;
    expect(nodes3).toContainEqual({ field: "findings_end_date", operator: "lt", value: "2023-03-01T00:00:00" }); // non-leap
  });

  it("a transposed window is refused, because an unsatisfiable filter answers 0", async () => {
    // found_after later than found_before builds `gt 2024-12-31T23:59:59 AND
    // lt 2023-03-01T00:00:00` — a filter nothing can satisfy. DOL answers it
    // HTTP 204, which this server renders as count 0, has_more false, and the
    // note that an empty result means no concluded published case was found.
    // Confirmed live 2026-09-14: that exact filter returns 204. The bound order
    // is the only thing that can tell a mistyped window from a real absence.
    const res: any = await call("top_cases", { found_after: "2025-01-01", found_before: "2023-02-28" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("2025-01-01");
    expect(res.content[0].text).toContain("2023-02-28");
    expect(res.content[0].text).toMatch(/selects nothing|later than/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a window whose bounds are equal is allowed: it is one day, not an error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const res: any = await call("top_cases", { found_after: "2024-06-16", found_before: "2024-06-16" });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("all three date-window tools promise the same inclusive semantics, verbatim", async () => {
    const { tools } = await client.listTools();
    const windowed = tools.filter((t) => "found_after" in ((t.inputSchema as any).properties ?? {}));
    expect(windowed.map((t) => t.name).sort()).toEqual(["employer_violations", "top_cases", "violations_by_state"]);
    for (const t of windowed) {
      const props = (t.inputSchema as any).properties;
      for (const bound of ["found_after", "found_before"]) {
        expect(props[bound].description).toContain("Inclusive: a case that ended on this exact date is included.");
      }
      expect(props.found_after.description).toContain("ended on or after");
      expect(props.found_before.description).toContain("ended on or before");
    }
    // One string per bound across all three, so the promise cannot drift.
    expect(new Set(windowed.map((t) => (t.inputSchema as any).properties.found_after.description)).size).toBe(1);
    expect(new Set(windowed.map((t) => (t.inputSchema as any).properties.found_before.description)).size).toBe(1);
  });

  it("a malformed date is rejected before any network call", async () => {
    const res: any = await call("top_cases", { found_after: "January 2024" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("YYYY-MM-DD");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("top_cases works with no filters at all (national biggest cases)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ case_id: "9", trade_nm: "BIG CO", bw_atp_amt: "5000000" }]));
    const body = payload(await call("top_cases", {}));
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    // Bare violation-count condition, no state/naics nodes.
    expect(filter).toEqual({ field: "case_violtn_cnt", operator: "gt", value: "0" }); // DOL 500s on numeric filter values
    expect(lastUrl().searchParams.get("sort_by")).toBe("bw_atp_amt");
    expect(body.cases[0].employer).toBe("BIG CO");
  });

  it("flagged_employers filters on the WHD flag and says it is not a court finding", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ case_id: "3", trade_nm: "REPEAT CO", flsa_repeat_violator: "R", bw_atp_amt: "900" }]));
    const body = payload(await call("flagged_employers", { state: "NY" }));
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.and).toContainEqual({ field: "flsa_repeat_violator", operator: "in", value: ["R", "RW"] });
    expect(String(body.note)).toContain("not a court finding");
    expect(body).toHaveProperty("data_currency");
  });

  it("the default repeat search includes the RW (repeat AND willful) rows", async () => {
    // eq "R" matched the literal "R" only, so the most serious category -- an
    // employer WHD flagged both repeat and willful -- was absent from the list
    // whose whole purpose is repeat violators. Live: eq "RW" returns case_id
    // 1476714 and 1461405, and neither can reach an eq "R" result.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("flagged_employers", {});
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter).toEqual({ field: "flsa_repeat_violator", operator: "in", value: ["R", "RW"] });
  });

  it("the willful search includes RW too, and reports which flags it matched", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const body = payload(await call("flagged_employers", { flag: "w" }));
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter).toEqual({ field: "flsa_repeat_violator", operator: "in", value: ["W", "RW"] });
    expect(body.query.flag).toBe("W");
    expect(body.query.matched_flags).toEqual(["W", "RW"]);
  });

  it("RW searches only the both-flags rows", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("flagged_employers", { flag: "RW" });
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter).toEqual({ field: "flsa_repeat_violator", operator: "in", value: ["RW"] });
  });

  it("rejects a flag outside R/W/RW before any network call, naming the three", async () => {
    // Free text reached the filter and came back a clean zero-result answer,
    // which reads as "no flagged employers" rather than "that is not a flag".
    const res: any = await call("flagged_employers", { flag: "repeat" });
    expect(res.isError).toBe(true);
    for (const legal of ["R", "W", "RW"]) expect(res.content[0].text).toContain(legal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("each flagged case carries the flag it was matched on", async () => {
    // Without this the one tool whose entire purpose is the flag returned a list
    // in which no case states its flag, and telling R from RW cost one
    // case_detail call per case.
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { case_id: "3", trade_nm: "Repeat Co", flsa_repeat_violator: "R", bw_atp_amt: "900" },
        { case_id: "4", trade_nm: "Both Co", flsa_repeat_violator: "RW", bw_atp_amt: "800" },
        { case_id: "5", trade_nm: "Blank Co", bw_atp_amt: "700" },
      ]),
    );
    const body = payload(await call("flagged_employers", {}));
    expect(body.cases.map((c: any) => c.flsa_repeat_violator)).toEqual(["R", "RW", null]);
    expect(body.cases[1].employer).toBe("Both Co"); // still a normalized case
  });

  it("no other list tool grew the flag field", async () => {
    // ROW_TYSON carries flsa_repeat_violator: "R". employer_violations must not
    // start reporting it -- the field map documents it as flagged_employers and
    // case_detail only.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const ev = payload(await call("employer_violations", { employer: "tyson" }));
    expect(ev.cases[0]).not.toHaveProperty("flsa_repeat_violator");

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const vbs = payload(await call("violations_by_state", { state: "AR" }));
    expect(vbs.cases[0]).not.toHaveProperty("flsa_repeat_violator");

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const tc = payload(await call("top_cases", {}));
    expect(tc.cases[0]).not.toHaveProperty("flsa_repeat_violator");
  });

  it("array filter values survive serialization as an array of strings", async () => {
    // stringifyFilterValues maps arrays elementwise; if it stringified the array
    // itself the `in` filter would become the literal "R,RW" and match nothing.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("flagged_employers", {});
    const raw = lastUrl().searchParams.get("filter_object")!;
    expect(raw).toContain('"value":["R","RW"]');
    expect(JSON.parse(raw).value).toEqual(["R", "RW"]);
  });
});

describe("outbound throttle", () => {
  // DOL Open Data is a free public service shared with everyone else using it.
  // The throttle is the politeness contract, and GAUNTLET §3 claimed these two
  // scans existed for a year while neither did.
  it("serializes concurrent requests through the throttle queue", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return jsonResponse([]);
    });

    await Promise.all([
      call("employer_violations", { employer: "alpha" }),
      call("employer_violations", { employer: "bravo" }),
      call("employer_violations", { employer: "charlie" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1); // never two requests on the wire at once
  });

  it("spaces request STARTS by the throttle gap", async () => {
    // Start-to-start, not gap-after-response: a slow reply must not let the next
    // request go out immediately behind it.
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return jsonResponse([]);
    });

    await Promise.all([
      call("employer_violations", { employer: "delta" }),
      call("employer_violations", { employer: "echo" }),
      call("employer_violations", { employer: "foxtrot" }),
    ]);

    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) {
      // 150ms floor; the slack is host timer resolution, not policy.
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(140);
    }
  });
});

describe("environment knobs", () => {
  // Each of these is Number(process.env.X ?? default) with nothing between the
  // operator's typo and the code. DOL_HTTP_ATTEMPTS=abc made HTTP_ATTEMPTS NaN,
  // so `attempt < NaN` was false on the first pass, the retry loop never ran,
  // and the function threw its uninitialised `last` -- rendering, through a real
  // MCP call, the text "Error: undefined". A NaN cache TTL is worse still: this
  // server's stated MUST NEVER is stale data presented as current, and a
  // never-expiring cache is exactly that.
  it("a non-numeric DOL_HTTP_ATTEMPTS falls back to the default instead of killing the loop", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DOL_HTTP_ATTEMPTS = "abc";
    fetchMock.mockResolvedValue(textResponse("upstream boom", { ok: false, status: 500 }));

    const res: any = await call("employer_violations", { employer: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // the documented default
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("500");
    expect(res.content[0].text).not.toContain("undefined");
    expect(warn.mock.calls.flat().join(" ")).toContain("DOL_HTTP_ATTEMPTS");
  });

  it("DOL_HTTP_ATTEMPTS=0 cannot produce a request that was never attempted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DOL_HTTP_ATTEMPTS = "0";
    fetchMock.mockResolvedValue(jsonResponse([]));

    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("no tool result can carry the text 'Error: undefined'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of ["abc", "0", "-4", "2.5", ""]) {
      for (const knob of ["DOL_HTTP_ATTEMPTS", "DOL_CACHE_TTL_MS", "DOL_CACHE_MAX"]) {
        clearDolCache();
        process.env[knob] = bad;
        fetchMock.mockResolvedValue(jsonResponse([]));
        const res: any = await call("top_cases", { limit: 1 });
        expect(res.content[0].text).not.toContain("Error: undefined");
        delete process.env[knob];
      }
    }
  });

  it("a valid DOL_HTTP_ATTEMPTS is still honoured", async () => {
    process.env.DOL_HTTP_ATTEMPTS = "2";
    fetchMock.mockResolvedValue(textResponse("upstream boom", { ok: false, status: 500 }));
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a non-numeric DOL_CACHE_TTL_MS still expires an entry at the documented default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DOL_CACHE_TTL_MS = "forever";
    fetchMock.mockResolvedValue(jsonResponse([]));
    const DAY = 24 * 60 * 60 * 1000;

    const t0 = Date.now();
    await call("employer_violations", { employer: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Only Date.now is faked: the throttle's setTimeout must keep running.
    const now = vi.spyOn(Date, "now").mockReturnValue(t0 + DAY - 60_000);
    await call("employer_violations", { employer: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // still inside the default day

    now.mockReturnValue(t0 + DAY + 60_000);
    await call("employer_violations", { employer: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // expired, refetched
  });

  it("DOL_CACHE_TTL_MS=0 still disables the cache", async () => {
    process.env.DOL_CACHE_TTL_MS = "0";
    fetchMock.mockResolvedValue(jsonResponse([]));
    await call("employer_violations", { employer: "acme" });
    await call("employer_violations", { employer: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("response cache", () => {
  // The WHD dataset records CONCLUDED cases, so a repeat query in one session is
  // asking about history that has already happened.
  it("serves a repeated query without a second request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await call("employer_violations", { employer: "acme" });
    await call("employer_violations", { employer: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a different employer as a different key", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await call("employer_violations", { employer: "acme" });
    await call("employer_violations", { employer: "globex" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry once DOL_CACHE_MAX is reached", async () => {
    // Hits and misses were pinned; eviction was not, so a cache that grew
    // without bound would have looked exactly like this one.
    process.env.DOL_CACHE_MAX = "2";
    fetchMock.mockResolvedValue(jsonResponse([]));

    await call("employer_violations", { employer: "alpha" }); // 1
    await call("employer_violations", { employer: "bravo" }); // 2
    await call("employer_violations", { employer: "charlie" }); // 3 -> evicts alpha
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await call("employer_violations", { employer: "charlie" }); // still cached
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await call("employer_violations", { employer: "alpha" }); // evicted: refetched
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failure", async () => {
    fetchMock.mockResolvedValue(textResponse("boom", { ok: false, status: 500 }));
    const bad: any = await call("employer_violations", { employer: "acme" });
    expect(bad.isError).toBe(true);
    const after = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue(jsonResponse([]));
    const good: any = await call("employer_violations", { employer: "acme" });
    expect(good.isError).toBeFalsy();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(after);
  });
});
