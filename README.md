# Kinetic Grid Grouping Fix Extension

Manifest V3 Chrome extension that monkeypatches the Kinetic `main.js` **in place** to fix three
virtual-scroll grid defects:

1. **Group/ungroup memory leak** — grouping then ungrouping a large virtual grid balloons into a
   render-all state (~2 GB / 469k-DOM-node leak on a 4,466-row Job Entry grid).
2. **Blank grid after bulk load** *(v3.1)* — after a large Search → Download Records → Get More →
   Select All → OK load (~25k rows), the grid renders **blank** even though the rows are in the DOM
   and the toolbar is enabled, until you manually scroll.
3. **Checkbox glyph styling drift after group/ungroup** *(v3.2)* — boolean columns render as Material
   Design Icon font glyphs (☐/☑); after a group→ungroup re-render some re-materialized cells come back
   with drifted presentation (different size, mis-alignment, or color) so the column's checkboxes look
   inconsistent. A scoped stylesheet pins them back to the column's own canonical look.

All three fixes ship together, default OFF, behind the same toggle.

## What it fixes (and how — v3, binding-directive layer)

Multi-field grouping legitimately expands the grid's `view` to **every** row (the grouped display
shows all rows). The bug is that on **ungroup** the windowed `view` is never restored: the Kinetic
grid-binding directive's `rebind()` recomputes `view` with a `state.take` that grouping nulled and
ungroup never restores, so `view` = the whole dataset and ~4,466 rows materialize into one `<tbody>`.

The fix hooks the binding directive's `rebind()` (anchor `rebind(){this.checkForPrismSkip()`): when
`state.group.length === 0` and `state.take` is pathological (missing / far above the natural window),
it restores `state.take` (+ `grid.pageSize`) to the **captured natural window** (~80) *before* the
original rebind recomputes `view`. Two things make it work:

1. **Right layer.** The content-directive `createScroller` (an earlier attempt) fires 0× on ungroup;
   `rebind()` fires on the ungroup edge and `state.take` is the lever.
2. **Right store.** The binding directive AND the Kendo grid component are *recreated* when grouping
   changes, so a per-instance capture is lost. The natural window is stashed on the Kinetic wrapper
   `bd.epGrid`, which **survives** the recreation.

**Live-validated (full scale):** all 4,466 rows loaded, multi-field group→ungroup → post-ungroup
`tbodyRows` **80** (vs 4,466), DOM **8,971** (vs 469,501), heap **248 MB** (vs 2,037 MB), stable
across cycles; mounts at 80 (no window shrink / scroll-snap regression); scroll-to-bottom populates
with no snap. Evidence: `.output/chrome-plugin-grid-fix/v3-validation-success.md`.

- **Default OFF.** `chrome.storage.local.gridFixEnabled` initializes to `false`; a freshly installed
  extension does nothing until you flip the toggle.
- No-debug default (`gridFixMode: "runtime"`): the MAIN-world `document_start` runtime hook runs with
  no `debugger` permission and no Chrome debugging banner. It installs early webpack traps and
  best-effort wraps the binding-directive class. On builds where the binding directive lives only
  inside the parser-loaded `main.*.js` closure, runtime mode reports `trapInstalled: true` but
  `applied: false` / `prototypeWrapped: false`.
- Validated text-rewrite mechanism (`gridFixMode: "debugger"`): an opt-in `chrome.debugger` permission
  grant enables CDP `Fetch` response-stage interception of Kinetic `main.*.js`, served via
  `patchBundleText` (one-line hook call injected at the `rebind` anchor + the hook def appended).
  This remains the only extension-only path that reliably rewrites the parser-loaded bundle before it
  executes.
- Feasibility boundary: in normal Manifest V3, `declarativeNetRequest` can block/redirect/modify
  headers but cannot transform arbitrary response bodies, and blocking `webRequest` is unavailable to
  non-policy extensions. Without `debugger` (or an external proxy/server-side delivery), the extension
  can support runtime/DOM/CSS fixes but cannot honestly claim a pre-execution `main.js` text rewrite.
