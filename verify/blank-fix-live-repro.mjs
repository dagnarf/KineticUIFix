// Repro for the intermittent blank-grid bug. Clears, runs search->download->scroll-results->select-all->OK,
// captures broken main-grid internals (incl. table transform). Loops until it catches a blank. With the
// extension enabled (or src/grid-blank-fix.js injected), the watchdog auto-corrects each blank it catches
// (watch __KINETIC_GRID_BLANK_FIX__.corrections()).
//   node verify/blank-fix-live-repro.mjs [--batches N] [--scroll-results FRAC] [--tries K] [--label L]
import { connect, clickAtElement, clickText, downloadAll, settleScroll, sleep, screenshot } from "./grid-live-harness.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const batches = Number(arg("--batches", "100"));
const scrollResults = arg("--scroll-results", null); // fraction 0..1 to scroll results grid before OK
const tries = Number(arg("--tries", "1"));
const label = arg("--label", "retrigger");

const DIAG = `(()=>{
  const g=document.querySelectorAll('.k-grid')[0]; if(!g) return {err:'no-grid'};
  const c=g.querySelector('.k-grid-content-virtual')||g.querySelector('.k-grid-content'); const cr=c.getBoundingClientRect();
  const tw=g.querySelector('.k-grid-table-wrap'); const tbl=g.querySelector('.k-grid-table')||g.querySelector('table'); const tb=g.querySelector('tbody');
  const rows=tb?[...tb.children]:[];
  const inView=rows.filter(r=>{const rr=r.getBoundingClientRect();return rr.bottom>cr.top&&rr.top<cr.bottom;}).length;
  const fr=rows[0]?rows[0].getBoundingClientRect():null;
  const job=rows[0]?(()=>{for(const t of rows[0].querySelectorAll('td')){const x=(t.innerText||'').trim();if(x)return x;}return '';})():null;
  return {
    scrollTop:Math.round(c.scrollTop), maxScroll:Math.round(c.scrollHeight-c.clientHeight),
    renderedRows:rows.length, rowsInView:inView, topGapPx:fr?Math.round(fr.top-cr.top):null, firstRowTop:fr?Math.round(fr.top):null, firstJob:job,
    contentTop:Math.round(cr.top),
    tableWrapTransform:tw?getComputedStyle(tw).transform:null, tableWrapTop:tw?Math.round(tw.getBoundingClientRect().top):null,
    tableTransform:tbl?getComputedStyle(tbl).transform:null, tableTop:tbl?Math.round(tbl.getBoundingClientRect().top):null,
    blankDefect:(inView===0 && rows.length>1)
  };
})()`;

async function oneTry(client, n) {
  console.error(`[try ${n}] clear...`);
  await clickAtElement(client, "i.mdi-broom"); await sleep(1500);
  console.error(`[try ${n}] open search...`);
  await clickAtElement(client, "i.ep-search-icon.mdi-file-find"); await sleep(1500);
  await clickText(client, "Search"); await sleep(3000);
  console.error(`[try ${n}] download (<=${batches})...`);
  const dl = await downloadAll(client, { maxIter: batches });
  console.error(`[try ${n}] loaded ${dl.finalLoaded}`);
  if (scrollResults != null) {
    const ms = await client.evaluate(`(()=>{const c=[...document.querySelectorAll('.k-grid')][1].querySelector('.k-grid-content'); return c.scrollHeight-c.clientHeight;})()`);
    console.error(`[try ${n}] scroll results to frac ${scrollResults} (top ${Math.round(ms * Number(scrollResults))})...`);
    await settleScroll(client, 1, ms * Number(scrollResults));
  }
  console.error(`[try ${n}] select-all + OK...`);
  await clickAtElement(client, ".k-grid-header input[type=checkbox]", 0); await sleep(1000);
  await clickText(client, "Ok"); await sleep(6000);
  const diag = await client.evaluate(DIAG);
  return { loaded: dl.finalLoaded, diag };
}

async function main() {
  const client = await connect();
  let result = null;
  for (let n = 1; n <= tries; n++) {
    result = await oneTry(client, n);
    console.error(`[try ${n}] blankDefect=${result.diag.blankDefect} firstJob=${result.diag.firstJob} inView=${result.diag.rowsInView} tableWrapTransform=${result.diag.tableWrapTransform}`);
    if (result.diag.blankDefect) { console.error(`[try ${n}] CAUGHT BLANK`); break; }
  }
  await screenshot(client, label);
  console.log(JSON.stringify(result, null, 2));
  client.close();
}
main().catch((e) => { console.error("FATAL", e && e.stack ? e.stack : e); process.exit(1); });
