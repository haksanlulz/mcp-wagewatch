import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// Fixtures: real WHISARD (WHD/enforcement) column names and response envelope.
// The DOL API wraps records in { "data": [ ... ] }.
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
  findings_start_date: "2021-01-01",
  findings_end_date: "2022-01-01",
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
  findings_start_date: "2019-06-01",
  findings_end_date: "2019-12-01",
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("lists exactly the four documented tools", async () => {
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

  it("builds an uppercased trade_nm/legal_name LIKE filter, sorted by back wages", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "acme" });

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe("https://apiprod.dol.gov/v4/get/WHD/enforcement/json");
    const filter = JSON.parse(url.searchParams.get("filter_object")!);
    expect(filter).toEqual({
      or: [
        { field: "trade_nm", operator: "like", value: "%ACME%" },
        { field: "legal_name", operator: "like", value: "%ACME%" },
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
    // The key rides the header, never the query string, so it cannot leak into
    // request logs (README: "the key is never logged").
    expect(url.searchParams.get("X-API-KEY")).toBe("test-key"); // query param: the header form 401s live
    expect(opts.headers["X-API-KEY"]).toBeUndefined();
    // Outbound requests carry an abort/timeout signal.
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // DOL Open Data is a free public service: identify ourselves on every call,
    // the same contract the sibling civic servers honour. Asserted because a
    // missing UA is invisible to every other test in this file — it shipped
    // that way until 2026-07-29.
    expect(opts.headers["User-Agent"]).toMatch(/^mcp-wagewatch\/\d/);
  });

  it("uppercases the employer term in the LIKE filter (WHD stores names uppercase)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await call("employer_violations", { employer: "Tyson Foods" });

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.or[0].value).toBe("%TYSON FOODS%");
    expect(filter.or[1].value).toBe("%TYSON FOODS%");
  });

  it("escapes LIKE metacharacters in the employer term so they match literally", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    // Input carries a backslash, percent, and underscore that must not act as wildcards.
    await call("employer_violations", { employer: "a_b%c\\d" });

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    // Uppercased to A_B%C\D, then backslash escaped first, then % and _.
    expect(filter.or[0].value).toBe("%A\\_B\\%C\\\\D%");
    expect(filter.or[1].value).toBe("%A\\_B\\%C\\\\D%");
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

  it("surfaces an HTTP error status as isError", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("upstream boom", { ok: false, status: 500 }));
    const res: any = await call("employer_violations", { employer: "acme" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("500");
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
    expect(body.earliest_findings_start).toBe("2019-06-01");
    expect(body.latest_findings_end).toBe("2022-01-01");
  });

  it("requires at least one of employer or state", async () => {
    const res: any = await call("back_wages_summary", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/at least one/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
    fetchMock.mockResolvedValue(jsonResponse({ data: [ROW_SMALL, ROW_TYSON] }));
    const body = payload(await call("employer_violations", { employer: "x" }));
    expect(body.data_currency.newest_findings_end_date).toBe("2022-01-01");
  });

  it("says so plainly when a result set carries no dates at all", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const body = payload(await call("employer_violations", { employer: "nobody" }));
    expect(body.data_currency.newest_findings_end_date).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// 1.1.0: top_cases, flagged_employers, date filters, visible truncation
// ---------------------------------------------------------------------------

describe("wagewatch 1.1.0", () => {
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

  it("date filters ride findings_end_date as gt/lt filter nodes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("violations_by_state", { state: "NY", found_after: "2024-01-01", found_before: "2026-01-01" });
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    const nodes = filter.and;
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "gt", value: "2024-01-01" });
    expect(nodes).toContainEqual({ field: "findings_end_date", operator: "lt", value: "2026-01-01" });
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
    expect(filter.and).toContainEqual({ field: "flsa_repeat_violator", operator: "eq", value: "R" });
    expect(String(body.note)).toContain("not a court finding");
    expect(body).toHaveProperty("data_currency");
  });
});
