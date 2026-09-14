# mcp-wagewatch

MCP server over the U.S. Department of Labor Wage and Hour Division (WHD) enforcement dataset: employer wage-theft history, back wages owed, civil penalties, and affected-employee counts. Built for worker-justice nonprofits, legal-aid intake, and union researchers.

The data is the WHISARD compliance-action dataset (every concluded WHD compliance action since FY2005) served from the DOL Open Data API. This server wraps the raw column names (`trade_nm`, `bw_atp_amt`, `ee_violtd_cnt`, ...) into normalized tool outputs — field map below.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `employer_violations` | `employer` (required), `state`, `found_after`, `found_before`, `limit` | Enforcement cases matching the employer name, largest back wages first. Per case: employer, location, findings dates, back wages, civil penalties, employees affected, violation count. |
| `back_wages_summary` | `employer` and/or `state` (at least one), `max_cases` | Aggregate totals across matching cases: total back wages, total employees affected, total civil penalties, case count, findings date range. |
| `violations_by_state` | `state` (required), `naics`, `found_after`, `found_before`, `limit` | Top cases in a state where a violation was found, ordered by back wages. Optional NAICS-prefix industry filter. |
| `case_detail` | `case_id` (required) | Full record for one case, including the per-statute breakdown (which laws were cited: FLSA, MSPA, H-1B, FMLA, Davis-Bacon, child labor, and so on). |
| `top_cases` | `state`, `naics`, `found_after`, `found_before`, `limit` (all optional) | The largest cases by back wages nationally, in a state, and/or in a date window — no employer name needed. |
| `flagged_employers` | `state`, `flag` (`R` default, `W`, or `RW`), `limit` | Cases carrying the WHD repeat/willful violator flag, each case stating its own flag. `R` returns repeat **and** both-flagged (`RW`) cases, `W` returns willful and `RW`; `RW` returns only cases flagged both. WHD characterization, not a court finding. |

## Data source

- Base URL: `https://apiprod.dol.gov/v4`
- Query path: `GET /get/WHD/enforcement/json` (agency `WHD`, endpoint `enforcement`, table `WHD_enforcement`)
- Auth: a free `X-API-KEY`. The v4 API accepts it ONLY as a query parameter (the header form answers 401 — verified live), so the key rides the URL; be aware of that anywhere full request URLs are logged. This server's error messages never include the URL.
- Filtering: the `filter_object` query parameter takes a JSON string with `field` / `operator` / `value` (operators `eq`, `neq`, `gt`, `lt`, `in`, `not_in`, `like`), composable with `and` / `or`. Paging via `limit` / `offset`, ordering via `sort_by` / `sort`.
- Scope: one row per concluded compliance action since FY2005.

Sources:
- DOL API User Guide (endpoint template, auth, `filter_object` syntax): https://www.dataportal.dol.gov/pdf/dol-api-user-guide.pdf
- Live dataset catalog (agency/endpoint identifiers): https://apiprod.dol.gov/v4/datasets
- Dataset landing page: https://catalog.data.gov/dataset/wage-and-hour-division-compliance-action-data
- WHISARD column dictionary: https://github.com/jeremybmerrill/whd/blob/master/lib/data/whd_data_dictionary.csv

### Field map (WHISARD column to normalized output)

| WHISARD column | Normalized field |
|----------------|------------------|
| `case_id` | `case_id` |
| `trade_nm` (fallback `legal_name`) | `employer` |
| `legal_name` | `legal_name` |
| `street_addr_1_txt`, `cty_nm`, `st_cd`, `zip_cd` | `location.{street,city,state,zip}` |
| `naic_cd`, `naics_code_description` | `naics_code`, `naics_description` |
| `findings_start_date`, `findings_end_date` | `findings_start_date`, `findings_end_date` |
| `bw_atp_amt` (total back wages agreed to pay) | `back_wages` |
| `ee_violtd_cnt` (employees employed in violation) | `employees_affected` |
| `case_violtn_cnt` (total case violations) | `violations` |
| sum of statute-level `*_cmp_assd_amt` | `civil_penalties` |
| `cmp_assd_cnt` (count of assessments) | `cmp_assessment_count` (case_detail only) |
| `flsa_repeat_violator` (WHD repeat/willful flag) | `flsa_repeat_violator` (`case_detail` and `flagged_employers` only) |

