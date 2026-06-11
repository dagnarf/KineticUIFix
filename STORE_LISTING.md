# Chrome Web Store submission — Kinetic Grid Grouping Fix

Everything needed to upload `dist/kinetic-grid-grouping-fix-<version>.zip` to the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and pass
review. Build the artifact with `npm run build` (or `npm run package` to gate on tests first).

---

## 0. TL;DR — what to upload

| Field | Value |
|---|---|
| **Package to upload** | `dist/kinetic-grid-grouping-fix-3.6.0.zip` (manifest.json at archive root) |
| **Manifest** | V3, version `3.6.0` |
| **Required permissions** | `scripting`, `storage`, `tabs` |
| **Optional permissions** | `debugger` (only for validated in-place `main.js` rewrite) |
| **Host permissions** | `*://*.epicorsaas.com/*` |
| **Optional host permissions** | User-entered domains/subdomains (`*://*/*` manifest ceiling; exact origins requested at runtime) |
| **Data collected** | **None** |
| **Privacy policy / Homepage / Support URL** | https://epidebug.help/kineticbugfix (live) |
| **Recommended visibility** | **Unlisted** or **Private** (see §6) — not general-public |

> ⚠️ **Read §5 before you submit.** The optional `debugger` permission remains the biggest review risk.
> The default runtime mode works without it; the validated bundle rewrite requests it only when selected.

---

## 1. Listing copy

**Name** (≤45 recommended): `Kinetic Grid Grouping Fix`

**Summary / short description** (≤132 chars, taken from `manifest.description`):
> Fixes Kinetic grid bugs plus auto-size, full-width mode, theme controls, and density sliders. Default OFF.

**Category:** Developer Tools (or Productivity)

**Detailed description** (paste into the dashboard):

```
Kinetic Grid Grouping Fix repairs a memory leak in Epicor Kinetic (epicorsaas.com)
data grids. After you group a large grid by several columns and then ungroup it,
the grid stops windowing and re-renders every row into the page — on a ~4,400-row
grid that balloons the tab to ~2 GB of heap and ~470,000 DOM nodes, making the
browser sluggish or crashing the tab.

The extension applies a small, targeted patch to Kinetic's own grid code so that
ungrouping restores the normal virtual-scroll window. With the fix on, the same
group→ungroup cycle stays at ~80 rendered rows and a few hundred MB of heap.

It also fixes a second grid bug: after loading a large set of records into a grid
through the search dialog (Download Records → Get More → Select All → OK), the grid
can render blank — the rows are loaded but scrolled out of view — until you manually
scroll. The fix detects that misalignment and nudges the grid back into view
automatically, and never interferes with a grid you are actively scrolling.

And a third: in grids with checkbox (yes/no) columns, grouping then ungrouping can
leave some checkboxes rendered at a different size or alignment than the rest of the
column. The fix pins every checkbox in a column back to that column's own normal
look, so they stay consistent. On a correctly rendered grid it changes nothing.

THEMING CONTROLS (optional, also off by default)
Two extra toggles let you control the Kinetic color theme on epicorsaas.com or a
user-approved Kinetic host:
• Disable theming — render a custom-themed tenant in the neutral stock palette.
• Custom colors — pick your own color per theme family (links, accents, tiles, etc.).
These apply instantly with no tab reload and are fully reversible — turn them off and
the page returns exactly to its normal appearance. They work by overriding the page's
own CSS color variables and never change any data.

DENSITY / PADDING SLIDERS (optional, also off by default)
Sliders let you fine-tune how compact or roomy each Kinetic component type is on
epicorsaas.com or a user-approved Kinetic host — grids, buttons, text fields, dropdowns, tabs and field labels — each
with its own row-height/padding and text-size controls. They work by overriding the
page's own CSS for each component family, so you can (for example) make grid rows
tighter to see more data, or enlarge field text for readability. They apply instantly
with no tab reload; drag any slider back to 100% (or Reset) to restore the stock
spacing exactly. They never change any data.

HOW IT WORKS
• The fix is OFF by default. Nothing changes until you open the toolbar popup and
  flip the toggle on, then reload your Kinetic tab.
• It runs on epicorsaas.com by default. Other Kinetic domains are added only when
  the user enters a domain/subdomain and approves Chrome's host-permission prompt.
• It collects no data and sends nothing off your device.

NOTE ON THE DEBUGGER BANNER
The default runtime delivery mode does not require Chrome's debugger permission and
does not show a debugging banner. If you select the Debugger mechanism, Chrome asks
for the optional debugger permission and shows an "extension is debugging this browser"
banner while that mode is ON. That mode is the validated way to rewrite Kinetic's
script as it loads. Turn the grid fix off or switch back to Runtime mode and the
banner disappears.

This is an independent, unofficial fix and is not affiliated with or endorsed by
Epicor. "Epicor" and "Kinetic" are trademarks of Epicor Software Corporation.
```

