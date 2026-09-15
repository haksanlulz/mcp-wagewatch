// Live smoke test: one real call per tool against the DOL API, each ASSERTING
// something about the answer's content.
//
// Gated on DOL_API_KEY: prints a skip notice and exits 0 when the key is unset,
// so it is safe to wire into CI without a secret.
//
//   npm run smoke
//
// Exit codes: 0 every check ran and passed · 1 a check failed OR did not run ·
// 2 upstream was unusable (429 / 5xx / transport), which is a statement about
// DOL, not about this code. A skipped check exits 1 with the failures, because
// the alternative is reporting green over a check nothing performed.
//
// WHY THE ASSERTIONS ARE THE POINT. This file used to print body.count and move
// on, so every tool passed by not throwing. The defect that closed in WW-1 --
// employer name search uppercased the term against a case-sensitive LIKE over
// mixed-case stored names, answering a confident "no cases found" -- produced
// count 0 everywhere and could not have reddened a single check here. A live
// rung that cannot distinguish a real answer from an empty one is not a rung.
//
// FIXTURE STABILITY. WHISARD is the record of CONCLUDED WHD compliance actions
// since FY2005. Concluded cases are historical: rows are added as investigations
// close, and published rows do not change. So a pinned case id stays valid, and
// a count assertion is written as a floor (">= what was measured"), which new
// publications can only push further from red. Measured 2026-09-14.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const KEY_SIGNUP_URL = "https://dataportal.dol.gov/registration";

if (!process.env.DOL_API_KEY?.trim()) {
  console.log(`smoke: skipped, set DOL_API_KEY to run live checks (free key: ${KEY_SIGNUP_URL})`);
  process.exit(0);
}

/** A concluded 2007 Indiana case, flagged RW. Its employer name is mixed-case. */
const PINNED_CASE_ID = "1476714";
/** Both concluded cases for this employer: 1476714 (2007) and 1419247 (2005). */
const PINNED_EMPLOYER = "Kevin Misch";
/** 151 matching cases on 2026-09-14; an uppercase-only search finds exactly 1. */
const BROAD_EMPLOYER = "Walmart";
const BROAD_EMPLOYER_FLOOR = 100;

/** Upstream said "come back later" — not a verdict about the answer. */
class UpstreamError extends Error {}

