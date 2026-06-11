// Live validation of the header-wrap + auto-fit interaction against a real Kinetic grid on CDP 9100.
// Targets the Order Tracker "Lines" panel-card grid by its visible headers. It injects the current local
// sources into the page with storage flags enabled, forces a fit, then asserts the UI/UX contract:
// headers are centered regardless of body alignment, labels wrap only at word boundaries, and narrow labels
// such as "UOM" plus two-word labels such as "Renewal Number" are not cut into partial words.
//
// Usage: node verify/header-wrap-live-harness.mjs --page-id <id> [--port 9100]
//        (find the page id via: curl -s localhost:9100/json/list)

import fs from "node:fs";
import path from "node:path";
import { CdpClient, findTarget, listPageTargets } from "./cdp-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
function flag(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const PORT = Number(flag("--port", "9100"));
const BROWSER = `http://localhost:${PORT}`;
let PAGE_ID = flag("--page-id", null);

const headerWrapSource = fs.readFileSync(path.join(root, "src", "grid-header-wrap.js"), "utf8");
const autofitSource = fs.readFileSync(path.join(root, "src", "grid-autofit.js"), "utf8");

const MEASURE = `(()=>{
  const text=(el)=>String((el&&el.textContent)||"").replace(/\\s+/g," ").trim();
  const px=(v)=>{const n=parseFloat(v);return Number.isFinite(n)?n:0;};
  const grids=[...document.querySelectorAll(".k-grid")].filter((grid)=>{
    const r=grid.getBoundingClientRect();
    if(r.width<=0||r.height<=0) return false;
    const headers=[...grid.querySelectorAll(".k-grid-header thead th")].map(text);
    return headers.includes("UOM")&&headers.includes("Renewal Number")&&headers.includes("Order Quantity");
  });
  const grid=grids[0];
  if(!grid) return {error:"no visible Lines grid"};
  const ths=[...grid.querySelectorAll(".k-grid-header thead th")];
  const cols=[...(grid.querySelector(".k-grid-header table colgroup")?.querySelectorAll("col")||[])];
  const content=grid.querySelector(".k-grid-content-virtual,.k-grid-content.k-virtual-content,.k-grid-content");
  const rows=[...(content?.querySelectorAll("tbody tr")||[])].filter((r)=>!/(k-grid-norecords|k-grouping-row|k-group-footer|k-detail-row)/.test(r.className)).slice(0,8);
  const wanted=["Line","Open","UOM","Order Quantity","Doc Unit Price","Renewal Number","Lock Line Quantity"];
  const canvas=document.createElement("canvas");
  const ctx=canvas.getContext("2d");
  const headers={};
  for(const label of wanted){
    const idx=ths.findIndex((th)=>text(th)===label);
    if(idx<0){ headers[label]={missing:true}; continue; }
    const th=ths[idx];
    const title=th.querySelector(".ep-grid-cell-text")||th.querySelector(".ep-grid-hdr")||th.querySelector(".k-column-title")||th.querySelector(".k-link")||th;
    const link=th.querySelector(".k-link")||title;
    const td=rows.find((r)=>r.children[idx])?.children[idx]||null;
    const cs=getComputedStyle(title);
    const linkCs=getComputedStyle(link);
    const tdcs=td?getComputedStyle(td):null;
    const lh=px(cs.lineHeight)||((px(cs.fontSize)||14)*1.2);
    ctx.font=[cs.fontStyle,cs.fontWeight,cs.fontSize,cs.fontFamily].join(" ");
    const linkRect=link.getBoundingClientRect();
    const contentWidth=linkRect.width-px(linkCs.paddingLeft)-px(linkCs.paddingRight);
    const words=label.split(/\\s+/).filter(Boolean).map((word)=>({word, width:+ctx.measureText(word).width.toFixed(2)}));
    headers[label]={
      idx,
      textAlign:cs.textAlign,
      thTextAlign:getComputedStyle(th).textAlign,
      dataTextAlign:tdcs?tdcs.textAlign:null,
      whiteSpace:cs.whiteSpace,
      overflowWrap:cs.overflowWrap,
      wordBreak:cs.wordBreak,
      colWidth:px(cols[idx]?.style.width),
      contentWidth:+contentWidth.toFixed(2),
      titleHeight:+title.getBoundingClientRect().height.toFixed(2),
      lineHeight:+lh.toFixed(2),
      titleLines:Math.max(1,Math.round(title.getBoundingClientRect().height/lh)),
      words,
      allWordsFit:words.every((item)=>item.width<=contentWidth+0.75),
      samples:rows.map((r)=>text(r.children[idx])).filter(Boolean).slice(0,5)
    };
  }
  return {
    page:{title:document.title, href:location.href},
    grid:{headerCount:ths.length,rowCount:rows.length,width:Math.round(grid.getBoundingClientRect().width)},
    markers:{
      headerWrap:document.documentElement.dataset.kineticGridHeaderWrap||null,
      autofit:document.documentElement.dataset.kineticGridAutofit||null
    },
    headers
  };
})()`;

const STUB_AND_INSTALL = `(()=>{
  try{
    const flags={
      gridHeaderWrapEnabled:true,
      gridAutoSizeEnabled:true,
      gridAutoFitDensity:0.5,
      customHostPatterns:[]
    };
    window.__HW_FLAGS__=flags;
    window.chrome=window.chrome||{};
    window.chrome.storage={
      local:{ get:(keys,cb)=>cb(Object.assign({},window.__HW_FLAGS__)) },
      onChanged:{ addListener:()=>{}, removeListener:()=>{} }
    };
    if(window.__KINETIC_GRID_HEADER_WRAP___RUNTIME?.uninstall) window.__KINETIC_GRID_HEADER_WRAP___RUNTIME.uninstall();
    if(window.__KINETIC_GRID_AUTOFIT___RUNTIME?.uninstall) window.__KINETIC_GRID_AUTOFIT___RUNTIME.uninstall();
    (0,eval)(${JSON.stringify(headerWrapSource)});
    (0,eval)(${JSON.stringify(autofitSource)});
    if(window.__KINETIC_GRID_AUTOFIT___RUNTIME?.fitNow) window.__KINETIC_GRID_AUTOFIT___RUNTIME.fitNow();
    if(window.__KINETIC_GRID_HEADER_WRAP___RUNTIME?.scanNow) window.__KINETIC_GRID_HEADER_WRAP___RUNTIME.scanNow();
    return {
      headerWrapInstalled:!!window.__KINETIC_GRID_HEADER_WRAP___RUNTIME,
      autofitInstalled:!!window.__KINETIC_GRID_AUTOFIT___RUNTIME
    };
  }catch(e){ return {error:String(e)}; }
})()`;

const UNINSTALL = `(()=>{
  const out={};
  try{ if(window.__KINETIC_GRID_AUTOFIT___RUNTIME?.uninstall){ window.__KINETIC_GRID_AUTOFIT___RUNTIME.uninstall(); out.autofit=true; } }catch(e){ out.autofitError=String(e); }
  try{ if(window.__KINETIC_GRID_HEADER_WRAP___RUNTIME?.uninstall){ window.__KINETIC_GRID_HEADER_WRAP___RUNTIME.uninstall(); out.headerWrap=true; } }catch(e){ out.headerWrapError=String(e); }
  return out;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, pass, checks) {
  checks.push([label, pass === true]);
}

async function main() {
  if (!PAGE_ID) {
    const pages = await listPageTargets(BROWSER);
    const orderTracker = pages.find((p) => /Order Tracker|EQMT2040|OrderNum=5413/i.test((p.title || "") + (p.url || "")));
    if (!orderTracker) { throw new Error("No Order Tracker page target; pass --page-id"); }
    PAGE_ID = orderTracker.id;
  }

  const c = new CdpClient(await findTarget(BROWSER, PAGE_ID));
  await c.connect();
  try {
    const before = await c.evaluate(MEASURE);
    console.log("BEFORE:", JSON.stringify(before));
    if (before.error) { throw new Error("baseline: " + before.error); }

    const inst = await c.evaluate(STUB_AND_INSTALL);
    console.log("INSTALL:", JSON.stringify(inst));
    if (inst.error) { throw new Error("install: " + inst.error); }

    await sleep(1300);
    const after = await c.evaluate(MEASURE);
    console.log("AFTER:", JSON.stringify(after));

    const checks = [];
    const h = after.headers || {};
    for (const label of ["Line", "Open", "UOM", "Order Quantity", "Doc Unit Price", "Renewal Number", "Lock Line Quantity"]) {
      check(label + " header centered", h[label]?.textAlign === "center" && h[label]?.thTextAlign === "center", checks);
      check(label + " does not use arbitrary word breaking", h[label]?.overflowWrap !== "anywhere" && h[label]?.wordBreak === "normal", checks);
      check(label + " whole words fit", h[label]?.allWordsFit === true, checks);
    }
    check("UOM stays one line", h.UOM?.titleLines <= 1, checks);
    check("Renewal Number uses at most two word-boundary lines", h["Renewal Number"]?.titleLines <= 2, checks);
    check("Doc Unit Price uses at most three word-boundary lines", h["Doc Unit Price"]?.titleLines <= 3, checks);
    check("numeric body alignment remains right", h.Line?.dataTextAlign === "right" && h["Order Quantity"]?.dataTextAlign === "right" && h["Renewal Number"]?.dataTextAlign === "right", checks);
    check("text body alignment remains start", h.UOM?.dataTextAlign === "start", checks);
    check("markers show active header-wrap + autofit", /"active":true/.test(after.markers?.headerWrap || "") && /"active":true/.test(after.markers?.autofit || ""), checks);

    let ok = true;
    console.log("\\n--- CHECKS ---");
    for (const [label, pass] of checks) {
      console.log((pass ? "PASS " : "FAIL ") + label);
      if (!pass) ok = false;
    }
    console.log("\\nSummary: UOM " + before.headers.UOM.colWidth + "px/" + before.headers.UOM.titleLines
      + " lines -> " + h.UOM.colWidth + "px/" + h.UOM.titleLines + " lines; Renewal Number "
      + before.headers["Renewal Number"].colWidth + "px/" + before.headers["Renewal Number"].titleLines
      + " lines -> " + h["Renewal Number"].colWidth + "px/" + h["Renewal Number"].titleLines + " lines");
    console.log(ok ? "\\nOVERALL PASS" : "\\nOVERALL FAIL");
    process.exitCode = ok ? 0 : 1;
  } finally {
    const reverted = await c.evaluate(UNINSTALL);
    console.log("UNINSTALL:", JSON.stringify(reverted));
    c.close();
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
