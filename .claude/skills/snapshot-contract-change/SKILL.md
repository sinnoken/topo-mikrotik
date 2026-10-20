---
name: snapshot-contract-change
description: "Use when adding, renaming, or removing a Snapshot field, an interface/link/device property, a finding id, or a query API; or deciding whether to bump S.VERSION or the schema. Walks the full data flow so every layer, the UI, tests and docs stay consistent."
argument-hint: "Describe the field or contract being changed"
user-invocable: true
---

> Claude Code 版。內容與 `.github/skills/snapshot-contract-change/SKILL.md`（GitHub Copilot 版）相同，修改時兩邊一起改；`tests/run.js` 會檢查兩者一致。

# Snapshot Contract Change

## Purpose

The Snapshot is the plain-JSON contract between the core and every view. A field added
in one layer and forgotten in another gives data that is parsed but never stored or
shown. Change the contract through the whole flow, once.

## Data flow checklist

Work through each layer in order and record which ones the change touches:

1. **Adapter** (`src/adapters/`): emits the fact with `block`/`line`.
2. **Model** (`src/model/build.js`): the entity factory (`iface()`, `device()`) and the
   `onXxx` handler. Add the default value here so the field always exists.
3. **Infer / check** (`src/model/infer.js`, `src/check/checks.js`): consume the field
   with a stated fallback when it is missing. Facts stay facts; inferences stay marked.
4. **Pipeline** (`src/pipeline.js`): serialize it, with deterministic ordering.
5. **Query** (`src/query/query.js`): expose it through `SSOT.query(snapshot)`; the UI
   must not read raw model structures.
6. **View** (`src/view/`): display it only if the user needs it. View state (selection,
   zoom, positions) never goes into the Snapshot.
7. **Compare** (`src/compare/`): decide whether the field takes part in comparison.
8. **Docs**: `README.md`, `docs/design-ssot.md` (data model), `docs/checks.md` (finding rules),
   `docs/collection.md` if collection changes.
9. **Tests**: a reproducible case in `tests/run.js`; UI behavior in `tests/ui-smoke.js`.

## Compatibility and versions

- Adding an optional field with a documented default is compatible. Keep existing field
  names, finding ids, messages and output ordering stable.
- `S.VERSION` and `S.SCHEMA` live in `src/core/ns.js`. The app rebuilds a restored
  baseline from its saved inputs when `snap.meta.version` differs from `S.VERSION`, so
  bumping the version is what makes old browsers pick up parsing changes.
  - Bump it only when the user wants stored baselines rebuilt, and say so. Do not bump
    it as a reflex, and revert if the user declines.
  - Change `S.SCHEMA` only for a breaking shape change. The restore path (`App.restore`)
    rebuilds a baseline with a different schema from its saved inputs. If there are no
    inputs, it tells the user the baseline is incompatible.
- Never add time, randomness or environment state to core results. Tests compare
  Snapshots with a fixed `now`.

## Verify

1. `npm test` (core tests, collector shell test, UI smoke). The golden test compares the
   sample Snapshot with `tests/golden/sample-snapshot.json`; after an intended change run
   `npm run golden:update` and review the `git diff` of that file before committing.
2. `git diff --check`.
3. Confirm `index.html` and `tools/core-files.js` core load order did not drift if a
   file was added.
4. Check the field is read by something: grep for the new name in checks, query and
   view. A stored field nobody uses is a gap worth reporting.