- When applied, the page exposes `window.__KINETIC_GRID_FIX__ = { version, enabled, applied, mode,
  bundleHash, anchorsHit, corrections, trapInstalled, prototypeWrapped }` (`corrections` increments
  each time the fix re-windows). Treat `applied: true` as meaningful only when
  `prototypeWrapped: true` or mode is `rebind-text`. The blank-fix adds `blankFixArmed` /
  `blankCorrections`; the checkbox standardizer adds `checkboxStyleFixArmed` / `checkboxCanonical` /
  `checkboxStyleReasserts` to the same shared marker.

## What it also fixes — blank grid after bulk load (v3.1, alignment watchdog)

Live-diagnosed 2026-06-04 on Job Status Maintenance (JCGO3033, SaaS950 Education) with 25,276 jobs.
Kendo positions virtual rows with `transform: translateY(N)` on `.k-grid-table`, where `N` tracks the
scroller's `scrollTop` (`N ≈ skip × rowHeight`). After a large bulk load the table is left translated
for a non-zero data window (`N ≈ 10,000px`) while `scrollTop` is `0` and **no scroll event fires to
reconcile them**, so the rendered rows sit ~10,000px below the viewport — the grid looks empty. It
persists (observed >90 s) until the user scrolls. It is intermittent / race-dependent.

The fix is a DOM-geometry **alignment watchdog** (`src/grid-blank-fix.js`). On grid mutations + a
1.5 s safety scan it checks each virtual grid; if rendered rows exist but **none intersect the
viewport while `scrollTop` is near the top** (the bug signature), it performs a **page-crossing scroll
nudge then returns to top**, which forces Kendo to recompute `translateY` in sync with `scrollTop`.
Proven live: a sub-page nudge does **not** trigger Kendo's `translateY` rewrite, but a page-crossing
`scrollTop` change does — so far-jump-then-0 realigns. It is **near-top-only** (never fights a user who
has scrolled away) and a no-op on healthy grids (validated: 0 false corrections at top or mid-scroll).

Delivered both ways, alongside the group/ungroup fix: M1 (debugger) appends the watchdog's
self-installing source to the patched bundle; M2 (runtime) installs it at `document_start`. When armed
the page marker carries `blankFixArmed: true` and `blankCorrections` (increments on each realign).
Live before/after: a populated grid forced blank (80 rows rendered, 0 in viewport) → watchdog →
38 rows in view at the top. Harness: `verify/grid-live-harness.mjs` (workflow automation + scroll
smoothness test + blank detector) and `verify/blank-fix-live-repro.mjs` (re-trigger + auto-fix check).

**v1.1 hardening (extension v3.1.1)** — live-validated on the JCGO3033 grid: (1) a **stability gate**
re-confirms the blank ~70ms before acting, so a single transient frame during fast scrolling is never
corrected; (2) **symmetric detection** catches rows rendered above *or* below the viewport at the top
(v1.0 caught only below); (3) a faster 800ms safety interval plus a **relevance-filtered**
MutationObserver (re-checks only on grid-related DOM churn, not page-wide); (4) an **in-flight guard**
so concurrent triggers don't stack corrections on one grid; (5) richer diagnostics — the per-correction
`log()` records the `trigger` source and signed `topGap`, `lastCorrection()` exposes the latest, and the
shared marker gains `lastCorrectionAt` / `lastTopGap` for field debugging.

## What it also fixes — checkbox glyph styling after group/ungroup (v3.2, style standardizer)

Reported 2026-06-04; confirmed live on Job Status Maintenance (JCGO3033, SaaS950 Education). Kinetic
boolean columns (To Firm, Firm, Locked, Mass Print, Engineered, Released, …) do **not** render as
`<input type=checkbox>` — each is a Material Design Icon **font glyph**:
`<span class="ep-grid-cell-check mdi mdi-checkbox-{blank,marked}-outline">`, sized and positioned
purely by CSS (font-size on the span; the icon drawn via `::before`). The canonical (healthy)
presentation is uniform: `font-size:24px; line-height:12px; display:flex; justify-content:center;
align-items:center; color:#000`. After a multi-field group→ungroup the grid re-materializes its rows
during the render-all window, and some re-rendered glyph cells come back with **drifted presentation**
(different font-size, mis-alignment, or color) — so the column's checkboxes look inconsistent even
though every *value* is still a correct glyph.

