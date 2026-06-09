#!/usr/bin/env node
// Read-only Track D probe: reports the §3 marker (__KINETIC_GRID_FIX__) + the §4 GridLeakMetric
// for a tab. No grouping, no drag, no leak — safe to run on any tab including the active one.
// Use it for: T_D_01 OFF-baseline marker-absent, T_D_02 ON applied===true, T_D_06 drift hash.
//
//   node verify/check-marker.mjs --page-id <id> --label off-baseline [--gc]
//
// Writes .output/chrome-plugin-grid-fix/markers/<label>.json (unless --print-only via no label).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CdpClient, DEFAULT_PORT, findTarget, parseFlags, safeFilePart } from "./cdp-lib.mjs";

const args = parseFlags(process.argv.slice(2), {
  port: DEFAULT_PORT,
  browserUrl: null,
  pageId: null,
  label: "marker",
  outDir: ".output/chrome-plugin-grid-fix/markers",
  gc: false,
});

if (args.help || !args.pageId) {
  console.log("Usage: node verify/check-marker.mjs --page-id <cdp-page-id> --label <label> [--gc]");
  process.exit(args.pageId ? 0 : 1);
}

const target = await findTarget(args.browserUrl, args.pageId);
const cdp = new CdpClient(target);
await cdp.connect();
try {
  const capturedUtc = new Date().toISOString();
  const context = await cdp.context();
  const marker = await cdp.marker();
  const metric = await cdp.metric();
  let postGc = null;
  if (args.gc) {
    await cdp.collectGarbage(1000);
    postGc = await cdp.metric();
  }
  const output = {
    schemaVersion: "grid-fix-marker/v1",
    label: args.label,
    capturedUtc,
    pageId: args.pageId,
    targetTitle: target.title ?? null,
    context,
    marker,
    metric,
    postGcMetric: postGc,
  };
  const outPath = resolve(join(args.outDir, `${safeFilePart(args.label)}.json`));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, path: outPath, marker, tbodyRows: metric?.tbodyRows ?? null, heapUsedMB: metric?.heapUsedMB ?? null, postGcHeapMB: postGc?.heapUsedMB ?? null }));
} finally {
  cdp.close();
}
