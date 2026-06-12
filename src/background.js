importScripts("grid-revirtualize-fix.js");
importScripts("grid-blank-fix.js");
importScripts("grid-checkbox-style-fix.js");
importScripts("grid-group-data-fix.js");
importScripts("grid-saved-layout-fix.js");

(function(){
  "use strict";

  var VERSION = "3.8.0";
  var STATE_KEYS = ["gridFixEnabled", "gridFixScope", "gridFixMode", "gridScrollBufferEnabled", "customHostPatterns"];
  var DEFAULT_STATE = {
    gridFixEnabled: false,
    gridFixScope: "kinetic-only",
    gridFixMode: "runtime",
    // Opt-in bigger virtual render buffer (reduces the blank-flash on fast scrolls). It rides the SAME
    // debugger/runtime grid-fix delivery (reload-gated) because it acts inside the rebind hook; it is most
    // effective in debugger (M1) mode, which is where the hook reliably engages. Default OFF.
    gridScrollBufferEnabled: false,
    customHostPatterns: []
  };
  var SCROLL_BUFFER_MULT = 4;   // render ~4x the grid's natural window so fast scrolls stay populated
  // Theme-control feature (kinetic-theme-control-extension §4.1). The ISOLATED-world content script
  // src/theme-control.js owns ALL theme behavior and applies it live in the page; this service worker only
  // seeds these defaults and mirrors their state on the action badge/title. These keys are NEVER routed
  // through the debugger / startEnabledMechanisms / tab-reload path (§4.6, T_C_04).
  var THEME_STATE_KEYS = ["themeDisableEnabled", "colorOverrideEnabled", "colorOverrideValues", "neutralTintEnabled", "neutralTintHex"];
  var THEME_DEFAULT_STATE = {
    themeDisableEnabled: false,
    colorOverrideEnabled: false,
    colorOverrideValues: {},
    neutralTintEnabled: false,
    neutralTintHex: ""
  };
  // Density/padding feature (src/padding-control.js). Same delivery class as the theme keys: the
  // ISOLATED-world content script owns ALL behavior and applies it live; this service worker only seeds
  // the default and mirrors it on the badge. NEVER routed through the debugger / reload path.
  var DENSITY_STATE_KEYS = ["componentDensity", "fullWidthEnabled"];
  var DENSITY_DEFAULT_STATE = { componentDensity: {}, fullWidthEnabled: false };
  // Auto-size-columns feature (src/grid-autofit.js). Same delivery class as the theme/density keys: the
  // ISOLATED-world content script owns ALL behavior and applies it live (measure rendered cells -> pin
  // <col> widths) on each dataset load; this service worker only seeds the default and mirrors it on the
  // badge. NEVER routed through the debugger / reload path.
  // gridHeaderWrapEnabled (src/grid-header-wrap.js) rides the SAME live-ISOLATED delivery class: line-wraps
  // grid header titles + narrows header-bound columns, badge only, never the debugger/reload path.
  var AUTOFIT_STATE_KEYS = ["gridAutoSizeEnabled", "gridHeaderWrapEnabled"];
  var AUTOFIT_DEFAULT_STATE = { gridAutoSizeEnabled: false, gridHeaderWrapEnabled: false };
  var PROTOCOL_VERSION = "1.3";
  var MAIN_WORLD_SCRIPT_ID = "kinetic-grid-fix-main-world";
  var CUSTOM_THEME_SCRIPT_ID = "kinetic-grid-fix-theme-custom-hosts";
  var CUSTOM_DENSITY_SCRIPT_ID = "kinetic-grid-fix-density-custom-hosts";
  var CUSTOM_AUTOFIT_SCRIPT_ID = "kinetic-grid-fix-autofit-custom-hosts";
  var CUSTOM_HEADER_WRAP_SCRIPT_ID = "kinetic-grid-fix-header-wrap-custom-hosts";
  var CUSTOM_COLUMN_PERSONALIZER_SCRIPT_ID = "kinetic-grid-fix-column-personalizer-custom-hosts";
  var CUSTOM_FOCUS_SCRIPT_ID = "kinetic-grid-fix-focus-scroll-custom-hosts";
  var DEFAULT_HOST_PATTERNS = ["*://*.epicorsaas.com/*"];
  var attachedTabs = {};
  var inflightRequests = {};
  // The DIRECTIVE-layer fix (src/grid-revirtualize-fix.js). The earlier provider-layer transform
  // (patch-transform.js) is retained in-repo for reference + its unit tests but is FALSIFIED and is
  // no longer wired into delivery (see .output/chrome-plugin-grid-fix/verification-report.md).
  var transform = self.__KINETIC_GRID_REVIRT__;
  // The blank-viewport-after-bulk-load fix (src/grid-blank-fix.js). DOM-geometry watchdog, delivered by
  // appending its self-installing source to the patched bundle (M1) / installed at document_start (M2).
  var blankFix = self.__KINETIC_GRID_BLANK_FIX___MODULE;
  // The boolean-glyph presentation standardizer (src/grid-checkbox-style-fix.js). Injects a scoped
  // stylesheet pinning the boolean checkbox glyph's size/alignment/color to the column's canonical
  // value so it never renders differently after a group/ungroup re-render. Same delivery as blankFix.
  var checkboxFix = self.__KINETIC_GRID_CHECKBOX_FIX___MODULE;
  // The grouping-draws-an-empty-grid fix (src/grid-group-data-fix.js). Text-rewrites the EpGrid
  // groupBindingData getter with a length-aware source chain so the new kendoGridGroupBinding template
  // branch gets the loaded rows (DataView/loader grids otherwise group to "No records available.").
  // Anchor-based rewrite -> debugger (M1) delivery only, riding the same gridFixEnabled toggle.
  var groupDataFix = self.__KINETIC_GRID_GROUP_DATA_FIX__;
  // The saved-layout-kills-dynamic-grids fix (src/grid-saved-layout-fix.js). Inserts the missing
  // s.panelCardGrid guard into EpGrid initFromSavedLayout's filteringMode restore so grids without a
  // panelCardGrid (e.g. SQL On The Fly's per-query Output grid) survive a saved layout that carries
  // filteringMode instead of throwing during init and never rendering. Same delivery as groupDataFix.
  var savedLayoutFix = self.__KINETIC_GRID_SAVED_LAYOUT_FIX__;

  function runtimeLastError(){
    return chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
  }

  function normalizeHostPatterns(value){
    var out = [];
    var seen = {};
    if (!Array.isArray(value)){
      return out;
    }
    for (var i = 0; i < value.length; i += 1){
      var pattern = typeof value[i] === "string" ? value[i].toLowerCase() : "";
      if (!pattern || seen[pattern]){
        continue;
      }
      if (!/^(\*|https?):\/\/(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+\/\*$/.test(pattern)){
        continue;
      }
      if (pattern === DEFAULT_HOST_PATTERNS[0]){
        continue;
      }
      seen[pattern] = true;
      out.push(pattern);
    }
    return out;
  }

  function supportedHostPatterns(customPatterns){
    return DEFAULT_HOST_PATTERNS.concat(normalizeHostPatterns(customPatterns));
  }

  function withState(callback){
    chrome.storage.local.get(DEFAULT_STATE, function(values){
      var customHostPatterns = normalizeHostPatterns(values.customHostPatterns);
      callback({
        gridFixEnabled: values.gridFixEnabled === true,
        gridFixScope: values.gridFixScope || DEFAULT_STATE.gridFixScope,
        gridFixMode: values.gridFixMode === "debugger" ? "debugger" : DEFAULT_STATE.gridFixMode,
        gridScrollBufferEnabled: values.gridScrollBufferEnabled === true,
        customHostPatterns: customHostPatterns,
        hostPatterns: supportedHostPatterns(customHostPatterns)
      });
    });
  }

  function withThemeState(callback){
    chrome.storage.local.get(THEME_DEFAULT_STATE, function(values){
      callback({
        themeDisableEnabled: values.themeDisableEnabled === true,
        colorOverrideEnabled: values.colorOverrideEnabled === true,
        colorOverrideValues: (values.colorOverrideValues && typeof values.colorOverrideValues === "object")
          ? values.colorOverrideValues
          : {},
        neutralTintEnabled: values.neutralTintEnabled === true,
        neutralTintHex: typeof values.neutralTintHex === "string" ? values.neutralTintHex : ""
      });
    });
  }

  function withDensityState(callback){
    chrome.storage.local.get(DENSITY_DEFAULT_STATE, function(values){
      callback({
        componentDensity: (values.componentDensity && typeof values.componentDensity === "object")
          ? values.componentDensity
          : {},
        fullWidthEnabled: values.fullWidthEnabled === true
      });
    });
  }

  function withAutofitState(callback){
    chrome.storage.local.get(AUTOFIT_DEFAULT_STATE, function(values){
      callback({
        gridAutoSizeEnabled: values.gridAutoSizeEnabled === true,
        gridHeaderWrapEnabled: values.gridHeaderWrapEnabled === true
      });
    });
  }

  // Short, human-readable labels for the currently active features, in priority order. The grid label
  // keeps its "reload to apply" hint (debugger delivery); the theme labels carry no such hint because the
  // content script applies them live (§5). "custom colors" only counts when the override toggle is on AND
  // at least one family color is set, mirroring the §4.4 marker's `active` rule.
  function activeFeatureLabels(grid, theme, density, autofit){
    var labels = [];
    if (grid.gridFixEnabled === true){
      labels.push("grid fix on (reload Kinetic tab to apply)");
    }
    // The scroll buffer only takes effect alongside the grid fix (same rebind-hook delivery).
    if (grid.gridFixEnabled === true && grid.gridScrollBufferEnabled === true){
      labels.push("scroll buffer");
    }
    // "auto-size columns" applies live (ISOLATED content script), so it carries no reload hint.
    if (autofit && autofit.gridAutoSizeEnabled === true){
      labels.push("auto-size columns");
    }
    // "wrap headers" applies live (ISOLATED content script), so it carries no reload hint.
    if (autofit && autofit.gridHeaderWrapEnabled === true){
      labels.push("wrap headers");
    }
    if (theme.themeDisableEnabled === true){
      labels.push("theming off");
    }
    if (theme.colorOverrideEnabled === true
      && theme.colorOverrideValues
      && Object.keys(theme.colorOverrideValues).length > 0){
      labels.push("custom colors");
    }
    if (theme.neutralTintEnabled === true && theme.neutralTintHex){
      labels.push("surface tint");
    }
    // "spacing adjusted" counts when any component family carries a non-default factor (the popup only
    // stores non-default entries and prunes empty families), mirroring the padding-control marker's
    // `active` rule. Applies live.
    if (density
      && density.componentDensity
      && Object.keys(density.componentDensity).length > 0){
      labels.push("spacing adjusted");
    }
    if (density && density.fullWidthEnabled === true){
      labels.push("full width");
    }
    return labels;
  }

  function setBadge(grid, theme, density, autofit){
    if (!chrome.action){
      return;
    }
    var labels = activeFeatureLabels(grid, theme, density, autofit);
    var anyActive = labels.length > 0;
    var text = anyActive ? "ON" : "";
    var title = anyActive
      ? "Kinetic Grid Grouping Fix — " + labels.join(" · ")
      : "Kinetic Grid Grouping Fix — OFF";
    if (chrome.action.setBadgeText){
      chrome.action.setBadgeText({ text: text });
    }
    if (chrome.action.setBadgeBackgroundColor){
      chrome.action.setBadgeBackgroundColor({ color: "#2ea043" });
    }
    if (chrome.action.setTitle){
      chrome.action.setTitle({ title: title });
    }
  }

  function refreshBadge(){
    withState(function(grid){
      withThemeState(function(theme){
        withDensityState(function(density){
          withAutofitState(function(autofit){
            setBadge(grid, theme, density, autofit);
          });
        });
      });
    });
  }

  function initializeDefaults(callback){
    chrome.storage.local.get(STATE_KEYS.concat(THEME_STATE_KEYS).concat(DENSITY_STATE_KEYS).concat(AUTOFIT_STATE_KEYS), function(values){
      var updates = {};
      if (typeof values.gridFixEnabled !== "boolean"){
        updates.gridFixEnabled = DEFAULT_STATE.gridFixEnabled;
      }
      if (!values.gridFixScope){
        updates.gridFixScope = DEFAULT_STATE.gridFixScope;
      }
      if (!values.gridFixMode){
        updates.gridFixMode = DEFAULT_STATE.gridFixMode;
      }
      if (typeof values.gridScrollBufferEnabled !== "boolean"){
        updates.gridScrollBufferEnabled = DEFAULT_STATE.gridScrollBufferEnabled;
      }
      if (!Array.isArray(values.customHostPatterns)){
        updates.customHostPatterns = [];
      }
      // Seed the theme-control keys so install/startup is genuinely default-OFF (§4.1): both toggles
      // default false; colorOverrideValues defaults to an empty map. Mirrors the gridFix* seeding above.
      // Seeding storage does NOT attach the debugger or reload anything — the content script self-gates.
      if (typeof values.themeDisableEnabled !== "boolean"){
        updates.themeDisableEnabled = THEME_DEFAULT_STATE.themeDisableEnabled;
      }
      if (typeof values.colorOverrideEnabled !== "boolean"){
        updates.colorOverrideEnabled = THEME_DEFAULT_STATE.colorOverrideEnabled;
      }
      if (!values.colorOverrideValues || typeof values.colorOverrideValues !== "object"){
        updates.colorOverrideValues = {};
      }
      if (typeof values.neutralTintEnabled !== "boolean"){
        updates.neutralTintEnabled = THEME_DEFAULT_STATE.neutralTintEnabled;
      }
      if (typeof values.neutralTintHex !== "string"){
        updates.neutralTintHex = THEME_DEFAULT_STATE.neutralTintHex;
      }
      // Seed the density map so install/startup is genuinely default-OFF: an empty map => fully inert.
      // Seeding storage does NOT attach the debugger or reload anything — the content script self-gates.
      if (!values.componentDensity || typeof values.componentDensity !== "object"){
        updates.componentDensity = {};
      }
      if (typeof values.fullWidthEnabled !== "boolean"){
        updates.fullWidthEnabled = DENSITY_DEFAULT_STATE.fullWidthEnabled;
      }
      // Seed the auto-size flag so install/startup is genuinely default-OFF. Seeding storage does NOT
      // attach the debugger or reload anything — the content script self-gates on this flag.
      if (typeof values.gridAutoSizeEnabled !== "boolean"){
        updates.gridAutoSizeEnabled = AUTOFIT_DEFAULT_STATE.gridAutoSizeEnabled;
      }
      // Seed the header-wrap flag so install/startup is genuinely default-OFF. The content script self-gates.
      if (typeof values.gridHeaderWrapEnabled !== "boolean"){
        updates.gridHeaderWrapEnabled = AUTOFIT_DEFAULT_STATE.gridHeaderWrapEnabled;
      }

      var names = Object.keys(updates);
      if (names.length === 0){
        if (callback){
          callback();
        }
        return;
      }

      chrome.storage.local.set(updates, function(){
        if (callback){
          callback();
        }
      });
    });
  }

  function parseUrl(url){
    try {
      return new URL(url);
    } catch (error) {
      return null;
    }
  }

  function patternHost(pattern){
    var match = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(pattern || "");
    return match ? match[2] : "";
  }

  function patternMatchesHost(hostname, pattern){
    var host = (hostname || "").toLowerCase();
    var allowed = patternHost(pattern).toLowerCase();
    if (!host || !allowed){
      return false;
    }
    if (allowed.indexOf("*.") === 0){
      var suffix = allowed.slice(2);
      return host === suffix || host.lastIndexOf("." + suffix) === host.length - suffix.length - 1;
    }
    return host === allowed;
  }

  function patternMatchesUrl(url, pattern){
    var parsed = parseUrl(url);
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")){
      return false;
    }
    var scheme = (pattern || "").split("://")[0];
    if (scheme !== "*" && scheme + ":" !== parsed.protocol){
      return false;
    }
    return patternMatchesHost(parsed.hostname, pattern);
  }

  function isKineticPageUrl(url, hostPatterns){
    var patterns = hostPatterns || DEFAULT_HOST_PATTERNS;
    for (var i = 0; i < patterns.length; i += 1){
      if (patternMatchesUrl(url, patterns[i])){
        return true;
      }
    }
    return false;
  }

  function isKineticMainBundleUrl(url, hostPatterns){
    var parsed = parseUrl(url);
    if (!parsed || !isKineticPageUrl(url, hostPatterns)){
      return false;
    }

    var slash = parsed.pathname.lastIndexOf("/");
    var fileName = slash >= 0 ? parsed.pathname.slice(slash + 1) : parsed.pathname;
    var lower = fileName.toLowerCase();
    return (lower === "main.js" || lower.indexOf("main.") === 0) && lower.lastIndexOf(".js") === lower.length - 3;
  }

  function mainBundleFetchPatterns(hostPatterns){
    var patterns = hostPatterns || DEFAULT_HOST_PATTERNS;
    var out = [];
    for (var i = 0; i < patterns.length; i += 1){
      var pattern = patterns[i];
      var pathIndex = pattern.indexOf("/*");
      if (pathIndex < 0){
        continue;
      }
      out.push({
        urlPattern: pattern.slice(0, pathIndex) + "/*/main*.js",
        resourceType: "Script",
        requestStage: "Response"
      });
    }
    return out;
  }

  function bundleHashFromUrl(url){
    var parsed = parseUrl(url);
    if (!parsed){
      return null;
    }

    var slash = parsed.pathname.lastIndexOf("/");
    var fileName = slash >= 0 ? parsed.pathname.slice(slash + 1) : parsed.pathname;
    var lower = fileName.toLowerCase();
    if (lower.indexOf("main.") !== 0 || lower.lastIndexOf(".js") !== lower.length - 3){
      return null;
    }

    var hash = fileName.slice(5, fileName.length - 3);
    return hash || null;
  }

  function debuggerSend(target, method, params){
    return new Promise(function(resolve, reject){
      if (!chrome.debugger || !chrome.debugger.sendCommand){
        reject(new Error("debugger permission is not granted"));
        return;
      }
      chrome.debugger.sendCommand(target, method, params || {}, function(result){
        var error = runtimeLastError();
        if (error){
          reject(new Error(error));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function hasDebuggerPermission(callback){
    try {
      if (!chrome.debugger || !chrome.debugger.attach){
        callback(false);
        return;
      }
      if (!chrome.permissions || !chrome.permissions.contains){
        callback(true);
        return;
      }
      chrome.permissions.contains({ permissions: ["debugger"] }, function(granted){
        runtimeLastError();
        callback(granted === true);
      });
    } catch (error) {
      callback(false);
    }
  }

  function attachDebugger(tabId, state){
    return new Promise(function(resolve, reject){
      if (attachedTabs[tabId]){
        resolve();
        return;
      }

      hasDebuggerPermission(function(granted){
        if (!granted){
          reject(new Error("debugger permission is not granted"));
          return;
        }

        var target = { tabId: tabId };
        chrome.debugger.attach(target, PROTOCOL_VERSION, function(){
          var error = runtimeLastError();
          if (error){
            reject(new Error(error));
            return;
          }

          attachedTabs[tabId] = true;
          debuggerSend(target, "Fetch.enable", {
            patterns: mainBundleFetchPatterns(state && state.hostPatterns)
          }).then(function(){
            resolve();
          }).catch(function(enableError){
            detachDebugger(tabId).finally(function(){
              reject(enableError);
            });
          });
        });
      });
    });
  }

  function detachDebugger(tabId){
    return new Promise(function(resolve){
      if (!attachedTabs[tabId] || !chrome.debugger || !chrome.debugger.detach){
        delete attachedTabs[tabId];
        resolve();
        return;
      }

      chrome.debugger.detach({ tabId: tabId }, function(){
        delete attachedTabs[tabId];
        resolve();
      });
    });
  }

  function detachKnownTabs(){
    var tabIds = Object.keys(attachedTabs);
    var promises = [];
    for (var i = 0; i < tabIds.length; i += 1){
      promises.push(detachDebugger(Number(tabIds[i])));
    }
    return Promise.all(promises);
  }

  function detachAttachedKineticTargets(){
    return new Promise(function(resolve){
      if (!chrome.debugger || !chrome.debugger.getTargets){
        resolve();
        return;
      }
      withState(function(state){
        chrome.debugger.getTargets(function(targets){
          var promises = [];
          for (var i = 0; i < targets.length; i += 1){
            if (targets[i].attached && targets[i].tabId && isKineticPageUrl(targets[i].url, state.hostPatterns)){
              attachedTabs[targets[i].tabId] = true;
              promises.push(detachDebugger(targets[i].tabId));
            }
          }
          Promise.all(promises).then(function(){
            resolve();
          });
        });
      });
    });
  }

  function queryKineticTabs(state){
    return new Promise(function(resolve){
      var patterns = state && state.hostPatterns ? state.hostPatterns : DEFAULT_HOST_PATTERNS;
      chrome.tabs.query({ url: patterns }, function(tabs){
        resolve(tabs || []);
      });
    });
  }

  function registerCustomHostContentScripts(state){
    return new Promise(function(resolve){
      if (!chrome.scripting || !chrome.scripting.unregisterContentScripts || !chrome.scripting.registerContentScripts){
        resolve();
        return;
      }

      var ids = [CUSTOM_THEME_SCRIPT_ID, CUSTOM_DENSITY_SCRIPT_ID, CUSTOM_AUTOFIT_SCRIPT_ID, CUSTOM_HEADER_WRAP_SCRIPT_ID, CUSTOM_COLUMN_PERSONALIZER_SCRIPT_ID, CUSTOM_FOCUS_SCRIPT_ID];
      chrome.scripting.unregisterContentScripts({ ids: ids }, function(){
        runtimeLastError();
        var matches = normalizeHostPatterns(state && state.customHostPatterns);
        if (matches.length === 0){
          resolve();
          return;
        }
        chrome.scripting.registerContentScripts([
          {
            id: CUSTOM_THEME_SCRIPT_ID,
            matches: matches,
            js: ["src/theme-control.js"],
            runAt: "document_start",
            allFrames: false
          },
          {
            id: CUSTOM_DENSITY_SCRIPT_ID,
            matches: matches,
            js: ["src/padding-control.js"],
            runAt: "document_start",
            allFrames: false
          },
          {
            id: CUSTOM_AUTOFIT_SCRIPT_ID,
            matches: matches,
            js: ["src/grid-autofit.js"],
            runAt: "document_start",
            allFrames: false
          },
          {
            id: CUSTOM_HEADER_WRAP_SCRIPT_ID,
            matches: matches,
            js: ["src/grid-header-wrap.js"],
            runAt: "document_start",
            allFrames: false
          },
          {
            id: CUSTOM_COLUMN_PERSONALIZER_SCRIPT_ID,
            matches: matches,
            js: ["src/column-personalizer.js"],
            runAt: "document_start",
            allFrames: false
          },
          {
            id: CUSTOM_FOCUS_SCRIPT_ID,
            matches: matches,
            js: ["src/grid-focus-scroll-fix.js"],
            runAt: "document_start",
            world: "MAIN",
            allFrames: false
          }
        ], function(){
          runtimeLastError();
          resolve();
        });
      });
    });
  }

  function syncHostContentScripts(){
    return new Promise(function(resolve){
      withState(function(state){
        registerCustomHostContentScripts(state).then(function(){
          resolve();
        });
      });
    });
  }

  function attachEligibleTabs(options, state){
    return queryKineticTabs(state).then(function(tabs){
      var promises = [];
      for (var i = 0; i < tabs.length; i += 1){
        if (!tabs[i].id || !isKineticPageUrl(tabs[i].url, state && state.hostPatterns)){
          continue;
        }

        promises.push(attachDebugger(tabs[i].id, state).then(function(tabId){
          return function(){
            if (options && options.reload){
              // bypassCache: main.js often loads from HTTP cache on a normal reload, so the
              // debugger Fetch interception never sees a network response and the patch is not
              // applied. A hard reload forces a refetch through the interceptor.
              chrome.tabs.reload(tabId, { bypassCache: true });
            }
          };
        }(tabs[i].id)).then(function(reload){
          reload();
        }).catch(function(){
        }));
      }
      return Promise.all(promises);
    });
  }

  function registerMainWorldProbe(state){
    return new Promise(function(resolve){
      if (!chrome.scripting || !chrome.scripting.unregisterContentScripts || !chrome.scripting.registerContentScripts){
        resolve();
        return;
      }
      chrome.scripting.unregisterContentScripts({ ids: [MAIN_WORLD_SCRIPT_ID] }, function(){
        // Consume any "Nonexistent script ID" lastError from the unregister-before-register guard.
        runtimeLastError();
        var script = {
          id: MAIN_WORLD_SCRIPT_ID,
          matches: state && state.hostPatterns ? state.hostPatterns : DEFAULT_HOST_PATTERNS,
          js: ["src/grid-revirtualize-fix.js", "src/grid-blank-fix.js", "src/grid-checkbox-style-fix.js", "src/inject-main-world.js"],
          runAt: "document_start",
          world: "MAIN",
          allFrames: false
        };
        chrome.scripting.registerContentScripts([script], function(){
          var error = runtimeLastError();
          if (error && script.matches.length > DEFAULT_HOST_PATTERNS.length){
            script.matches = DEFAULT_HOST_PATTERNS;
            chrome.scripting.registerContentScripts([script], function(){
              runtimeLastError();
              resolve();
            });
            return;
          }
          resolve();
        });
      });
    });
  }

  function unregisterMainWorldProbe(){
    return new Promise(function(resolve){
      if (!chrome.scripting || !chrome.scripting.unregisterContentScripts){
        resolve();
        return;
      }
      chrome.scripting.unregisterContentScripts({ ids: [MAIN_WORLD_SCRIPT_ID] }, function(){
        // Consume the expected "Nonexistent script ID" lastError when nothing was registered.
        runtimeLastError();
        resolve();
      });
    });
  }

  /*
   * Legacy context kept intentionally absent: the runtime probe registration above is the only
   * MAIN-world registration path.
   */
  function startEnabledMechanisms(reloadTabs){
    withState(function(state){
      if (!state.gridFixEnabled){
        teardownMechanisms();
        return;
      }

      var mode = state.gridFixMode || DEFAULT_STATE.gridFixMode;
      if (mode === "runtime"){
        registerMainWorldProbe(state).then(function(){
          if (reloadTabs){
            queryKineticTabs(state).then(function(tabs){
              for (var i = 0; i < tabs.length; i += 1){
                if (tabs[i].id){
                  chrome.tabs.reload(tabs[i].id);
                }
              }
            });
          }
        });
        return;
      }

      hasDebuggerPermission(function(granted){
        if (!granted){
          registerMainWorldProbe(state).then(function(){
            if (reloadTabs){
              queryKineticTabs(state).then(function(tabs){
                for (var i = 0; i < tabs.length; i += 1){
                  if (tabs[i].id){
                    chrome.tabs.reload(tabs[i].id);
                  }
                }
              });
            }
          });
          return;
        }
        unregisterMainWorldProbe().then(function(){
          attachEligibleTabs({ reload: reloadTabs }, state);
        });
      });
    });
  }

  function teardownMechanisms(){
    unregisterMainWorldProbe().then(function(){
      detachKnownTabs().then(function(){
        detachAttachedKineticTargets();
      });
    });
  }

  /*
   * The following helpers operate on paused debugger Fetch responses. They are reachable only when the
   * optional debugger permission was granted and the user selected debugger mode.
   */
  function textFromResponseBody(response){
    if (!response || !response.body){
      return "";
    }

    if (!response.base64Encoded){
      return response.body;
    }

    var binary = atob(response.body);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1){
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  function base64FromText(text){
    var bytes = new TextEncoder().encode(text);
    var parts = [];
    var size = 32768;
    for (var i = 0; i < bytes.length; i += size){
      var slice = bytes.subarray(i, i + size);
      parts.push(String.fromCharCode.apply(null, slice));
    }
    return btoa(parts.join(""));
  }

  function normalizedHeaders(headers){
    var output = [];
    var hasContentType = false;
    // main.<hash>.js is served immutable-cacheable; if we let the PATCHED response inherit those
    // headers, Chrome caches the patched bytes under the content-hashed URL and a normal reload (even
    // after toggling the fix OFF) keeps serving the cached patched bundle — the fix never reverts.
    // Strip all caching/validation headers and force no-store so every load re-fetches: the extension
    // re-patches while ON, and a reload after OFF gets the stock bundle back.
    var blocked = {
      "content-length": true,
      "content-encoding": true,
      "x-content-encoding-over-network": true,
      "cache-control": true,
      "pragma": true,
      "expires": true,
      "etag": true,
      "last-modified": true,
      "age": true
    };

    for (var i = 0; i < (headers || []).length; i += 1){
      var header = headers[i];
      if (!header || !header.name){
        continue;
      }
      var lower = header.name.toLowerCase();
      if (blocked[lower]){
        continue;
      }
      if (lower === "content-type"){
        hasContentType = true;
      }
      output.push({ name: header.name, value: header.value || "" });
    }

    if (!hasContentType){
      output.push({ name: "Content-Type", value: "application/javascript; charset=utf-8" });
    }
    output.push({ name: "Cache-Control", value: "no-store, no-cache, must-revalidate" });

    return output;
  }

  function continuePausedRequest(source, requestId){
    return debuggerSend(source, "Fetch.continueRequest", { requestId: requestId }).catch(function(){
    });
  }

  function fulfillPausedRequest(source, params, patchedText){
    return debuggerSend(source, "Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: params.responseStatusCode || 200,
      responsePhrase: params.responseStatusText || "OK",
      responseHeaders: normalizedHeaders(params.responseHeaders),
      body: base64FromText(patchedText)
    });
  }

  function handlePausedRequest(source, params){
    if (!params || !params.requestId || inflightRequests[params.requestId]){
      return;
    }
    inflightRequests[params.requestId] = true;

    withState(function(state){
      if (!state.gridFixEnabled || !isKineticMainBundleUrl(params.request.url, state.hostPatterns)){
        continuePausedRequest(source, params.requestId).finally(function(){
          delete inflightRequests[params.requestId];
        });
        return;
      }

      debuggerSend(source, "Fetch.getResponseBody", { requestId: params.requestId }).then(function(response){
        var originalText = textFromResponseBody(response);
        var result = transform.patchBundleText(originalText, {
          url: params.request.url,
          bundleHash: bundleHashFromUrl(params.request.url),
          extensionVersion: VERSION,
          // Bake the scroll-buffer config alongside the hook ONLY when opted in (omitted => buffer OFF).
          config: state.gridScrollBufferEnabled
            ? { scrollBuffer: true, bufferMult: SCROLL_BUFFER_MULT }
            : null
        });

        // Start from the rebind-patched bundle when that anchor matched; otherwise the original text.
        var rebindApplied = !!(result && result.applied && typeof result.patched === "string");
        var combined = rebindApplied ? result.patched : originalText;

        // Rewrite the EpGrid groupBindingData getter (grouping-draws-an-empty-grid fix). Independent
        // anchor, so it applies whether or not the rebind anchor matched.
        if (groupDataFix && typeof groupDataFix.patchBundleText === "function"){
          var groupDataResult = groupDataFix.patchBundleText(combined, { url: params.request.url });
          if (groupDataResult && groupDataResult.applied && typeof groupDataResult.patched === "string"){
            combined = groupDataResult.patched;
          }
        }

        // Guard initFromSavedLayout's filteringMode restore (saved-layout-kills-dynamic-grids fix).
        // Independent regex anchor, so it applies whether or not the other anchors matched.
        if (savedLayoutFix && typeof savedLayoutFix.patchBundleText === "function"){
          var savedLayoutResult = savedLayoutFix.patchBundleText(combined, { url: params.request.url });
          if (savedLayoutResult && savedLayoutResult.applied && typeof savedLayoutResult.patched === "string"){
            combined = savedLayoutResult.patched;
          }
        }

        // Always append the blank-fix watchdog installer when enabled — it is DOM-based and independent
        // of the rebind anchor, so it must apply even on bundles where the rebind anchor is absent.
        if (blankFix && typeof blankFix.WATCHDOG_SOURCE === "string"
          && combined.indexOf("__KINETIC_GRID_BLANK_FIX__") < 0){
          combined = combined + ";try{(" + blankFix.WATCHDOG_SOURCE + ")(window);}catch(_kgbf){}";
        }

        // Append the boolean-glyph style standardizer installer — also DOM/CSS-based and independent of
        // the rebind anchor, so it applies on every bundle whether or not the leak hook matched.
        if (checkboxFix && typeof checkboxFix.STYLE_SOURCE === "string"
          && combined.indexOf("__KINETIC_GRID_CHECKBOX_FIX__") < 0){
          combined = combined + ";try{(" + checkboxFix.STYLE_SOURCE + ")(window);}catch(_kgcf){}";
        }

        if (combined === originalText){
          // Neither fix changed the bundle -> serve it untouched.
          return continuePausedRequest(source, params.requestId);
        }

        return fulfillPausedRequest(source, params, combined);
      }).catch(function(){
        return continuePausedRequest(source, params.requestId);
      }).finally(function(){
        delete inflightRequests[params.requestId];
      });
    });
  }

  chrome.runtime.onInstalled.addListener(function(){
    initializeDefaults(function(){
      refreshBadge();
      syncHostContentScripts();
      startEnabledMechanisms(false);
    });
  });

  chrome.runtime.onStartup.addListener(function(){
    initializeDefaults(function(){
      refreshBadge();
      syncHostContentScripts();
      startEnabledMechanisms(false);
    });
  });

  var toggleReactionTimer = null;
  var pendingReload = false;

  chrome.storage.onChanged.addListener(function(changes, areaName){
    if (areaName !== "local"){
      return;
    }

    // Theme-control + density keys affect ONLY the badge/title. The ISOLATED content scripts apply them
    // live in the page; they must NEVER attach the debugger or reload a tab (§4.6, T_C_04).
    var themeChanged = !!(changes.themeDisableEnabled
      || changes.colorOverrideEnabled
      || changes.colorOverrideValues
      || changes.neutralTintEnabled
      || changes.neutralTintHex);
    var densityChanged = !!(changes.componentDensity || changes.fullWidthEnabled);
    // Auto-size-columns is the same delivery class as theme/density: live ISOLATED content script, badge
    // only, NEVER the debugger/reload path.
    var autofitChanged = !!(changes.gridAutoSizeEnabled || changes.gridHeaderWrapEnabled);
    // Grid keys drive the debugger/runtime delivery mechanism (attach + hard reload). The scroll buffer
    // is baked into the same patched bundle, so toggling it must re-run delivery + reload too.
    var gridChanged = !!(changes.gridFixEnabled || changes.gridFixMode || changes.gridScrollBufferEnabled);
    var hostsChanged = !!changes.customHostPatterns;

    if (!themeChanged && !densityChanged && !autofitChanged && !gridChanged && !hostsChanged){
      return;
    }

    // The badge reflects all feature groups; refresh it on any change that can alter what it shows.
    // gridFixMode alone never changes the badge text/title, matching the prior behavior.
    if (changes.gridFixEnabled || changes.gridScrollBufferEnabled || themeChanged || densityChanged || autofitChanged){
      refreshBadge();
    }

    if (!gridChanged){
      if (hostsChanged){
        syncHostContentScripts().then(function(){
          startEnabledMechanisms(false);
        });
      }
      // Theme-only change: the badge is already refreshed above; do NOT touch the debugger/reload path.
      return;
    }

    // Debounce rapid toggling so attach/detach + tab reloads do not thrash.
    if (changes.gridFixEnabled && changes.gridFixEnabled.newValue === true){
      pendingReload = true;
    }
    // Toggling the scroll buffer (while the grid fix stays on) re-bakes the bundle, which only takes
    // effect on a fresh fetch -> force a reload so the new window size applies.
    if (changes.gridScrollBufferEnabled){
      pendingReload = true;
    }
    if (toggleReactionTimer){
      clearTimeout(toggleReactionTimer);
    }
    toggleReactionTimer = setTimeout(function(){
      toggleReactionTimer = null;
      var reload = pendingReload;
      pendingReload = false;
      syncHostContentScripts().then(function(){
        startEnabledMechanisms(reload);
      });
    }, 200);
  });

  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab){
    if (changeInfo.status !== "loading"){
      return;
    }

    withState(function(state){
      if (!isKineticPageUrl(changeInfo.url || tab.url, state.hostPatterns)){
        return;
      }
      if (state.gridFixEnabled && (state.gridFixMode || DEFAULT_STATE.gridFixMode) === "debugger"){
        attachDebugger(tabId, state).catch(function(){
        });
      }
    });
  });

  if (chrome.debugger && chrome.debugger.onEvent){
    chrome.debugger.onEvent.addListener(function(source, method, params){
      if (method === "Fetch.requestPaused"){
        handlePausedRequest(source, params);
      }
    });
  }

  if (chrome.debugger && chrome.debugger.onDetach){
    chrome.debugger.onDetach.addListener(function(source){
      if (source && source.tabId){
        delete attachedTabs[source.tabId];
      }
    });
  }

  initializeDefaults(function(){
    refreshBadge();
    syncHostContentScripts();
    startEnabledMechanisms(false);
  });
})();
