// MAIN-world document_start entry for the RUNTIME (M2) delivery mode (no debugger banner).
// Registered after src/grid-revirtualize-fix.js + src/grid-blank-fix.js, so __KINETIC_GRID_REVIRT__ and
// __KINETIC_GRID_BLANK_FIX___MODULE are already on window. It (1) exposes the group/ungroup corrector
// global + best-effort wraps the binding directive, and (2) installs the blank-viewport-after-bulk-load
// alignment watchdog. M1 (debugger Fetch text-inject) is the preferred/robust mode; this is the
// banner-free fallback.

(function (W) {
  "use strict";

  if (!W) {
    return;
  }

  var revirt = W.__KINETIC_GRID_REVIRT__;
  if (revirt && typeof revirt.installDirectiveWrap === "function") {
    try {
      if (typeof revirt.installHook === "function") {
        revirt.installHook(W);
      }
      W.__KINETIC_GRID_REVIRT_RESULT__ = revirt.installDirectiveWrap(W);
    } catch (error) {
      W.__KINETIC_GRID_REVIRT_RESULT__ = { applied: false, mode: "directive-runtime", anchorsHit: [] };
    }
  }

  // Blank-viewport-after-bulk-load alignment watchdog (independent of the group/ungroup fix).
  var blankFix = W.__KINETIC_GRID_BLANK_FIX___MODULE;
  if (blankFix && typeof blankFix.install === "function") {
    try {
      blankFix.install(W);
    } catch (blankError) {
      /* never throw at document_start */
    }
  }

  // Boolean-glyph presentation standardizer (independent of the group/ungroup + blank fixes).
  var checkboxFix = W.__KINETIC_GRID_CHECKBOX_FIX___MODULE;
  if (checkboxFix && typeof checkboxFix.install === "function") {
    try {
      checkboxFix.install(W);
    } catch (checkboxError) {
      /* never throw at document_start */
    }
  }
})(window);
