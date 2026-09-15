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
    // term rides in three case variants across both name columns. Three, not
    // all of them — internal capitals are the residue, named in the answer.
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

  it("sends a LIKE metacharacter through unescaped, because DOL's engine has no escape character (R1)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    // This test asserted the OPPOSITE until 2026-09-14: that the term arrived
    // backslash-escaped. Live, six probes in one run, every escaped form answers
    // HTTP 204 while its bare twin answers 200 with rows -- `%Kevin\_Misch%` and
    // `%Kevin\%Misch%` both zero, `%Kevin_Misch%` and `%Kevin%Misch%` both two.
    // So the escaping aimed a pattern at a literal backslash and the answer was
    // a confident "no cases found", this dataset's worst one. Unescaped, the
    // metacharacter widens the search, which a caller can see and narrow.
    await call("employer_violations", { employer: "a_b%c\\d" });

    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    const values: string[] = filter.or.map((n: any) => n.value);
    expect(values).toContain("%a_b%c\\d%"); // raw, byte for byte as typed
    expect(values).toContain("%A_B%C\\D%"); // uppercase
    for (const v of values) {
      expect(v).not.toContain("\\_"); // no escape sequence reaches DOL
      expect(v).not.toContain("\\%");
      expect(v).not.toContain("\\\\");
    }
  });

  it("a zero-result name search says the case variants are three, not all of them", async () => {
    // Three variants close a name stored as typed, uppercased or title-cased.
    // They do NOT close internal capitals — "ABC Plumbing", "JBS USA",
    // "McDonald's" — because LIKE has no case-insensitive form and DOL exposes
    // no `ilike`. That residue arrives as count 0, which on this dataset reads
    // as "no wage theft here", so the empty answer has to name it.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const body = payload(await call("employer_violations", { employer: "abc plumbing" }));
    expect(body.count).toBe(0);
    expect(String(body.note)).toMatch(/case-SENSITIVE/i);
    expect(String(body.note)).toContain("ABC Plumbing");
    expect(String(body.note)).toMatch(/retry/i);
  });

  it("a name search that found cases carries no retry hint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON] }));
    const body = payload(await call("employer_violations", { employer: "tyson" }));
    expect(body.count).toBe(1);
    expect(String(body.note ?? "")).not.toMatch(/retry/i);
  });

  it("a zero-result state query carries no retry hint: only a name can hit the case problem", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const body = payload(await call("violations_by_state", { state: "NY" }));
    expect(body.count).toBe(0);
    expect(String(body.note ?? "")).not.toMatch(/capitalization/i);
  });

  it("both name-searching tools state the case caveat, in one shared string", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const descs = ["employer_violations", "back_wages_summary"].map(
      (n) => (byName[n].inputSchema as any).properties.employer.description as string,
    );
    for (const d of descs) {
      expect(d).toContain("case-sensitive");
      expect(d).toContain("ABC Plumbing");
    }
    // One suffix across both, so the caveat cannot drift between them.
    const suffixes = descs.map((d) => d.slice(d.indexOf(" Matching is case-sensitive")));
    expect(new Set(suffixes).size).toBe(1);
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

  // The object shape above was rejected from the start; every OTHER non-array
  // JSON value fell through a trailing `return []` and was rendered as count 0
  // carrying the name-retry hint, with isError undefined -- the same false "no
  // wage-theft history" one type away. A real empty answer cannot arrive here:
  // dolGetOnce returns [] for a 204 or an empty body before JSON.parse (R2).
  for (const [label, body] of [
    ["a literal null", null],
    ["a bare JSON string", "quota exceeded"],
    ["a number", 0],
    ["a boolean", false],
  ] as const) {
    it(`rejects ${label} body instead of reading it as zero cases (R2)`, async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      const res: any = await call("employer_violations", { employer: "acme" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("unrecognized response");
    });
  }

  it("still reads a 204 as a real empty answer, not an unrecognized one (R2)", async () => {
    // The guard above must not swallow the single most load-bearing answer this
    // dataset gives. 204 returns before JSON.parse, so it stays count 0.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, text: async () => "" });
    const body = payload(await call("employer_violations", { employer: "nonesuch" }));
    expect(body.count).toBe(0);
    expect(body.cases).toEqual([]);
  });
});