The fix (`src/grid-checkbox-style-fix.js`) injects **one scoped stylesheet** that pins the boolean
glyph's size + alignment (and the **enabled**-cell color) to the column's own canonical value, appended
last in `<head>` with `!important` so it wins the cascade over whatever class a drifted cell lost/gained.
It is:

- **Adaptive / theme-safe** — the canonical values are **sampled from the majority** of currently
  rendered glyphs (modal font-size/line-height/justify/align/color), not hardcoded, so a compact-density
  or re-themed grid pins to *its own* healthy values. The captured `24px` defaults are only the
  bootstrap fallback used before any glyph exists (at `document_start`).
- **Disabled-state-preserving** — color is pinned only for cells **outside** `.ep-row-rule-disabled`
  (`:not()` selector), so the value-driven greying of disabled booleans is never overridden.
- **A visual no-op on healthy grids** — on a consistent grid the pin equals the existing values, so
  nothing moves; it only takes visible effect on a cell that actually drifted. **Live-validated**: on
  the real 480-glyph JCGO3033 grid the standardizer sampled the true canonical and reported **0
  deviations / 0 visual change**; a glyph forced to 40px was pulled back to 24px by the pin.
- **Preventive** — injected CSS applies to every matching glyph the instant it enters the DOM, so a
  re-rendered cell can never *display* drifted before being corrected.

Delivered both ways alongside the other fixes: M1 (debugger) appends the standardizer's self-installing
source to the patched bundle; M2 (runtime) installs it at `document_start`. When armed the shared marker
carries `checkboxStyleFixArmed: true`, `checkboxCanonical` (the sampled values), and
`checkboxStyleReasserts`. A relevance-filtered MutationObserver + a light safety interval re-assert the
stylesheet if a full SPA re-mount strips it.

## Theming controls — disable theming + custom colors (v3.3, ISOLATED CSS-variable injector)

v3.3 adds **two independent, additive theming toggles** that are completely separate from the three grid
fixes above — different delivery path, no debugger, **no tab reload**, **no new required permissions**:

1. **Disable theming** — neutralizes a themed tenant so it renders in the stock (un-themed) palette.
2. **Override colors** — per-family color pickers that recolor the Kinetic UI to colors you choose.
3. **Surface / neutral tint** (v3.6) — one picker blends a hue into Kinetic's grayscale ramp
   (borders + surfaces) while preserving each shade's lightness, so contrast stays intact.

**The finding that drives it** (captured live 2026-06-05 on two tenants): Epicor Kinetic theming is
delivered as **exactly 25 CSS custom properties** set in an inline `style` attribute on the `<html>`
element, in **10 color families** (`--primary`, `--secondary`, `--tertiary`, `--accent`, `--base`,
`--interactive`, `--focus`, `--error`, `--success`, `--warning` + their lightness variants). A later
CDP-9100 palette census found the base stylesheet declares **two more `--success` tints**
(`--success-4566`, `--success-3682`) that are *not* in the inline attribute (so the tenant never rotates
them) — the full theme namespace is **27 tokens** / 10 families. The **stock** value of every token is
identical across tenants; a "themed" tenant simply **hue-rotates** the brand families (e.g. Education's
primary is hue 0 = maroon; stock is hue 192 = teal). An `!important` `html{ --token:value }` rule injected
as a `<style>` beats the inline (non-`!important`) theme value, and removing the `<style>` restores the
page **exactly**. So:

- **Disable** = pin all 27 tokens to their stock values with `!important` → the themed tenant looks
  un-themed (the 2 base-only success tints are pinned as a harmless no-op).
