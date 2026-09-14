#!/usr/bin/env node
/**
 * Build the .mcpb bundle: a ZIP carrying manifest.json, the compiled server, and
 * the production dependency tree.
 *
 * An .mcpb is what a worker-center or legal-aid staffer can install without a
 * terminal — the README's alternative is hand-editing a JSON config block with
 * an API key in it, which is this server's only real adoption barrier.
 *
 * Format: MCPB manifest spec 0.3 (modelcontextprotocol/mcpb, MANIFEST.md,
 * "Current version: 0.3"). A node-type bundle carries its dependencies in
 * node_modules and typically a package.json at the bundle root.
 *
 * Run: npm run pack:mcpb        (verify it: npm run verify:mcpb)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./lib/zip.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

// The manifest and package.json state the same version to two different
// installers. They drift the moment nothing compares them.
if (manifest.version !== pkg.version) {
  fail(`manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}

if (spawnSync("npm", ["run", "build"], { cwd: repo, shell: true, stdio: "inherit" }).status !== 0) fail("build");

const entryPoint = manifest.server.entry_point;
if (!existsSync(join(repo, entryPoint))) fail(`entry_point ${entryPoint} does not exist after the build`);

/** Every file under `dir`, as bundle-relative forward-slash paths. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

const files = [];
const add = (absolute) => {
  const name = relative(repo, absolute).split(sep).join("/");
  files.push({ name, data: readFileSync(absolute) });
};

add(join(repo, "manifest.json"));
add(join(repo, "package.json"));
for (const doc of ["README.md", "LICENSE"]) {
  if (existsSync(join(repo, doc))) add(join(repo, doc));
}
for (const f of walk(join(repo, "dist"))) add(f);

// Production dependencies only. `npm ls --omit=dev --parseable --all` is npm's
// own answer to "what would a production install contain", so the bundle's
// dependency surface is the published package's, not this checkout's devDeps.
const listed = spawnSync("npm", ["ls", "--omit=dev", "--parseable", "--all"], {
  cwd: repo,
  shell: true,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const depDirs = (listed.stdout ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && l !== repo && l.includes(`${sep}node_modules${sep}`));
if (depDirs.length === 0) fail("npm ls listed no production dependencies — refusing to ship a bundle that cannot start");

const seen = new Set();
for (const dir of depDirs) {
  for (const f of walk(dir)) {
    if (seen.has(f)) continue; // nested trees overlap with their parents
    seen.add(f);
    add(f);
  }
}

const out = join(repo, `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.mcpb`);
const { entries, bytes } = writeZip(out, files);
console.log(`packed ${relative(repo, out)}`);
console.log(`  ${entries} entries, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  entry_point ${entryPoint}, ${depDirs.length} production dependencies`);
