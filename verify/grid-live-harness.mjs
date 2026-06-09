// Live CDP harness for the Kinetic virtual-grid fixes — workflow automation (Search -> Download
// Records -> Get More -> Select All -> OK), grid scroll-smoothness testing, and blank-grid detection.
// The iterative-testing rig used to diagnose + validate the blank-grid-after-bulk-load fix
// (src/grid-blank-fix.js). Built on the same cdp-lib.mjs CdpClient as the leak harness. CLI:
//   node verify/grid-live-harness.mjs <cmd> [args...]
// Commands:
//   scan                       read-only DOM sweep (buttons/panels/grids)
//   metric                     grid/heap metric snapshot
//   shot <label>               screenshot to .tmp/jobstatus-grid/<label>.png
//   eval '<expr>'              evaluate arbitrary JS expression, print JSON
//   evalfile <path>            evaluate JS from a file
//   click-sel '<css>'          real-mouse click at element center (1st match)
//   click-text '<txt>'         click inner button whose text === txt
// Env: PAGE_ID (default JSM tab), PORT (default 9100)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CdpClient, findTarget, METRIC_SOURCE } from "./cdp-lib.mjs";

const PAGE_ID = process.env.PAGE_ID || "5BEDE8F4F83D722EFC68F60491023EDA";
const PORT = process.env.PORT || "9100";
const BROWSER = `http://127.0.0.1:${PORT}`;
const OUT = process.env.HARNESS_OUT || ".tmp/grid-live";
try { mkdirSync(OUT, { recursive: true }); } catch (e) { /* ignore */ }

// whitespace-collapse without the \s template-literal trap (\\s -> \s in the string)
const NORM = "(s)=>String(s||'').trim().replace(/[ \\t\\r\\n]+/g,' ').slice(0,80)";

