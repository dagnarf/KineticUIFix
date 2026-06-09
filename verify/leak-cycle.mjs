#!/usr/bin/env node
// Track D leak driver: multi-field group -> ungroup, N cycles, metric (+ post-GC heap) each.
// HEAVY + OOM-RISK: only run on a FRESH tab with all records preloaded, never on the user's
// already-leaked tab. One full multi-field leak per tab, then reload to recover.
//
//   node verify/leak-cycle.mjs --page-id <id> --fields Job,Part,Rev --cycles 5 \
//       --label off-leak --stop-heap-mb 3000 --gc
//
// Records the §3 marker at start (so the run is self-identifying as OFF/ON) and emits a
// per-cycle series (afterUngroup tbodyRows + post-GC heap) for the no-monotonic-growth gate.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CdpClient, DEFAULT_PORT, METRIC_SOURCE, findTarget, parseFlags, safeFilePart } from "./cdp-lib.mjs";

const args = parseFlags(process.argv.slice(2), {
  port: DEFAULT_PORT,
  browserUrl: null,
  pageId: null,
  label: "leak-cycle",
  outDir: ".output/chrome-plugin-grid-fix",
  cycles: 5,
  fields: ["Job", "Part", "Rev"],
  waitMs: 1500,
  stopHeapMB: 3000,
  gc: false,
});

if (args.help || !args.pageId) {
  console.log("Usage: node verify/leak-cycle.mjs --page-id <id> --fields Job,Part,Rev --cycles 5 [--gc] [--stop-heap-mb 3000]");
  process.exit(args.pageId ? 0 : 1);
}
if (!args.fields.length) throw new Error("--fields must contain at least one header label.");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function geometryExpression(field) {
  return `(()=>{const text=(el)=>String((el&&((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('title')||'')))||'').replace(/\\s+/g,' ').trim(); const headers=[...document.querySelectorAll('.k-grid-header th')].filter((el)=>text(el)); const needle=${JSON.stringify(field)}.toLowerCase(); const header=headers.find((el)=>text(el).toLowerCase().includes(needle))||headers[0]||null; const panel=document.querySelector('kendo-grid-group-panel,.k-grouping-header,.k-grid-group-panel'); const rect=(el)=>{if(!el)return null; const r=el.getBoundingClientRect(); return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),text:text(el)};}; return {header:rect(header),panel:rect(panel),headers:headers.map((el,index)=>({index,text:text(el)})).slice(0,40),panelText:text(panel)};})()`;
}

function ungroupExpression() {
  return `(async()=>{const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms)); const click=(el)=>{if(!el)return false; const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2; const opts={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0,buttons:1}; el.dispatchEvent(new PointerEvent('pointerdown',opts)); el.dispatchEvent(new MouseEvent('mousedown',opts)); el.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0})); el.dispatchEvent(new MouseEvent('mouseup',{...opts,buttons:0})); el.click(); return true;}; const active=()=>document.querySelectorAll('kendo-grid-group-panel .k-chip,.k-grouping-header .k-group-indicator,.k-grid-group-panel .k-chip').length; const attempts=[]; for(let pass=0;pass<12&&active()>0;pass+=1){const selectors=['kendo-grid-group-panel .k-chip-remove-action','kendo-grid-group-panel button[aria-label*=Remove]','.k-grid-group-panel .k-chip-remove-action','.k-grouping-header .k-group-indicator .k-i-close','.k-grouping-header .k-group-indicator button','.k-chip button','.k-chip .k-svg-i-x','.k-chip .k-i-x']; const targets=selectors.flatMap((sel)=>[...document.querySelectorAll(sel)]).filter((el,index,array)=>array.indexOf(el)===index); attempts.push({pass,groupsBefore:active(),targets:targets.length}); if(!targets.length)break; for(const target of targets){click(target); await wait(250);} await wait(1000);} return {groupsAfter:active(),attempts};})()`;
}

async function drag(cdp, start, end) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y });
  await wait(150);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1 });
  await wait(250);
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const ratio = i / steps;
    const ease = ratio < 0.5 ? 2 * ratio * ratio : -1 + (4 - 2 * ratio) * ratio;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + (end.x - start.x) * ease, y: start.y + (end.y - start.y) * ease, button: "left", buttons: 1 });
    await wait(35);
  }
  await wait(250);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1 });
}

const target = await findTarget(args.browserUrl, args.pageId);
const cdp = new CdpClient(target);
await cdp.connect();
try {
  await cdp.send("Page.bringToFront");
  const run = {
    schemaVersion: "grid-fix-leak-cycle/v1",
    capturedUtc: new Date().toISOString(),
    pageId: args.pageId,
    targetTitle: target.title ?? null,
    fields: args.fields,
    cycles: args.cycles,
    markerAtStart: await cdp.marker(),
    snapshots: [{ label: "baseline", metric: await cdp.metric() }],
    cyclesResult: [],
  };
  for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
    const cycleResult = { cycle, groupResults: [] };
    for (const field of args.fields) {
      const geometry = await cdp.evaluate(geometryExpression(field));
      if (!geometry.header || !geometry.panel) {
        cycleResult.groupResults.push({ ok: false, field, geometry, error: "missing-header-or-group-panel" });
        continue;
      }
      const start = { x: geometry.header.x + Math.min(Math.max(20, geometry.header.w * 0.45), geometry.header.w - 10), y: geometry.header.y + geometry.header.h / 2 };
      const end = { x: geometry.panel.x + Math.min(Math.max(90, geometry.panel.w * 0.25), geometry.panel.w - 20), y: geometry.panel.y + geometry.panel.h / 2 };
      const before = await cdp.evaluate(METRIC_SOURCE);
      await drag(cdp, start, end);
      await wait(args.waitMs);
      const after = await cdp.evaluate(METRIC_SOURCE);
      cycleResult.groupResults.push({ ok: after.activeGroups > before.activeGroups, field, beforeGroups: before.activeGroups, afterGroups: after.activeGroups });
    }
    cycleResult.afterGroup = await cdp.metric();
    cycleResult.ungroup = await cdp.evaluate(ungroupExpression());
    await wait(args.waitMs);
    cycleResult.afterUngroup = await cdp.metric();
    if (args.gc) {
      await cdp.collectGarbage(1000);
      cycleResult.afterUngroupPostGc = await cdp.metric();
    }
    run.cyclesResult.push(cycleResult);
    const series = cycleResult.afterUngroupPostGc || cycleResult.afterUngroup;
    run.snapshots.push({ label: `after-ungroup-${cycle}`, metric: series });
    const heap = series.heapUsedMB;
    if (args.stopHeapMB > 0 && heap !== null && heap >= args.stopHeapMB) {
      run.stopped = { reason: "heap-threshold", cycle, heapUsedMB: heap, stopHeapMB: args.stopHeapMB };
      break;
    }
  }
  // Per-cycle series for the no-monotonic-growth gate.
  run.series = run.cyclesResult.map((c) => {
    const m = c.afterUngroupPostGc || c.afterUngroup;
    return { cycle: c.cycle, tbodyRows: m.tbodyRows, heapUsedMB: m.heapUsedMB, domNodes: m.domNodes };
  });
  const outPath = resolve(join(args.outDir, `${safeFilePart(args.label)}-leak-cycle.json`));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, path: outPath, marker: run.markerAtStart, cycles: run.cyclesResult.length, series: run.series, stopped: run.stopped ?? null }));
} finally {
  cdp.close();
}
