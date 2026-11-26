# Changelog

## 2.0.0 — prepared locally, 2026-11-26

**Breaking: every tool result now opens with a fixed label block.** `content[0]` is the text `[UNTRUSTED THIRD-PARTY CONTENT] ...`, saying the next block came from the upstream source and is data, never instructions; the data that used to be `content[0]` is now `content[1]`, unchanged. A program that parses results should skip the block whose text starts with `[UNTRUSTED THIRD-PARTY CONTENT]`. Every tool also declares MCP tool annotations (read-only, non-destructive, idempotent, open world).

`back_wages_summary` returns at most 50 `matched_employers` groups, largest back wages first, and adds `matched_employers_total`; when the list is cut, a `matched_employers_note` says how many were left out. The totals still cover every retrieved case. Before this, a state-wide `all_pages` summary returned one entry per distinct employer with no limit.

## 1.2.0 — prepared locally, 2026-11-04

Add inclusive date/industry annual summaries and opt-in case-ID paging up to 10,000 cases. Progress/cancellation, duplicate-ID detection, explicit incomplete coverage and separate source employer identities prevent misleading annual or corporate comparisons.

Includes the preceding local correctness fixes and regression coverage. This version has not been published or deployed. See GAUNTLET.md for verification requirements.
