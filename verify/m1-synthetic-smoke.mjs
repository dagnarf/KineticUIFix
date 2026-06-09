import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cdpPort = Number(process.env.KINETIC_GRID_FIX_SMOKE_CDP_PORT || 9238);
const serverPort = Number(process.env.KINETIC_GRID_FIX_SMOKE_HTTP_PORT || 8128);
const headless = process.env.KINETIC_GRID_FIX_SMOKE_HEADLESS !== "0";
const host = "centralusdtedu00.epicorsaas.com";
const profileRoot = path.join(repoRoot, ".tmp", "chrome-plugin-grid-fix", "m1-smoke-profile");
const extensionRoot = process.env.KINETIC_GRID_FIX_EXTENSION_ROOT ? path.resolve(process.env.KINETIC_GRID_FIX_EXTENSION_ROOT) : appRoot;
const extensionName = "Kinetic Grid Grouping Fix";
const fixture = fs.readFileSync(path.join(appRoot, "verify", "fixtures", "anchor-main-slice.js"), "utf8");
const blankUrl = `http://${host}:${serverPort}/blank.html`;
const indexUrl = `http://${host}:${serverPort}/SaaS950/apps/erp/home/index.html`;
const mainUrl = "/SaaS950/apps/erp/home/main.437c1f00e1f99d77.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((commandResolve, commandReject) => {
            pending.set(id, { resolve: commandResolve, reject: commandReject });
          });
        },
        close() {
          ws.close();
        }
      });
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) {
        return;
      }
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || "CDP command failed"));
        return;
      }
      entry.resolve(message.result || {});
    });

    ws.addEventListener("error", () => {
      reject(new Error(`Unable to connect to ${wsUrl}`));
    });
  });
}

function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === mainUrl) {
      response.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": String(Buffer.byteLength(fixture))
      });
      response.end(`${fixture};window.__FAKE_MAIN_LOADED__=true;`);
      return;
    }

    if (request.url === "/blank.html") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>blank</title>");
      return;
    }

    if (request.url === "/SaaS950/apps/erp/home/index.html") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<!doctype html><title>synthetic kinetic</title><script src="${mainUrl}"></script>`);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(serverPort, "127.0.0.1", () => resolve(server));
  });
}

async function workerEval(worker, expression) {
  const result = await worker.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(`Runtime.evaluate exception: ${JSON.stringify(result.exceptionDetails)}`);
  }
  if (result.result && result.result.objectId && (result.result.subtype === "promise" || result.result.className === "Promise" || result.result.description === "Promise")) {
    const awaited = await worker.send("Runtime.awaitPromise", {
      promiseObjectId: result.result.objectId,
      returnByValue: true
    });
    if (awaited.exceptionDetails) {
      throw new Error(`Runtime.awaitPromise exception: ${JSON.stringify(awaited.exceptionDetails)}`);
    }
    return awaited.result ? awaited.result.value : null;
  }
  if (result.result && result.result.type === "object" && result.result.value && Object.keys(result.result.value).length === 0) {
    return { __rawEmptyObject: true, description: result.result.description || null, className: result.result.className || null };
  }
  return result.result ? result.result.value : null;
}

async function loadUnpackedExtension() {
  const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
  const browser = await connectCdp(version.webSocketDebuggerUrl);
  try {
    const result = await browser.send("Extensions.loadUnpacked", { path: extensionRoot });
    return result.id || result.extensionId || null;
  } finally {
    browser.close();
  }
}

async function findKineticGridFixWorkerTarget(expectedExtensionId = null) {
  const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const workers = targets.filter((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://") && target.webSocketDebuggerUrl);

  for (const target of workers) {
    if (expectedExtensionId && target.url.startsWith(`chrome-extension://${expectedExtensionId}/`)) {
      return target;
    }

    let worker = null;
    try {
      worker = await connectCdp(target.webSocketDebuggerUrl);
      await worker.send("Runtime.enable").catch(() => {});
      const manifestName = await workerEval(worker, "typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.getManifest?null:chrome.runtime.getManifest().name");
      if (manifestName === extensionName) {
        return target;
      }
    } catch (error) {
      // Ignore unrelated extension workers and keep looking for ours.
    } finally {
      if (worker) {
        worker.close();
      }
    }
  }

  return null;
}