- **Override** = pin the chosen families to user-derived values. From the picked hex the base token takes
  the exact color and each lightness variant keeps its **own designed lightness** (picked hue+saturation),
  preserving the contrast ramp Epicor designed — so changing only the hue reproduces native-style theming.
- **Both on** = stock everywhere, your colors where you set them (later-wins source order).
- **Both off** = the `<style>` is removed entirely and the page reverts to its native appearance.

**Surface / neutral tint (v3.6).** A CDP-9100 full-screen census established that the 10 family pickers
already control **100% of the brand/chromatic color** on screen; the only colors they don't touch are the
7-token `--neutral-*` grayscale ramp (`hsl(0,0%,L)`: borders/dividers/surfaces ≈ 87% of on-screen gray,
never tenant-rotated). The neutral-tint control pins those 7 to `hsl(pickedHue, pickedSat, stockL)` — it
injects a hue + saturation but **keeps each token's stock lightness**, so contrast ratios (which depend on
lightness) are unchanged and text/surfaces stay legible. Deep text grays (Kendo/Bootstrap tokens) are left
alone on purpose. Default-OFF, same ISOLATED live-injection path, no new required permissions. Live-proven 7/7
(`.tmp/palette-audit/verify-neutral-tint.mjs`): the border gray recolors `rgb(204,204,204)`→tinted while
brand colors stay put, exact revert.

**Delivery (`src/theme-control.js`).** A declarative **ISOLATED-world** content script
(`run_at: document_start`, scoped to the already-granted `*://*.epicorsaas.com/*` host, plus any
user-granted custom hosts) reads the three `chrome.storage.local` keys (`themeDisableEnabled`,
`colorOverrideEnabled`, `colorOverrideValues`),
builds the `<style id="kinetic-theme-control">`, and subscribes to `chrome.storage.onChanged` so a
color-picker drag **previews live on already-open tabs with no reload**. It runs ISOLATED (not MAIN)
world — it never touches page JS, only the shared DOM — which is a **lower-risk surface than the grid
fix's debugger path**. Both toggles **default OFF**; when both are off the injector is fully inert (no
`<style>`, status marker `active:false`). The injector publishes a status marker to
`document.documentElement.dataset.kineticThemeControl` (and the ISOLATED `window`) that the popup reads
in MAIN world (`{ version, active, themeDisabled, colorOverride, families, tokensPinned, reasserts }`).

**Live-validated** (`verify/theme-live-harness.mjs`, CDP-9100 against the themed Education and un-themed
Third tenants): disable flips all 25 computed `:root` tokens to stock and the home-card tiles visibly
shift maroon→teal (`rgb(100,2,2)`→`rgb(2,80,100)`); an override of `--primary` to `#1a73e8` turns the
tiles blue (`rgb(28,116,233)`); turning everything off reverts every token **exactly** to baseline; and
the un-themed Third tenant already matches stock — proving "disable on Education ⇒ looks like Third".
Evidence: [`.output/chrome-plugin-grid-fix/theme-verification.md`](.output/chrome-plugin-grid-fix/theme-verification.md).

## Wrap column headers (v3.20, ISOLATED header-wrap + narrow injector)

v3.20 adds a **"Wrap column headers"** toggle. By default a Kinetic grid header forces each title onto one
line (`white-space:nowrap` + ellipsis) with `table-layout:fixed` columns, so a column whose **data is just a
checkbox** is still pinned wide enough to fit its whole title on one line — e.g. on **ABC Code Maintenance**
the *Exclude from Cycle Count* column is **229px** while its content needs ~20px. The toggle flips header
titles to `white-space:normal` so multi-word titles **stack vertically at word boundaries**, centers the
header label independently from the column's body-data alignment, and **narrows** each column whose width was
dictated only by its header down to the width of its **widest word** plus the live Kendo header inset. That
keeps dense labels such as *UOM* on one line and labels such as *Renewal Number* on two intact-word lines
instead of cutting whole words apart.

