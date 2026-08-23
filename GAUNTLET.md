# GAUNTLET — mcp-wagewatch

Constraint state for this server (SSoT). Created by `/gauntlet convert` 2026-07-29.
Operator owns §1 and §5; Claude maintains §2–§4 and §6, transcribing operator rulings only.

One of four near-identical civic servers converted together on 2026-07-29
(`mcp-fairrent` is the pilot and carries the fullest escape log). Sibling
precedent: `mcp-scryfall/GAUNTLET.md`.

## §1 Oracle — done-definition

- **It is**: a stdio MCP server over the U.S. DOL Wage and Hour Division enforcement dataset. Tools — `employer_violations`, `back_wages_summary`, `violations_by_state`, `case_detail`. It exists so that employer wage-theft history, back wages owed, civil penalties and affected-employee counts are answered from WHISARD rather than recalled.
- **DONE means**: (a) an MCP client sees every tool and a real lookup round-trips
  over stdio; (b) results carry the underlying values so a caller can cite rather
  than trust; (c) every upstream request is serialized, spaced, timed out, and
  identifies itself.
- **Non-goals**: predicting enforcement outcomes, naming individuals, any claim about a current employer relationship.

- **MUST NEVER** (operator, 2026-07-29): *"Stale data presented as current."* WHD
  publishes concluded investigations, late. A 2019 case is not an employer's
  present compliance state, and an empty result is not a clean record. Every
  answer is exactly as current as its newest row and must say so. Locked by SPEC
  `vintage-on-every-answer`.

⚠️ The three bullets above the MUST NEVER line are still transcribed from the
README rather than elicited; the MUST NEVER clause is operator-authored.

## §2 Channel map

**A test suite is one channel; it is never the artifact's channel.**

| Artifact | Real channel | Pass condition | Rung? |
|---|---|---|---|
| server process | an MCP client spawns it and speaks JSON-RPC over **stdio** | initialize handshake · tools/list returns the documented set · a real lookup round-trips | ✅ **`npm run verify:pack` spawns the installed binary and speaks real stdio** (added 2026-07-29). ⚠️ `npm run smoke` and `test/` are BOTH `InMemoryTransport` — an earlier version of this table claimed smoke drove real stdio; it does not, and that claim was wrong when written. |
| upstream API contract | live the U.S. DOL Wage and Hour Division enforcement dataset | endpoints answer; token absence is reported, not crashed | ✅ `npm run smoke` (skips loudly without `DOL_API_KEY` (free)) |
| public repo | a stranger clones and runs `npm test` | suite green, typecheck clean, build emits | ✅ **GitHub Actions, Node 18/20/22** (added 2026-07-29): `npm ci` → typecheck → build → test, plus a separate `package` job running `verify:pack` |
| **npm package** | a stranger runs `npx @haksanlulz/mcp-wagewatch` having never cloned | bin shim resolves · server boots · handshake answers · tools/list is well-formed | ✅ **`npm run verify:pack`** — builds, packs, installs the tarball into a throwaway project, launches **through the bin shim**, speaks MCP. Mutation-probed against the real historical defect: restoring the `npx tsx` shebang turns it red. Wired into CI. |
| registry listing (LobeHub, Glama) | a stranger reads the README there and follows it cold | documented install produces a working server | 🔴 **NO RUNG** — the README is the consumed artifact on those sites and nothing checks it stays executable |

## §3 Invariants — scans

| Invariant | Scan | Status |
|---|---|---|
| Concurrent calls cannot breach the throttle | vitest: *"serializes concurrent requests through the throttle queue"* | ✅ present |
| Spacing is start-to-start, not gap+latency | vitest: *"spaces request STARTS by the throttle gap"* | ✅ present |
| One hung request cannot wedge later calls | `AbortSignal.timeout(15_000)` on every fetch | ✅ present (assertion via the header test) |
| Every request identifies itself to DOL | vitest asserts `User-Agent` matches `^mcp-wagewatch/\d` | ✅ **added 2026-07-29, mutation-probed red** |
| Token never enters the query string | vitest asserts header-only auth | ✅ present |
| Published tarball ships no tests/tooling | `files` whitelist + `npm pack --dry-run` | ✅ **added 2026-07-29** — `files: ["dist"]`; `verify:pack` fails if any source, test or tsconfig appears in the tarball |
| Every answer states its vintage (SPEC `vintage-on-every-answer`) | vitest ×3 — the note, newest-date across a mixed set, and the no-dates case; computed from rows, never the clock | ✅ **added 2026-07-29**, written RED first |

## §4 Ladder

| Class | Rungs |
|---|---|
| docs-only | none |
| code-touch (`server.ts` / `index.ts` / `test/`) | `npm test` + `npm run typecheck` + §3 scans · **this is a public commit** |
| behavior-change (tool names, schemas, output shape) | + `npm run smoke` with a live token + README tool table + §5 specs |
| artifact-affecting (`package.json`, deps, shebang, tsconfig) | + **`npm run verify:pack`** |
| release (tag / npm publish) | + the full §2 channel map + `npm run smoke` with a live token + §5 specs |