**Visual assets — pre-generated** by `npm run store-assets` into `dist/store-assets/`
(headless-Chrome render of `store/render-assets.mjs`; re-run any time to refresh):

| Dashboard slot | File | Size |
|---|---|---|
| Store icon | `store-icon-128.png` | 128×128 |
| Screenshot 1 (hero) | `screenshot-1-hero.png` | 1280×800 |
| Screenshot 2 (interface, **Advanced expanded**) | `screenshot-2-interface.png` | 1280×800 |
| Screenshot 3 (before/after results) | `screenshot-3-results.png` | 1280×800 |
| Screenshot 4 (how it works) | `screenshot-4-howitworks.png` | 1280×800 |
| Screenshot 5 (safety/scope) | `screenshot-5-trust.png` | 1280×800 |
| Small promo tile | `promo-small-440x280.png` | 440×280 |
| Marquee promo tile | `promo-marquee-1400x560.png` | 1400×560 |
| Raw popup UI (Advanced expanded) | `popup-interface.png` | 420×640 |

Upload at least 1 screenshot (all 5 recommended) + the store icon. Promo tiles are optional but
improve placement. The in-package toolbar icons (`icons/icon*.png`) were refreshed to the same design.

**v3.3 theming screenshots (recommended additions):** the popup now has the two theming switches + the
10-family color-picker panel — re-run `npm run store-assets` to refresh the popup captures so they show
the theming controls. A compelling **before/after** of disable-theming on a themed tenant is already
captured live in `.tmp/theme-live/` (`education-baseline.png` = themed maroon UI vs
`education-disable-applied.png` = stock teal UI; plus `education-override-primary-applied.png` for custom
blue) — crop these to 1280×800 for a "disable theming" / "custom colors" screenshot pair.

**Promo / demo video (optional but STRONGLY recommended given `debugger` — see §5):** a short
YouTube clip showing the toggle, the banner, and the heap/DOM dropping after the fix. The numbers in
`screenshot-3-results.png` come from `.output/chrome-plugin-grid-fix/v3-validation-success.md`.

---

## 2. Single-purpose statement

The Chrome Web Store requires one clear purpose. Paste:

> This extension has a single purpose: client-side UI remediation for Epicor Kinetic (on
> epicorsaas.com). It fixes data-grid rendering defects — a memory leak after grouping then
> ungrouping a large grid, a blank grid after a large search-dialog load, and inconsistent
> checkbox-cell styling after group/ungroup — and lets the user adjust that same app's color
> theme (disable theming, or set custom colors). It does this entirely by adjusting the page's
> own grid code and CSS color variables; it stores no data, contacts no server, and runs on no
> other site.

---

## 3. Permission justifications

The dashboard requires a justification for **each** permission. Copy these into the matching boxes.

| Permission | Justification to paste |
|---|---|
| **debugger** (optional) | The validated rewrite mode must rewrite Epicor's content-hashed `main.*.js` bundle as it loads to insert a one-line hook at the grid's `rebind()` method. The Chrome `debugger` API's Fetch domain is the reliable way to intercept and rewrite that already-built, minified (Angular Ivy) script at response time on the live SaaS app, where the page's CSP and class minification make a page-world class wrap unreliable. The debugger permission is requested only when the user selects Debugger mode. Runtime mode remains available without this permission. |
| **scripting** | Register the page-world `document_start` runtime hook, register custom-host content scripts after a user grants a host, and read the in-page status markers (`window.__KINETIC_GRID_FIX__`, `dataset.kineticThemeControl`, `dataset.kineticPaddingControl`) from the active supported Kinetic tab so the popup can show whether fixes applied. |
| **storage** | Persist the user's settings (grid fix on/off, delivery mechanism, scope; user-approved custom host patterns; the theming settings; full-width mode; and the density/padding slider factors) in `chrome.storage.local`. Nothing is synced or transmitted. |
| **tabs** | Find open supported Kinetic tabs in order to reload them so runtime hooks / optional rewrite mode take effect on the next `main.js` load, react to navigation on those tabs, and read the active tab's URL in the popup to scope the status readout. Tab data is never transmitted. |
| **Host permission `*://*.epicorsaas.com/*`** | The extension operates on Epicor Kinetic SaaS, served from `*.epicorsaas.com`, by default. This host scope is required to register scoped scripts, run the theming/density content scripts, and query/reload those tabs. |
| **Optional host permissions** | Some customers serve Kinetic through a custom domain or subdomain. The popup lets the user enter an exact host (`tenant.example.com`) or wildcard (`*.example.com`); Chrome then prompts for that exact origin set. The extension stores only the approved match patterns in `chrome.storage.local` and registers the same scripts on those hosts. |