Same delivery class as auto-size/theming: a separate **ISOLATED-world** content script
(`src/grid-header-wrap.js`, `run_at: document_start`), **no debugger, no `main.js` rewrite, no tab reload, no
new permission**, applied **live**, default **OFF**. Turning it off removes the wrap CSS and restores the
native widths.

**Race-free coordination with Auto-size columns.** Both features write `<col>` widths, so exactly one owns
them: when **Auto-size columns** is ON, header-wrap injects only the wrap CSS and **defers** sizing to
`grid-autofit.js`, which (seeing the header-wrap flag) measures each header by its **widest word** and narrows
it as part of its own fit while preserving enough header text area for that word. When auto-size is OFF,
header-wrap owns the shrink-only narrowing itself.

**Live-validated** (CDP 9100, Education SaaS950, Order Tracker Lines grid, 2026-06-10; harness
`verify/header-wrap-live-harness.mjs`): headers center regardless of text/numeric/boolean body alignment;
*UOM* remains a single intact word; *Renewal Number* wraps to intact words; and numeric/text body alignment is
unchanged. Earlier ABC Code Maintenance validation remains the wide-header compaction proof case.

## UI density / padding sliders (v3.5, ISOLATED per-component-family override injector)

v3.5 adds **per-component-family density sliders** — fine-tune the size of each Kinetic component type
independently: grids, buttons, text fields, dropdowns, tabs, and field labels. Same delivery class as
theming: a separate **ISOLATED-world** content script (`src/padding-control.js`, `run_at:
document_start`, already-granted or user-approved host), **no debugger, no `main.js` rewrite, no tab
reload, no new required permission**, applied **live**, default **OFF**.

v3.30 adds a default-off **"Text area auto-size"** switch in the same Padding & spacing panel. When enabled,
Kinetic `ep-text-area` fields remove the native vertical resize handle and the runtime writes reversible
inline heights from each textarea's measured `scrollHeight`; turning it off clears those inline heights and
restores Kinetic's native `resize: vertical` behavior.

v3.31 adds a default-off **"Full width mode"** switch in that same live injector. It removes the Kinetic
`ep-view.page-content.header-width` cap and stretches the fixed page header, panel cards, panel-card grids,
and their AppStudio container wrappers to the full available splitter-pane width. It is intended for
ultrawide monitors and high-density layouts: the page can consume the unused right-side viewport without
requiring a reload or changing any data.

**Why per-family overrides, not token scaling** (captured live 2026-06-05; `.tmp/padding-iter/`). The
earlier v3.4 approach scaled Kendo's `:root` design tokens (`--kendo-spacing-*`, `--kendo-font-size-*`).
That was proven a **near-no-op on real Epicor forms**: spacing 1.8× and font 1.4× left the Order Entry
form visually identical — only pure-Kendo buttons/toolbar moved. The reason (found by scanning the 21k
live CSS rules): **Epicor's `ep-*`/`erp-*` Angular layer overrides Kendo's token-driven sizing with
hardcoded px, much of it `!important`** (e.g. `.ep-dropdown … .k-input-inner{height:40px}`,
`.ep-short-control …{height:24px!important}`, `ep-… .k-grid td{height:22px;padding:0 7px}`), and px
`font-size` throughout. So the mechanism that actually reaches Epicor's chrome is a small set of
**`!important` rules matched to each family's real selectors**, with values scaled by that family's
user factor.

Each family exposes the dimensions that genuinely move it (default 1.0 = stock; a slider at 100% emits
**no rule at all** ⇒ a true no-op):