describe("back_wages_summary", () => {
  it("asks for the largest cases first, so a capped floor is the strongest one (R6)", async () => {
    // The only query in this file that carried no sort_by. Uncapped it makes no
    // difference to the totals; capped it decides WHICH cases are summed, and
    // which row's date becomes latest_findings_end -- i.e. the vintage
    // data_currency reports. Unsorted, a capped answer could state a vintage
    // years older than the newest matching case while the SPEC says an answer
    // is exactly as current as its newest row.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    await call("back_wages_summary", { employer: "tyson", max_cases: 2 });
    const url = lastUrl();
    expect(url.searchParams.get("sort_by")).toBe("bw_atp_amt");
    expect(url.searchParams.get("sort")).toBe("desc");
  });

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
    // Three rows come back for max_cases 2: the third is the probe row, and it
    // is what makes `capped` a statement about the data rather than about the
    // page being full.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL, ROW_SMALL] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson", max_cases: 2 }));
    expect(body.case_count).toBe(2); // the probe row is not summed
    expect(body.total_back_wages).toBe(155000.5); // 150000.5 + 5000, not 160000.5
    expect(body.capped).toBe(true);
    expect(String(body.note)).toContain("the totals are a floor");
    expect(lastUrl().searchParams.get("limit")).toBe("3"); // max_cases + 1
  });

  it("does not flag a total that came in under max_cases", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson", max_cases: 3 }));
    expect(body.case_count).toBe(2);
    expect(body.capped).toBe(false);
  });

  it("counts a civil-penalty column the old allow-list did not name", async () => {
    // totalCivilPenalties scans every *_cmp_assd_amt key on the row, on purpose
    // and by the same rule the README documents for all three tools that report
    // penalties. back_wages_summary used to restrict its request to an 11-name
    // hardcoded list and then run that open-ended scan over the truncated row,
    // so the same fact had two owners: a statute column WHD adds tomorrow would
    // be counted by case_detail and dropped by the aggregate, silently.
    //
    // The 11 names were the complete live set on 2026-09-14 (110 columns on a
    // real row, 11 of them *_cmp_assd_amt), so this is the FUTURE column, not a
    // present miss — which is why no projection is the fix rather than a longer
    // list. Cost measured the same day: an unprojected 1000-row page is 2.8 MB
    // in 3.7 s, inside DOL's 5 MB ceiling and this server's 15 s timeout, and
    // every other tool already fetches whole rows.
    const withNewStatute: Record<string, unknown> = { ...ROW_SMALL, dbra_cmp_assd_amt: "750" };
    // The mock honours `fields` the way DOL does — a projected column is simply
    // not on the row that comes back. Without that, a projection bug is
    // invisible to a mocked suite, which is how this one survived.
    fetchMock.mockImplementationOnce(async (url: URL) => {
      const fields = url.searchParams.get("fields");
      const kept =
        fields == null
          ? withNewStatute
          : Object.fromEntries(Object.entries(withNewStatute).filter(([k]) => fields.split(",").includes(k)));
      return jsonResponse({ data: [kept] });
    });
    const body = payload(await call("back_wages_summary", { employer: "tyson" }));
    expect(body.total_civil_penalties).toBe(1750); // 1000 flsa + 750 the list never named
    // No projection at all: a `fields` list is what made the divergence possible.
    expect(lastUrl().searchParams.get("fields")).toBeNull();
  });

  it("a $0 total for a name that matched nothing says why it might be zero", async () => {
    // The most citable thing this tool produces is a dollar figure, and $0 is
    // the one a reader turns into "this employer has no wage-theft history".
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const body = payload(await call("back_wages_summary", { employer: "abc plumbing" }));
    expect(body.case_count).toBe(0);
    expect(body.total_back_wages).toBe(0);
    expect(String(body.note)).toMatch(/case-SENSITIVE/i);
    expect(String(body.note)).toMatch(/retry/i);

    // A state-only query that came back empty is a different fact, and does not
    // get the name caveat.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const byState = payload(await call("back_wages_summary", { state: "WY" }));
    expect(byState.case_count).toBe(0);
    expect(String(byState.note)).not.toMatch(/capitalization/i);
  });

  it("an exact-max_cases total is not called a floor", async () => {
    // rows.length >= cap is true when the true match count is exactly cap, so
    // an EXACT total was published under a note saying the totals are a floor.
    // This is the tool whose output is a dollar figure a caseworker pastes into
    // a letter, and the direction of that error is the one that makes a correct
    // number unciteable. Every list tool got the limit+1 probe row for this;
    // this one did not.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [ROW_TYSON, ROW_SMALL] }));
    const body = payload(await call("back_wages_summary", { employer: "tyson", max_cases: 2 }));
    expect(body.case_count).toBe(2);
    expect(body.capped).toBe(false);
    // The whole total is present, so it is citable as a total.
    expect(body.total_back_wages).toBe(155000.5);
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

  it("rejects a two-letter code that is not a state, on every tool that takes one (WW-N)", async () => {
    // The shape check passed anything alphabetic, so `{st_cd eq "ZZ"}` went out
    // as a legal filter, came back 204, and rendered as count 0 under the note
    // that an empty result means no concluded published case was found -- the
    // confident zero, from two wrong characters. NU-for-NV and MI-for-MN are
    // the realistic typos; ZZ and XX are not codes at all.
    for (const [tool, args] of [
      ["violations_by_state", {}],
      ["top_cases", {}],
      ["employer_violations", { employer: "acme" }],
      ["flagged_employers", {}],
      ["back_wages_summary", {}],
    ] as const) {
      for (const bad of ["ZZ", "XX", "NU", "QQ"]) {
        const res: any = await call(tool, { ...args, state: bad });
        expect(res.isError, `${tool} should refuse state ${bad}`).toBe(true);
        expect(res.content[0].text).toContain(bad);
        expect(res.content[0].text).toMatch(/not a US state/i);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a falsy non-string state on every tool, rather than answering nationally (C4)", async () => {
    // The case above only ever sends two-letter STRINGS, so it could not see
    // that employer_violations gated its state filter on plain truthiness while
    // the other four used `!= null && !== ""`. {state: 0} and {state: false}
    // were therefore refused by four tools and silently dropped by the fifth,
    // which then answered nationally under a query echo reporting state: null.
    // A national answer to a state-scoped question is the transposed-key defect
    // one argument over, so the five tools have to agree.
    for (const [tool, args] of [
      ["violations_by_state", {}],
      ["top_cases", {}],
      ["employer_violations", { employer: "acme" }],
      ["flagged_employers", {}],
      ["back_wages_summary", {}],
    ] as const) {
      // 0 and false only: NaN does not survive the JSON-RPC hop, so a case
      // built on it would be asserting against `null` and quietly passing.
      for (const falsy of [0, false]) {
        const res: any = await call(tool, { ...args, state: falsy });
        expect(res.isError, `${tool} should refuse state ${String(falsy)}`).toBe(true);
        expect(res.content[0].text).toMatch(/2-letter/i);
      }
    }
    // An OMITTED state is still the national query it has always been, and an
    // empty string is still the same as omitting it: this narrows the falsy
    // hole without closing the documented "no state" path.
    fetchMock.mockResolvedValue(jsonResponse([]));
    for (const omitted of [{}, { state: "" }, { state: null }]) {
      const res: any = await call("top_cases", omitted);
      expect(res.isError, `top_cases ${JSON.stringify(omitted)} should be a national query`).toBeUndefined();
      expect(payload(res).query.state).toBeNull();
    }
  });

  it("accepts the whole federal code domain: 50 states, DC, and the territories (WW-N)", async () => {
    // Source for the domain: the Census Bureau's FIPS/USPS reference
    // https://www2.census.gov/geo/docs/reference/state.txt (STUSAB column,
    // fetched 2026-09-14). A territory wrongly refused here would be the same
    // silent zero one layer up, so acceptance is pinned as tightly as refusal.
    //
    // Driven with the key unset and one attempt, so each code is decided by
    // normState and stops at the auth check: 57 real requests would be 57
    // throttle gaps, and the throttle is not what this case is about.
    delete process.env.DOL_API_KEY;
    process.env.DOL_HTTP_ATTEMPTS = "1";
    const codes =
      "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR UM VI".split(
        " ",
      );
    expect(codes).toHaveLength(57);
    expect(new Set(codes).size).toBe(57);
    for (const code of codes) {
      const res: any = await call("violations_by_state", { state: code });
      // Past normState, into the request path: the only complaint is the key.
      expect(res.content[0].text, `state ${code} should be accepted`).toContain("DOL_API_KEY is not set");
    }
    // ...while a non-code never gets that far.
    const bad: any = await call("violations_by_state", { state: "ZZ" });
    expect(bad.content[0].text).toMatch(/not a US state/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes a lowercase state code rather than refusing it (WW-N)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("violations_by_state", { state: "ny" });
    expect(lastUrl().searchParams.get("filter_object")).toContain('"NY"');
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
  it("filters by NAICS prefix", async () => {
    // violations_by_state's identical path was pinned and this one was not.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("top_cases", { naics: "72" });
    const filter = JSON.parse(lastUrl().searchParams.get("filter_object")!);
    expect(filter.and).toContainEqual({ field: "naic_cd", operator: "like", value: "72%" });

    // Every stored code length, so a validator cannot narrow the real domain:
    // 2 to 6 digits, measured over the 500 most recent rows (2026-09-15).
    for (const code of ["7", "72", "722", "7225", "72251", "722511"]) {
      // "72" repeats the call above, which the response cache would serve
      // without touching fetch, leaving lastUrl() pointing at the prior code.
      clearDolCache();
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const res: any = await call("top_cases", { naics: code });
      expect(res.isError, `naics ${code} should be accepted`).toBeUndefined();
      const nodes = JSON.parse(lastUrl().searchParams.get("filter_object")!).and;
      expect(nodes).toContainEqual({ field: "naic_cd", operator: "like", value: `${code}%` });
    }
  });

  it("refuses a NAICS prefix that is not digits, on both tools that take one (C2)", async () => {
    // `naics` was the last closed-domain argument left unvalidated, and it is
    // the QUIETEST confident zero in the server: live 2026-09-15,
    // {naic_cd like "restaurant%"} answers HTTP 204, which top_cases renders as
    // count 0 with no `note` key at all -- top_cases only emits a note when
    // hasMore -- under the data_currency line saying no concluded published
    // case was found. So a mistyped INDUSTRY was strictly quieter than a
    // mistyped STATE, which normState has refused since round 2.
    //
    // This deliberately inverts the old second half of the prefix case above,
    // which asserted that `7_2` rode through as a LIKE wildcard. That contract
    // is R1's and it still holds where it matters -- an employer NAME, pinned
    // by the metacharacter case -- because over-matching a name is recoverable.
    // A `_` in a numeric code is a typo, and under-matching is all it can do.
    // Only the blank cases reach the network; the rest throw before it.
    fetchMock.mockResolvedValue(jsonResponse([]));
    for (const tool of ["top_cases", "violations_by_state"] as const) {
      for (const bad of ["restaurant", "7_2", "72%", "72a", "", "  ", "7225113", "-72"]) {
        const args = tool === "violations_by_state" ? { state: "NY", naics: bad } : { naics: bad };
        const res: any = await call(tool, args);
        if (bad.trim() === "") {
          // An empty/blank prefix means "no industry filter", as it always did.
          expect(res.isError, `${tool} should treat a blank naics as absent`).toBeUndefined();
          continue;
        }
        expect(res.isError, `${tool} should refuse naics ${JSON.stringify(bad)}`).toBe(true);
        expect(res.content[0].text).toMatch(/1-6 digits/i);
        expect(res.content[0].text).toMatch(/Nothing was queried/i);
      }
    }
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

  it("every list tool says the page was truncated, not only the two that did (F1)", async () => {
    // has_more was always reported; the NOTE was not. top_cases carried no
    // `note` key at all and flagged_employers' note is a static flag-semantics
    // string that never varied with hasMore, so a caller reading the prose half
    // of the answer -- a human, or a model summarising it -- learned about
    // truncation on employer_violations and violations_by_state and not on the
    // other two. Assert the property on all four, so a fifth cannot reopen it.
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        case_id: String(i + 1),
        trade_nm: "ACME",
        st_cd: "NY",
        bw_atp_amt: "100",
        flsa_repeat_violator: "R",
      }));
    for (const [tool, args] of [
      ["employer_violations", { employer: "acme" }],
      ["top_cases", {}],
      ["violations_by_state", { state: "NY" }],
      ["flagged_employers", {}],
    ] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse(page(6)));
      const body = payload(await call(tool, { ...args, limit: 5 }));
      expect(body.has_more, `${tool} has_more`).toBe(true);
      expect(String(body.note), `${tool} note`).toContain("More cases match than the 5 shown");

      // Same params, so the truncated page above is still in the response
      // cache; drop it or the complete-page half reads the cached rows.
      clearDolCache();
      fetchMock.mockResolvedValueOnce(jsonResponse(page(2)));
      const whole = payload(await call(tool, { ...args, limit: 5 }));
      expect(whole.has_more, `${tool} has_more on a complete page`).toBe(false);
      // A complete page never claims truncation. flagged_employers still
      // carries its standing flag-semantics note, so this is the sentence, not
      // the field.
      expect(String(whole.note ?? ""), `${tool} note on a complete page`).not.toContain("More cases match");
    }
  });

  it("stops telling a caller at the page ceiling to raise limit (R3)", async () => {
    // clampLimit caps at 100 and no tool exposes offset, so at the ceiling
    // "raise limit" is advice that cannot be followed: asking for 500 is
    // clamped back to 100 and answers the same note again. The note is the only
    // thing a prose reader sees, so it has to say what actually works.
    const rows = Array.from({ length: 101 }, (_, i) => ({
      case_id: String(i + 1),
      trade_nm: "ACME",
      bw_atp_amt: "100",
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));
    const body = payload(await call("employer_violations", { employer: "acme", limit: 100 }));
    expect(body.has_more).toBe(true);
    expect(String(body.note)).toContain("More cases match than the 100 shown");
    expect(String(body.note)).toContain("page ceiling");
    expect(String(body.note)).toContain("narrow the query");
    expect(String(body.note)).not.toContain("raise limit");

    // A limit the caller CAN still raise keeps the actionable half, and names
    // the ceiling so the next step is one call rather than two.
    clearDolCache();
    fetchMock.mockResolvedValueOnce(jsonResponse(rows.slice(0, 6)));
    const under = payload(await call("employer_violations", { employer: "acme", limit: 5 }));
    expect(String(under.note)).toContain("raise limit (up to 100)");
  });

  it("flagged_employers keeps its flag-semantics note alongside the truncation one (F1)", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      case_id: String(i + 1),
      trade_nm: "ACME",
      flsa_repeat_violator: "RW",
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));
    const body = payload(await call("flagged_employers", { limit: 5 }));
    expect(String(body.note)).toContain("More cases match than the 5 shown");
    // The reason this tool exists is still explained in the same field.
    expect(String(body.note)).toContain("flsa_repeat_violator is WHD's own flag");
    expect(String(body.note)).toContain("RW is a separate stored value");
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

  it("a shape-legal date that is not a real calendar date is rejected, not rolled over", async () => {
    // The shape regex above passes all of these; Date.UTC ROLLS them over
    // instead of rejecting, so before this guard "2024-01-99" was sent as
    // `gt 2024-04-07T23:59:59` and "0000-00-00" as `gt 1899-11-29T23:59:59`,
    // while the query echo still reported what was typed.
    for (const bad of ["2024-01-99", "2024-13-45", "0000-00-00", "2023-02-29", "2024-04-31"]) {
      const res: any = await call("top_cases", { found_after: bad });
      expect(res.isError, `found_after ${bad} should be refused`).toBe(true);
      expect(res.content[0].text).toContain(bad);
      expect(res.content[0].text).toMatch(/not a real calendar date/i);
      expect(fetchMock).not.toHaveBeenCalled();
    }
    // found_before gets the same treatment, named as itself.
    const res: any = await call("top_cases", { found_before: "2024-02-30" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("found_before");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a rolled-over bound can no longer walk past the transposed-window guard", async () => {
    // The order check in dateFilters compares the RAW strings, so "2024-01-99"
    // sorts before "2024-02-01" and the pair passed it -- then built
    // `gt 2024-04-07T23:59:59 AND lt 2024-02-02T00:00:00`, the exact
    // unsatisfiable filter that guard exists to refuse. DOL answers 204 and
    // this server renders it as a clean count 0.
    const res: any = await call("top_cases", { found_after: "2024-01-99", found_before: "2024-02-01" });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("real calendar edges are still accepted (leap day, month ends)", async () => {
    for (const good of ["2024-02-29", "2024-01-31", "2024-04-30", "2024-12-31", "1900-01-01"]) {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const res: any = await call("top_cases", { found_after: good });
      expect(res.isError, `found_after ${good} should be accepted`).toBeFalsy();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
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

  it("waits out the throttle gap after the previous response settles", async () => {
    // What the code actually does, measured rather than assumed. throttled()
    // chains the gap onto the PREVIOUS call's settle, so real start-to-start
    // spacing is upstream latency PLUS the gap. That is the conservative
    // direction and it is deliberate, but a zero-latency mock cannot tell it
    // apart from true start-to-start spacing — which is what GAUNTLET §3
    // certified for a while, off a scan that could not measure it.
    //
    // The mock therefore takes real time, and both relations are asserted: the
    // gap floor after the response, and the consequence at the starts.
    const LATENCY = 300;
    const starts: number[] = [];
    const ends: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, LATENCY));
      ends.push(Date.now());
      return jsonResponse([]);
    });

    await Promise.all([
      call("employer_violations", { employer: "delta" }),
      call("employer_violations", { employer: "echo" }),
      call("employer_violations", { employer: "foxtrot" }),
    ]);

    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) {
      // 150ms floor; the 10ms slack is host timer resolution, not policy.
      expect(starts[i] - ends[i - 1]).toBeGreaterThanOrEqual(140);
      // ... which means a slow reply pushes the next start out by its own
      // latency as well. An implementation that spaced starts alone would send
      // the next request the instant the gap elapsed, mid-response.
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(LATENCY + 140);
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

  it("evicts on total ROWS too, not only on entry count (WW-M)", async () => {
    // DOL_CACHE_MAX bounds ENTRIES. That stopped bounding memory when
    // back_wages_summary dropped its `fields` projection: one entry became up
    // to max_cases+1 WHOLE rows (~2.8 KB each), so 300 entries is a ~840 MB
    // ceiling. The entry count here is deliberately far from binding.
    process.env.DOL_CACHE_MAX = "300";
    const bigPage = (tag: string) =>
      jsonResponse(Array.from({ length: 10_000 }, (_, i) => ({ case_id: `${tag}-${i}`, bw_atp_amt: "1" })));

    fetchMock.mockResolvedValueOnce(bigPage("a"));
    await call("employer_violations", { employer: "alpha" }); // 10k rows cached
    fetchMock.mockResolvedValueOnce(bigPage("b"));
    await call("employer_violations", { employer: "bravo" }); // 20k, at the ceiling
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Still both cached: 20,000 is the ceiling, not past it.
    await call("employer_violations", { employer: "alpha" });
    await call("employer_violations", { employer: "bravo" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(bigPage("c"));
    await call("employer_violations", { employer: "charlie" }); // 30k -> over, evict oldest
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // charlie is the newest and survives; the oldest by LRU order was refetched.
    await call("employer_violations", { employer: "charlie" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockResolvedValueOnce(bigPage("a"));
    await call("employer_violations", { employer: "alpha" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never evicts the entry it just wrote, however large (WW-M)", async () => {
    // A single answer bigger than the row ceiling must still be served from
    // cache: dropping it would make the cache a miss-generator for exactly the
    // queries it exists to spare.
    process.env.DOL_CACHE_MAX = "300";
    fetchMock.mockResolvedValueOnce(
      jsonResponse(Array.from({ length: 25_000 }, (_, i) => ({ case_id: `x-${i}` }))),
    );
    await call("employer_violations", { employer: "whale" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await call("employer_violations", { employer: "whale" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
