#!/usr/bin/env node
// render-assets.mjs — Chrome Web Store visual assets for the Kinetic Grid Grouping Fix.
// Renders crisp PNGs at exact pixel sizes via headless Google Chrome (no image deps).
//
// Outputs:
//   icons/icon{16,32,48,128}.png                  (in-package toolbar icon — polished)
//   dist/store-assets/store-icon-128.png          (store listing icon)
//   dist/store-assets/screenshot-1-hero.png       (1280x800)
//   dist/store-assets/screenshot-2-interface.png  (1280x800 — real popup, Advanced EXPANDED)
//   dist/store-assets/screenshot-3-results.png    (1280x800 — before/after metrics)
//   dist/store-assets/screenshot-4-howitworks.png (1280x800)
//   dist/store-assets/screenshot-5-trust.png      (1280x800)
//   dist/store-assets/popup-interface.png         (near-native popup, Advanced EXPANDED)
//   dist/store-assets/promo-small-440x280.png     (small promo tile)
//   dist/store-assets/promo-marquee-1400x560.png  (marquee promo tile)
//
// Run: npm run store-assets   (or: node store/render-assets.mjs)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // extension root
const WORKSPACE = resolve(ROOT, "..", "..");
const ICONS = join(ROOT, "icons");
const OUT = join(ROOT, "dist", "store-assets");
const TMP = join(WORKSPACE, ".tmp", "store-render");
const PAGES = join(TMP, "pages");
const PROFILE = join(TMP, "profile");
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

rmSync(PROFILE, { recursive: true, force: true }); // clear any stale SingletonLock
for (const d of [OUT, PAGES, PROFILE]) {
  mkdirSync(d, { recursive: true });
}
let profileCounter = 0; // fresh profile per render avoids Chrome's process-singleton lock

