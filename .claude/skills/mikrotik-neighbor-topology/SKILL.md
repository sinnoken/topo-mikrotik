---
name: mikrotik-neighbor-topology
description: "Use when working with MikroTik RouterOS neighbor discovery, LLDP, MNDP, CDP, /ip neighbor output, topology collection, duplicate links, or protocol-aware neighbor aggregation. Consult the official MikroTik manual and preserve traceable, offline-compatible project behavior."
argument-hint: "Describe the RouterOS neighbor/topology behavior to inspect or change"
user-invocable: true
---

> Claude Code 版。內容與 `.github/skills/mikrotik-neighbor-topology/SKILL.md`（GitHub Copilot 版）相同，修改時兩邊一起改；`tests/run.js` 會檢查兩者一致。

# MikroTik Neighbor Topology

## Purpose

Use this skill for changes or investigations involving RouterOS neighbor discovery
and topology inference in this repository. It covers LLDP, MNDP, CDP, bridge
interfaces, protocol-specific records, and duplicate neighbor/link handling.

## Finding Official RouterOS Documentation

The official RouterOS manual is available in machine-readable plain-text
formats:

<https://manual.mikrotik.com/llms.txt>

- `https://manual.mikrotik.com/llms.txt` indexes every manual page with a
  description and link. Read this first to find the relevant documentation.
- `https://manual.mikrotik.com/llms-full.txt` concatenates the entire manual
  into one text file and is intended for bulk ingestion or a full local copy.

Use the official documentation as the source of truth for RouterOS field names,
command output, and protocol semantics. Prefer the index and relevant linked
pages; use the full manual when broader context is needed. Do not copy the
manual into the repository or add a runtime network dependency.

## Procedure

1. Read the relevant project instructions, adapter, model, reader, tests, and
   directly related documentation before editing.
2. Consult the official manual index above and follow the relevant RouterOS
   documentation link when the behavior or field semantics are uncertain.
3. Trace the data flow:
   - RouterOS text output and parsing
   - adapter facts and source line metadata
   - model claims, devices, interfaces, and links
   - checks, queries, and UI projections
4. Treat protocol discovery as evidence, not as a unique device or link by
   itself. A single local interface can report the same remote system through
   multiple protocols.
5. Review deduplication at both levels:
   - Neighbor evidence: merge records for the same local interface and remote
     system; protocol and non-empty fields should be unions/merged evidence.
   - Topology links: use the existing canonical unordered endpoint key so
     reverse observations do not create a second link.
6. Prefer stable identity evidence in this order:
   - remote chassis/device MAC when available;
   - canonicalized system identity;
   - address or other identifiers only as documented, weaker evidence.
   Do not use a remote port name as the device identity. A port name may differ
   by protocol or be absent.
7. Keep bridge-member handling explicit. Prefer a physical interface over a
   bridge-only observation when they describe the same evidence, but do not
   silently discard distinct physical links.
8. Preserve provenance (`block`, source file, and line where available), expose
   protocol evidence when the data contract supports it, and report ambiguity
   instead of silently choosing between conflicting facts.
9. Add a reproducible regression test before or together with the fix. Include,
   where relevant:
   - LLDP and MNDP/CDP on the same local interface;
   - differing or missing remote port names;
   - identity and MAC fallback;
   - bridge plus physical-interface observations;
   - reverse observations from both devices.
10. Update directly related documentation, then run the smallest relevant test
    command, `git diff --check`, and inspect the final diff.

## Repository-specific invariants

- Keep the project zero-dependency and directly-openable offline.
- Keep adapters responsible for parsed facts and models responsible for
  canonicalization/inference; do not move UI logic into either layer.
- Use existing canonical key helpers and link aggregation instead of introducing
  a parallel identity scheme.
- Do not hide malformed or ambiguous RouterOS input with broad catches or
  success-shaped fallbacks.
- Keep output ordering and source references deterministic.

## Expected review questions

- Can LLDP, MNDP, and CDP observations on one local interface produce multiple
  claims for one remote device?
- Does a missing `interface-name` or a protocol-specific identity change the
  deduplication key incorrectly?
- Can bridge and member-port observations create duplicate links or false
  one-way/K01 findings?
- Are protocol unions, field conflicts, and provenance retained?
- Are reverse observations merged without changing endpoint direction semantics?