Notes:
- There is no single total-CMP-dollar column in WHISARD. `cmp_assd_cnt` is a count of assessments; the dollar penalties live in per-statute columns (`flsa_cmp_assd_amt`, `mspa_cmp_assd_amt`, `h1b_cmp_assd_amt`, and so on). `civil_penalties` sums those.
- `back_wages_summary` aggregates client-side (the API does not expose a group-by), over up to `max_cases` matching rows (default 1000). If `capped` is true the totals are a floor.
- **Name search: the endpoint's `LIKE` is case-SENSITIVE, and WHISARD stores names mixed-case.** Confirmed live 2026-09-14 by the pair that disproves the opposite claim this line used to make: `{"field":"trade_nm","operator":"like","value":"%KEVIN MISCH%"}` answers HTTP 204 with zero rows, while `"%Kevin Misch%"` answers HTTP 200 with case_id 1476714 and case_id 1419247. Of the 500 most recent rows by `findings_end_date`, 485 (97%) carry a mixed-case `trade_nm`. So the server searches `trade_nm` and `legal_name` for the term in every case variant — as typed, uppercased, and title-cased — as one `or` filter, wrapping each as `%term%`. `LIKE` metacharacters (`%`, `_`, `\`) are escaped after the case fold, so a stray wildcard in the input matches literally.
- `found_after` and `found_before` are **inclusive**: a case whose findings ended on the exact date is included. DOL's operators are `eq`/`neq`/`gt`/`lt`/`in`/`not_in`/`like` with no `gte`/`lte`, and `findings_end_date` is a midnight timestamp, so each bound is shifted one day outward to the instant just outside the window.
- **A zero-match filter answers HTTP 204 with an empty body** (confirmed live) — the server parses that as an empty result set, so "no concluded case found" is a real answer: `count: 0`, `has_more: false`, and the data-currency note that absence is not evidence of compliance.
- **All `filter_object` values must be JSON strings** — the engine answers a 500 "server error querying the dataset" for numeric values (`{"value": 0}` fails, `{"value": "0"}` works; confirmed live). Every filter value is string-coerced at serialization time.
- List tools request `limit + 1` rows and report `has_more`, so a page of exactly `limit` rows is never mistakable for a complete answer.

## Install

### As a bundle (no terminal)