> **Theming/density add no new required permission.** They are delivered by declarative
> `content_scripts` entry (`src/theme-control.js`) that runs in the **default ISOLATED world** on the
> **already-granted** `*.epicorsaas.com` host, or on a user-approved custom host. The injector
> reads `chrome.storage.local` and overrides the page's own CSS custom properties via an injected
> `<style>`; it **never accesses the page's JavaScript** (ISOLATED world) and **never attaches the
> debugger**. This is a strictly **lower-risk surface** than the grid fix's debugger delivery — worth
> noting for reviewers: the broadened functionality did not broaden the permission surface.

> **Remote code:** Declare **"No, I am not using remote code."** All executed code (the grid hook and the
> theming CSS) is bundled in the package; the extension only *rewrites the host page's own
> already-downloaded script* with locally-bundled text and injects locally-built CSS. It loads no script
> from a remote server.

---

## 4. Privacy / data-use disclosures (Privacy practices tab)

- **Data collection:** select **does not collect or use** any of the listed user-data categories.
- **Disclosures to certify:**
  - ☑ I do not sell or transfer user data to third parties (outside approved use cases).
  - ☑ I do not use or transfer user data for purposes unrelated to the item's single purpose.
  - ☑ I do not use or transfer user data to determine creditworthiness or for lending.
- **Privacy policy URL:** **https://epidebug.help/kineticbugfix** (live — the page has a
  `#privacy` "Privacy policy" section). Also use it for the listing's **Homepage** and **Support** URL.
  The page is served additively from the Caddy static root (`html/kineticbugfix/index.html`); source
  lives at `AIWebsite/kineticbugfix/index.html`, redeploy on macOS via
  `python3 AIWebsite/.tmp/deploy_kineticbugfix.py`.

The hosted policy text (already on the page):

```
This extension does not collect, store, transmit, or sell any personal or usage data.
All settings (the on/off toggle, delivery mechanism, scope, custom host patterns, colors,
and density sliders) are stored locally on your device via chrome.storage.local and never
leave your browser. The extension makes no network requests of its own and contains no
analytics or tracking. It operates only on epicorsaas.com or hostnames you explicitly add
and approve in Chrome.
```

---

## 5. ⚠️ Review-risk callout: optional `debugger`

This remains the thing most likely to slow down approval if reviewers focus on the optional permission:

1. **Heightened scrutiny.** Extensions that request `debugger` get extra manual review; Google
   restricts it to cases where it is essential. Our justification (rewriting the host's hashed bundle
   at load) is legitimate, but expect questions and a longer turnaround.
2. **End-user warnings are mode-specific.** Install should not request `debugger`. Selecting Debugger
   mode prompts for the optional permission, and while that mode is active Chrome displays the
   *"…started debugging this browser"* infobar. Runtime mode avoids both.
3. **Reviewers can't log in to Kinetic.** The fix only engages on an authenticated Epicor Kinetic
   tenant (paid ERP), which reviewers don't have. **Mitigate** with: clear reviewer notes (§7), the
   default-OFF/harmless-without-Kinetic design, and a **demo video**.
4. **Runtime mode is supported but not equivalent to text rewrite.** The popup's *Runtime hook*
   mechanism avoids the banner and supports the DOM/CSS fixes, but it cannot rewrite the parser-loaded
   `main.*.js` bytes. Where the Ivy class is not reachable from page world, it reports
   `trapInstalled:true` but `prototypeWrapped:false` / `applied:false`. Do not market runtime mode as
   parity with the validated Debugger rewrite.
5. **If review pushes back on `debugger`:** the realistic alternatives are (a) **Enterprise
   self-hosting / Admin-console force-install** (no public CWS review of the debugger use), or (b)
   escalating an **upstream fix to Epicor/Telerik** so no extension is needed. See
   `.output/grid-grouping-leak/upstream-decision.md`.