**Hard gate:** a skipped rung makes the done-report say **BLOCKED**, not done.
`prepublishOnly` (`build && typecheck && test`) enforces the code half mechanically.
The npm channel itself is covered by `verify:pack`, which CI runs on every push.

## §5 Acceptance specs

### SPEC vintage-on-every-answer
```
Given WHD enforcement data, which lags and records concluded investigations
When any tool returns a result
Then the result reports the newest findings date actually present in it
```
Computed from the returned rows, **never from the clock**. A generated-on
timestamp would assert the opposite of the truth and is itself the bug: it
would stamp "today" on a 2019 record. The empty case reports `null` rather
than omitting the field, because an answer with no dates is the one most
likely to be read as current.

Check: `test/server.test.ts` (tagged `spec: vintage-on-every-answer`), three
cases — the note, the newest-date computation across a mixed set, and the
no-dates case.
**Red-capable:** written RED first; all three failed before `withDataCurrency`
existed (2026-07-29).

*Slots 2 and 3 are open and operator-owned.*

## §6 Escape log

**2026-07-29 · The npm package cannot work, and the install line I recommended was wrong.**
Adding `bin` + `files` + a scoped name and then actually exercising the channel —
`npm pack`, install the tarball into a clean project, spawn the installed binary and
speak MCP to it — showed the binary dies on launch. `index.ts` carries
`#!/usr/bin/env -S npx tsx`, and npm's generated shim cannot honour that: it resolves
`npx-cli.js` inside the *consumer's* `node_modules/npm/`, which does not exist.
Isolated to packaging, not code — the installed source runs correctly when `tsx` is
invoked directly, and the repo's own smoke still passes.
**RESOLVED same day by operator ruling** ("bring it up to our best"): a compile step went
in. `tsc` already had `outDir`/`rootDir`/`nodenext` configured and every relative import
already carried a `.js` extension, so the build cost was the shebang and the wiring —
`#!/usr/bin/env node`, `bin` → `dist/index.js`, `files: ["dist"]`, `prepublishOnly`.
**⚑ And the first version of the new rung was toothless.** It spawned `node dist/index.js`
directly, which bypasses the shebang — so it passed against the broken package. Caught by
mutation-probing the rung itself; it now launches through the **bin shim**, and restoring
the `npx tsx` shebang turns it red. **This is the founding-incident shape twice over** —
21 green tests plus a passing smoke over an artifact that could not start, and then a
rung that could not see it.

**2026-07-29 · `mcp-wagewatch` shipped with no User-Agent at all; 21 green tests never noticed.**
It called a free federal API as an anonymous Node client while all three siblings
identified themselves. Fixed, and the missing assertion added to all four —
mutation-probed in each. **New rung** (§3): every server asserts its own UA.

**2026-07-29 · Four of my own probes returned confident wrong answers in one session.**
`npm pack --dry-run` writes no file, so an install test ran against a tarball that never
existed and reported "no bin linked". A UA mutation probe grepped stdout for
`"User-Agent"`, which also appears in a *passing* run because it is in the test name.
A test-count grep missed fairrent entirely because it runs vitest 2.1.9 with ANSI codes
while the siblings run 4.1.10. A rate-limiter read called fairrent's throttle naive when
it is correctly serialized. **Standing rule for this repo: a probe that cannot be shown
to return a negative is not evidence** (workspace Audit Discipline Rules 22/23).

### 2026-08-23 — 1.1.0: top_cases, flagged_employers, date windows, visible truncation (behavior-change class)

`top_cases` (largest by back wages, no employer required), `flagged_employers`
(WHD's flsa_repeat_violator flag; the note says it is WHD's characterization,
not a court finding). found_after/found_before windows on the list tools.
The audit's silent-truncation finding closed structurally: list tools request
limit+1 and report has_more — a page of exactly `limit` rows is no longer
indistinguishable from a complete answer. Rungs: 30 tests, typecheck,
verify:pack. ⚠️ No DOL key on this machine; live smoke gated, changes are
mock-verified against the already-live-verified request grammar.

## Known gaps, ranked by blast radius

1. **README-as-artifact.** It is what LobeHub and Glama render, and it still documents the
   old clone-and-point-tsx-at-it install. Nothing checks the documented path executes, and
   the published package now supports a shorter one. **Highest-value remaining item.**
2. **§5 holds one spec of a planned three** — the operator's stated MUST-NEVER for this
   server is authored, implemented and linked (2026-07-29). Slots 2 and 3 are open. §1's
   descriptive bullets are still transcribed from the README rather than elicited; only the
   MUST NEVER clause is in his words.
3. **vitest version drift** — fairrent 2.1.9, the siblings 4.1.10, for no recorded reason.
4. **`smoke` is in-memory, not stdio.** `verify:pack` now covers the real-stdio channel, so
   smoke's remaining job is the live upstream contract. Its name oversells it.
5. **Nothing is published yet.** The package is verified publishable; `npm publish` is an
   operator action.