- **Grids** — Row height · **Cell padding** · Text size. *Row height* is the information-density lever:
  the real row-height floor in Epicor grids is **not** the `<td>` (its padding is 0) but the cell wrapper
  (`.ep-grid .k-grid tr td .ep-grid-cell { line-height: 22px }`, spec 0,3,1) **and the tallest cell** —
  often a fixed-height `<input>` in a select/edit column. So the lever scales the cell line-height/height
  **and** in-cell inputs (at ≥ that specificity, `!important`) alongside `td/th` height, which actually
  compacts the row (live: 25→15px, ~75 rows visible vs ~46). It **coexists with Kendo virtual scrolling**:
  because the override is present at `document_start`, Kendo *measures* the already-compact row and sizes
  its height-container + `translateY` to match — verified by scrolling deep with real wheel events, rows
  fill the viewport at every depth with **no blank tail** (post-render CSS or `zoom` would desync the
  spacer; only the pre-measure path is consistent). *Cell padding* scales the horizontal inset of data
  cells (`.ep-grid-cell`) and headers (`.k-header`) by the same factor (stock 7px) so columns pack tighter
  while staying aligned.
- **Buttons** — Padding (`.k-button` padding-block) · Text size.
- **Text fields** — Field height (text/numeric `.k-input-inner` height + the floating-label padding-top;
  scoped away from dropdowns) · Text size.
- **Dropdowns** — Field height (combo/list/picker; **coordinated** with `.k-input-value-text`
  height + padding-top so the bigger value never clips its `overflow:hidden` box) · Text size.
- **Tabs** — Padding (`.k-tabstrip-items .k-link`) · Text size.
- **Field labels** — Text size.

**Emission mechanism.** A `<style id="kinetic-padding-control">` whose `textContent` is `buildCss(state)`
— plain `!important` rules like `.k-grid td.k-table-td { height: 38.4px !important; }`. (A text `<style>`
is sufficient here: unlike the theme tokens there are no fractional custom-prop *names*.) It wins via
`!important` + last-in-`<head>` source order and **reverts exactly** when the element is removed; it never
touches the inline `<html style>` attribute (where tenant theme tokens live), so an Angular theme-rewrite
can't wipe it and it can't disturb theme-control. The pure engine is `buildCss(state) → CSS text`; the
component-family `FAMILIES` table (each dim → selectors + per-prop stock `base`) is the single source of truth
(mirrored in `popup.js`, lockstep-asserted by the tests). Storage keys: **`componentDensity`**
(`{family→{dim→factor}}`; only non-default entries stored, empty families pruned ⇒ empty map is fully
inert), **`textAreaAutoSizeEnabled`**, and **`fullWidthEnabled`**. Marker: `document.documentElement.dataset.kineticPaddingControl`
= `{version, active, adjustments:[{family,dim,factor}], ruleCount, reasserts, textAreaAutoSize,
textAreaAutoSizeCount, fullWidth}`.

**Live-validated** (`verify/padding-live-harness.mjs`, CDP-9100): the mechanism proof injects the engine
CSS under a distinct probe id and asserts each family's representative rendered element moves the right
way and reverts exactly; `--e2e` performs an **Unpacked Extension Reload**
(`chrome.developerPrivate.reload`), reloads Education, waits for the SPA to paint, drives
`componentDensity` from the popup page, and asserts per-family movement + marker through the **real**
content-script path, then OFF → exact revert (OVERALL PASS 2026-06-05).
Evidence: [`.output/chrome-plugin-grid-fix/padding-verification.json`](.output/chrome-plugin-grid-fix/padding-verification.json).

## Popup (toggle slider)

Click the toolbar icon: an accessible **on/off switch** bound to `gridFixEnabled` (visually OFF by
default), a **"Reload the Kinetic tab to apply"** hint, a live **status readout** for the active tab
read from `window.__KINETIC_GRID_FIX__`, and an **Advanced** section (Debugger vs Runtime mechanism +
scope). Below the grid fix are the two **theming switches** (Disable theming, Override colors) with a
revealable **10-family color-picker panel** (per-row Reset + "Reset all to stock") and a live theming
status line — these apply **immediately, with no reload hint**, because the content script reacts to
storage changes live. Below them a **"Padding & spacing"** disclosure (like the Advanced link) reveals
the **Full width mode** and **Text area auto-size** switches plus **per-component-family density sliders**,
grouped by family (Grids / Buttons / Text fields / Dropdowns / Tabs / Field labels) with live `%` readouts,
per-row Reset, "Reset all to default", and a live spacing status line — also applied live with no reload. The toolbar **badge** reads `ON` (green)
when any feature is active and the title enumerates which (e.g. `grid fix on (reload Kinetic tab to
apply) · theming off · custom colors · spacing adjusted`).
Icons: `node icons/make-icons.mjs`.