function parseEvalValue(value) {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

async function main() {
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}`);
  }

  fs.rmSync(profileRoot, { recursive: true, force: true });
  fs.mkdirSync(profileRoot, { recursive: true });

  if (!fs.existsSync(path.join(extensionRoot, "manifest.json"))) {
    throw new Error(`Extension manifest not found at ${extensionRoot}`);
  }

  const server = await startServer();
  const chromeArgs = [
    `--user-data-dir=${profileRoot}`,
    `--remote-debugging-port=${cdpPort}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    `--host-resolver-rules=MAP ${host} 127.0.0.1`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    blankUrl
  ];

  if (headless) {
    chromeArgs.splice(chromeArgs.length - 1, 0, "--headless=new");
  }

  const chrome = childProcess.spawn(chromePath, chromeArgs, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitFor("Chrome CDP", () => fetchJson(`http://127.0.0.1:${cdpPort}/json/version`));
    let loadedExtensionId = null;
    let loadExtensionError = null;
    try {
      loadedExtensionId = await loadUnpackedExtension();
    } catch (error) {
      loadExtensionError = error;
    }

    let workerTarget;
    try {
      workerTarget = await waitFor("extension service worker", async () => {
        return findKineticGridFixWorkerTarget(loadedExtensionId);
      });
    } catch (error) {
      const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`).catch(() => []);
      const targetSummary = targets.map((target) => ({ type: target.type, title: target.title, url: target.url })).slice(0, 20);
      const loadDetail = loadExtensionError ? `; loadUnpacked=${loadExtensionError.message}` : "";
      throw new Error(`${error.message}${loadDetail}; targets=${JSON.stringify(targetSummary)}; stderr=${stderr.slice(-2000)}`);
    }

    const worker = await connectCdp(workerTarget.webSocketDebuggerUrl);
    try {
      await worker.send("Runtime.enable").catch(() => {});
      const workerInfo = await workerEval(worker, "({href:self.location.href, chromeType:typeof chrome, chromeKeys:typeof chrome==='object'?Object.keys(chrome).sort():[], manifest:typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.getManifest?null:chrome.runtime.getManifest()})");
      if (!workerInfo || !workerInfo.manifest || workerInfo.manifest.name !== extensionName) {
        throw new Error(`unexpected extension worker target: ${JSON.stringify(workerInfo)}`);
      }
      if (!workerInfo.chromeKeys.includes("storage")) {
        throw new Error(`extension worker lacks chrome.storage in CDP context: ${JSON.stringify(workerInfo)}`);
      }

      const navigationExpression = `new Promise((resolve)=>{chrome.storage.local.set({gridFixEnabled:true,gridFixMode:"debugger"},()=>{setTimeout(()=>{chrome.tabs.query({url:"*://*.epicorsaas.com/*"},(tabs)=>{const tab=tabs[0];if(!tab){resolve(JSON.stringify({ok:false,error:"no tab"}));return;}chrome.tabs.update(tab.id,{url:${JSON.stringify(indexUrl)}},()=>resolve(JSON.stringify({ok:true,tabId:tab.id,error:chrome.runtime.lastError&&chrome.runtime.lastError.message})));});},1000);});})`;
      const navigation = parseEvalValue(await workerEval(worker, navigationExpression));
      if (!navigation || !navigation.ok || navigation.error) {
        throw new Error(`extension navigation failed: ${navigation ? JSON.stringify(navigation) : "no result"}`);
      }

      const marker = await waitFor("rewritten main marker", async () => {
        const probeExpression = `new Promise((resolve)=>{chrome.tabs.query({url:"*://*.epicorsaas.com/*"},(tabs)=>{const tab=tabs.find((candidate)=>candidate.url&&candidate.url.indexOf("index.html")>=0)||tabs[0];if(!tab){resolve(JSON.stringify({error:"no tab",result:null}));return;}chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({loaded:!!window.__FAKE_MAIN_LOADED__,marker:window.__KINETIC_GRID_FIX__||null})},(results)=>resolve(JSON.stringify({error:chrome.runtime.lastError&&chrome.runtime.lastError.message,result:results&&results[0]&&results[0].result})));});})`;
        const probe = parseEvalValue(await workerEval(worker, probeExpression));
        if (!probe || probe.error || !probe.result || !probe.result.loaded || !probe.result.marker) {
          return null;
        }
        return probe.result.marker;
      });

      console.log(JSON.stringify({ ok: true, marker }, null, 2));
    } finally {
      worker.close();
    }
  } finally {
    try {
      const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
      const browser = await connectCdp(version.webSocketDebuggerUrl);
      try {
        await browser.send("Browser.close");
      } finally {
        browser.close();
      }
    } catch (error) {
      chrome.kill("SIGTERM");
    }
    server.close();
    await sleep(500);
    if (!chrome.killed) {
      chrome.kill("SIGTERM");
    }
  }

  if (stderr.includes("Extension error")) {
    throw new Error(stderr);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
