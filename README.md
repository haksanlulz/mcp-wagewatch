# mcp-wagewatch

MCP server over the U.S. Department of Labor Wage and Hour Division (WHD) enforcement dataset: employer wage-theft history, back wages owed, civil penalties, and affected-employee counts. Built for worker-justice nonprofits, legal-aid intake, and union researchers.

The data is the WHISARD compliance-action dataset (every concluded WHD compliance action since FY2005) served from the DOL Open Data API. This server wraps the raw column names (`trade_nm`, `bw_atp_amt`, `ee_violtd_cnt`, ...) into normalized tool outputs — field map below.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `employer_violations` | `employer` (required), `state`, `limit` | Enforcement cases matching the employer name, largest back wages first. Per case: employer, location, findings dates, back wages, civil penalties, employees affected, violation count. |
| `back_wages_summary` | `employer` and/or `state` (at least one), `max_cases` | Aggregate totals across matching cases: total back wages, total employees affected, total civil penalties, case count, findings date range. |
| `violations_by_state` | `state` (required), `naics`, `limit` | Top cases in a state where a violation was found, ordered by back wages. Optional NAICS-prefix industry filter. |
| `case_detail` | `case_id` (required) | Full record for one case, including the per-statute breakdown (which laws were cited: FLSA, MSPA, H-1B, FMLA, Davis-Bacon, child labor, and so on). |

## Data source

- Base URL: `https://apiprod.dol.gov/v4`
- Query path: `GET /get/WHD/enforcement/json` (agency `WHD`, endpoint `enforcement`, table `WHD_enforcement`)
- Auth: a free `X-API-KEY`, sent only as a request header (never in the query string, so it stays out of URLs and logs).
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
- Name search uses SQL `LIKE` on `trade_nm` and `legal_name`, wrapping the term as `%term%`. The term is uppercased defensively (WHD stores names largely in uppercase) and `LIKE` metacharacters (`%`, `_`, `\`) are escaped so they match literally. See the caveats below.

## Install

No build step. Runs directly on [tsx](https://github.com/privatenumber/tsx).

```
git clone https://github.com/haksanlulz/mcp-wagewatch.git
cd mcp-wagewatch
npm install
```

## API key

Register for a free DOL Open Data API key at https://dataportal.dol.gov/registration, then expose it as `DOL_API_KEY`:

```
export DOL_API_KEY=your-key-here      # macOS / Linux
setx DOL_API_KEY your-key-here        # Windows (new shells)
```

Without the key the tools return an error naming the variable and the key-signup URL. The key is never logged.

## MCP client config

Point your MCP client at `index.ts` via tsx. Use an absolute path.

```json
{
  "mcpServers": {
    "wagewatch": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-wagewatch/index.ts"],
      "env": { "DOL_API_KEY": "your-key-here" }
    }
  }
}
```

## Response shape

`employer_violations` with `{ "employer": "tyson", "state": "AR", "limit": 1 }` returns this shape. Values are illustrative (test-fixture data, not a live capture — see the caveats below):

```json
{
  "query": { "employer": "tyson", "state": "AR" },
  "count": 1,
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
  ]
}
```

Then pass a `case_id` to `case_detail` for the per-statute breakdown.

## Caveats

The metadata endpoint is key-gated and this was built without a key, so:

- The column names are checked against the published WHISARD data dictionary (table `whd_whisard`) and the dataset description, not against the live `WHD/enforcement` metadata endpoint (which requires the key). The v4 `enforcement` endpoint is the same underlying WHISARD data, so the names are expected to match, but the exact live field list is unconfirmed. The normalizer is defensive: unknown-shaped values coerce to `null` rather than throwing, and the CMP total scans every `*_cmp_assd_amt` column present.
- `LIKE` case-sensitivity on the DOL endpoint is unconfirmed, so the search term is uppercased defensively before the `%term%` wrap (WHD stores names largely in uppercase) and `LIKE` metacharacters are escaped to match literally. If name searches still under-return, casing on the endpoint is the place to look.
- Run `npm run smoke` with a real key to confirm field names and behavior end to end before relying on output.

## Develop

```
npm test         # vitest, fetch mocked with the documented response shapes (no key needed)
npm run smoke    # one live call per tool (needs DOL_API_KEY; skips cleanly without)
npm run typecheck
```

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the mocked vitest suite (a real MCP client/server pair over an in-memory transport, fetch stubbed with the documented DOL response shapes) plus `npm run typecheck` — not by live API calls; the caveats above scope what stays unconfirmed until `npm run smoke` runs with a real key. The author reviewed the code and is accountable for it.

## License

MIT. See [LICENSE](LICENSE). Public U.S. government data from the U.S. Department of Labor. Unofficial, not affiliated with DOL.
