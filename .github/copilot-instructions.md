# Copilot instructions for topo-mikrotik

## Project shape

This is a zero-dependency, offline MikroTik RouterOS topology and network-baseline
viewer. It runs directly from `index.html` (including `file://`); there is no
server or bundler. Runtime data stays in the browser and the last baseline is
stored in IndexedDB under `topo-mikrotik`.

The application has one shared global namespace, `globalThis.SSOT`, implemented
as ordinary scripts loaded in a deliberate order:

1. `src/core/` provides the namespace, IP utilities, and canonical keys.
2. `src/readers/` turns bundle-v1 or files-v1 input into source blocks.
3. `src/adapters/` recognizes and parses RouterOS output into facts.
4. `src/model/` builds entities from facts; `src/model/infer.js` derives device
   kinds, link classes/VLANs, groups, and profile annotations.
5. `src/check/` reports input, coverage, link, VLAN, address, and routing
   findings.
6. `src/pipeline.js` runs the read → recognize → parse → model → infer → check
   pipeline and serializes a pure JSON Snapshot.
7. `src/query/` is the read-only API for the UI and comparison module.
8. `src/view/` renders the Snapshot, including the Canvas graph, panels, search,
   route tracing, and persistence.

The Node tests load the same core scripts as the browser through
`tests/load.js`. The authoritative core script order is
`tools/core-files.js`; the first scripts in `index.html` must stay in exactly
the same order. UI scripts and optional built-in profiles/sample data follow
the core list.

## Commands

Node.js is the only required tool and dependencies do not need to be installed.

```bash
npm test
```

Runs the core test suite followed by the DOM-based UI smoke test:
`node tests/run.js && node tests/ui-smoke.js`.

```bash
npm run test:large
```

Adds the approximately 1,000-device performance/clean-network test to the
core suite.

```bash
npm run sample
npm run gen:large
```

Regenerates the sample input and its embedded browser copy, or generates
`samples/large-1000.txt` for scale testing. Generated sample files should be
updated together when the sample changes.

```bash
npm run oui -- path/to/oui-data.json
```

Rebuilds the offline OUI vendor data in `src/data/oui-data.js`.

There is no configured lint or format command. To run only the UI smoke test:

```bash
node tests/ui-smoke.js
```

The core runner has no test-name filter; its closest supported focused run is
to run `node tests/run.js` (or `node tests/run.js --large` for the stress case).
For a custom input through the UI smoke path:

```bash
SMOKE_INPUT=path/to/input.txt node tests/ui-smoke.js
```

## Architecture and data contracts

- `SSOT.build(sources, options)` is the synchronous Node/test entry point;
  browser code uses the incremental `buildAsync` path so progress can be
  displayed. A source is `{ name, text }`; options may include a profile,
  expected-data overrides, and a fixed `now`.
- Readers preserve block/file/line provenance. Adapters must attach source
  references to facts so findings and UI details can open the original line.
- The model is built from facts using canonical keys from `src/core/keys.js`;
  do not merge entities by display labels or profile annotations.
- Profiles are optional annotations. They may canonicalize aliases/domain names
  before modeling and add kind/role/site/group/label metadata afterward, but
  must not invent, delete, or mutate collected facts.
- `Snapshot` is the boundary between core processing and presentation. Keep
  `view/` and `compare/` on the `SSOT.query(snapshot)` read-only interface
  rather than reaching into model-building Maps/Sets or reimplementing lookup
  logic.
- Findings are explicit rather than silently discarded. Unrecognized blocks and
  recognized-but-empty/non-detail blocks become `I01`; duplicate device/data
  blocks use the last block and report `I02`.
- Snapshot output is intended to be deterministic for the same input and
  options. `meta.createdAt` and timing are the intentional runtime exceptions;
  tests pass a fixed `now` when comparing snapshots.

## Repository-specific change conventions

### Adding or changing parsers

- RouterOS `print` input is expected in `detail without-paging` key/value form;
  preserve support for continuation lines, quoted values, flags, and RouterOS
  6/7 variations.
- Add a new vendor adapter under `src/adapters/`, register it with
  `S.adapters.register()`, add it to `tools/core-files.js`, and add the same
  script before the dependent pipeline scripts in `index.html`.
- Add a new input format under `src/readers/` and register it in
  `src/readers/index.js`'s `ORDER`. Reader precedence matters because
  bundle-v1 is selected before files-v1.
- New checks belong in the check catalog/implementation in
  `src/check/checks.js`; add representative fault data and assertions to the
  core tests.

### Browser and generated assets

- Keep the application usable by opening `index.html` directly. Do not
  introduce module imports, a required dev server, external runtime assets, or
  network calls without changing the project’s offline contract.
- `samples/sample-bundle.js` is generated from
  `samples/sample-bundle.txt` by `tools/embed-sample.js`; do not hand-edit the
  embedded JavaScript.
- Keep source files as plain scripts using the existing IIFE/global namespace
  pattern unless the loading architecture is deliberately updated.
- IndexedDB persistence belongs in `src/view/store.js`; UI state and graph-only
  virtual unknown-peer nodes must not alter the Snapshot.

### Tests and documentation

- Core tests are plain `assert` tests registered in `tests/run.js`, not a test
  framework. The UI smoke test executes the scripts from `index.html` against a
  minimal DOM and exercises the main UI flows without a real browser.
- Test data is synthetic and modeled on RouterOS conventions, not captured
  device output. Keep the limitation in mind when changing parser behavior.
- When changing collection requirements, input syntax, profiles, or the
  Snapshot contract, update the relevant documentation in `README.md` and
  `docs/` (especially `docs/design-ssot.md`, `docs/collection.md`, and
  `docs/profile.md`) along with tests.