// ---------------------------------------------------------------- design tokens
const C = {
  blue: "#1f6feb",
  blue2: "#1654bd",
  blueBright: "#3d86ff",
  green: "#2ea043",
  ink: "#10131a",
  muted: "#5a6169",
  line: "#e4e7eb",
  bad: "#cf3b2e",
  warnBg: "#fff6e5",
  warnInk: "#7a4d00",
  warnLine: "#ffe2ad"
};
const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// The grid + check mark, scaled to its viewBox. Reused by icon and promo art.
function iconSvg() {
  return `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.blueBright}"/>
      <stop offset="1" stop-color="${C.blue2}"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="27" fill="url(#bg)"/>
  <rect x="6" y="6" width="116" height="58" rx="27" fill="#ffffff" opacity="0.10"/>
  <g fill="#ffffff">
    <rect x="29" y="33" width="70" height="12" rx="4"/>
    <rect x="29" y="58" width="70" height="12" rx="4"/>
    <rect x="29" y="83" width="44" height="12" rx="4"/>
  </g>
  <rect x="57" y="29" width="6" height="50" rx="3" fill="#ffffff" opacity="0.5"/>
  <circle cx="95" cy="95" r="23" fill="${C.green}" stroke="#ffffff" stroke-width="6"/>
  <path d="M84 95 l8 8 l14 -16" fill="none" stroke="#ffffff" stroke-width="6.5"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

// ---------------------------------------------------------- faithful popup card
// Component CSS copied from popup/popup.css, scoped under .kgf so it can sit on any
// canvas (popup.css styles html/body globally, which would fight the canvas).
const POPUP_CSS = `
.kgf{--blue:${C.blue};--green:${C.green};--red:#b42318;--ink:#1a1d21;--muted:#5a6169;
  --line:#e4e7eb;--bg:#ffffff;--track-off:#c8ccd2;width:320px;padding:14px 16px 12px;
  background:#fff;color:var(--ink);font-family:${FONT};font-size:13px;border-radius:12px;
  box-shadow:0 24px 60px rgba(16,32,64,.28),0 2px 8px rgba(16,32,64,.12);}
.kgf *{box-sizing:border-box;}
.kgf .hdr{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.kgf .hdr-icon{flex:0 0 auto;border-radius:6px;}
.kgf .hdr-text h1{margin:0;font-size:14px;font-weight:650;line-height:1.2;}
.kgf .sub{margin:2px 0 0;font-size:11px;color:var(--muted);line-height:1.3;}
.kgf .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
  border:1px solid var(--line);border-radius:8px;background:#f7f8fa;}
.kgf .toggle-label{display:flex;flex-direction:column;gap:2px;}
.kgf .toggle-title{font-weight:600;}
.kgf .toggle-state{font-size:11px;font-weight:600;}
.kgf .state-on{color:var(--green);}
.kgf .switch{appearance:none;border:0;padding:0;background:transparent;cursor:pointer;}
.kgf .switch-track{display:inline-block;width:44px;height:24px;border-radius:999px;
  background:var(--track-off);position:relative;}
.kgf .switch-thumb{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);}
.kgf .switch[aria-checked="true"] .switch-track{background:var(--blue);}
.kgf .switch[aria-checked="true"] .switch-thumb{transform:translateX(20px);}
.kgf .hint{margin:10px 0 0;padding:8px 10px;font-size:11.5px;color:#7a4d00;background:#fff6e5;
  border:1px solid #ffe2ad;border-radius:6px;}
.kgf .status{margin-top:14px;}
.kgf .status h2{margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;color:var(--muted);}
.kgf .status-grid{display:grid;grid-template-columns:70px 1fr;gap:3px 8px;margin:0;}
.kgf .status-grid dt{color:var(--muted);}
.kgf .status-grid dd{margin:0;font-variant-numeric:tabular-nums;word-break:break-all;}
.kgf .ok{color:var(--green);font-weight:600;}
.kgf .advanced{margin-top:14px;}
.kgf .advanced > summary{cursor:pointer;font-size:11px;color:var(--muted);list-style:none;
  font-weight:600;}
.kgf .advanced > summary::before{content:"\\25be";margin-right:5px;}
.kgf .adv-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:8px;}
.kgf .adv-row label{color:var(--muted);}
.kgf .adv-row select{flex:0 0 auto;font:inherit;padding:3px 6px;border:1px solid var(--line);
  border-radius:6px;background:#fff;}
.kgf .adv-note{margin:6px 0 0;font-size:10.5px;color:var(--muted);line-height:1.35;}
.kgf .ftr{display:flex;align-items:center;margin-top:14px;padding-top:8px;border-top:1px solid var(--line);
  font-size:10.5px;color:var(--muted);}
.kgf .spacer{flex:1 1 auto;}
.kgf .default-note{font-weight:600;}
`;

// ON state, status filled, Advanced EXPANDED (open). data: URI icon keeps it self-contained.
function popupCard(iconDataUri) {
  return `<div class="kgf">
  <header class="hdr">
    <img class="hdr-icon" src="${iconDataUri}" alt="" width="28" height="28" />
    <div class="hdr-text">
      <h1>Kinetic Grid Grouping Fix</h1>
      <p class="sub">Prevents the group/ungroup virtualization leak in Kinetic grids.</p>
    </div>
  </header>
  <section class="toggle-row">
    <div class="toggle-label">
      <span class="toggle-title">Patch enabled</span>
      <span class="toggle-state state-on">On</span>
    </div>
    <span class="switch" role="switch" aria-checked="true" aria-label="Enable Kinetic grid grouping fix">
      <span class="switch-track"><span class="switch-thumb"></span></span>
    </span>
  </section>
  <p class="hint">Reload the Kinetic tab to apply the change.</p>
  <section class="status">
    <h2>Status on this tab</h2>
    <dl class="status-grid">
      <dt>Patched</dt><dd class="ok">Yes</dd>
      <dt>Mode</dt><dd>directive-text</dd>
      <dt>Bundle</dt><dd>437c1f00e1f99d77</dd>
      <dt>Anchors</dt><dd>rebind-hook</dd>
    </dl>
  </section>
  <details class="advanced" open>
    <summary>Advanced</summary>
    <div class="adv-row">
      <label for="mode">Mechanism</label>
      <select id="mode"><option>Debugger (in-place rewrite)</option></select>
    </div>
    <p class="adv-note">Chrome shows an &ldquo;extension is debugging this browser&rdquo; banner while ON. This is expected; it disappears when you turn the patch OFF.</p>
    <div class="adv-row">
      <label for="scope">Scope</label>
      <select id="scope"><option>Kinetic main.js only</option></select>
    </div>
  </details>
  <footer class="ftr">
    <span class="version">v3.0.0</span>
    <span class="spacer"></span>
    <span class="default-note">Default: OFF</span>
  </footer>
</div>`;
}

// data: URI of the 128 icon so the popup card + promo art are self-contained.
function iconDataUri() {
  const svg = iconSvg();
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// ---------------------------------------------------------------- render engine
function doc(w, h, inner, extraCss = "", transparent = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${w}px;height:${h}px;overflow:hidden;${transparent ? "" : "background:#fff;"}font-family:${FONT};color:${C.ink};-webkit-font-smoothing:antialiased;}
${extraCss}
</style></head><body>${inner}</body></html>`;
}

// Chrome 148 new-headless writes the PNG but does not reliably self-exit, so we
// spawn it, poll until the screenshot file appears and its size stops growing,
// then kill it. Fast (kills as soon as the PNG is stable) and hang-proof.
function render(name, w, h, html, transparent = false) {
  const htmlPath = join(PAGES, name.replace(/\//g, "_") + ".html");
  const outPath = name.includes("/") ? join(ROOT, name) : join(OUT, name + ".png");
  writeFileSync(htmlPath, html);
  rmSync(outPath, { force: true });
  const prof = join(PROFILE, "p" + profileCounter++);
  mkdirSync(prof, { recursive: true });
  const args = [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--user-data-dir=" + prof,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=" + w + "," + h,
    "--screenshot=" + outPath
  ];
  if (transparent) {
    args.push("--default-background-color=00000000");
  }
  args.push("file://" + htmlPath);

  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, args, { stdio: "ignore" });
    let settled = false;
    let lastSize = -1;
    let stable = 0;
    let waited = 0;
    const tick = setInterval(() => {
      waited += 150;
      if (existsSync(outPath)) {
        const size = statSync(outPath).size;
        stable = size > 0 && size === lastSize ? stable + 1 : 0;
        lastSize = size;
        if (stable >= 2) {
          finish(null);
          return;
        }
      }
      if (waited >= 25000) {
        finish(new Error("render timeout: " + outPath));
      }
    }, 150);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      if (err) reject(err);
      else if (!existsSync(outPath)) reject(new Error("no png: " + outPath));
      else resolve(outPath);
    }
    child.on("error", finish);
  });
}