## Load Unpacked

1. Open `chrome://extensions`, enable Developer Mode.
2. Load unpacked → select `apps/kinetic-grid-fix-extension/`.
3. Flip the popup toggle ON and **reload the Kinetic tab** (runtime hooks and any debugger rewrite act
   at the next `main.js` load). Runtime mode is the no-debug default; selecting Debugger mode requests
   Chrome's optional debugger permission and shows the expected debugging banner while ON.
4. To support a non-`epicorsaas.com` Kinetic domain, open Advanced, add an exact host such as
   `tenant.example.com` or a wildcard such as `*.example.com`, approve Chrome's host-permission prompt,
   then reload matching tabs.

Reload the extension after manifest/service-worker/content-script changes.

## Packaging for the Chrome Web Store

```
npm run package   # check + 105 tests + build
# or just the build:
npm run build     # node scripts/build-store-zip.mjs
```

This emits, under `dist/` (gitignored):

- `unpacked/` — the loadable unpacked dir (chrome://extensions → Load unpacked).
- `kinetic-grid-grouping-fix-<version>.zip` — **upload this to the Chrome Web Store** (manifest.json
  sits at the archive root). The build is content-reproducible (fixed mtime + sorted entries) and
  contains only the 14 runtime files (incl. `src/theme-control.js`) — no tests, no `package.json`, no
  `patch-transform.js`. The build cross-checks every `content_scripts` entry against the file allowlist,
  so a declared content script can never be silently dropped from the package.
- `kinetic-grid-grouping-fix-<version>.zip.sha256` and `build-manifest.json` (per-file + zip hashes).

The build enforces the store's hard limits (manifest `description` ≤ 132 chars, `name` ≤ 75) and
refuses to ship the falsified provider transform. **Full submission guide** — listing copy,
single-purpose statement, per-permission justifications, privacy disclosures, the optional `debugger`
review-risk callout, visibility recommendation, and reviewer notes — is in
[`STORE_LISTING.md`](STORE_LISTING.md). Bump `version` in `manifest.json` for every re-upload.

## Reproduce / validate the fix

The leak only reproduces with the **whole dataset preloaded client-side**. The toolkit has a
first-class command for that iterable step:

```
dotnet run --project src/EpicorToolkit.App -- cdp grid-download-all --page-id <id> --port 9100
```

It enters preload mode (grid header download button) and **real-CDP-clicks** "Get More" until
"All N records loaded" (synthetic dispatched clicks do not register on that button). Then enable
grouping (grid vertical-dots → "Toggle Grouping") and run the efficacy gate:

```
node apps/kinetic-grid-fix-extension/verify/leak-cycle.mjs --page-id <id> --fields Job,Part,Rev --cycles 2 --gc
```

Gate: post-ungroup `tbodyRows ≈ 80` (vs ~4,466 unpatched). Recover a ballooned tab with a reload + GC.

## Version-drift runbook (when Kinetic rolls `main.js`)

The transform anchors on **preserved property names**, not the bundle hash or byte offsets, so it
survives rebuilds. To re-validate against a new `main.*.js`:

1. `npm test` (in this dir) — the unit suite includes real-bundle fixtures
   (`verify/fixtures/binding-slice-{437c1f00,a25a4062}.js`) that anchor the contract.
2. Confirm the anchor occurs **exactly once** in the new bundle:
   `rebind(){this.checkForPrismSkip()` (the transform refuses 0 or >1 matches and serves the bundle
   unchanged — fail-safe, the leak simply returns until refreshed). Refresh the fixtures from the new
   bundle if the property-level pattern changed, and re-run the live efficacy gate above.
3. The `rebind` override body (`this.checkForPrismSkip()||(this.customLoading?this.loader.query(
   this.epGrid,this.state):super.rebind())`) has been byte-identical across `437c1f00` and `a25a4062`.

## Tests

`npm test` runs the full unit suite (136 tests). Group/ungroup fix: the corrector against a faithful
binding-directive + recreation model, `patchBundleText` (idempotent / fail-safe / real-bundle
fixtures), the appended hook def standalone, and the M2 binding-class wrap. The service-worker M1
contract test (`verify/background-m1.test.mjs`) proves the debugger Fetch path fulfills with the
patched body. Blank-grid fix (`verify/grid-blank-fix.test.mjs`): the watchdog against a fake-DOM grid
that models Kendo's `translateY`-tracks-`scrollTop` response (detect + correct, no false positives at
top / mid-scroll / scrolled-away, self-contained `WATCHDOG_SOURCE`, bounded retries, the exact
`background.js` M1 combine of rebind-patch + watchdog-append, and the v1.1 cases — stability gate drops a
transient blank, symmetric above-viewport detection, and diagnostics/log fields). Checkbox standardizer
(`verify/grid-checkbox-style-fix.test.mjs`): the style fix against a fake-DOM grid that models
`getComputedStyle` — adaptive modal sampling (majority wins / theme-safe), the injected scoped CSS,
disabled-state-preserving color (`:not(.ep-row-rule-disabled)`), `diagnose()` deviation counting,
SPA-re-mount re-assert, document_start bootstrap-then-refine, idempotent/fail-safe/teardown, and the
three-way M1 combine of rebind-patch + blank-append + checkbox-append.

