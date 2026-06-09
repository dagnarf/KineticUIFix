// Shared CDP helpers for the Track D verification harness.
// Self-contained (no deps): minimal CDP websocket client + the §4 GridLeakMetric + the §3
// marker reader. Adapted from the predecessor plan's .tmp/grid-grouping-leak harness so the
// before/after numbers compare across both plans.

export const DEFAULT_PORT = 9100;

// §4 GridLeakMetric — VERBATIM from 00_shared_context.md (plus a few extra read-only fields).
export const METRIC_SOURCE = `(()=>{const q=(s)=>{try{return document.querySelectorAll(s).length}catch(e){return -1}};
const grid=document.querySelector('kendo-grid')||document.querySelector('.k-grid');
const content=grid?grid.querySelector('.k-grid-content-virtual')||grid.querySelector('.k-grid-content'):null;
const mem=(window.performance&&performance.memory)?performance.memory:null;
const chips=document.querySelectorAll('kendo-grid-group-panel .k-chip,.k-grouping-header .k-group-indicator,.k-grid-group-panel .k-chip');
const tb=grid?grid.querySelector('tbody'):null;
return {heapUsedMB:mem?+(mem.usedJSHeapSize/1048576).toFixed(1):null,
heapTotalMB:mem?+(mem.totalJSHeapSize/1048576).toFixed(1):null,
heapLimitMB:mem?+(mem.jsHeapSizeLimit/1048576).toFixed(1):null,
domNodes:document.getElementsByTagName('*').length,
tbodyRows:tb?tb.children.length:null,
virtualContentPresent:q('.k-grid-content-virtual'),
heightContainerPresent:q('.k-height-container'),
viewportClientH:content?content.clientHeight:null,
scrollH:content?content.scrollHeight:null,
activeGroups:chips.length,
colCount:q('kendo-grid col'),
headerCells:q('.k-grid-header th')};})()`;

// §3 marker reader — proves whether the extension's patch is live on this tab.
// Runtime mode reports both trap installation and actual binding-prototype wrapping; only
// marker.applied/prototypeWrapped=true is an efficacy precondition.
export const MARKER_SOURCE = `(()=>{var m=window.__KINETIC_GRID_FIX__;var r=window.__KINETIC_GRID_REVIRT_RESULT__;return m?{present:true,version:m.version||null,enabled:m.enabled===true,applied:m.applied===true,mode:m.mode||null,bundleHash:m.bundleHash||null,anchorsHit:Array.isArray(m.anchorsHit)?m.anchorsHit.slice(0,12):[],corrections:typeof m.corrections==="number"?m.corrections:null,trapInstalled:m.trapInstalled===true,prototypeWrapped:m.prototypeWrapped===true,scans:typeof m.scans==="number"?m.scans:null,runtimeResult:r?{applied:r.applied===true,mode:r.mode||null,anchorsHit:Array.isArray(r.anchorsHit)?r.anchorsHit.slice(0,12):[],trapInstalled:r.trapInstalled===true,prototypeWrapped:r.prototypeWrapped===true,scans:typeof r.scans==="number"?r.scans:null}:null}:{present:false};})()`;

export const PAGE_CONTEXT_SOURCE = `(()=>({title:document.title,href:location.href,readyState:document.readyState}))()`;

export async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return await response.json();
}

export async function findTarget(browserUrl, pageId) {
  const targets = await readJson(`${browserUrl.replace(/\/$/, "")}/json/list`);
  const target = targets.find((item) => item.id === pageId);
  if (!target) throw new Error(`No CDP page target with id ${pageId}.`);
  if (!target.webSocketDebuggerUrl) throw new Error(`Target ${pageId} has no webSocketDebuggerUrl.`);
  return target;
}

export async function listPageTargets(browserUrl) {
  const targets = await readJson(`${browserUrl.replace(/\/$/, "")}/json/list`);
  return targets.filter((t) => t.type === "page");
}

export class CdpClient {
  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect(timeoutMs = 10000) {
    if (!globalThis.WebSocket) throw new Error("This Node runtime does not expose global WebSocket.");
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("CDP WebSocket connection timed out.")), timeoutMs);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timer); rejectPromise(new Error("CDP WebSocket error.")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("CDP WebSocket is not connected.");
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression, opts = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: opts.userGesture === true,
    });
    if (result.exceptionDetails) throw new Error(`Runtime.evaluate exception: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result?.value ?? null;
  }

  async metric() {
    return this.evaluate(METRIC_SOURCE);
  }

  async marker() {
    return this.evaluate(MARKER_SOURCE);
  }

  async context() {
    return this.evaluate(PAGE_CONTEXT_SOURCE);
  }

  async collectGarbage(waitMs = 1000) {
    await this.send("HeapProfiler.collectGarbage");
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

export function parseFlags(argv, defaults) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--port") args.port = Number(next());
    else if (arg === "--browser-url") args.browserUrl = next();
    else if (arg === "--page-id") args.pageId = next();
    else if (arg === "--label") args.label = next();
    else if (arg === "--out-dir") args.outDir = next();
    else if (arg === "--gc") args.gc = true;
    else if (arg === "--cycles") args.cycles = Number(next());
    else if (arg === "--fields") args.fields = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--wait-ms") args.waitMs = Number(next());
    else if (arg === "--stop-heap-mb") args.stopHeapMB = Number(next());
    else if (arg === "--help" || arg === "-h") { args.help = true; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.browserUrl = args.browserUrl || `http://127.0.0.1:${args.port}`;
  return args;
}

export function safeFilePart(value) {
  return String(value).trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "metric";
}