// ---------------------------------------------------------------- shared pieces
function wordmark(size = 26) {
  return `<span style="display:inline-flex;align-items:center;gap:12px;">
    <span style="width:${size + 14}px;height:${size + 14}px;display:inline-block;">${iconSvg()}</span>
    <span style="font-size:${size}px;font-weight:750;letter-spacing:-.01em;">Kinetic Grid Grouping Fix</span>
  </span>`;
}

const HERO_BG = `background:radial-gradient(1200px 600px at 78% -10%, ${C.blueBright} 0%, ${C.blue} 38%, ${C.blue2} 100%);`;

// metric bar: label, before, after, fill fraction (after/before visual)
function metric(label, before, after, afterFrac) {
  return `<div class="metric">
    <div class="m-label">${label}</div>
    <div class="m-bars">
      <div class="m-row"><span class="m-tag bad">before</span><div class="m-bar"><div class="m-fill bad" style="width:100%"></div><span class="m-val">${before}</span></div></div>
      <div class="m-row"><span class="m-tag good">after</span><div class="m-bar"><div class="m-fill good" style="width:${afterFrac}%"></div><span class="m-val">${after}</span></div></div>
    </div>
  </div>`;
}

const METRIC_CSS = `
.metric{margin:0 0 26px;}
.m-label{font-size:21px;font-weight:700;margin-bottom:10px;color:${C.ink};}
.m-row{display:flex;align-items:center;gap:12px;margin:7px 0;}
.m-tag{width:58px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}
.m-tag.bad{color:${C.bad};}
.m-tag.good{color:${C.green};}
.m-bar{position:relative;flex:1 1 auto;height:30px;background:#f1f3f6;border-radius:8px;overflow:hidden;}
.m-fill{position:absolute;top:0;left:0;height:100%;border-radius:8px;}
.m-fill.bad{background:linear-gradient(90deg,#f0857a,${C.bad});}
.m-fill.good{background:linear-gradient(90deg,#54c178,${C.green});}
.m-val{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-weight:750;font-size:15px;
  color:#10131a;font-variant-numeric:tabular-nums;}
.m-fill.bad ~ .m-val{color:#fff;}
`;