6. **The theming and density/padding features do NOT change this risk.** Both run as
   declarative **ISOLATED-world** content scripts (CSS-variable override / token scaling) on the
   already-granted or user-approved host with no debugger use — a lower-risk surface than the
   optional rewrite mode. The `debugger` review risk remains scoped to the validated rewrite path only.

---

## 6. Visibility recommendation

This patches one specific third-party SaaS app and is only useful to Epicor Kinetic customers hitting
this leak. A general-public listing invites review friction and confuses unrelated users.

| Option | When to use |
|---|---|
| **Unlisted** *(recommended)* | Anyone with the link can install; not searchable. Good for sharing within your org / with other Kinetic customers. Still goes through review. |
| **Private** (trusted testers or a Google Workspace group) | Tightest scope; install limited to specified accounts. |
| **Enterprise self-hosted / Admin Console** | Best for a single company: force-install via Google Admin policy without a public CWS listing — sidesteps public review of `debugger`. |
| **Public** | Not recommended here. |

> A one-time **$5 developer registration fee** applies to the publishing Google account. Items with
> sensitive permissions may also require identity/domain verification.

---

## 7. Notes for reviewers (paste into the "Notes to reviewer" / test-instructions box)

```
WHAT IT DOES
This extension fixes a memory leak in Epicor Kinetic (epicorsaas.com) data grids that
occurs after a user groups a large grid by several columns and then ungroups it. It
inserts a one-line hook into the page's own grid code so ungrouping restores normal
virtual scrolling.

DEFAULT-OFF / SAFE TO INSTALL
The fix is OFF by default. On install it does nothing until the user opens the popup
and flips the toggle, then reloads their Kinetic tab. It acts on epicorsaas.com by
default; additional Kinetic domains require an explicit user-entered host and Chrome
host-permission approval.

WHY THE OPTIONAL DEBUGGER PERMISSION EXISTS
Kinetic ships its UI as a single content-hashed, minified main.<hash>.js. The only
reliable way to insert the fix is to rewrite that script as it loads, via the debugger
Fetch domain, scoped to supported Kinetic tabs and only after the user selects Debugger
mode and approves Chrome's optional permission prompt. Runtime mode remains available
without debugger permission, but it cannot rewrite the already-built script bytes.

HOW TO VERIFY WITHOUT AN EPICOR LOGIN
The full fix requires a paid Epicor Kinetic account, which is not publicly available.
However you can confirm the extension is well-formed and inert by default:
  1. Load it (unpacked or from the store). No banner appears, no debugger attaches.
  2. Open the toolbar popup: the on/off switch (default OFF), an "Advanced" section
     (mechanism + scope + additional host input), and a status readout render with no login.
  3. Visit any non-epicorsaas.com site that you have not added: the extension takes no action.
A demo video of the fix on a live tenant is available at: https://youtu.be/5hlHqpIXwrY.

DATA
No data is collected, stored remotely, or transmitted. Settings live in
chrome.storage.local only. No remote code is loaded.
```

---

## 8. Pre-submission checklist

- [ ] `npm run package` is green (check + 105 tests + build).
- [ ] `dist/kinetic-grid-grouping-fix-<ver>.zip` exists; `unzip -l` shows `manifest.json` at root and
      only the 14 runtime files incl. `src/theme-control.js` (no `verify/`, `package.json`,
      `patch-transform.js`, `README.md`).
- [ ] `manifest.description` ≤ 132 chars (the build enforces this).
- [ ] Bump `version` in `manifest.json` for every re-upload (the store rejects a re-used version).
- [ ] Listing copy, single-purpose, and all permission justifications (§1–§3) pasted in.
- [ ] Privacy practices completed; privacy-policy URL live (§4).
- [ ] Visibility set to Unlisted/Private (§6).
- [ ] At least one 1280×800 (or 640×400) screenshot uploaded; 128×128 store icon present (in package).
- [ ] Reviewer notes (§7) pasted; demo video linked if available.
- [ ] Decision recorded on `debugger` strategy (§5) in case of pushback.

---

## 9. Re-uploading a new version

1. Bump `manifest.json` `version` (e.g. `3.0.1`). Keep `package.json` `version` in sync.
2. `npm run package` → upload the new `dist/kinetic-grid-grouping-fix-<ver>.zip`.
3. If Kinetic shipped a new `main.*.js`, re-run the version-drift checks in `README.md` first so the
   anchor still matches (the patch fails safe — it serves the bundle unchanged if the anchor moved,
   so the leak silently returns until the fixtures are refreshed).
