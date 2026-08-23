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
| `flagged_employers` | `state`, `flag` (default `R`), `limit` | Cases carrying the WHD repeat/willful violator flag (its data dictionary publishes R / W / RW). WHD characterization, not a court finding. |

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

Notes:
- There is no single total-CMP-dollar column in WHISARD. `cmp_assd_cnt` is a count of assessments; the dollar penalties live in per-statute columns (`flsa_cmp_assd_amt`, `mspa_cmp_assd_amt`, `h1b_cmp_assd_amt`, and so on). `civil_penalties` sums those.
- `back_wages_summary` aggregates client-side (the API does not expose a group-by), over up to `max_cases` matching rows (default 1000). If `capped` is true the totals are a floor.
- Name search uses SQL `LIKE` on `trade_nm` and `legal_name`, wrapping the term as `%term%`. The endpoint's `LIKE` is case-insensitive (confirmed live: mixed-case stored names match an uppercased term), and `LIKE` metacharacters (`%`, `_`, `\`) are escaped so they match literally.
- **A zero-match filter answers HTTP 204 with an empty body** (confirmed live) — the server parses that as an empty result set, so "no concluded case found" is a real answer: `count: 0`, `has_more: false`, and the data-currency note that absence is not evidence of compliance.
- **All `filter_object` values must be JSON strings** — the engine answers a 500 "server error querying the dataset" for numeric values (`{"value": 0}` fails, `{"value": "0"}` works; confirmed live). Every filter value is string-coerced at serialization time.
- List tools request `limit + 1` rows and report `has_more`, so a page of exactly `limit` rows is never mistakable for a complete answer.

## Install

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

Without the key the tools return an error naming the variable and the key-signup URL. The key is never logged.

## Response shape

`employer_violations` with `{ "employer": "tyson", "state": "AR", "limit": 1 }` returns this shape. Values are illustrative (test-fixture data, not a live capture — see the caveats below):

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
      "findings_start_date": "2021-01-01",
      "findings_end_date": "2022-01-01",
      "back_wages": 150000.5,
      "civil_penalties": 7500,
      "employees_affected": 88,
      "violations": 12
    }
  ],
  "data_currency": {
    "newest_findings_end_date": "2022-01-01",
    "note": "WHD publishes concluded investigations on a lag. These are historical enforcement records, not an employer's present compliance state, and an empty result means no concluded published case was found — not that none exists."
  }
}
```

`data_currency` is attached to **every** response and is computed from the rows actually returned, never from the clock: an answer is exactly as current as its newest record. When a result set carries no dates, `newest_findings_end_date` is `null` rather than absent.

Then pass a `case_id` to `case_detail` for the per-statute breakdown.

## Verification state

Everything has been run live against the real API with a real key (`npm run smoke`, 6/6, 2026-08-23), and three contract facts were only discoverable live: the key is accepted **only as a query parameter** (the `X-API-KEY` header form answers 401), a zero-match filter answers **HTTP 204 with an empty body**, and **numeric `filter_object` values 500** (strings work). All three are handled and regression-tested. Column names were confirmed against live rows; the normalizer stays defensive regardless (unknown-shaped values coerce to `null`, and the CMP total scans every `*_cmp_assd_amt` column present).

## Develop

```
npm test         # vitest, fetch mocked with the documented response shapes (no key needed)
npm run smoke    # one live call per tool (needs DOL_API_KEY; skips cleanly without)
npm run typecheck
```

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the mocked vitest suite (a real MCP client/server pair over an in-memory transport, fetch stubbed with the real response shapes), `npm run typecheck`, and live runs of every tool against the real DOL API with a real key — which is where the query-param auth, 204-empty, and string-only-filter contract facts came from. The author reviewed the code and is accountable for it.

## License

MIT. See [LICENSE](LICENSE). Public U.S. government data from the U.S. Department of Labor. Unofficial, not affiliated with DOL.