Theming controls (`verify/theme-control.test.mjs`): the pure color util (`hexToHsl`/`hslToHex`
round-trips, `hslStr`, `isValidHex`), the §4.2 derivation worked example + single-token/multi-variant
families + `literal-base`/`hue-only`/`hue-sat` modes, `stockBlock` (25 `!important` decls, one `html`
host), `buildCss` build order (disable / override / both-on later-wins / inert→`''`),
`validFamilies`/`countTokens`, and the fake-DOM runtime (live `storage.onChanged` apply+revert, the §4.4
marker shape, host gating, idempotent install/uninstall). `verify/manifest-shape.test.mjs` adds the
ISOLATED `content_scripts` entry shape + the **no-new-permissions** assertion;
`verify/popup-logic.test.mjs` covers the popup's pure theme helpers
(`nextOverrideValues`/`stockHex`/`themeStatusText`/`isThemeActive`); `verify/background-theme-coexist.test.mjs`
proves a theme-key change refreshes only the badge and **never** attaches the debugger or reloads a tab
(with a grid-key positive control). The live mechanism is verified by `verify/theme-live-harness.mjs`
(CDP-9100, above).

Density / padding sliders (`verify/padding-control.test.mjs`): the pure per-family engine (`FAMILIES`
integrity incl. each dim's selectors + per-prop `base`, the dropdown value-text anti-clip coordination,
text-fields scoped away from dropdowns, `clampFactor`/`isDefaultFactor`/`round2`, `buildCss` scaling +
FAMILIES ordering + inert/skip-at-default cases, `activeAdjustments`/`ruleCount`) and the fake-DOM runtime
that models the `<style>.textContent` applier (scaled `!important` CSS, the marker shape, host gating,
live `storage.onChanged` apply+revert, full-width mode, idempotent install/uninstall). `verify/popup-logic.test.mjs`
adds the popup's pure density helpers (nested `nextComponentDensity` RMW + empty-family pruning,
`countComponentAdjustments`, status helpers) and a **popup↔engine `FAMILIES` lockstep** assertion;
`verify/manifest-shape.test.mjs` asserts the second ISOLATED `content_scripts` entry; the
background coexist test proves a `componentDensity` change is **badge-only** (never attach/reload). The
live per-family movement + the **Unpacked Extension Reload** end-to-end path are verified by
`verify/padding-live-harness.mjs` (CDP-9100, above).
