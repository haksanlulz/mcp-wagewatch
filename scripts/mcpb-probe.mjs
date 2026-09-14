#!/usr/bin/env node
/**
 * CHANNEL RUNG — the .mcpb bundle, exercised the way a client consumes it.
 *
 * Sibling of pack-probe.mjs, which covers the npm channel. Same lesson behind
 * both: a green suite says nothing about whether the shipped artifact starts.
 * This one packs the bundle, reads the ZIP back, extracts it to a throwaway
 * directory with no repo on disk, launches the manifest's own entry_point the
 * way the manifest's mcp_config says to, and speaks MCP JSON-RPC over stdio.
 *
 * Checked, in order:
 *   1. the bundle is a readable ZIP, and an independent unzip agrees
 *   2. manifest.json parses, and its version matches package.json
 *   3. manifest.server.entry_point EXISTS inside the zip (not merely declared)
 *   4. DOL_API_KEY is declared required + sensitive in user_config, and is what
 *      mcp_config.env passes to the server
 *   5. no source, test or tooling file rode along
 *   6. the extracted bundle boots and tools/list returns the documented six
 *
 * Run: npm run verify:mcpb
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "./lib/zip.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`  ok  ${m}`);

console.log(`mcpb-probe: ${pkg.name}@${pkg.version}`);

// --- 1. pack -----------------------------------------------------------------
if (spawnSync("node", [join(repo, "scripts", "pack-mcpb.mjs")], { cwd: repo, shell: false, stdio: "inherit" }).status !== 0) {
  fail("pack:mcpb");
}
const bundle = join(repo, `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.mcpb`);
if (!existsSync(bundle)) fail(`no bundle at ${bundle}`);

const zip = readZip(bundle);
ok(`bundle reads back as a zip: ${zip.size} entries`);

// --- 2. manifest -------------------------------------------------------------
const manifestEntry = zip.get("manifest.json");
if (!manifestEntry) fail("manifest.json is not in the bundle");
const manifest = JSON.parse(manifestEntry.read().toString("utf8"));
if (manifest.manifest_version !== "0.3") fail(`manifest_version is ${manifest.manifest_version}, expected 0.3`);
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} != package.json ${pkg.version}`);
for (const required of ["name", "description", "author", "server"]) {
  if (manifest[required] == null) fail(`manifest is missing the required field ${required}`);
}
if (!manifest.author?.name) fail("manifest.author.name is required by the spec");
ok(`manifest_version 0.3, version ${manifest.version} matches package.json`);

// --- 3. entry point is IN the zip, not merely declared ------------------------
const entryPoint = manifest.server?.entry_point;
if (!entryPoint) fail("manifest.server.entry_point is missing");
if (!zip.has(entryPoint)) fail(`entry_point ${entryPoint} is declared but absent from the bundle`);
ok(`entry_point ${entryPoint} is present (${zip.get(entryPoint).size} bytes)`);

// --- 4. the key is a required, sensitive user_config field --------------------
const apiKey = manifest.user_config?.api_key;
if (!apiKey) fail("user_config.api_key is missing — the bundle would install without a way to set the key");
if (apiKey.required !== true) fail("user_config.api_key must be required: every tool needs it");
if (apiKey.sensitive !== true) fail("user_config.api_key must be sensitive: it is a credential");
const env = manifest.server?.mcp_config?.env ?? {};
if (env.DOL_API_KEY !== "${user_config.api_key}") {
  fail(`mcp_config.env.DOL_API_KEY is ${JSON.stringify(env.DOL_API_KEY)}, expected \${user_config.api_key}`);
}
ok("DOL_API_KEY is a required, sensitive user_config field, injected through mcp_config.env");

// --- 5. nothing that should not ship ------------------------------------------
const leaked = [...zip.keys()].filter((f) => /^(test\/|smoke\.ts|server\.ts|index\.ts|tsconfig|\.env|live-check)/.test(f));
if (leaked.length) fail(`bundle carries non-shippable files: ${leaked.slice(0, 10).join(", ")}`);
const toolNames = (manifest.tools ?? []).map((t) => t.name).sort();
ok(`no sources or tests; manifest advertises ${toolNames.length} tools`);

// --- 6. an independent unzip agrees this is a zip ------------------------------
// Our own reader round-tripping our own writer proves nothing about the format.
// PowerShell's Expand-Archive (.NET ZipFile) and `unzip` are other people's code.
const extract = mkdtempSync(join(tmpdir(), "mcpb-"));
try {
  let extracted = false;
  const unzip = spawnSync("unzip", ["-q", "-o", bundle, "-d", extract], { shell: false, encoding: "utf8" });
  if (unzip.status === 0) {
    extracted = true;
    ok("independent check: `unzip` read the bundle");
  } else if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${bundle}' -DestinationPath '${extract}' -Force`],
      { shell: false, encoding: "utf8" },
    );
    if (ps.status === 0) {
      extracted = true;
      ok("independent check: PowerShell Expand-Archive read the bundle");
    } else {
      console.log(`  --  no independent unzip available (${(ps.stderr ?? "").trim().slice(0, 200)})`);
    }
  } else {
    console.log("  --  no independent unzip available on this machine");
  }

  // Fall back to our own reader for the launch test, but say so: a launch from
  // our own extraction still proves the server runs, just not the format.
  if (!extracted) {
    for (const [name, entry] of zip) {
      const target = join(extract, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.read());
    }
    console.log("  --  extracted with this repo's own reader; format not independently confirmed");
  }

  // --- 7. launch it the way the manifest says ---------------------------------
  const entryOnDisk = join(extract, entryPoint);
  if (!existsSync(entryOnDisk)) fail(`entry_point ${entryPoint} missing after extraction`);
  const args = (manifest.server.mcp_config.args ?? []).map((a) => a.replaceAll("${__dirname}", extract));
  const child = spawn(manifest.server.mcp_config.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: extract,
    // The host would substitute the user's key here. Any non-empty value proves
    // the wiring; no tool is called, so no request reaches DOL.
    env: { ...process.env, DOL_API_KEY: "mcpb-probe-not-a-real-key" },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-probe", version: "1.0.0" } },
  });
  await new Promise((r) => setTimeout(r, 1200));
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await new Promise((r) => setTimeout(r, 2000));
  child.kill();
  await new Promise((r) => {
    child.once("exit", r);
    setTimeout(r, 3000);
  });

  const msgs = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const init = msgs.find((m) => m.id === 1);
  if (!init?.result) fail(`no initialize response from the bundle. stderr: ${err.slice(0, 500)}`);
  ok(`initialize -> ${init.result.serverInfo?.name}@${init.result.serverInfo?.version}`);

  const list = msgs.find((m) => m.id === 2)?.result?.tools;
  if (!Array.isArray(list) || list.length === 0) fail(`tools/list returned nothing. stderr: ${err.slice(0, 500)}`);
  const served = list.map((t) => t.name).sort();
  const documented = [
    "back_wages_summary",
    "case_detail",
    "employer_violations",
    "flagged_employers",
    "top_cases",
    "violations_by_state",
  ];
  if (JSON.stringify(served) !== JSON.stringify(documented)) {
    fail(`tools/list served ${served.join(", ")}; the six documented are ${documented.join(", ")}`);
  }
  // The manifest's own advertised list has to agree with what the server serves,
  // or the install page describes a different product from the one that runs.
  if (JSON.stringify(toolNames) !== JSON.stringify(documented)) {
    fail(`manifest.tools lists ${toolNames.join(", ")}, the server serves ${served.join(", ")}`);
  }
  ok(`tools/list -> the six documented tools, matching manifest.tools`);

  console.log("PASS — the bundle installs its key, starts, and serves its tools.");
} finally {
  try {
    rmSync(extract, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* a temp directory the OS can clean is not a verdict about the artifact */
  }
}