// ---------------------------------------------------------------- 1: icons
console.log("rendering icons...");
for (const size of [16, 32, 48, 128]) {
  await render(
    "icons/icon" + size + ".png",
    size,
    size,
    doc(size, size, `<div style="width:${size}px;height:${size}px;">${iconSvg()}</div>`,
      `svg{display:block;width:100%;height:100%;}`, true),
    true
  );
}
// store listing icon (128, identical mark)
await render("store-icon-128", 128, 128,
  doc(128, 128, `<div style="width:128px;height:128px;">${iconSvg()}</div>`,
    `svg{display:block;width:100%;height:100%;}`, true), true);

// ---------------------------------------------------------------- 2: hero (1280x800)
console.log("rendering screenshots...");
await render("screenshot-1-hero", 1280, 800, doc(1280, 800, `
  <div class="hero">
    <div class="hero-copy">
      <div class="eyebrow">Epicor Kinetic &middot; Chrome extension</div>
      <h1>Stop the grid<br/>grouping memory leak.</h1>
      <p>Grouping then ungrouping a large Kinetic grid stops windowing and renders every row &mdash; ballooning a tab past <b>2&nbsp;GB</b>. This fixes it in place.</p>
      <div class="chips">
        <span class="chip">2,037 MB &rarr; <b>248 MB</b></span>
        <span class="chip">469k &rarr; <b>8,971</b> nodes</span>
        <span class="chip">Default <b>OFF</b></span>
      </div>
    </div>
    <div class="hero-art">${popupCard(iconDataUri())}</div>
  </div>`,
  POPUP_CSS + `
  .hero{${HERO_BG}width:1280px;height:800px;display:flex;align-items:center;gap:40px;padding:0 80px;color:#fff;}
  .hero-copy{flex:1 1 0;max-width:600px;}
  .eyebrow{font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.85;margin-bottom:18px;}
  .hero h1{font-size:64px;line-height:1.04;font-weight:800;letter-spacing:-.02em;margin-bottom:22px;}
  .hero p{font-size:23px;line-height:1.5;opacity:.95;max-width:560px;}
  .hero p b{font-weight:800;}
  .chips{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px;}
  .chip{background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);border-radius:999px;
    padding:9px 18px;font-size:17px;font-weight:600;}
  .chip b{font-weight:800;}
  .hero-art{flex:0 0 auto;transform:scale(1.18);transform-origin:center right;}
  `));

// ---------------------------------------------------------------- 3: interface (popup, Advanced expanded)
await render("screenshot-2-interface", 1280, 800, doc(1280, 800, `
  <div class="wrap">
    <div class="left">
      <div class="eyebrow">The toolbar popup</div>
      <h2>One switch.<br/>Clear status.</h2>
      <ul class="feat">
        <li><b>Default OFF</b> &mdash; nothing changes until you flip it on.</li>
        <li><b>Reload to apply</b> &mdash; the patch acts at the next page load.</li>
        <li><b>Live status</b> &mdash; see exactly whether the fix is active on the tab.</li>
        <li><b>Advanced</b> &mdash; choose the delivery mechanism &amp; scope.</li>
      </ul>
    </div>
    <div class="right">${popupCard(iconDataUri())}</div>
  </div>`,
  POPUP_CSS + `
  .wrap{width:1280px;height:800px;display:flex;align-items:center;gap:60px;padding:0 90px;
    background:linear-gradient(180deg,#f4f7fc,#e9eef7);}
  .left{flex:1 1 0;}
  .eyebrow{font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.blue};margin-bottom:14px;}
  .left h2{font-size:56px;line-height:1.05;font-weight:800;letter-spacing:-.02em;color:${C.ink};margin-bottom:26px;}
  .feat{list-style:none;font-size:21px;line-height:1.55;color:#2b313a;}
  .feat li{position:relative;padding-left:34px;margin:14px 0;}
  .feat li::before{content:"";position:absolute;left:0;top:9px;width:18px;height:18px;border-radius:50%;
    background:${C.green};box-shadow:0 0 0 4px rgba(46,160,67,.18);}
  .feat b{font-weight:750;}
  .right{flex:0 0 auto;transform:scale(1.32);transform-origin:center;}
  `));

