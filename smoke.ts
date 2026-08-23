// Live smoke test: one real call per tool against the DOL API.
// Gated on DOL_API_KEY: prints a skip notice and exits 0 when the key is unset,
// so it is safe to wire into CI without a secret.
//
//   npm run smoke
//
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const KEY_SIGNUP_URL = "https://dataportal.dol.gov/registration";

if (!process.env.DOL_API_KEY?.trim()) {
  console.log(`smoke: skipped, set DOL_API_KEY to run live checks (free key: ${KEY_SIGNUP_URL})`);
  process.exit(0);
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let failures = 0;
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`ok   ${label}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let sampleCaseId: string | null = null;

  await run("employer_violations", async () => {
    const body = parse(await client.callTool({ name: "employer_violations", arguments: { employer: "walmart", limit: 3 } }));
    console.log(`     -> ${body.count} case(s); first employer: ${body.cases[0]?.employer ?? "(none)"}`);
    sampleCaseId = body.cases[0]?.case_id ?? null;
  });

  await run("back_wages_summary", async () => {
    const body = parse(await client.callTool({ name: "back_wages_summary", arguments: { employer: "walmart", max_cases: 200 } }));
    console.log(`     -> ${body.case_count} case(s); total back wages $${body.total_back_wages}`);
  });

  await run("violations_by_state", async () => {
    const body = parse(await client.callTool({ name: "violations_by_state", arguments: { state: "NY", limit: 3 } }));
    console.log(`     -> ${body.count} case(s); top employer: ${body.cases[0]?.employer ?? "(none)"}`);
  });

  await run("case_detail", async () => {
    if (!sampleCaseId) {
      console.log("     -> skipped (no case id from employer_violations)");
      return;
    }
    const body = parse(await client.callTool({ name: "case_detail", arguments: { case_id: sampleCaseId } }));
    console.log(`     -> case ${sampleCaseId} found=${body.found}; statutes: ${(body.statute_breakdown ?? []).map((s: any) => s.statute).join(", ") || "(none)"}`);
  });

  await run("top_cases", async () => {
    const body = parse(await client.callTool({ name: "top_cases", arguments: { state: "NY", limit: 3 } }));
    console.log(`     -> ${body.count} case(s), has_more=${body.has_more}; biggest: ${body.cases[0]?.employer ?? "(none)"} $${body.cases[0]?.back_wages ?? "?"}`);
    if (typeof body.has_more !== "boolean") throw new Error("expected a has_more flag");
  });

  await run("flagged_employers", async () => {
    const body = parse(await client.callTool({ name: "flagged_employers", arguments: { state: "NY", limit: 3 } }));
    console.log(`     -> ${body.count} flagged case(s), has_more=${body.has_more}; first: ${body.cases[0]?.employer ?? "(none)"}`);
  });

  await client.close();
  await server.close();

  if (failures > 0) {
    console.error(`\nsmoke: ${failures} tool(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke: all tools ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