const UPSTREAM_SIGNATURE = /HTTP (429|5\d\d)|timed out|timeout|fetch failed|network/i;

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let passed = 0;
  let failures = 0;
  let upstream = 0;
  let skipped = 0;

  /** Call a tool, separating "DOL is unavailable" from "the answer is wrong". */
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name, arguments: args });
    if (res.isError) {
      const text = String(res.content[0].text);
      if (UPSTREAM_SIGNATURE.test(text)) throw new UpstreamError(text);
      throw new Error(text);
    }
    return parse(res);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`ok       ${label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UpstreamError) {
        upstream++;
        console.error(`UPSTREAM ${label}: ${message}`);
      } else {
        failures++;
        console.error(`FAIL     ${label}: ${message}`);
      }
    }
  };

  /** A check that could not be run is not a check that passed. */
  const skip = (label: string, why: string) => {
    skipped++;
    console.log(`SKIPPED  ${label}: ${why}`);
  };

  let sampleCaseId: string | null = null;

  await run("employer_violations", async () => {
    const body = await callTool("employer_violations", { employer: PINNED_EMPLOYER, limit: 5 });
    console.log(`         -> ${body.count} case(s): ${body.cases.map((c: any) => c.case_id).join(", ")}`);
    assert(body.count >= 2, `expected >= 2 cases for "${PINNED_EMPLOYER}", got ${body.count}`);
    const ids = body.cases.map((c: any) => c.case_id);
    assert(ids.includes(PINNED_CASE_ID), `expected case ${PINNED_CASE_ID} among ${ids.join(", ")}`);
    const hit = body.cases.find((c: any) => c.case_id === PINNED_CASE_ID);
    assert(/misch/i.test(String(hit.employer)), `unexpected employer name: ${hit.employer}`);
    assert(hit.location.state === "IN", `expected state IN, got ${hit.location.state}`);
    // The live date shape is a full timestamp, not a bare YYYY-MM-DD.
    assert(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(hit.findings_end_date)),
      `findings_end_date is not a timestamp: ${hit.findings_end_date}`,
    );
    sampleCaseId = hit.case_id;
  });

  await run("back_wages_summary", async () => {
    const body = await callTool("back_wages_summary", { employer: BROAD_EMPLOYER, max_cases: 200 });
    console.log(`         -> ${body.case_count} case(s); total back wages $${body.total_back_wages}`);
    // An uppercase-only name search returns 1 case here, so this floor is what
    // stands between the WW-1 defect and a green live rung.
    assert(
      body.case_count >= BROAD_EMPLOYER_FLOOR,
      `expected >= ${BROAD_EMPLOYER_FLOOR} cases for "${BROAD_EMPLOYER}", got ${body.case_count}`,
    );
    assert(body.total_back_wages > 0, `expected non-zero back wages, got ${body.total_back_wages}`);
    // A RELATIONSHIP, not a pinned upper bound. `capped === false` against a
    // fixed max_cases 200 was the one assertion in this file that new
    // publications could turn red for a reason that is not a defect — 49 more
    // Walmart cases and a green live rung goes red pointing at the code. What
    // holds at every count is that capping only happens on a full page.
    assert(
      body.capped === false || body.case_count === 200,
      `capped=${body.capped} at case_count=${body.case_count} against max_cases 200`,
    );
    // The SPEC on the one tool that returns no rows: its newest date leaves as
    // latest_findings_end, and the vintage scanner has to know that name or the
    // aggregate answers null over dated cases (WW-A). Live, because the shape
    // this reads is the server's own and a mock cannot disagree with it.
    assert(
      body.data_currency.newest_findings_end_date === body.latest_findings_end,
      `vintage ${body.data_currency.newest_findings_end_date} != latest_findings_end ${body.latest_findings_end}`,
    );
    assert(body.latest_findings_end != null, "expected a newest findings date over 151 concluded cases");
    // ... and the other direction on capping, at a cap the count is already far
    // past, so it stays true as the dataset grows.
    const capped = await callTool("back_wages_summary", { employer: BROAD_EMPLOYER, max_cases: 5 });
    assert(
      capped.capped === true && capped.case_count === 5,
      `at max_cases 5 expected capped=true over 5 cases, got capped=${capped.capped} case_count=${capped.case_count}`,
    );
  });

  await run("violations_by_state", async () => {
    const body = await callTool("violations_by_state", { state: "NY", limit: 3 });
    console.log(`         -> ${body.count} case(s), has_more=${body.has_more}; top: ${body.cases[0]?.employer}`);
    assert(body.count === 3, `expected the full page of 3, got ${body.count}`);
    assert(body.has_more === true, "expected has_more on a 3-case page of New York");
    assert(String(body.note ?? "").includes("More cases match"), "expected the truncation note");
    for (const c of body.cases) {
      assert(c.location.state === "NY", `expected NY, got ${c.location.state} on case ${c.case_id}`);
    }
    // Ordered by back wages, largest first.
    const wages = body.cases.map((c: any) => c.back_wages ?? 0);
    assert(wages[0] > 0, `expected a non-zero largest back-wage figure, got ${wages[0]}`);
    assert(
      wages.every((w: number, i: number) => i === 0 || w <= wages[i - 1]),
      `expected descending back wages, got ${wages.join(", ")}`,
    );
  });

  await run("case_detail (pinned case)", async () => {
    const body = await callTool("case_detail", { case_id: PINNED_CASE_ID });
    console.log(
      `         -> case ${PINNED_CASE_ID} found=${body.found}; statutes: ${(body.statute_breakdown ?? []).map((s: any) => s.statute).join(", ")}`,
    );
    assert(body.found === true, `expected to find case ${PINNED_CASE_ID}`);
    assert(body.case_id === PINNED_CASE_ID, `case id echoed as ${body.case_id}`);
    assert(body.flsa_repeat_violator === "RW", `expected flag RW, got ${body.flsa_repeat_violator}`);
    assert(Array.isArray(body.statute_breakdown), "statute_breakdown is not an array");
    assert(body.statute_breakdown.length >= 1, "expected at least one statute on a case with violations");
  });

  if (sampleCaseId) {
    await run("case_detail (case id from the search above)", async () => {
      const body = await callTool("case_detail", { case_id: sampleCaseId });
      assert(body.found === true, `expected to find case ${sampleCaseId}`);
      assert(body.case_id === sampleCaseId, `case id echoed as ${body.case_id}`);
      console.log(`         -> case ${sampleCaseId} round-trips from a list result`);
    });
  } else {
    skip("case_detail (case id from the search above)", "employer_violations returned no case id");
  }

  await run("top_cases", async () => {
    const body = await callTool("top_cases", { state: "NY", limit: 3 });
    console.log(
      `         -> ${body.count} case(s), has_more=${body.has_more}; biggest: ${body.cases[0]?.employer} $${body.cases[0]?.back_wages}`,
    );
    assert(body.count === 3, `expected the full page of 3, got ${body.count}`);
    assert(body.has_more === true, "expected has_more on a 3-case page of New York");
    assert(body.cases[0].back_wages > 0, `expected a non-zero largest case, got ${body.cases[0].back_wages}`);
    assert(body.data_currency.newest_findings_end_date != null, "expected a vintage on a non-empty answer");
  });

  await run("flagged_employers", async () => {
    const body = await callTool("flagged_employers", { state: "NY", limit: 3 });
    console.log(
      `         -> ${body.count} flagged case(s): ${body.cases.map((c: any) => `${c.case_id}=${c.flsa_repeat_violator}`).join(", ")}`,
    );
    assert(body.count === 3, `expected the full page of 3, got ${body.count}`);
    assert(JSON.stringify(body.query.matched_flags) === '["R","RW"]', `matched_flags: ${JSON.stringify(body.query.matched_flags)}`);
    for (const c of body.cases) {
      // Every returned case states its flag, and it is one the search asked for.
      assert(
        c.flsa_repeat_violator === "R" || c.flsa_repeat_violator === "RW",
        `case ${c.case_id} carries flag ${JSON.stringify(c.flsa_repeat_violator)}`,
      );
    }
  });

  await run("a single-day window is inclusive of its own day", async () => {
    // Both bounds on one date: a strict gt/lt would answer zero. Live-verified
    // rows exist on 2024-06-16 (WW-4).
    const day = "2024-06-16";
    const body = await callTool("top_cases", { found_after: day, found_before: day, limit: 3 });
    console.log(`         -> ${body.count} case(s) ending exactly ${day}`);
    assert(body.count > 0, `expected cases ending on ${day}, got ${body.count}`);
    for (const c of body.cases) {
      assert(
        String(c.findings_end_date).startsWith(day),
        `case ${c.case_id} ends ${c.findings_end_date}, outside the requested day`,
      );
    }
  });

  await run("an unknown argument is refused, not ignored", async () => {
    const res: any = await client.callTool({
      name: "top_cases",
      arguments: { state: "NY", found_afer: "2024-01-01" },
    });
    assert(res.isError === true, "expected an error for a misspelled argument");
    assert(String(res.content[0].text).includes("found_afer"), "expected the offending key to be named");
  });

  await client.close();
  await server.close();

  console.log(`\nsmoke: ${passed} passed, ${failures} failed, ${upstream} upstream, ${skipped} skipped`);
  if (failures > 0) process.exit(1);
  if (upstream > 0) {
    console.error("smoke: DOL was unavailable for at least one check — rerun before reading this as a pass");
    process.exit(2);
  }
  // A skip printed that sentence and then exited 0 anyway, which is the sentence
  // being wrong about itself. CI reads this exit code as the verdict for the
  // upstream channel (§2), and GAUNTLET §4 certifies the live rung against it.
  //
  // Today the one skip site cannot be reached alone: sampleCaseId is only null
  // when employer_violations failed (failures > 0, exit 1) or was rate-limited
  // (upstream > 0, exit 2). Observed both ways while probing this on 2026-09-14
  // -- DOL 429'd a whole run and the skip rode along behind the upstream count.
  // So nothing has ever exited 0 over a skipped check, which is the dormant
  // shape rather than a safe one: a second skip site, or this one gaining a
  // cause of its own, turns it into a green over a check that never ran.
  if (skipped > 0) {
    console.error("smoke: some checks did not run; a skip is not a pass");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