// ---------------------------------------------------------------- 4: results
await render("screenshot-3-results", 1280, 800, doc(1280, 800, `
  <div class="page">
    <div class="head">${wordmark(24)}<span class="caption">After group &rarr; ungroup on a 4,466-row grid</span></div>
    <div class="body">
      <h2>Real numbers, same grid.</h2>
      ${metric("Tab heap", "2,037 MB", "248 MB", 12)}
      ${metric("Attached DOM nodes", "469,501", "8,971", 8)}
      ${metric("Rows rendered into one &lt;tbody&gt;", "4,466", "80", 4)}
      <p class="foot">Live-validated, stable across repeated group/ungroup cycles.</p>
    </div>
  </div>`,
  METRIC_CSS + `
  .page{width:1280px;height:800px;display:flex;flex-direction:column;}
  .head{height:84px;background:${C.blue};color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 48px;}
  .head svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.2));}
  .caption{font-size:16px;font-weight:600;opacity:.92;}
  .body{flex:1 1 auto;padding:46px 80px 0;}
  .body h2{font-size:40px;font-weight:800;letter-spacing:-.02em;margin-bottom:34px;color:${C.ink};}
  .foot{font-size:18px;color:${C.muted};margin-top:6px;}
  `));

// ---------------------------------------------------------------- 5: how it works
await render("screenshot-4-howitworks", 1280, 800, doc(1280, 800, `
  <div class="page">
    <div class="head">${wordmark(24)}<span class="caption">Three steps</span></div>
    <div class="body">
      <h2>How to use it</h2>
      <div class="steps">
        <div class="step"><div class="num">1</div><h3>Flip the toggle ON</h3><p>Click the toolbar icon and turn on the switch. It is OFF by default.</p></div>
        <div class="step"><div class="num">2</div><h3>Reload the Kinetic tab</h3><p>The patch is applied as <code>main.js</code> loads on the next refresh.</p></div>
        <div class="step"><div class="num">3</div><h3>Group &amp; ungroup freely</h3><p>The grid keeps its compact virtual window &mdash; no more render-all balloon.</p></div>
      </div>
      <p class="note"><b>Note:</b> in the default mode Chrome shows an &ldquo;extension is debugging this browser&rdquo; banner while the fix is ON &mdash; expected, and gone the moment you turn it OFF.</p>
    </div>
  </div>`,
  `
  .page{width:1280px;height:800px;display:flex;flex-direction:column;}
  .head{height:84px;background:${C.blue};color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 48px;}
  .caption{font-size:16px;font-weight:600;opacity:.92;}
  .body{flex:1 1 auto;padding:46px 70px 0;}
  .body h2{font-size:40px;font-weight:800;letter-spacing:-.02em;margin-bottom:38px;color:${C.ink};}
  .steps{display:flex;gap:26px;}
  .step{flex:1 1 0;background:#f6f8fc;border:1px solid ${C.line};border-radius:16px;padding:30px 28px;}
  .num{width:50px;height:50px;border-radius:50%;background:${C.blue};color:#fff;font-size:26px;font-weight:800;
    display:flex;align-items:center;justify-content:center;margin-bottom:20px;}
  .step h3{font-size:24px;font-weight:750;margin-bottom:10px;color:${C.ink};}
  .step p{font-size:18px;line-height:1.5;color:#3a414b;}
  .step code{background:#e6ebf3;border-radius:5px;padding:1px 6px;font-size:16px;}
  .note{margin-top:34px;background:${C.warnBg};border:1px solid ${C.warnLine};color:${C.warnInk};
    border-radius:12px;padding:18px 22px;font-size:18px;line-height:1.5;}
  `));