`npm run pack:mcpb` builds `haksanlulz-mcp-wagewatch-<version>.mcpb` — an [MCPB bundle](https://github.com/modelcontextprotocol/mcpb) (manifest spec 0.3). Clients that install MCPB bundles take the file directly and prompt for the DOL API key, which the manifest declares as a required, sensitive `user_config` field; nothing about the install involves editing JSON by hand.

The bundle carries `dist/`, `manifest.json`, `package.json`, and the **production dependency tree** — 3,523 files, 4.4 MB, measured 2026-09-14. That makes the dependency surface a shipped payload rather than a resolution-time detail, which is what `test/no-http-stack.test.ts` bounds: one runtime dependency, stdio transport only, no HTTP transport in the executed path.

`npm run verify:mcpb` packs the bundle, reads the ZIP back, confirms an independent unzip agrees, checks the manifest's version against `package.json` and that its `entry_point` is actually inside the archive, then extracts to a throwaway directory and launches the server the way `mcp_config` says to, asserting `tools/list` returns the documented six. It also refuses a bundle carrying a credential-shaped file (`.env`, `.npmrc`, `.netrc`, `.git-credentials`) anywhere in the tree, dependencies included — the root-anchored source-and-test patterns beside it cannot match anything the packer emits and are a guard against a future packer change, not a live check.

### As an npm package

Nothing to clone. Point your MCP client at it and npm fetches it on first run:

```json
{
  "mcpServers": {
    "wagewatch": {
      "command": "npx",
      "args": ["-y", "@haksanlulz/mcp-wagewatch"],
      "env": { "DOL_API_KEY": "your-dol-key" }
    }
  }
}
```

<details>
<summary>From source (contributors)</summary>

```bash
git clone https://github.com/haksanlulz/mcp-wagewatch
cd mcp-wagewatch
npm install
npm run build     # emits dist/; the published bin is dist/index.js
```

`npm start` runs the TypeScript directly via [`tsx`](https://github.com/privatenumber/tsx) without building.
</details>

## API key

Register for a free DOL Open Data API key at https://dataportal.dol.gov/registration, then expose it as `DOL_API_KEY`:

```
export DOL_API_KEY=your-key-here      # macOS / Linux
setx DOL_API_KEY your-key-here        # Windows (new shells)
```

Without the key the tools return an error naming the variable and the key-signup URL.

⚠️ **The key rides the query string, because the v4 API rejects the header form with a 401** (verified live). Anything that logs full outbound request URLs — a corporate proxy, a debugging HTTP client — will see it. What this server guarantees instead is that no message it returns carries the request URL or the key: an upstream error body that echoes the request, or a transport error that quotes the URL it was fetching, is redacted before it reaches a caller. Pinned by the test *"never lets the request URL or the key reach a caller in an error"*.

### Optional tuning

| Variable | Default | Meaning |
|----------|---------|---------|
| `DOL_HTTP_ATTEMPTS` | `3` | Total attempts per request (retries 429/5xx/transport). `1` disables retrying. |
| `DOL_CACHE_TTL_MS` | `86400000` (a day) | Lifetime of a cached response. `0` disables the cache. |
| `DOL_CACHE_MAX` | `300` | Cached responses kept before the oldest is evicted. |

Each is read per use and validated: a value that is not a whole number in range is ignored, with a one-line note on stderr, and the default applies. A NaN attempt ceiling used to skip the request loop entirely and surface as `Error: undefined`, and a NaN TTL is a cache that never expires — which is this server's stated worst failure.

## Response shape

`employer_violations` with `{ "employer": "tyson", "state": "AR", "limit": 1 }` returns this shape. Values are illustrative (test-fixture data, not a live capture — see Verification state below; for a real capture, see the worked example):

```json
{
  "query": { "employer": "tyson", "state": "AR", "found_after": null, "found_before": null },
  "count": 1,
  "has_more": false,
  "cases": [
    {
      "case_id": "1234567",
      "employer": "TYSON FOODS INC",
      "legal_name": "TYSON FOODS INCORPORATED",
      "location": { "street": "2200 DON TYSON PKWY", "city": "SPRINGDALE", "state": "AR", "zip": "72762" },
      "naics_code": "311615",
      "naics_description": "Poultry Processing",
      "findings_start_date": "2021-01-01T00:00:00",
      "findings_end_date": "2022-01-01T00:00:00",
      "back_wages": 150000.5,
      "civil_penalties": 7500,
      "employees_affected": 88,
      "violations": 12
    }
  ],
  "data_currency": {
    "newest_findings_end_date": "2022-01-01T00:00:00",
    "note": "WHD publishes concluded investigations on a lag. These are historical enforcement records, not an employer's present compliance state, and an empty result means no concluded published case was found — not that none exists."
  }
}
```

`data_currency` is attached to **every** response and is computed from the rows actually returned, never from the clock: an answer is exactly as current as its newest record. When a result set carries no dates, `newest_findings_end_date` is `null` rather than absent.

## Worked example: an intake desk

A worker names an employer at a legal-aid intake desk. Four calls, in order. Every figure below is from a live capture on **2026-09-14**; re-running the calls reproduces the case ids.

**1. Find the cases.** `employer_violations { "employer": "Kevin Misch" }` → `count: 2`.

| case_id | employer | ended | back wages | employees | civil penalties |
|---|---|---|---|---|---|
| `1419247` | Kevin Misch Trucking & Excavating (Wheatfield, IN) | 2005-09-24 | $41,918 | 16 | $0 |
| `1476714` | Kevin Misch Excavating (Crown Point, IN) | 2007-05-27 | $30,438 | 23 | $11,069 |

Note what the search had to do to find them: WHISARD stores the name as `Kevin Misch Excavating`, and DOL's `LIKE` is case-sensitive, so `%KEVIN MISCH%` answers HTTP 204 — zero rows — for an employer with two published cases.

**2. Open the larger one.** `case_detail { "case_id": "1419247" }` → the per-statute breakdown is a single row: FLSA, 17 violations, $41,918 in back wages, 16 employees, no civil money penalty. Nothing under MSPA, H-2A, FMLA or child labor — this was a straight wage-and-hour case.

**3. Get the pattern.** `back_wages_summary { "employer": "Kevin Misch" }` → `case_count: 2`, `total_back_wages: 72356`, `total_employees_affected: 39`, `total_civil_penalties: 11069`, spanning findings from 2003-11-01 to 2007-05-27, `capped: false` (so the totals are totals, not a floor).

**4. Check the flag.** `flagged_employers { "state": "IN", "flag": "RW" }` → case `1476714` is in the list, carrying `flsa_repeat_violator: "RW"` — WHD flagged the second investigation as both repeat and willful. The first case carries `"N/A"`.

The paragraph a caseworker pastes into an intake note:

> DOL's Wage and Hour Division has published two concluded investigations of Kevin Misch Trucking & Excavating (Wheatfield and Crown Point, IN): one closing 2005-09-24 with $41,918 in back wages for 16 employees, and one closing 2007-05-27 with $30,438 for 23 employees plus $11,069 in civil money penalties — $72,356 and 39 workers in total, all of it under the Fair Labor Standards Act. WHD flagged the second investigation as both repeat and willful, which is WHD's own characterization at the close of its investigation and not a court finding. These are concluded cases, published on a lag, so they describe what this employer was found to have done and not what it is doing now — and an employer with nothing here has not been cleared, only never published.

That last clause is the one to keep. An empty result from any of these tools means WHD has not published a concluded investigation naming the employer; it is not a clean record, and the `data_currency` note on every response says so.

## Verification state

Everything has been run live against the real API with a real key: `npm run smoke`, **9 passed / 0 failed / 0 upstream / 0 skipped, 2026-09-14**. Five contract facts were only discoverable live, all handled and regression-tested:

- the key is accepted **only as a query parameter** (the `X-API-KEY` header form answers 401);
- a zero-match filter answers **HTTP 204 with an empty body**;
- **numeric `filter_object` values 500** — strings work, including inside an `in` array;
- **`LIKE` is case-sensitive** over mixed-case stored names (see the name-search note above);
- **`findings_end_date` is a midnight timestamp**, which is what makes a strict `gt`/`lt` bound drop its own day.

Column names were confirmed against live rows; the normalizer stays defensive regardless (unknown-shaped values coerce to `null`, and the CMP total scans every `*_cmp_assd_amt` column present).

Two things to know before running the live rung. Until 2026-09-14 the smoke asserted nothing about content — it printed counts and passed by not throwing, which is why a name search returning zero everywhere could not redden it; each check now asserts a count floor or an expected value, and a pinned case id carries its own stability argument (WHISARD records concluded cases; published rows do not change). And **DOL rate-limits hard**: a full smoke run plus a few ad-hoc queries is enough to draw a stretch of HTTP 429s with an empty body and no `Retry-After`. The smoke reports that as `UPSTREAM` and exits **2**, distinct from a failed assertion's **1**, because a 429 is a statement about DOL rather than about this code. Rerun it later rather than reading either as a pass.

Advisories, `npm audit` on **2026-09-14**: 2 moderate, both in the MCP SDK's HTTP-transport dependencies — hono (`<=4.13.4`) and qs (via express). Neither is reachable here: `test/no-http-stack.test.ts` pins that this server imports the stdio transport and nothing else. The .mcpb bundle **ships** those files rather than resolving them at install, so they are a payload, unreachable but present; `npm audit fix` is available and untaken, because a dependency bump is artifact-affecting and belongs to its own change.

## Testing

Two tiers, split by script. No test markers; the split is which command you run.

```
npm test           # offline: vitest, fetch mocked with the documented response shapes, no key needed
npm run smoke      # live: one real call per tool against the DOL API (needs DOL_API_KEY; skips and exits 0 without it)
npm run typecheck   # both tsconfigs: the shipped surface, then smoke.ts and test/ too
npm run verify:pack  # packs the tarball, installs it in a throwaway project, launches through the bin shim, speaks MCP
npm run verify:mcpb  # packs the .mcpb bundle, extracts it cold, launches the manifest's entry_point, speaks MCP
```

Counts, measured 2026-09-14:

- App: 1918 lines (`server.ts` 1080, `smoke.ts` 240, `scripts/mcpb-probe.mjs` 196, `scripts/lib/zip.mjs` 172, `scripts/pack-probe.mjs` 129, `scripts/pack-mcpb.mjs` 93, `index.ts` 8). `find . -type f \( -name '*.ts' -o -name '*.mjs' \) -not -path './node_modules/*' -not -path './dist/*' -not -path './test/*' | xargs wc -l`
- Tests: 1071 lines, 77 tests in 2 files. `find ./test -name '*.test.ts' | xargs wc -l` for the lines; the test count is vitest's. The grep `grep -cE '^\s*(it|test)\(' test/*.test.ts` reads 72, because the per-tool unknown-argument cases are generated in a loop — one `it(` for six tests.

What the offline suite covers, by layer: `test/server.test.ts` runs a real MCP client and server over an in-memory transport with fetch stubbed, and asserts the request grammar (filter_object shape, LIKE escaping and case variants, string-coerced values and array values, inclusive date bounds, limit+1 probe row, query-param key, User-Agent, abort signal), the argument contract (unknown keys refused before any network call, one case per tool), the response normalization (field map, per-statute penalty sums, the repeat/willful flag, 204-empty as zero matches, error envelopes rejected), the retry policy (3 attempts on 5xx, none on 4xx or a non-JSON body), the environment knobs (a bad value falls back to the documented default rather than killing the retry loop or freezing the cache), the outbound throttle (concurrent calls serialized, and the gap held between one response settling and the next request going out, measured against a mock that takes real time), the redaction of the request URL and key out of every error message, the response cache including LRU eviction, and the data_currency spec. `test/no-http-stack.test.ts` pins the dependency surface: stdio transport only, one runtime dependency. The live smoke, `verify:pack` and `verify:mcpb` cover what mocks cannot: the DOL contract, the published npm artifact and the .mcpb bundle.

Mutation probes, 2026-09-14, each restored after the run:

| Mutation in `server.ts` | Reddened |
|---|---|
| `shiftIsoDate(after, -1)` → `0` (inclusive date bound) | 3 tests, 47 of 50 passing at the time |
| bad-value branch of `envInt` → `false` | 4 tests, including "no tool result can carry the text 'Error: undefined'" |
| drop the `validateArgs` call | 9 of the 11 unknown-argument tests; the coverage assertion and the accepts-declared-arguments test stay green, correctly |
| drop `top_cases`' NAICS prefix filter | both `top_cases` filter tests |
| `FLAG_SEARCHES.W` → `["W"]` | the willful-includes-RW test |
| `capped: rows.length >= cap` → `> cap` | the capped test |
| `cacheMax()` → `Infinity` | the LRU eviction test |
| `violations_by_state`' truncation note → `undefined` | the has_more note test |
| drop `redactSecrets` from the error path | the URL/key redaction test |
| `queue.then(fn, fn)` → `fn()` (throttle serialization) | the serialization test, and the spacing test with it |
| `THROTTLE_MS` → `0` | the spacing test |
| the throttle gap re-chained onto the queue gate (true start-to-start spacing) | the spacing test, at −143ms |
| revert WW-1's case variants (live `npm run smoke`) | 2 checks red — `employer_violations` "expected >= 2 cases, got 0" and `back_wages_summary` "expected >= 100 cases for Walmart, got 1" at $0 total — exit 1 |

Earlier probe, 2026-09-11: dropping the `%` escape from `escapeLike` failed exactly one test, `employer_violations > escapes LIKE metacharacters in the employer term so they match literally` (37 of 38 passed).

One note on running probes here: `npx vitest run --reporter=basic` exits 1 without running anything on vitest 4, so a probe wired that way reports every mutation as red whether or not the suite noticed. Use the default reporter and read the per-test FAIL lines.

The call-count assertions — 24 in the source as of 2026-09-14, up from the 9 audited on 2026-09-11 — were each kept for pinning a contract, not for recording that a function ran: no network call before validation passes (the largest group, one per tool since arguments are now checked up front), retry counts under the attempt ceiling, cache dedupe and LRU eviction. Policy: assert behavior and payloads, not that a function was called.

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the mocked vitest suite (a real MCP client/server pair over an in-memory transport, fetch stubbed with the real response shapes), `npm run typecheck`, and live runs of every tool against the real DOL API with a real key — which is where the query-param auth, 204-empty, and string-only-filter contract facts came from. The author reviewed the code and is accountable for it.

## License

MIT. See [LICENSE](LICENSE). Public U.S. government data from the U.S. Department of Labor. Unofficial, not affiliated with DOL.