const SCAN = `(()=>{
  const norm=${NORM};
  const vis=(el)=>{ if(!el) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'; };
  const txt=(el)=>norm(el.innerText||el.textContent);
  const named=[...document.querySelectorAll('button, ep-button, [role=button]')].filter(vis)
    .map(b=>({tag:b.tagName.toLowerCase(), text:txt(b), cls:String(b.className||'').slice(0,70), disabled:b.disabled===true||b.getAttribute('aria-disabled')==='true'}))
    .filter(b=>b.text);
  const panels=[...document.querySelectorAll('ep-base-sliding-panel, ep-dialog, kendo-dialog, .ep-dialog, .k-dialog, .k-window, ep-search, .ep-search-panel')].filter(vis)
    .map(p=>({tag:p.tagName.toLowerCase(), cls:String(p.className||'').slice(0,70), header: txt(p).slice(0,100)}));
  const grids=[...document.querySelectorAll('kendo-grid, .k-grid')].map(g=>({cls:String(g.className||'').slice(0,60), tbodyRows:g.querySelectorAll('tbody tr').length, vis:vis(g)}));
  return {url:location.href, title:document.title, readyState:document.readyState, buttonCount:named.length, buttons:named, panels, grids};
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads the search-results banner: "N records loaded" + Get More button state.
async function bannerStatus(client) {
  return client.evaluate(`(()=>{
    const vis=(el)=>{ if(!el) return false; const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; };
    const norm=(s)=>String(s||'').trim().replace(/[ \\t\\r\\n]+/g,' ');
    const st=document.querySelector('.erp-panelcard-grid-banner-status');
    const txt=st?norm(st.textContent):null;
    const m=txt?txt.match(/([0-9,]+)[ ]*records/i):null;
    const loaded=m?parseInt(m[1].replace(/,/g,''),10):null;
    let gm=null;
    document.querySelectorAll('.erp-panelcard-grid-banner-get-more, ep-button, button').forEach(el=>{
      if(gm)return; if(norm(el.innerText||el.textContent)!=='Get More')return;
      gm={visible:vis(el), disabled:el.getAttribute('aria-disabled')==='true'||el.disabled===true};
    });
    return {txt, loaded, getMore:gm};
  })()`);
}

// Drives Download Records -> Get More loop until exhausted.
async function downloadAll(client, opts = {}) {
  const maxIter = opts.maxIter || 100;
  const settleMs = opts.settleMs || 700;
  const pollMs = 400, pollMax = 40; // up to ~16s per batch
  const history = [];
  let st = await bannerStatus(client);
  if (st.loaded == null) {
    await clickAtElement(client, "i.mdi-download");
    // poll for the first-batch preload banner to render (can take >1s for 500 rows)
    for (let p = 0; p < pollMax; p++) {
      await sleep(pollMs);
      st = await bannerStatus(client);
      if (st.loaded != null) break;
    }
  }
  history.push({ step: "preload", loaded: st.loaded });
  const isAllDone = (s) => !!(s.txt && /^all\b/i.test(s.txt));
  for (let i = 0; i < maxIter; i++) {
    st = await bannerStatus(client);
    if (isAllDone(st)) break; // "All N records loaded" -> truly exhausted
    if (!st.getMore || !st.getMore.visible || st.getMore.disabled) {
      // Get More may just be lagging behind the count render; poll before concluding done.
      let appeared = false;
      for (let q = 0; q < 10; q++) {
        await sleep(300);
        st = await bannerStatus(client);
        if (isAllDone(st)) { appeared = false; break; }
        if (st.getMore && st.getMore.visible && !st.getMore.disabled) { appeared = true; break; }
      }
      if (!appeared) break;
    }
    const before = st.loaded ?? 0;
    await clickText(client, "Get More");
    let cur = before, done = false;
    for (let p = 0; p < pollMax; p++) {
      await sleep(pollMs);
      const s2 = await bannerStatus(client);
      cur = s2.loaded ?? cur;
      if ((s2.loaded != null && s2.loaded > before) || !s2.getMore || !s2.getMore.visible) { done = true; break; }
    }
    history.push({ step: i + 1, loaded: cur });
    if (cur === before) break; // no progress -> exhausted/stuck
  }
  const final = await bannerStatus(client);
  return { finalLoaded: final.loaded, finalText: final.txt, getMoreStillVisible: !!(final.getMore && final.getMore.visible), batches: history.length - 1, history };
}

async function clickAtElement(client, selector, index = 0) {
  // returns {ok, rect} ; performs a real mouse press/release at element center
  const info = await client.evaluate(`(()=>{
    const els=[...document.querySelectorAll(${JSON.stringify(selector)})];
    const el=els[${index}];
    if(!el) return {ok:false, reason:'no-match', count:els.length};
    el.scrollIntoView({block:'center',inline:'center'});
    const r=el.getBoundingClientRect();
    return {ok:true, x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height, count:els.length, tag:el.tagName.toLowerCase()};
  })()`);
  if (!info || !info.ok) return info || { ok: false };
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: info.x, y: info.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.x, y: info.y, button: "left", clickCount: 1 });
  return info;
}

async function clickText(client, text) {
  const info = await client.evaluate(`(()=>{
    const norm=${NORM};
    const want=${JSON.stringify(text)};
    const btns=[...document.querySelectorAll('button.ep-button, button, ep-button, [role=button]')];
    const el=btns.find(b=>norm(b.innerText||b.textContent)===want && (b.tagName.toLowerCase()==='button'));
    const any=el||btns.find(b=>norm(b.innerText||b.textContent)===want);
    if(!any) return {ok:false, reason:'no-match'};
    any.scrollIntoView({block:'center',inline:'center'});
    const r=any.getBoundingClientRect();
    return {ok:true, x:r.left+r.width/2, y:r.top+r.height/2, tag:any.tagName.toLowerCase()};
  })()`);
  if (!info || !info.ok) return info || { ok: false };
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: info.x, y: info.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.x, y: info.y, button: "left", clickCount: 1 });
  return info;
}

const KEYS = {
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
};
async function pressKey(client, name) {
  const k = KEYS[name];
  if (!k) return { ok: false, reason: `unknown key ${name}` };
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  return { ok: true, key: name };
}

// Samples one .k-grid (by index): scroll geometry, virtual window size, rendered first/last row, heap.
function sampleExpr(idx) {
  return `(()=>{
    const grids=[...document.querySelectorAll('.k-grid')];
    const g=grids[${idx}]; if(!g) return {ok:false, reason:'no-grid', gridCount:grids.length};
    const c=g.querySelector('.k-grid-content-virtual')||g.querySelector('.k-grid-content');
    const tb=g.querySelector('tbody');
    const rows=tb?[...tb.children]:[];
    const cellText=(r)=>{const tds=r.querySelectorAll('td'); for(const td of tds){const t=String(td.innerText||td.textContent||'').trim(); if(t) return t;} return '';};
    const jobs=rows.map(cellText).filter(Boolean);
    const mem=(window.performance&&performance.memory)?+(performance.memory.usedJSHeapSize/1048576).toFixed(1):null;
    const hc=g.querySelector('.k-height-container');
    // viewport alignment: how many rendered rows actually intersect the visible content box, and the blank gap above them
    const cr=c?c.getBoundingClientRect():null;
    let inView=0, firstRowTop=null;
    if(cr){ for(const r of rows){ const rr=r.getBoundingClientRect(); if(firstRowTop===null) firstRowTop=Math.round(rr.top); if(rr.bottom>cr.top && rr.top<cr.bottom) inView++; } }
    const topGap = (cr&&firstRowTop!==null)?Math.round(firstRowTop-cr.top):null;
    return {ok:true,
      rowsInView:inView,
      topGapPx:topGap,
      scrollTop:c?Math.round(c.scrollTop):null,
      scrollH:c?c.scrollHeight:null,
      clientH:c?c.clientHeight:null,
      maxScroll:c?Math.max(0,c.scrollHeight-c.clientHeight):null,
      tbodyRows:rows.length,
      firstJob:jobs[0]||null,
      lastJob:jobs[jobs.length-1]||null,
      spacerH:hc?Math.round(parseFloat(hc.style.height)||hc.offsetHeight):null,
      domNodes:document.getElementsByTagName('*').length,
      heapMB:mem};
  })()`;
}

// Sets scrollTop to an absolute target and polls until it stabilizes (this grid applies scroll async).
// Returns {requested, settled, settleMs, drift} where drift = max |reading - prevReading| seen while settling.
async function settleScroll(client, idx, target, opts = {}) {
  const pollStep = opts.pollStep || 160, pollCap = opts.pollCap || 16;
  const tgt = Math.round(target);
  await client.evaluate(`(()=>{const g=[...document.querySelectorAll('.k-grid')][${idx}]; const c=g.querySelector('.k-grid-content-virtual')||g.querySelector('.k-grid-content'); if(c)c.scrollTop=${tgt}; return true;})()`);
  const readings = [];
  let prev = null, settleMs = 0, stableHits = 0, drift = 0, last = null, arrived = false, postArrivalDrift = 0, arrivedMs = null;
  const nearTol = Math.max(50, Math.abs(tgt) * 0.05);
  for (let p = 0; p < pollCap; p++) {
    await sleep(pollStep); settleMs += pollStep;
    const s = await client.evaluate(`(()=>{const g=[...document.querySelectorAll('.k-grid')][${idx}]; const c=g.querySelector('.k-grid-content-virtual')||g.querySelector('.k-grid-content'); return c?Math.round(c.scrollTop):null;})()`);
    last = s; readings.push(s);
    if (prev != null) {
      const delta = Math.abs((s || 0) - prev);
      drift = Math.max(drift, delta);
      if (arrived) postArrivalDrift = Math.max(postArrivalDrift, delta); // oscillation after first reaching target
      if (Math.abs((s || 0) - prev) <= 2) { stableHits++; if (stableHits >= 2) break; } else stableHits = 0;
    }
    if (!arrived && Math.abs((s || 0) - tgt) <= nearTol) { arrived = true; arrivedMs = settleMs; }
    prev = s;
  }
  return { requested: tgt, settled: last, settleMs, drift, postArrivalDrift, arrivedMs, readings };
}

// Wheel + seek scroll test on a grid; quantifies smoothness vs jumping and virtualization health.
async function scrollTest(client, idx, opts = {}) {
  const geo = await client.evaluate(`(()=>{const g=[...document.querySelectorAll('.k-grid')][${idx}]; if(!g)return null; const c=g.querySelector('.k-grid-content-virtual')||g.querySelector('.k-grid-content')||g; const r=c.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height)};})()`);
  if (!geo) return { ok: false, reason: "no-grid" };
  // reset to top and let the async scroller settle so the wheel phase starts clean
  const resetSettle = await settleScroll(client, idx, 0);
  const base = await client.evaluate(sampleExpr(idx));

  // --- wheel phase: emulate real mouse-wheel ticks ---
  const ticks = opts.ticks || 30, delta = opts.delta || 800, stepMs = opts.stepMs || 110;
  const wheel = [];
  for (let i = 0; i < ticks; i++) {
    await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: geo.x, y: geo.y, deltaX: 0, deltaY: delta });
    await sleep(stepMs);
    wheel.push(await client.evaluate(sampleExpr(idx)));
  }
  let reversals = 0, jumps = 0, stalls = 0, maxTbody = base.tbodyRows || 0, maxHeap = base.heapMB || 0, maxDom = base.domNodes || 0;
  for (let i = 1; i < wheel.length; i++) {
    const a = wheel[i - 1], b = wheel[i];
    if (b.scrollTop != null && a.scrollTop != null) {
      const d = b.scrollTop - a.scrollTop;
      const atBottom = a.maxScroll != null && a.scrollTop >= a.maxScroll - 2;
      if (d < -2) reversals++;                       // scrolled backward unexpectedly
      else if (d === 0 && !atBottom) stalls++;        // no movement though not at bottom
      else if (d > delta * 4) jumps++;                // moved far more than one tick implies
    }
    maxTbody = Math.max(maxTbody, b.tbodyRows || 0);
    maxHeap = Math.max(maxHeap, b.heapMB || 0);
    maxDom = Math.max(maxDom, b.domNodes || 0);
  }
  // first-job monotonic advance: as we scroll down the top rendered Job index should generally increase
  const firstJobs = wheel.map((w) => w.firstJob).filter(Boolean);
  const distinctFirstJobs = new Set(firstJobs).size;

  // --- seek phase: jump scrollTop to fractions; poll until settled (Kendo applies async) ---
  const fracs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const seek = [];
  for (const f of fracs) {
    const target = Math.round((base.maxScroll || 0) * f);
    const st = await settleScroll(client, idx, target);
    const s = await client.evaluate(sampleExpr(idx));
    s.frac = f; s.requested = st.requested; s.settleMs = st.settleMs; s.settleDrift = st.drift;
    s.postArrivalDrift = st.postArrivalDrift; s.arrivedMs = st.arrivedMs;
    s.offBy = (s.scrollTop != null) ? Math.round(s.scrollTop - st.requested) : null;
    seek.push(s);
  }
  const blankSeeks = seek.filter((s) => !s.firstJob || (s.tbodyRows || 0) === 0).length;
  // honored: actual scrollTop close to requested fraction target
  let seekHonored = 0;
  for (const s of seek) {
    if (s.maxScroll == null) continue;
    const want = Math.round(s.maxScroll * s.frac);
    if (Math.abs((s.scrollTop || 0) - want) <= Math.max(40, s.clientH ? s.clientH * 0.5 : 40)) seekHonored++;
  }

  const allSamples = [base, ...wheel, ...seek];
  const inViewVals = allSamples.map((s) => s.rowsInView || 0);
  const verdicts = {
    minRowsInView: Math.min(...inViewVals),
    maxRowsInView: Math.max(...inViewVals),
    maxTopGapPx: Math.max(...allSamples.map((s) => Math.abs(s.topGapPx || 0))),
    viewportBlankSometimes: inViewVals.some((v) => v === 0),
    viewportAlignedAlways: inViewVals.every((v) => v > 0),
    wheelReversals: reversals,
    wheelJumps: jumps,
    wheelStalls: stalls,
    distinctTopRowsDuringWheel: distinctFirstJobs,
    maxTbodyRows: maxTbody,
    virtualizationIntact: maxTbody < (opts.virtualCeiling || 500),
    maxHeapMB: maxHeap,
    maxDomNodes: maxDom,
    blankSeeks,
    seekHonored,
    seekTotal: fracs.length,
    smoothScroll: reversals === 0 && jumps === 0 && stalls <= 2 && distinctFirstJobs >= Math.min(ticks, 6),
    resetSettleMs: resetSettle.settleMs,
    resetSettleDrift: resetSettle.drift,
    maxSeekSettleMs: Math.max(...seek.map((s) => s.settleMs || 0)),
    maxSeekSettleDrift: Math.max(...seek.map((s) => s.settleDrift || 0)),
    maxSeekPostArrivalDrift: Math.max(...seek.map((s) => s.postArrivalDrift || 0)),
    smoothSeek: Math.max(...seek.map((s) => s.postArrivalDrift || 0)) < (opts.jumpTol || ((base.clientH || 700) * 2)),
  };
  return { ok: true, gridIndex: idx, geo, base, resetSettle, verdicts, wheel, seek };
}

// Polls page/grid state after a heavy action (e.g. OK with many rows). Early-exits when settled.
async function monitorLoad(client, seconds = 90, idx = 0) {
  const series = [];
  for (let i = 0; i < seconds; i++) {
    const s = await client.evaluate(`(()=>{
      const norm=(s)=>String(s||'').trim().replace(/[ \\t\\r\\n]+/g,' ');
      const grids=[...document.querySelectorAll('.k-grid')];
      const g=grids[${idx}]; const tb=g?g.querySelector('tbody'):null;
      const panel=document.querySelector('ep-base-sliding-panel');
      const panelOpen=panel?(()=>{const r=panel.getBoundingClientRect();return r.width>0&&r.height>0;})():false;
      const loading=!!document.querySelector('.ep-loading-progress, .ep-busy, ep-loading-bar, .k-loading-mask, .ep-loading-bar');
      const h=(window.performance&&performance.memory)?+(performance.memory.usedJSHeapSize/1048576).toFixed(0):null;
      const st=document.querySelector('.erp-panelcard-grid-banner-status');
      return {gridCount:grids.length, mainRows:tb?tb.children.length:null, panelOpen, loading, heapMB:h, dom:document.getElementsByTagName('*').length, banner:st?norm(st.textContent):null};
    })()`);
    s.t = i;
    series.push(s);
    // early exit: panel closed and main grid populated and not loading (2 consecutive)
    if (!s.panelOpen && (s.mainRows || 0) > 1 && !s.loading && i > 1) {
      const prev = series[series.length - 2];
      if (prev && !prev.panelOpen && (prev.mainRows || 0) > 1) break;
    }
    await sleep(1000);
  }
  return series;
}

async function screenshot(client, label) {
  await client.send("Page.enable").catch(() => {});
  const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = `${OUT}/${label}.png`;
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  return path;
}

export async function connect() {
  const target = await findTarget(BROWSER, PAGE_ID);
  const client = new CdpClient(target);
  await client.connect();
  return client;
}
export { clickText, clickAtElement, pressKey, bannerStatus, downloadAll, scrollTest, settleScroll, sampleExpr, screenshot, monitorLoad, sleep, SCAN, METRIC_SOURCE };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const client = await connect();
  let out;
  switch (cmd) {
    case "scan": out = await client.evaluate(SCAN); break;
    case "metric": out = await client.evaluate(METRIC_SOURCE); break;
    case "shot": out = { saved: await screenshot(client, rest[0] || "shot") }; break;
    case "eval": out = await client.evaluate(rest[0]); break;
    case "evalfile": out = await client.evaluate(readFileSync(rest[0], "utf8")); break;
    case "click-sel": out = await clickAtElement(client, rest[0], Number(rest[1] || 0)); break;
    case "click-text": out = await clickText(client, rest[0]); break;
    case "key": out = await pressKey(client, rest[0] || "Escape"); break;
    case "banner": out = await bannerStatus(client); break;
    case "monitor": out = await monitorLoad(client, Number(rest[0] || 90), Number(rest[1] || 0)); break;
    case "download-all": out = await downloadAll(client, { maxIter: Number(rest[0] || 100) }); break;
    case "scroll-test": {
      const idx = Number(rest[0] ?? 1);
      const label = rest[1] || `grid${idx}`;
      const full = await scrollTest(client, idx, {});
      if (full.ok) {
        writeFileSync(`${OUT}/scroll-${label}.json`, JSON.stringify(full, null, 2));
        out = {
          gridIndex: full.gridIndex, base: full.base, verdicts: full.verdicts,
          wheelHead: full.wheel.slice(0, 3), wheelTail: full.wheel.slice(-2),
          seek: full.seek.map((s) => ({ frac: s.frac, requested: s.requested, scrollTop: s.scrollTop, offBy: s.offBy, settleMs: s.settleMs, tbodyRows: s.tbodyRows, firstJob: s.firstJob, lastJob: s.lastJob })),
          savedFull: `${OUT}/scroll-${label}.json`,
        };
      } else out = full;
      break;
    }
    default: out = { error: `unknown cmd: ${cmd}` };
  }
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  client.close();
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("FATAL", e && e.stack ? e.stack : e); process.exit(1); });
}