// ---------------------------------------------------------------- 6: trust / scope
await render("screenshot-5-trust", 1280, 800, doc(1280, 800, `
  <div class="page">
    <div class="head">${wordmark(24)}<span class="caption">Safe by design</span></div>
    <div class="body">
      <h2>You stay in control</h2>
      <div class="cards">
        <div class="card"><div class="ic">${shieldGlyph()}</div><h3>Runs only on epicorsaas.com</h3><p>No other site is touched. One narrow host scope.</p></div>
        <div class="card"><div class="ic">${lockGlyph()}</div><h3>Collects no data</h3><p>No analytics, no tracking, nothing leaves your device.</p></div>
        <div class="card"><div class="ic">${powerGlyph()}</div><h3>Off until you say so</h3><p>Disabled by default; one click to enable or disable.</p></div>
        <div class="card"><div class="ic">${codeGlyph()}</div><h3>Targeted, in-place patch</h3><p>Restores the grid&rsquo;s own virtual window &mdash; no remote code.</p></div>
      </div>
      <p class="disc">Independent, unofficial fix. Not affiliated with or endorsed by Epicor. &ldquo;Epicor&rdquo; and &ldquo;Kinetic&rdquo; are trademarks of Epicor Software Corporation.</p>
    </div>
  </div>`,
  `
  .page{width:1280px;height:800px;display:flex;flex-direction:column;}
  .head{height:84px;background:${C.blue};color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 48px;}
  .caption{font-size:16px;font-weight:600;opacity:.92;}
  .body{flex:1 1 auto;padding:44px 80px 0;}
  .body h2{font-size:40px;font-weight:800;letter-spacing:-.02em;margin-bottom:32px;color:${C.ink};}
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:22px;}
  .card{background:#f6f8fc;border:1px solid ${C.line};border-radius:16px;padding:26px 28px;display:flex;flex-direction:column;}
  .ic{width:46px;height:46px;margin-bottom:16px;color:${C.blue};}
  .ic svg{width:46px;height:46px;}
  .card h3{font-size:23px;font-weight:750;margin-bottom:7px;color:${C.ink};}
  .card p{font-size:17px;line-height:1.45;color:#3a414b;}
  .disc{margin-top:26px;font-size:14px;color:${C.muted};line-height:1.5;}
  `));

// ---------------------------------------------------------------- 7: native popup (Advanced expanded)
await render("popup-interface", 420, 640, doc(420, 640,
  `<div class="stage">${popupCard(iconDataUri())}</div>`,
  POPUP_CSS + `
  body{background:linear-gradient(180deg,#eef2f9,#dfe6f2);}
  .stage{width:420px;height:640px;display:flex;align-items:center;justify-content:center;}
  `));

// ---------------------------------------------------------------- 8: small promo 440x280
await render("promo-small-440x280", 440, 280, doc(440, 280, `
  <div class="tile">
    <div style="width:96px;height:96px;margin-bottom:18px;">${iconSvg()}</div>
    <div class="name">Kinetic Grid Grouping Fix</div>
    <div class="tag">Stops the group/ungroup memory leak.</div>
  </div>`,
  `
  .tile{width:440px;height:280px;${HERO_BG}color:#fff;display:flex;flex-direction:column;
    align-items:center;justify-content:center;text-align:center;padding:0 28px;}
  .name{font-size:25px;font-weight:800;letter-spacing:-.01em;}
  .tag{font-size:16px;opacity:.92;margin-top:8px;}
  `));

// ---------------------------------------------------------------- 9: marquee 1400x560
await render("promo-marquee-1400x560", 1400, 560, doc(1400, 560, `
  <div class="mq">
    <div class="mq-left">
      <div style="width:150px;height:150px;">${iconSvg()}</div>
    </div>
    <div class="mq-right">
      <h1>Kinetic Grid Grouping Fix</h1>
      <p>Stops the Epicor Kinetic grid group/ungroup memory leak &mdash; in place.</p>
      <div class="chips">
        <span class="chip">2&nbsp;GB &rarr; <b>248&nbsp;MB</b></span>
        <span class="chip">469k &rarr; <b>8,971</b> nodes</span>
        <span class="chip">Default <b>OFF</b></span>
      </div>
    </div>
  </div>`,
  `
  .mq{width:1400px;height:560px;${HERO_BG}color:#fff;display:flex;align-items:center;gap:56px;padding:0 90px;}
  .mq-left{flex:0 0 auto;filter:drop-shadow(0 20px 40px rgba(0,0,0,.25));}
  .mq-right{flex:1 1 0;}
  .mq h1{font-size:62px;font-weight:800;letter-spacing:-.02em;line-height:1.02;}
  .mq p{font-size:27px;opacity:.95;margin-top:18px;max-width:900px;line-height:1.4;}
  .chips{display:flex;flex-wrap:wrap;gap:14px;margin-top:30px;}
  .chip{background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3);border-radius:999px;
    padding:10px 20px;font-size:19px;font-weight:600;}
  .chip b{font-weight:800;}
  `));

// ---------------------------------------------------------------- glyphs (inline)
function shieldGlyph() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>`;
}
function lockGlyph() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
}
function powerGlyph() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>`;
}
function codeGlyph() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7l-5 5 5 5"/><path d="M15 7l5 5-5 5"/></svg>`;
}

console.log("done. assets in " + OUT + " and " + ICONS);
