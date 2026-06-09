# Track D — Verification Harness (live CDP 9100)

Proves, numerically and OFF-vs-ON, that the extension prevents the grid group/ungroup
virtualization leak when enabled and is inert when disabled. Drives the page only through the
toggle (`chrome.storage.local.gridFixEnabled`) and the §3 marker (`window.__KINETIC_GRID_FIX__`).

These are **live** scripts against the workspace CDP Chrome on port 9100. The leak driver is
**heavy and OOM-risky** — read the safety notes before running it.

## Files

| Script | Risk | Purpose |
|---|---|---|
| `cdp-lib.mjs` | — | Shared CDP client + §4 `GridLeakMetric` (`METRIC_SOURCE`) + §3 marker reader (`MARKER_SOURCE`). No CLI. |
| `check-marker.mjs` | read-only | Report the marker + a metric snapshot for a tab. Safe on any tab. T_D_01/02/06. |
| `leak-cycle.mjs` | **heavy** | Multi-field group→ungroup × N cycles with per-cycle metric (+ post-GC heap). T_D_01 leak / T_D_03 efficacy. |
| `*.test.mjs` | offline | Unit tests (`npm test`): manifest+icons shape, popup logic, patch-transform, M1 background contract. |

## Prerequisites for a live run

1. Resolve a **fresh** Job Entry (JCGO3001) page id each session:
   `curl -s http://127.0.0.1:9100/json | jq -r '.[]|select(.type=="page")|.id+" "+.title'`
2. Preload all 4466 records (header download button `.ep-user-action-button.mdi-download`,
   then "Get More" ×N until "All 4466 records loaded"). Reuse `.tmp/grid-grouping-leak/download-records.mjs`.
3. Enable grouping via the grid `mdi-dots-vertical` menu → "Toggle Grouping" so the group panel
   exists (reuse `.tmp/grid-grouping-leak/toggle-grouping.js`).

## OFF baseline (control) — T_D_01

```bash
# Marker must be ABSENT (extension OFF/not loaded = inert):
node verify/check-marker.mjs --page-id <PID> --label off-baseline
# Then reproduce the leak on a FRESH tab (download-all + toggle-grouping done first):
node verify/leak-cycle.mjs --page-id <PID> --fields Job,Part,Rev --cycles 1 --label off-leak --gc
# Expect afterUngroup tbodyRows ≈ 4466 (leaked) — confirms the defect still exists when OFF.
```

## ON efficacy (the gate) — T_D_02/T_D_03

Toggle ON. With the shipped extension, flip via the popup switch, or from the extension's
service-worker CDP target:
`chrome.storage.local.set({gridFixEnabled:true, gridFixMode:"debugger"})`
(`debugger`/M1 is the validated shipped mechanism and is unit-proven by
`background-m1.test.mjs`). Runtime-only mode is diagnostic/best-effort: it can install traps without
reaching the parser-loaded `main.*.js` binding class, in which case marker.applied remains false.
Reload the tab after changing mode.

```bash
node verify/check-marker.mjs --page-id <PID> --label on-applied
# Expect marker.applied===true. For runtime mode, prototypeWrapped must also be true.
node verify/leak-cycle.mjs --page-id <PID> --fields Job,Part,Rev --cycles 5 --label on-efficacy --gc --stop-heap-mb 3000
# GATE: every series[].tbodyRows ≤ 120 (target <80), heap stable (no monotonic growth).
```

## Safety (non-negotiable)

- **Fresh tab only** for `leak-cycle.mjs`; one full multi-field leak per tab, then reload to
  recover (469k→~82 nodes, heap reclaims fully). Never run it on the user's already-leaked tab.
- `--stop-heap-mb 3000` aborts before the ~4 GB OOM cliff. Keep it set.
- Education tenant is read-only for Epicor writes; grouping/scrolling are client-side only.
- Re-resolve `--page-id` every session; pin it on every call.
