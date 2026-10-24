---
name: routeros-parser-fixtures
description: "Use when adding or changing a RouterOS adapter or parser (src/adapters/mikrotik.js), handling a new or odd CLI output shape (multi-line continuation, bridge/port names, missing sections), or adding collection commands. Drives fixture-first regression tests, missing-data fallbacks, and collection doc sync."
argument-hint: "Describe the RouterOS command output or parsing problem"
user-invocable: true
---

> Claude Code 版。內容與 `.github/skills/routeros-parser-fixtures/SKILL.md`（GitHub Copilot 版）相同，修改時兩邊一起改；`tests/docs.js` 會檢查兩者一致。

# RouterOS Parser Fixtures

## Purpose

Adapters turn RouterOS CLI text into traceable facts. Real output is irregular, and a
parser change that only fits one sample tends to break another. Work fixture-first.

## Procedure

1. **Get the real shape first.** Ask for or locate a real excerpt (user-pasted output,
   `tests/fixtures/real/`, `samples/`). Anonymize real output with `tools/anonymize.js`
   before adding it to `tests/fixtures/real/`; never commit the `.map.json` table. Note continuation lines, quoting, flags legends, `a,b` lists, and
   `x/y` compound names. Test fixtures are hand-written from docs, not captured, so say
   so when the shape is a guess. Consult <https://manual.mikrotik.com/llms.txt> for
   field semantics.
2. **Write the failing test before the fix** in `tests/run.js`, using the existing
   `build(text)` helper with a fixed `now`. Cover:
   - the exact pasted shape (including multi-line continuation);
   - quoting and case variants (`"x"`, `x`, `X`, trailing spaces);
   - both sides of a pair when the fact is relational (reverse observation);
   - the case where the section is missing (see step 4).
3. **Parse, do not guess.** The adapter emits facts with `block`/`line` provenance.
   Keep raw values that later stages may need (for example `rawType`, `hwMac`, MTU),
   and canonicalize in the model, not the adapter. Do not widen a regex to match one
   sample without checking the others.
   - When adding or changing an adapter, declare every line that by format carries no
     fact (flags legend, continuation, disabled entry, …) with `ignore(line, why)`.
     Every other non-empty line in a parsed block becomes I03 (`src/adapters/index.js`).
   - Widen what counts as ignorable only when the official manual says the line carries
     no data. Never widen it just to make an I03 go away.
   - RouterOS error messages (`bad command name`, `syntax error`, `failure:` …) are never
     ignorable. `S.adapters.parse` reports them even if an adapter ignores them.
4. **Plan the fallback chain.** Any single print can be absent. For each derived value
   write down the order: primary command, other collected commands (such as the
   `/export` section), then name-based inference as the last resort. Inferred values
   stay inferences. Never turn a missing section into a success-shaped default; surface
   it through an existing finding or coverage entry.
5. **Check neighbors of the change.** Names can differ by protocol and by side
   (`ether3,bridge` locally, `bridge/ether2` remotely). Compare using the shared
   canonical key helpers, not ad-hoc string handling.
6. **Sync docs.** Update `docs/收集清單與輸入格式.md` (command table; every print uses
   `detail without-paging`) and the adapter table in `docs/設計說明.md`.
7. **Verify.** Run `npm test`, then `git diff --check`. If the change affects
   a sample, regenerate through `npm run sample` instead of editing it by hand.

## From an I03 on real output to a fixture

Every I03 found on real device output goes through this loop
(see `docs/架構決策/011-I03轉成fixture的回歸流程.md`):

1. Anonymize the collection file with `tools/anonymize.js` and read the result once
   more by hand; never commit the `.map.json` table.
2. Save it as `tests/fixtures/real/<RouterOS version>-<model>.txt`. The existing tests
   now fail on that I03, which is expected.
3. Write a failing test for those lines first, stating the facts they should produce or
   the manual-backed reason they are ignorable.
4. Fix the parser until the test passes. Do not resolve it by ignoring the lines (see
   step 3 of the procedure).

## Pitfalls seen in this repo

- An adapter fix that is correct but a browser still shows old results: the restored
  baseline was built before the fix. Tell the user to reload the input; see the
  `snapshot-contract-change` skill for when to bump the version.
- Hard-coded counts in tests (`links.length === 77`) make later correct changes look
  like regressions. Assert the relationship, not the total, when you can.
