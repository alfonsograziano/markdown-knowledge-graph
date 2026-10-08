/* Knowledge Graph viewer. Plain browser JS, no build step. Runs offline inside data/graph.html.
   Uses graphology (model), graphology-library (ForceAtlas2, Louvain) and sigma (WebGL). */
(function () {
"use strict";

const T = { start: performance.now() };
const RAW = window.__GRAPH__;
const LIB = window.graphologyLibrary;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n.toLocaleString("en-US");
// Let the browser paint the loading message. The timeout also covers a hidden tab, where frames never come.
const nextFrame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 50); });
const store = {
  get(k, d) { try { const v = localStorage.getItem("mdkg:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("mdkg:" + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked: fine */ } },
};
const MOBILE = () => window.matchMedia("(max-width:860px)").matches;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.replace(/./g, "$&$&"); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); }
function rgba(h, a) { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a.toFixed(3)})`; }
const DAY = 864e5;
const dayNum = (s) => (s ? Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY) : null);
const dayStr = (d) => new Date(d * DAY).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const prettyDate = (s) => (s ? dayStr(dayNum(s)) : "");

/* ------------------------------------------------------------------ 1. model */

const TYPE_LABEL = { file: "untyped file" };
const PALETTE = {
  light: {
    typeList: ["#4f46e5", "#c2410c", "#2563eb", "#be185d", "#d97706", "#0f766e", "#b91c1c", "#15803d", "#475569", "#7c3aed"],
    file: "#857f6e",
    types: {},
    comm: ["#e15759", "#4e79a7", "#59a14f", "#f28e2b", "#b07aa1", "#2aa1a8", "#c9a227", "#ff8fa3", "#9c755f", "#6b8e23", "#8c6bb1", "#d35400"],
    other: "#b3b0a6",
  },
  dark: {
    typeList: ["#8b85ff", "#fb923c", "#60a5fa", "#f472b6", "#fbbf24", "#2dd4bf", "#f87171", "#4ade80", "#94a3b8", "#c4b5fd"],
    file: "#a8a395",
    types: {},
    comm: ["#ff7b7d", "#6fa3d9", "#7cc56f", "#ffa94d", "#cf9bc4", "#4fc6cc", "#e8c547", "#ffa3b5", "#c49a7c", "#9cc254", "#ad8fd6", "#ff8a4c"],
    other: "#5d5b55",
  },
};

const N = []; // nodes: files first, then entities
for (const f of RAW.files) {
  N.push({ kind: "file", key: f.key, name: f.title || f.key, type: f.type || "file", status: f.status, path: f.path, folder: f.folder, inScope: f.in_scope });
}
const FILE_COUNT = N.length;
for (const [uuid, name, summary, labels] of RAW.entities) {
  N.push({ kind: "entity", key: uuid, name, summary, labels: labels || [] });
}
const n = N.length;
const FACTS = RAW.facts.map(([s, t, rel, text, valid, invalid, sources]) => ({ s, t, rel, text, valid, invalid, v: dayNum(valid), x: dayNum(invalid), sources }));

// Merge parallel edges: one drawn edge per pair and layer, the details stay in lists.
const E = []; // {kind, s, t, items}
const edgeIndex = new Map();
const adj = Array.from({ length: n }, () => []);
function edgeFor(kind, s, t) {
  const k = kind + (s < t ? s + "-" + t : t + "-" + s);
  let i = edgeIndex.get(k);
  if (i === undefined) {
    i = E.length; edgeIndex.set(k, i);
    E.push({ kind, s, t, items: [] });
    adj[s].push(i); adj[t].push(i);
  }
  return E[i];
}
const linksOut = Array.from({ length: FILE_COUNT }, () => []);
const linksIn = Array.from({ length: FILE_COUNT }, () => []);
for (const [s, t, rel, field] of RAW.layer1) {
  linksOut[s].push({ to: t, rel, field }); linksIn[t].push({ from: s, rel, field });
  if (s !== t) edgeFor("exact", s, t).items.push({ s, t, rel, field });
}
const factsOf = Array.from({ length: n }, () => []);
const factsFromFile = Array.from({ length: FILE_COUNT }, () => []);
FACTS.forEach((f, k) => {
  factsOf[f.s].push(k); if (f.t !== f.s) factsOf[f.t].push(k);
  for (const src of f.sources) factsFromFile[src].push(k);
  if (f.s !== f.t) edgeFor("fact", f.s, f.t).items.push(k);
});
const sourcesOf = Array.from({ length: n }, () => []); // entity -> [{f, c}]
const mentionsOf = Array.from({ length: FILE_COUNT }, () => []); // file -> [{e, c}]
let mentionTotal = 0;
for (const [f, e, c] of RAW.mentions) {
  sourcesOf[e].push({ f, c }); mentionsOf[f].push({ e, c }); mentionTotal++;
  edgeFor("mention", f, e).items.push(c);
}
const deg = adj.map((a) => a.length);
const hasDated = new Uint8Array(n);
for (const f of FACTS) if (f.v != null) { hasDated[f.s] = 1; hasDated[f.t] = 1; }

// Importance decides who gets a label first. Files get a small bonus: they are your own notes.
const importance = N.map((nd, i) => deg[i] * (nd.kind === "file" ? 1.6 : 1) + (nd.kind === "file" ? 2 : 0));
const ORDER = Array.from({ length: n }, (_, i) => i).sort((a, b) => importance[b] - importance[a]);
const nodeSize = (i) => Math.min(22, (N[i].kind === "file" ? 4.2 : 2.4) + (N[i].kind === "file" ? 1.7 : 1.55) * Math.sqrt(deg[i]));

// File types come from the `type` frontmatter field: most common first, untyped files last.
const typeCounts = new Map();
for (const x of N) if (x.kind === "file") typeCounts.set(x.type, (typeCounts.get(x.type) || 0) + 1);
const types = [...typeCounts.keys()].sort((a, b) => (a === "file") - (b === "file") || typeCounts.get(b) - typeCounts.get(a));
for (const mode of ["light", "dark"]) {
  const P = PALETTE[mode];
  types.forEach((t, i) => { P.types[t] = t === "file" ? P.file : P.typeList[i % P.typeList.length]; });
  P.types.file = P.file;
}
const folderCounts = new Map();
for (let i = 0; i < FILE_COUNT; i++) folderCounts.set(N[i].folder, (folderCounts.get(N[i].folder) || 0) + 1);
const folders = [...folderCounts.keys()].sort();
// The date slider moves through the facts, not through the calendar: every step passes the same number
// of facts. Most facts are recent, and one old date (a birthday in 1975) would otherwise squeeze them
// all into the last pixel. At either end the range is open, so nothing is cut off.
const DAYS = FACTS.map((f) => f.v).filter((d) => d != null).sort((a, b) => a - b);
const STEPS = 200;
const hasDates = DAYS.length > 1 && DAYS[DAYS.length - 1] > DAYS[0];
const stepDay = (k) => DAYS[Math.round((k / STEPS) * (DAYS.length - 1))];
const dMin = 0, dMax = STEPS;

/* ------------------------------------------------------------------ 2. state */

const DEFAULTS = () => ({
  layers: { files: true, entities: true, exact: true, facts: true, mentions: false, expired: false },
  types: new Set(types), folders: new Set(folders), minDeg: 0,
  from: hasDates ? dMin : 0, to: hasDates ? dMax : 0, undated: true, community: null,
});
const S = Object.assign(DEFAULTS(), { focus: 0, selected: null, hovered: null, density: store.get("density", 2), theme: store.get("theme", "system"), query: "" });

const vis = new Uint8Array(n);
const evis = new Uint8Array(E.length);
const factOK = new Uint8Array(FACTS.length);
let hl = null, hlCenter = null, searchSet = null;

/* ------------------------------------------------------------------ 3. theme */

let C = null; // current colors
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue(k).trim();
  const dark = v("color-scheme") === "dark";
  const P = dark ? PALETTE.dark : PALETTE.light;
  C = { dark, P, bg: v("--g-bg"), exact: v("--g-exact"), fact: v("--g-fact"), mention: v("--g-mention"), label: v("--g-label"), halo: v("--g-halo"), dim: v("--g-dim"), accent: v("--accent"), muted: v("--muted") };
}
let labelSoft = "#333";
function applyTheme() {
  const t = S.theme;
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  $("#btn-theme").title = "Theme: " + (t === "system" ? "follows the system" : t) + " (click to change)";
  readTheme();
  labelSoft = rgba(C.label, 0.82);
}
const commColor = (c) => (c != null && c < C.P.comm.length ? C.P.comm[c] : C.P.other);
function baseColor(i) { const nd = N[i]; return nd.kind === "file" ? C.P.types[nd.type] || C.P.types.file : commColor(COMM[i]); }

/* ------------------------------------------------------------------ 4. communities */

let COMM = new Int32Array(n).fill(-1);
let COMMS = []; // [{id, size, name}] sorted by entity count
function computeCommunities() {
  const g = new graphology.UndirectedGraph();
  for (let i = 0; i < n; i++) g.addNode(i);
  for (const e of E) {
    const w = e.kind === "fact" ? Math.min(3, e.items.length) : e.kind === "exact" ? 1 : 0.5;
    g.addEdge(e.s, e.t, { weight: w });
  }
  const res = LIB.communitiesLouvain.detailed(g, { getEdgeWeight: "weight", rng: mulberry32(7), resolution: 1 });
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const c = res.communities[i];
    if (!groups.has(c)) groups.set(c, { raw: c, members: [], entities: 0 });
    const gr = groups.get(c); gr.members.push(i); if (N[i].kind === "entity") gr.entities++;
  }
  const sorted = [...groups.values()].filter((g2) => g2.entities > 0).sort((a, b) => b.entities - a.entities);
  COMMS = sorted.map((gr, id) => {
    const top = gr.members.filter((i) => N[i].kind === "entity").sort((a, b) => deg[b] - deg[a]).slice(0, 2).map((i) => N[i].name);
    for (const i of gr.members) COMM[i] = id;
    return { id, size: gr.entities, name: top.join(", "), members: gr.members };
  });
  for (const gr of groups.values()) if (gr.entities === 0) for (const i of gr.members) COMM[i] = -1;
  return res.modularity;
}

/* ------------------------------------------------------------------ 5. visibility */

function recompute() {
  const L = S.layers;
  const narrowDates = hasDates && (S.from > dMin || S.to < dMax);
  const loDay = S.from > dMin ? stepDay(S.from) : -Infinity, hiDay = S.to < dMax ? stepDay(S.to) : Infinity;
  for (let k = 0; k < FACTS.length; k++) {
    const f = FACTS[k];
    let ok = L.facts && (!f.invalid || L.expired);
    // A fact counts as in the range when it became true inside the range (its valid_at date).
    if (ok && narrowDates) ok = f.v == null ? S.undated : f.v >= loDay && f.v <= hiDay;
    else if (ok && f.v == null) ok = S.undated;
    factOK[k] = ok ? 1 : 0;
  }
  const typeFilter = S.types.size < types.length, folderFilter = S.folders.size < folders.length;
  const fileBase = (i) => S.types.has(N[i].type) && S.folders.has(N[i].folder);
  for (let i = 0; i < n; i++) {
    const nd = N[i];
    let ok = deg[i] >= S.minDeg && (S.community == null || COMM[i] === S.community);
    if (nd.kind === "file") ok = ok && L.files && fileBase(i);
    else {
      ok = ok && L.entities;
      if (ok && (typeFilter || folderFilter) && sourcesOf[i].length) ok = sourcesOf[i].some((s) => fileBase(s.f));
      if (ok && narrowDates && hasDated[i]) ok = factsOf[i].some((k) => factOK[k] && FACTS[k].v != null);
    }
    vis[i] = ok ? 1 : 0;
  }
  if (S.selected != null) vis[S.selected] = 1;
  const focusOn = S.focus > 0 && S.selected != null;
  for (let e = 0; e < E.length; e++) {
    const ed = E[e];
    let ok = vis[ed.s] && vis[ed.t];
    if (ok) {
      if (ed.kind === "exact") ok = L.exact;
      else if (ed.kind === "fact") ok = ed.items.some((k) => factOK[k]);
      else ok = L.mentions || focusOn;
    }
    evis[e] = ok ? 1 : 0;
  }
  if (focusOn) {
    // Breadth-first walk from the selected node, over edges that are drawn.
    const keep = new Uint8Array(n); keep[S.selected] = 1;
    let frontier = [S.selected];
    for (let h = 0; h < S.focus; h++) {
      const next = [];
      for (const i of frontier) for (const e of adj[i]) {
        if (!evis[e]) continue;
        const j = E[e].s === i ? E[e].t : E[e].s;
        if (!keep[j]) { keep[j] = 1; next.push(j); }
      }
      frontier = next;
    }
    for (let i = 0; i < n; i++) if (!keep[i]) vis[i] = 0;
    for (let e = 0; e < E.length; e++) if (evis[e] && !(vis[E[e].s] && vis[E[e].t])) evis[e] = 0;
  }
  updateHighlight();
  updateCounters();
}

function updateHighlight() {
  const c = S.hovered != null ? S.hovered : S.selected;
  if (c == null) { hl = null; hlCenter = null; return; }
  hlCenter = c; hl = new Set([c]);
  for (const e of adj[c]) if (evis[e] || E[e].kind === "mention") {
    const j = E[e].s === c ? E[e].t : E[e].s;
    if (vis[j]) hl.add(j);
  }
}

function updateCounters() {
  let vn = 0, ve = 0;
  for (let i = 0; i < n; i++) vn += vis[i];
  for (let e = 0; e < E.length; e++) ve += evis[e];
  $("#visible").textContent = vn === n ? `${fmt(n)} nodes · ${fmt(ve)} edges` : `Showing ${fmt(vn)} of ${fmt(n)} nodes · ${fmt(ve)} edges`;
  let hidden = 0;
  if (S.minDeg > 0) for (let i = 0; i < n; i++) if (deg[i] < S.minDeg) hidden++;
  $("#mindeg-note").textContent = S.minDeg > 0 ? `Hides ${fmt(hidden)} nodes with fewer than ${S.minDeg} connections.` : "Hide nodes with fewer connections.";
}

/* ------------------------------------------------------------------ 6. graph and renderer */

const graph = new graphology.Graph({ type: "undirected", multi: false, allowSelfLoops: false });
let sigma = null;
let zoomBucket = 0;
const ALPHA = { // per zoom bucket, from far away to very close
  exact: [0.32, 0.42, 0.55, 0.7, 0.85],
  fact: [0.14, 0.22, 0.34, 0.5, 0.65],
  mention: [0.06, 0.1, 0.15, 0.22, 0.3],
};
const crowd = E.length > 6000 ? 0.7 : E.length > 2500 ? 0.85 : 1;
const bucketFor = (r) => (r > 1.1 ? 0 : r > 0.55 ? 1 : r > 0.28 ? 2 : r > 0.14 ? 3 : 4);

// Edge colours as ready-made strings, one set per layer, so the reducer does no string work.
let EDGE_COLORS = {};
function paintEdges() {
  for (const kind of ["exact", "fact", "mention"]) {
    const base = C[kind];
    EDGE_COLORS[kind] = { strong: rgba(base, 0.95), mid: rgba(base, 0.25), search: rgba(base, 0.7), ghost: rgba(base, 0.04), zoom: ALPHA[kind].map((a) => rgba(base, a * crowd)) };
  }
}
function paintNodes() {
  paintEdges();
  graph.forEachNode((key, a) => {
    const i = a.i, col = baseColor(i), dim = mix(col, C.bg, C.dark ? 0.78 : 0.8);
    const file = N[i].kind === "file";
    graph.mergeNodeAttributes(key, { color: col, ring: col, gap: file ? C.bg : col, dim });
  });
}

function buildGraph() {
  for (let i = 0; i < n; i++) graph.addNode(i, { i, x: 0, y: 0, size: nodeSize(i), label: null, color: "#999", ring: "#999", gap: "#999", dim: "#ccc" });
  E.forEach((e, k) => {
    const type = e.kind === "exact" ? "arrow" : e.kind === "fact" ? "curve" : "line";
    const size = e.kind === "exact" ? 1.6 : e.kind === "fact" ? Math.min(3.2, 1 + 0.5 * (e.items.length - 1)) : 0.7;
    const w = e.kind === "fact" ? Math.min(3, e.items.length) : e.kind === "exact" ? 1.5 : 0.4;
    graph.addEdgeWithKey(k, e.s, e.t, { ei: k, type, size, weight: w, curvature: 0.18 });
  });
}

function nodeReducer(key, a) {
  const i = a.i;
  if (!vis[i]) return { x: a.x, y: a.y, hidden: true };
  const r = { x: a.x, y: a.y, size: a.size, color: a.color, ring: a.ring, gap: a.gap, label: null, zIndex: 1 };
  const focusSet = hl || searchSet;
  if (focusSet && !focusSet.has(i)) { r.color = r.ring = r.gap = a.dim; r.zIndex = 0; }
  else if (focusSet) r.zIndex = 2;
  if (i === S.selected) { r.ring = C.label; r.gap = C.bg; r.size = a.size * 1.15; r.zIndex = 3; }
  return r;
}

function edgeReducer(key, a) {
  const e = a.ei;
  if (!evis[e]) return { hidden: true };
  const ed = E[e];
  const col = EDGE_COLORS[ed.kind];
  const r = { size: a.size, type: a.type, curvature: a.curvature, zIndex: 0 };
  if (hl) {
    if (ed.s === hlCenter || ed.t === hlCenter) { r.color = col.strong; r.size = a.size * 1.5; r.zIndex = 2; }
    else if (hl.has(ed.s) && hl.has(ed.t)) r.color = col.mid;
    else return { hidden: true };
  } else if (searchSet) {
    r.color = searchSet.has(ed.s) && searchSet.has(ed.t) ? col.search : col.ghost;
  } else {
    r.color = col.zoom[zoomBucket];
  }
  return r;
}

// One factor for all node sizes: about 1 on a laptop screen with 2,000 nodes, smaller on a phone or with 5,000.
let sizeScale = 1;
function updateSizeScale() {
  const r = $("#stage").getBoundingClientRect();
  sizeScale = Math.max(0.35, Math.min(1, Math.sqrt((r.width * r.height) / Math.max(1, n)) / 24));
}

function makeRenderer() {
  updateSizeScale();
  const R = Sigma.rendering;
  const NodeProgram = R.createNodeBorderProgram({
    borders: [
      { size: { value: 0.3 }, color: { attribute: "ring" } },
      { size: { value: 0.22 }, color: { attribute: "gap" } },
      { size: { fill: true }, color: { attribute: "color" } },
    ],
  });
  sigma = new Sigma(graph, $("#sigma"), {
    renderLabels: false,
    renderEdgeLabels: false,
    defaultNodeType: "ringed",
    nodeProgramClasses: { ringed: NodeProgram },
    nodeHoverProgramClasses: { ringed: NodeProgram },
    edgeProgramClasses: { arrow: R.EdgeArrowProgram, curve: R.EdgeCurveProgram, line: R.EdgeLineProgram },
    defaultDrawNodeHover: () => {},
    nodeReducer, edgeReducer,
    zIndex: true,
    minEdgeThickness: 0.5,
    minCameraRatio: 0.008,
    maxCameraRatio: 4,
    stagePadding: 40,
    itemSizesReference: "screen",
    // Nodes grow slower than the zoom, and shrink on small screens or in big graphs.
    zoomToSizeRatioFunction: (r) => Math.sqrt(r) / sizeScale,
    hideEdgesOnMove: E.length > 20000,
    allowInvalidContainer: true,
  });
  sigma.getCamera().on("updated", (st) => {
    const b = bucketFor(st.ratio);
    if (b !== zoomBucket) { zoomBucket = b; sigma.refresh({ skipIndexation: true }); }
  });
  sigma.on("afterRender", drawLabels);
}

/* ------------------------------------------------------------------ 7. labels: level of detail, no overlap */

const lc = $("#labels"), lctx = lc.getContext("2d");
let dpr = 1;
function sizeLabelCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = $("#stage").getBoundingClientRect();
  lc.width = Math.round(r.width * dpr); lc.height = Math.round(r.height * dpr);
}
// [min rendered radius in px for an unforced label, max labels on screen]
const DENSITY = [[12, 30], [9, 80], [6.5, 180], [4.2, 400], [2.5, 1000]];
const DENSITY_NAME = ["fewest", "fewer", "normal", "more", "most"];
const widthCache = new Map();
function textWidth(text, font) {
  const k = font + "|" + text;
  let w = widthCache.get(k);
  if (w === undefined) { lctx.font = font; w = lctx.measureText(text).width; widthCache.set(k, w); }
  return w;
}
const clip = (s, m) => (s.length > m ? s.slice(0, m - 1).trimEnd() + "…" : s);
let lastLabelCount = 0, lastDraws = [];

// A small spatial hash: boxes go into 40 px cells, so a collision test only looks at its neighbours.
function makeGrid() {
  const CELL = 40, cells = new Map();
  const span = (x, y, w, h, fn) => {
    const x0 = Math.floor(x / CELL), x1 = Math.floor((x + w) / CELL), y0 = Math.floor(y / CELL), y1 = Math.floor((y + h) / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) if (fn(gx * 100003 + gy)) return true;
    return false;
  };
  return {
    hit(x, y, w, h, skip = -1) {
      return span(x, y, w, h, (k) => {
        const list = cells.get(k);
        if (list) for (const b of list) if (b[4] !== skip && x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return true;
        return false;
      });
    },
    add(x, y, w, h, owner = -2) {
      const b = [x, y, w, h, owner];
      span(x, y, w, h, (k) => { let list = cells.get(k); if (!list) cells.set(k, (list = [])); list.push(b); return false; });
    },
  };
}

const PX = new Float32Array(n), PY = new Float32Array(n), PR = new Float32Array(n), ON = new Uint8Array(n);
function drawLabels() {
  if (!sigma) return;
  const W = lc.width / dpr, H = lc.height / dpr;
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lctx.clearRect(0, 0, W, H);
  const [minR, maxBase] = DENSITY[S.density];
  const maxLabels = Math.round(maxBase * Math.min(1.6, Math.max(0.3, (W * H) / (1200 * 800))));
  // Where every node is on screen. Nodes are obstacles too: a label only shows where there is free room.
  const nodes = makeGrid(), labels = makeGrid();
  for (let i = 0; i < n; i++) {
    ON[i] = 0;
    if (!vis[i]) continue;
    const d = sigma.getNodeDisplayData(i);
    if (!d || d.hidden) continue;
    const p = sigma.framedGraphToViewport(d), r = sigma.scaleSize(d.size);
    if (p.x < -320 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
    ON[i] = 1; PX[i] = p.x; PY[i] = p.y; PR[i] = r;
    if (r >= 1.2) { const q = r * 0.85; nodes.add(p.x - q, p.y - q, 2 * q, 2 * q, i); }
  }
  const done = new Uint8Array(n);
  let placed = 0;
  const draws = [];
  function place(i, forced, strong) {
    if (done[i] || !ON[i]) return;
    const r = PR[i], px = PX[i], py = PY[i];
    if (!forced && r < minR) return;
    const file = N[i].kind === "file";
    const fs = strong ? 13 : file ? 12 : 11.5;
    const font = `${strong ? 650 : file ? 600 : 450} ${fs}px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif`;
    const text = clip(N[i].name, strong ? 64 : forced ? 40 : 30);
    const w = textWidth(text, font) + 4, h = fs + 4;
    const spots = [[px + r + 3, py - h / 2], [px - r - 3 - w, py - h / 2], [px - w / 2, py - r - h - 1], [px - w / 2, py + r + 1]];
    for (let s = 0; s < (forced ? 4 : 2); s++) {
      const [x, y] = spots[s];
      if (!forced && (x < 0 || x + w > W || y < 0 || y + h > H)) continue;
      if (labels.hit(x, y, w, h)) continue;
      if (!forced && nodes.hit(x, y, w, h, i)) continue;
      labels.add(x, y, w, h); done[i] = 1; placed++;
      draws.push([text, font, x + 2, y + h / 2, strong, file, w, h, i]);
      return;
    }
    if (strong) { // the hovered or selected node always gets its label
      const [x, y] = spots[0];
      labels.add(x, y, w, h); done[i] = 1; placed++;
      draws.push([text, font, x + 2, y + h / 2, strong, file]);
    }
  }
  // Labels that must show: the hovered or selected node, then its neighbours, then search hits.
  if (hlCenter != null) place(hlCenter, true, true);
  if (S.selected != null && S.selected !== hlCenter) place(S.selected, true, true);
  if (hl) [...hl].sort((a, b) => importance[b] - importance[a]).forEach((i) => place(i, true, false));
  if (searchSet) for (const i of searchTop) place(i, true, false);
  // Then everything else, most important first, while there is room.
  if (!hl && !searchSet) {
    for (let k = 0; k < ORDER.length && placed < maxLabels; k++) place(ORDER[k], false, false);
  }
  lctx.textBaseline = "middle";
  lctx.lineJoin = "round";
  for (const [text, font, x, y, strong, file] of draws) {
    lctx.font = font;
    lctx.lineWidth = 3.5; lctx.strokeStyle = C.halo; lctx.strokeText(text, x, y);
    lctx.fillStyle = file || strong ? C.label : labelSoft;
    lctx.fillText(text, x, y);
  }
  lastLabelCount = placed; lastDraws = draws;
}

/* ------------------------------------------------------------------ 8. layout (ForceAtlas2) */

const POS_KEY = "pos:v1";
let layout = null, layoutTimer = null, layoutRAF = null;
const layoutState = { running: false, started: 0, settledMs: null, mode: "" };

function seedPositions(useCache) {
  const cache = useCache ? store.get(POS_KEY, {}) : {};
  const rnd = mulberry32(42);
  let hits = 0;
  const placed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = cache[N[i].key];
    if (p) { graph.mergeNodeAttributes(i, { x: p[0], y: p[1] }); placed[i] = 1; hits++; }
  }
  // Start each community as its own blob, laid out on a spiral, so ForceAtlas2 only has to refine.
  const size = new Map();
  for (let i = 0; i < n; i++) if (COMM[i] >= 0) size.set(COMM[i], (size.get(COMM[i]) || 0) + 1);
  const spread = Math.sqrt(n) * 4;
  const center = (c) => { const a = c * 2.39996, r = spread * Math.sqrt(c + 0.5); return [Math.cos(a) * r, Math.sin(a) * r]; };
  const later = [];
  for (let i = 0; i < n; i++) {
    if (placed[i]) continue;
    // Nodes new since the last visit start next to a neighbour that already has a place.
    const near = hits ? adj[i].map((e) => (E[e].s === i ? E[e].t : E[e].s)).find((j) => placed[j]) : undefined;
    let x, y;
    if (near != null) {
      const a = graph.getNodeAttributes(near);
      x = a.x + (rnd() - 0.5) * 20; y = a.y + (rnd() - 0.5) * 20;
    } else if (COMM[i] >= 0) {
      const [cx, cy] = center(COMM[i]), rad = Math.sqrt(size.get(COMM[i])) * 3 * Math.sqrt(rnd()), ang = rnd() * Math.PI * 2;
      x = cx + Math.cos(ang) * rad; y = cy + Math.sin(ang) * rad;
    } else { later.push(i); continue; }
    graph.mergeNodeAttributes(i, { x, y }); placed[i] = 1;
  }
  for (const i of later) {
    const near = adj[i].map((e) => (E[e].s === i ? E[e].t : E[e].s)).find((j) => placed[j]);
    const a = near != null ? graph.getNodeAttributes(near) : { x: (rnd() - 0.5) * spread * 8, y: (rnd() - 0.5) * spread * 8 };
    graph.mergeNodeAttributes(i, { x: a.x + (rnd() - 0.5) * 20, y: a.y + (rnd() - 0.5) * 20 }); placed[i] = 1;
  }
  return hits / n;
}

function savePositions() {
  const out = {};
  graph.forEachNode((k, a) => { out[N[a.i].key] = [Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10]; });
  store.set(POS_KEY, out);
}

function fa2Settings() {
  const s = LIB.layoutForceAtlas2.inferSettings(graph);
  // LinLog pulls groups apart, which makes clusters easy to see.
  return Object.assign(s, { barnesHutOptimize: n > 900, barnesHutTheta: 1, linLogMode: true, scalingRatio: 2, gravity: 1, strongGravityMode: false, slowDown: 1.5, edgeWeightInfluence: 1, adjustSizes: false, outboundAttractionDistribution: false });
}

function extentOf() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  graph.forEachNode((k, a) => { if (a.x < x0) x0 = a.x; if (a.x > x1) x1 = a.x; if (a.y < y0) y0 = a.y; if (a.y > y1) y1 = a.y; });
  return Math.hypot(x1 - x0, y1 - y0) || 1;
}

function startLayout(maxMs) {
  stopLayout(false);
  const settings = fa2Settings();
  layoutState.running = true; layoutState.started = performance.now(); layoutState.settledMs = null; layoutState.trace = []; layoutState.iterations = 0;
  $("#layoutpill").classList.add("on");
  $("#layoutmsg").textContent = "Settling layout…";
  let prev = new Float64Array(n * 2), calm = 0, lastIters = -1;
  graph.forEachNode((k, a) => { prev[a.i * 2] = a.x; prev[a.i * 2 + 1] = a.y; });
  const check = () => {
    // Stop when nodes barely move any more, or when time is up.
    const ext = extentOf();
    let move = 0;
    graph.forEachNode((k, a) => { move += Math.hypot(a.x - prev[a.i * 2], a.y - prev[a.i * 2 + 1]); prev[a.i * 2] = a.x; prev[a.i * 2 + 1] = a.y; });
    const rel = move / n / ext;
    const t = performance.now() - layoutState.started;
    // ForceAtlas2 never stops fully; below this the picture no longer changes in a way you can see.
    if (layoutState.mode === "main thread" && layoutState.iterations === lastIters) { if (t > maxMs) stopLayout(true); return; } // nothing ran yet
    lastIters = layoutState.iterations;
    calm = rel < 0.005 ? calm + 1 : 0;
    layoutState.trace = (layoutState.trace || []).concat([[Math.round(t), +rel.toFixed(5)]]);
    $("#layoutbar").style.transform = `scaleX(${Math.min(1, Math.max(t / maxMs, Math.min(1, 0.005 / Math.max(rel, 1e-9))))})`;
    if (calm >= 2 || t > maxMs) stopLayout(true);
  };
  try {
    if (/[?&]noworker\b/.test(location.search)) throw new Error("worker disabled by ?noworker");
    layout = new LIB.FA2Layout(graph, { settings, getEdgeWeight: "weight" });
    layout.start();
    layoutState.mode = "worker";
  } catch (err) {
    // No web worker (some browsers block them on file:// pages): run on the main thread in small steps.
    layout = null; layoutState.mode = "main thread";
    // setTimeout, not requestAnimationFrame, so it also runs while the tab is in the background.
    let iters = 2;
    const step = () => {
      if (!layoutState.running) return;
      const t0 = performance.now();
      LIB.layoutForceAtlas2.assign(graph, { iterations: iters, settings, getEdgeWeight: "weight" });
      layoutState.iterations += iters;
      const dt = performance.now() - t0;
      iters = Math.max(1, Math.min(40, Math.round(iters * (12 / Math.max(dt, 1)))));
      layoutRAF = setTimeout(step, 0);
    };
    layoutRAF = setTimeout(step, 0);
  }
  layoutTimer = setInterval(check, 400);
}

function stopLayout(finished) {
  if (layout) { layout.kill(); layout = null; }
  if (layoutRAF) clearTimeout(layoutRAF), (layoutRAF = null);
  if (layoutTimer) clearInterval(layoutTimer), (layoutTimer = null);
  if (!layoutState.running) return;
  layoutState.running = false;
  layoutState.settledMs = Math.round(performance.now() - layoutState.started);
  $("#layoutpill").classList.remove("on");
  if (finished !== false) savePositions();
  T.layout = layoutState.settledMs;
  console.info(`[mdkg] layout settled in ${layoutState.settledMs} ms (${layoutState.mode})`);
}

/* ------------------------------------------------------------------ 9. camera helpers */

// Frame a set of nodes. Works in screen pixels at the current zoom, so it is exact whatever the aspect ratio.
function frame(ids, centerOn, pad = 1.3) {
  const cam = sigma.getCamera(), { width: W, height: H } = sigma.getDimensions();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, c = 0;
  for (const i of ids) {
    const d = sigma.getNodeDisplayData(i);
    if (!d || d.hidden) continue;
    const p = sigma.framedGraphToViewport(d);
    c++; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  if (!c) return;
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, bw = x1 - x0, bh = y1 - y0;
  if (centerOn != null) {
    const d = sigma.getNodeDisplayData(centerOn), p = sigma.framedGraphToViewport(d);
    cx = p.x; cy = p.y; bw = 2 * Math.max(p.x - x0, x1 - p.x); bh = 2 * Math.max(p.y - y0, y1 - p.y);
  }
  // On a phone the details sheet covers the bottom of the screen: frame the part above it.
  const sheet = MOBILE() && $("#panel").classList.contains("open") ? $("#panel").offsetHeight : 0;
  const availH = Math.max(120, H - sheet);
  const k = Math.max(bw / W, bh / availH) * pad;
  const ratio = Math.max(0.02, Math.min(1.1, k > 0 ? cam.ratio * k : 0.08));
  const target = sigma.viewportToFramedGraph({ x: cx, y: cy });
  if (sheet) {
    // Shift the camera down by half the sheet, measured in graph units at the new zoom.
    const a = sigma.viewportToFramedGraph({ x: 0, y: 0 }), b = sigma.viewportToFramedGraph({ x: 0, y: sheet / 2 });
    const f = ratio / cam.ratio;
    target.x += (b.x - a.x) * f; target.y += (b.y - a.y) * f;
  }
  cam.animate({ x: target.x, y: target.y, ratio }, { duration: 500 });
}
// Move the camera so the node and its direct neighbours fill most of the screen.
function flyTo(i) {
  const ids = [i];
  for (const e of adj[i]) if (evis[e]) ids.push(E[e].s === i ? E[e].t : E[e].s);
  frame(ids, i, 1.35);
}
function fitVisible() {
  const ids = [];
  for (let i = 0; i < n; i++) if (vis[i]) ids.push(i);
  if (ids.length === n) return sigma.getCamera().animatedReset({ duration: 450 });
  frame(ids, null, 1.25);
}

/* ------------------------------------------------------------------ 10. interactions */

function select(i, opts = {}) {
  S.selected = i;
  if (i == null) {
    S.focus = 0; $("#panel").classList.remove("open");
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* file:// may refuse */ }
  }
  else {
    renderPanel(i);
    try { history.replaceState(null, "", "#" + encodeURIComponent(N[i].key)); } catch (e) { /* file:// may refuse */ }
  }
  recompute();
  sigma.resize(); sizeLabelCanvas(); // the panel may have just opened or closed
  sigma.refresh({ skipIndexation: true });
  if (i != null && S.focus > 0) setTimeout(fitVisible, 30);
  else if (i != null && opts.fly) flyTo(i);
}

function setFocus(h) {
  if (S.selected == null) { toast("Select a node first"); return; }
  S.focus = h;
  recompute(); sigma.refresh({ skipIndexation: true });
  renderPanel(S.selected);
  setTimeout(fitVisible, 30);
}

let dragged = null, dragMoved = false;
function wireSigmaEvents() {
  const tip = $("#tip");
  sigma.on("enterNode", ({ node }) => {
    S.hovered = +node; updateHighlight(); sigma.refresh({ skipIndexation: true });
    $("#sigma").style.cursor = "pointer";
    const nd = N[+node];
    const kind = nd.kind === "file" ? (TYPE_LABEL[nd.type] || nd.type) : "entity";
    tip.innerHTML = `<div>${esc(nd.name)}</div><div class="k">${esc(kind)} · ${fmt(deg[+node])} connection${deg[+node] === 1 ? "" : "s"}${nd.kind === "entity" && factsOf[+node].length ? " · " + fmt(factsOf[+node].length) + " facts" : ""}</div>`;
    const d = sigma.getNodeDisplayData(node), p = sigma.framedGraphToViewport(d), r = sigma.scaleSize(d.size);
    const W = $("#stage").clientWidth;
    tip.style.display = "block";
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(W - tw - 8, Math.max(8, p.x - tw / 2)) + "px";
    tip.style.top = Math.max(8, p.y - r - tip.offsetHeight - 10) + "px";
  });
  sigma.on("leaveNode", () => {
    S.hovered = null; updateHighlight(); sigma.refresh({ skipIndexation: true });
    $("#sigma").style.cursor = ""; tip.style.display = "none";
  });
  sigma.on("clickNode", ({ node }) => { if (dragMoved) return; select(+node); });
  sigma.on("clickStage", () => { if (dragMoved) return; if (S.selected != null) select(null); });
  sigma.on("doubleClickNode", (e) => { e.preventSigmaDefault(); select(+e.node, { fly: true }); });
  // Drag a node to move it.
  sigma.on("downNode", (e) => {
    dragged = +e.node; dragMoved = false;
    graph.setNodeAttribute(dragged, "fixed", true);
    if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
  });
  sigma.getMouseCaptor().on("mousemovebody", (e) => {
    if (dragged == null) return;
    dragMoved = true; tip.style.display = "none";
    const p = sigma.viewportToGraph(e);
    graph.mergeNodeAttributes(dragged, { x: p.x, y: p.y });
    e.preventSigmaDefault(); e.original.preventDefault(); e.original.stopPropagation();
  });
  const up = () => {
    if (dragged != null) { graph.removeNodeAttribute(dragged, "fixed"); if (dragMoved && !layoutState.running) savePositions(); }
    dragged = null; setTimeout(() => (dragMoved = false), 0);
  };
  sigma.getMouseCaptor().on("mouseup", up);
  sigma.getMouseCaptor().on("mouseleave", up);
}

/* ------------------------------------------------------------------ 11. search */

const SEARCH = N.map((nd, i) => ({ i, s: nd.name.toLowerCase(), p: nd.kind === "file" ? nd.path.toLowerCase() : "" }));
let searchTop = [], active = 0;
const isSep = (ch) => ch === undefined || /[\s\-_/.,:;()'"&]/.test(ch);
function scoreToken(tok, s) {
  const idx = s.indexOf(tok);
  if (idx >= 0) return { score: 1000 - idx * 2 - (s.length - tok.length) * 0.3 + (isSep(s[idx - 1]) ? 250 : 0) + (idx === 0 ? 100 : 0), hits: [[idx, idx + tok.length]] };
  // In-order letters with gaps (fuzzy): "orc agnt" still finds "Orchestrating Coding Agents".
  let si = 0, last = -2, run = 0, score = 0; const hits = [];
  for (const ch of tok) {
    const j = s.indexOf(ch, si);
    if (j < 0) return null;
    if (j === last + 1) { run++; score += 6 * run; hits[hits.length - 1][1] = j + 1; }
    else { run = 0; score -= Math.min(j - last - 1, 12); hits.push([j, j + 1]); }
    if (isSep(s[j - 1])) score += 10;
    last = j; si = j + 1;
  }
  if (hits.length > Math.max(3, tok.length / 2)) return null;
  return { score: 300 + score - s.length * 0.2, hits };
}
function searchFor(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const out = [];
  for (const it of SEARCH) {
    let total = 0, hits = [], ok = true;
    for (const t of toks) {
      let r = scoreToken(t, it.s);
      if (!r && it.p) { const rp = scoreToken(t, it.p); if (rp) r = { score: rp.score - 200, hits: [] }; }
      if (!r) { ok = false; break; }
      total += r.score; hits = hits.concat(r.hits);
    }
    if (ok) out.push({ i: it.i, score: total + Math.log2(1 + deg[it.i]) * 12, hits });
  }
  return out.sort((a, b) => b.score - a.score);
}
function markHits(name, hits) {
  if (!hits.length) return esc(name);
  const marks = new Uint8Array(name.length);
  for (const [a, b] of hits) for (let k = a; k < b && k < name.length; k++) marks[k] = 1;
  let out = "", open = false;
  for (let k = 0; k < name.length; k++) {
    if (marks[k] && !open) { out += "<mark>"; open = true; }
    if (!marks[k] && open) { out += "</mark>"; open = false; }
    out += esc(name[k]);
  }
  return out + (open ? "</mark>" : "");
}
function swatch(i) {
  const nd = N[i];
  return nd.kind === "file" ? `<span class="sw ring" style="color:${baseColor(i)}"></span>` : `<span class="sw" style="background:${baseColor(i)}"></span>`;
}
function kindLabel(i) { const nd = N[i]; return nd.kind === "file" ? (TYPE_LABEL[nd.type] || nd.type) : "entity"; }
function runSearch() {
  const q = $("#search").value.trim();
  S.query = q;
  const box = $("#results");
  if (!q) { box.classList.remove("open"); $("#search").setAttribute("aria-expanded", "false"); searchSet = null; searchTop = []; sigma.refresh({ skipIndexation: true }); return; }
  const res = searchFor(q);
  searchTop = res.slice(0, 12).map((r) => r.i);
  searchSet = q.length >= 2 && res.length ? new Set(res.slice(0, 400).map((r) => r.i)) : null;
  active = 0;
  box.innerHTML = res.length
    ? res.slice(0, 12).map((r, k) => `<div class="res" role="option" data-i="${r.i}" aria-selected="${k === 0}">${swatch(r.i)}<span class="nm">${markHits(N[r.i].name, r.hits)}</span><span class="kd">${esc(kindLabel(r.i))} · ${deg[r.i]}</span></div>`).join("") + (res.length > 12 ? `<div class="res hint">${fmt(res.length - 12)} more match. Keep typing to narrow.</div>` : "")
    : `<div class="hint res">Nothing matches “${esc(q)}”.</div>`;
  box.classList.add("open"); $("#search").setAttribute("aria-expanded", "true");
  sigma.refresh({ skipIndexation: true });
}
function pickResult(i) {
  $("#search").value = ""; runSearch(); $("#search").blur();
  if (!vis[i]) { // the node is filtered out: show it anyway by dropping filters that hide it
    S.minDeg = 0; S.community = null; Object.assign(S.layers, { files: true, entities: true });
    syncControls();
  }
  select(i, { fly: true });
}

/* ------------------------------------------------------------------ 12. side panel */

function chip(i, extra) {
  return `<button class="chip" data-go="${i}" title="${esc(N[i].name)}">${swatch(i)}<span class="t">${esc(N[i].name)}</span>${extra != null ? `<span class="n">${extra}</span>` : ""}</button>`;
}
function chipList(ids, limit, extraFn) {
  const head = ids.slice(0, limit).map((i) => chip(i, extraFn ? extraFn(i) : null)).join("");
  const rest = ids.length - limit;
  return `<div class="chips">${head}</div>` + (rest > 0 ? `<button class="more" data-more="${esc(JSON.stringify(ids.slice(limit)))}">Show ${fmt(rest)} more</button>` : "");
}
function factItem(k, from) {
  const f = FACTS[k];
  const other = f.s === from ? f.t : f.s;
  const when = [f.valid ? "since " + prettyDate(f.valid) : "no date", f.invalid ? "until " + prettyDate(f.invalid) : ""].filter(Boolean).join(" ");
  const src = f.sources.map((s) => `<a data-go="${s}" title="${esc(N[s].path)}">${esc(N[s].name)}</a>`).join(", ");
  return `<li class="fact${f.invalid ? " old" : ""}"><p class="txt">${esc(f.text)}</p><div class="meta"><span class="rel">${esc(f.rel)}</span><span>${when}</span>${other !== from && from != null ? `<a data-go="${other}">→ ${esc(N[other].name)}</a>` : ""}${src ? `<span>from ${src}</span>` : ""}</div></li>`;
}
function factList(ks, from, limit) {
  const sorted = ks.slice().sort((a, b) => (!!FACTS[a].invalid - !!FACTS[b].invalid) || ((FACTS[b].v ?? -1) - (FACTS[a].v ?? -1)));
  const head = sorted.slice(0, limit).map((k) => factItem(k, from)).join("");
  const rest = sorted.length - limit;
  return `<ul class="facts">${head}</ul>` + (rest > 0 ? `<button class="more" data-morefacts="${esc(JSON.stringify(sorted.slice(limit)))}" data-from="${from ?? ""}">Show ${fmt(rest)} more facts</button>` : "");
}
function focusControl() {
  return `<div class="badges" style="margin-top:10px"><span class="seg" role="group" aria-label="Show neighbourhood">${[[0, "Everything"], [1, "1 hop"], [2, "2 hops"]].map(([h, t]) => `<button data-focus="${h}" aria-pressed="${S.focus === h}">${t}</button>`).join("")}</span></div>`;
}
function renderPanel(i) {
  const nd = N[i], p = $("#panel");
  let html;
  const close = `<button class="iconbtn close" data-close aria-label="Close details"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  if (nd.kind === "entity") {
    const comm = COMM[i] >= 0 ? COMMS[COMM[i]] : null;
    const facts = factsOf[i];
    const nb = [...new Set(adj[i].filter((e) => E[e].kind === "fact").map((e) => (E[e].s === i ? E[e].t : E[e].s)))].sort((a, b) => deg[b] - deg[a]);
    const srcs = sourcesOf[i].slice().sort((a, b) => b.c - a.c);
    html = `<div class="head">${close}<div class="kind">${swatch(i)}Entity${comm ? ` · group: ${esc(comm.name)}` : ""}${nd.labels.length ? " · " + esc(nd.labels.join(", ")) : ""}</div><h2>${esc(nd.name)}</h2>
      <div class="badges"><span class="badge">${fmt(deg[i])} connections</span><span class="badge">${fmt(facts.length)} facts</span><span class="badge">${fmt(srcs.length)} source file${srcs.length === 1 ? "" : "s"}</span></div>${focusControl()}</div>
      <div class="body">
      <h4>Summary</h4>${nd.summary ? `<p>${esc(nd.summary)}</p>` : `<p class="empty">No summary yet.</p>`}
      <h4>Facts <span>${fmt(facts.length)}</span></h4>${facts.length ? factList(facts, i, 25) : `<p class="empty">No facts link this entity to another one.</p>`}
      <h4>Comes from <span>${fmt(srcs.length)} file${srcs.length === 1 ? "" : "s"}</span></h4>${srcs.length ? `<ul class="links">${srcs.map((s) => `<li><span class="rel">${s.c} episode${s.c === 1 ? "" : "s"}</span><a data-go="${s.f}" title="${esc(N[s.f].path)}">${esc(N[s.f].name)}</a></li>`).join("")}</ul>` : `<p class="empty">No source file found.</p>`}
      <h4>Neighbours <span>${fmt(nb.length)}</span></h4>${nb.length ? chipList(nb, 30, (j) => deg[j]) : `<p class="empty">None.</p>`}
      </div>`;
  } else {
    const abs = RAW.meta.source_root.replace(/\/$/, "") + "/" + nd.path;
    const vscode = "vscode://file" + encodeURI(abs.startsWith("/") ? abs : "/" + abs);
    const out = linksOut[i] || [], inn = linksIn[i] || [];
    const ents = (mentionsOf[i] || []).slice().sort((a, b) => deg[b.e] - deg[a.e]).map((m) => m.e);
    const ff = factsFromFile[i] || [];
    const relName = (l) => (l.field ? l.field : l.rel === "LINKS_TO" ? "link" : l.rel.toLowerCase());
    html = `<div class="head">${close}<div class="kind">${swatch(i)}${esc(TYPE_LABEL[nd.type] || nd.type)}${nd.inScope ? "" : " · outside the indexed scope"}</div><h2>${esc(nd.name)}</h2>
      <div class="badges">${nd.status ? `<span class="badge">${esc(nd.status)}</span>` : ""}<span class="badge">${esc(nd.folder)}</span><span class="badge">${fmt(deg[i])} connections</span><span class="badge">${fmt(ents.length)} entities</span></div>
      <div class="path"><code>${esc(nd.path)}</code><button data-copy="${esc(nd.path)}" title="Copy the path">Copy</button><a href="${esc(vscode)}" title="Open in VS Code">VS Code</a></div>${focusControl()}</div>
      <div class="body">
      <h4>Links out <span>${fmt(out.length)}</span></h4>${out.length ? `<ul class="links">${out.map((l) => `<li><span class="rel" title="${esc(l.rel)}">${esc(relName(l))}</span><a data-go="${l.to}" title="${esc(N[l.to].path)}">${esc(N[l.to].name)}</a></li>`).join("")}</ul>` : `<p class="empty">None.</p>`}
      <h4>Links in <span>${fmt(inn.length)}</span></h4>${inn.length ? `<ul class="links">${inn.map((l) => `<li><span class="rel" title="${esc(l.rel)}">${esc(relName(l))}</span><a data-go="${l.from}" title="${esc(N[l.from].path)}">${esc(N[l.from].name)}</a></li>`).join("")}</ul>` : `<p class="empty">None.</p>`}
      <h4>Entities it mentions <span>${fmt(ents.length)}</span></h4>${ents.length ? chipList(ents, 30, (j) => deg[j]) : `<p class="empty">${nd.inScope ? "Not indexed yet." : "This file is outside the indexed scope."}</p>`}
      <h4>Facts from this file <span>${fmt(ff.length)}</span></h4>${ff.length ? factList(ff, null, 10) : `<p class="empty">None.</p>`}
      </div>`;
  }
  p.innerHTML = html;
  p.classList.add("open");
  p.scrollTop = 0;
}

/* ------------------------------------------------------------------ 13. sidebar controls */

function rowHTML(attr, value, label, count, color, ring) {
  return `<label class="row"><input type="checkbox" ${attr}="${esc(value)}" checked>${color ? `<span class="sw${ring ? " ring" : ""}" style="${ring ? "color" : "background"}:${color}"></span>` : ""}<span class="lbl" title="${esc(label)}">${esc(label)}</span><span class="cnt">${fmt(count)}</span></label>`;
}
function buildControls() {
  $("#c-files").textContent = fmt(FILE_COUNT);
  $("#c-entities").textContent = fmt(n - FILE_COUNT);
  $("#c-exact").textContent = fmt(RAW.layer1.length);
  $("#c-facts").textContent = fmt(FACTS.filter((f) => !f.invalid).length);
  $("#c-mentions").textContent = fmt(mentionTotal);
  $("#c-expired").textContent = fmt(FACTS.filter((f) => f.invalid).length);
  $("#c-undated").textContent = fmt(FACTS.filter((f) => f.v == null).length);
  const maxDeg = Math.max(1, ...deg);
  $("#mindeg").max = String(Math.min(30, maxDeg));
  renderTypeRows();
  $("#folders").innerHTML = folders.map((f) => rowHTML("data-folder", f, f, folderCounts.get(f))).join("");
  renderCommunityRows();
  // dates
  if (hasDates) {
    for (const id of ["#dfrom", "#dto"]) { const el = $(id); el.min = dMin; el.max = dMax; el.step = 1; }
  } else {
    $("#dfrom").closest(".sec").style.display = "none";
  }
  $("#built").textContent = `Built ${new Date(RAW.meta.built).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} from Neo4j. Drag nodes to move them; the layout is remembered in this browser.`;
  $("#stats").innerHTML = `<b>${fmt(FILE_COUNT)}</b> files · <b>${fmt(n - FILE_COUNT)}</b> entities · <b>${fmt(FACTS.filter((f) => !f.invalid).length)}</b> facts<span class="wide"> · <b>${fmt(mentionTotal)}</b> mentions · <b>${fmt(COMMS.length)}</b> groups</span>`;
}
function renderTypeRows() {
  const counts = {}; for (let i = 0; i < FILE_COUNT; i++) counts[N[i].type] = (counts[N[i].type] || 0) + 1;
  $("#types").innerHTML = types.map((t) => rowHTML("data-type", t, TYPE_LABEL[t] || t, counts[t], C.P.types[t] || C.P.types.file, true)).join("");
  syncControls();
}
function renderCommunityRows() {
  const shown = COMMS.slice(0, C.P.comm.length);
  const rest = COMMS.slice(C.P.comm.length);
  $("#communities").innerHTML = shown.map((c) => `<div class="row" data-comm="${c.id}" role="button" tabindex="0"><span class="sw" style="background:${commColor(c.id)}"></span><span class="lbl" title="${esc(c.name)}">${esc(c.name || "group " + (c.id + 1))}</span><span class="cnt">${fmt(c.size)}</span></div>`).join("")
    + (rest.length ? `<div class="row" style="cursor:default"><span class="sw" style="background:${C.P.other}"></span><span class="lbl">${fmt(rest.length)} smaller groups</span><span class="cnt">${fmt(rest.reduce((a, c) => a + c.size, 0))}</span></div>` : "");
  syncControls();
}
function syncControls() {
  document.querySelectorAll("[data-layer]").forEach((el) => (el.checked = !!S.layers[el.dataset.layer]));
  document.querySelectorAll("[data-type]").forEach((el) => { el.checked = S.types.has(el.dataset.type); el.closest(".row").classList.toggle("off", !el.checked); });
  document.querySelectorAll("[data-folder]").forEach((el) => { el.checked = S.folders.has(el.dataset.folder); el.closest(".row").classList.toggle("off", !el.checked); });
  document.querySelectorAll("[data-comm]").forEach((el) => el.classList.toggle("off", S.community != null && +el.dataset.comm !== S.community));
  $("#comm-clear").hidden = S.community == null;
  $("#mindeg").value = S.minDeg; $("#mindeg-out").textContent = S.minDeg;
  $("#density").value = S.density; $("#density-out").textContent = DENSITY_NAME[S.density];
  $("#undated").checked = S.undated;
  if (hasDates) {
    $("#dfrom").value = S.from; $("#dto").value = S.to;
    $("#dfrom-out").textContent = S.from > dMin ? dayStr(stepDay(S.from)) : "From the start";
    $("#dto-out").textContent = S.to < dMax ? dayStr(stepDay(S.to)) : "To the end";
    $("#dfrom-out").title = "Oldest fact: " + dayStr(DAYS[0]); $("#dto-out").title = "Newest fact: " + dayStr(DAYS[DAYS.length - 1]);
    const fill = $("#dfill");
    fill.style.left = `calc(8px + (100% - 16px) * ${S.from / STEPS})`;
    fill.style.width = `calc((100% - 16px) * ${(S.to - S.from) / STEPS})`;
    let inRange = 0;
    for (let k = 0; k < FACTS.length; k++) inRange += factOK[k];
    $("#dates-note").textContent = `${fmt(inRange)} of ${fmt(FACTS.length)} facts shown. Each step of the slider passes the same number of facts.`;
  }
}
let refreshQueued = false;
function apply() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    recompute(); syncControls(); sigma.refresh({ skipIndexation: true });
  });
}

function wireControls() {
  const side = $("#side");
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.layer) { S.layers[t.dataset.layer] = t.checked; apply(); }
    else if (t.dataset.type) { t.checked ? S.types.add(t.dataset.type) : S.types.delete(t.dataset.type); apply(); }
    else if (t.dataset.folder) { t.checked ? S.folders.add(t.dataset.folder) : S.folders.delete(t.dataset.folder); apply(); }
    else if (t.id === "undated") { S.undated = t.checked; apply(); }
  });
  $("#mindeg").addEventListener("input", (e) => { S.minDeg = +e.target.value; apply(); });
  $("#density").addEventListener("input", (e) => { S.density = +e.target.value; store.set("density", S.density); syncControls(); sigma.scheduleRender(); });
  $("#dfrom").addEventListener("input", (e) => { S.from = Math.min(+e.target.value, S.to); apply(); });
  $("#dto").addEventListener("input", (e) => { S.to = Math.max(+e.target.value, S.from); apply(); });
  $("#dates-reset").addEventListener("click", () => { S.from = dMin; S.to = dMax; apply(); });
  side.addEventListener("click", (e) => {
    const all = e.target.closest("[data-all]");
    if (all) {
      const key = all.dataset.all, full = key === "types" ? types : folders;
      const set = S[key];
      if (set.size === full.length) set.clear(); else full.forEach((x) => set.add(x));
      all.textContent = set.size === full.length ? "None" : "All";
      apply(); return;
    }
    const c = e.target.closest("[data-comm]");
    if (c) { const id = +c.dataset.comm; S.community = S.community === id ? null : id; apply(); setTimeout(fitVisible, 40); }
  });
  $("#comm-clear").addEventListener("click", () => { S.community = null; apply(); setTimeout(fitVisible, 40); });
  $("#btn-reset").addEventListener("click", () => { Object.assign(S, DEFAULTS(), { focus: 0 }); apply(); setTimeout(fitVisible, 40); });
  $("#btn-relayout").addEventListener("click", () => { seedPositions(false); sigma.setCustomBBox(null); startLayout(maxLayoutMs(false)); });
  $("#layoutstop").addEventListener("click", () => stopLayout(true));
  const toggleSide = (force) => {
    if (MOBILE()) {
      const open = force ?? !side.classList.contains("drawer");
      side.classList.toggle("drawer", open); $("#scrim").classList.toggle("on", open); $("#btn-side").setAttribute("aria-pressed", open);
    } else {
      const open = force ?? side.classList.contains("closed");
      side.classList.toggle("closed", !open); $("#btn-side").setAttribute("aria-pressed", open);
      store.set("side", open);
      requestAnimationFrame(() => { sigma.resize(); sizeLabelCanvas(); sigma.refresh({ skipIndexation: true }); });
    }
  };
  $("#btn-side").addEventListener("click", () => toggleSide());
  $("#scrim").addEventListener("click", () => toggleSide(false));
  if (MOBILE()) $("#btn-side").setAttribute("aria-pressed", "false");
  else if (store.get("side", true) === false) toggleSide(false);
  $("#btn-fit").addEventListener("click", fitVisible);
  $("#z-fit").addEventListener("click", fitVisible);
  $("#z-in").addEventListener("click", () => sigma.getCamera().animatedZoom({ duration: 250 }));
  $("#z-out").addEventListener("click", () => sigma.getCamera().animatedUnzoom({ duration: 250 }));
  $("#btn-help").addEventListener("click", () => $("#help").classList.toggle("open"));
  $("#help").addEventListener("click", (e) => { if (e.target.id === "help") $("#help").classList.remove("open"); });
  $("#btn-theme").addEventListener("click", () => {
    S.theme = S.theme === "system" ? (C.dark ? "light" : "dark") : S.theme === "light" ? "dark" : "system";
    store.set("theme", S.theme); themeChanged();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (S.theme === "system") themeChanged(); });

  // panel
  $("#panel").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { const i = +go.dataset.go; if (!vis[i]) { S.minDeg = 0; S.community = null; syncControls(); } select(i, { fly: true }); return; }
    const f = e.target.closest("[data-focus]");
    if (f) { setFocus(+f.dataset.focus); return; }
    if (e.target.closest("[data-close]")) { select(null); return; }
    const cp = e.target.closest("[data-copy]");
    if (cp) { copy(cp.dataset.copy); return; }
    const more = e.target.closest("[data-more]");
    if (more) { const ids = JSON.parse(more.dataset.more); more.previousElementSibling.insertAdjacentHTML("beforeend", ids.map((j) => chip(j, deg[j])).join("")); more.remove(); return; }
    const mf = e.target.closest("[data-morefacts]");
    if (mf) { const ks = JSON.parse(mf.dataset.morefacts), from = mf.dataset.from === "" ? null : +mf.dataset.from; mf.previousElementSibling.insertAdjacentHTML("beforeend", ks.map((k) => factItem(k, from)).join("")); mf.remove(); }
  });

  // search
  const input = $("#search"), box = $("#results");
  input.addEventListener("input", runSearch);
  input.addEventListener("focus", () => { if (input.value.trim()) runSearch(); });
  input.addEventListener("keydown", (e) => {
    const items = [...box.querySelectorAll(".res[data-i]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!items.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items.forEach((el, k) => el.setAttribute("aria-selected", k === active)); items[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { if (items[active]) pickResult(+items[active].dataset.i); }
    else if (e.key === "Escape") { e.stopPropagation(); if (input.value) { input.value = ""; runSearch(); } else input.blur(); }
  });
  box.addEventListener("mousedown", (e) => { const r = e.target.closest(".res[data-i]"); if (r) { e.preventDefault(); pickResult(+r.dataset.i); } });
  input.addEventListener("blur", () => setTimeout(() => box.classList.remove("open"), 120));

  // keyboard
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== "checkbox" && document.activeElement.type !== "range";
    if (e.key === "Escape") {
      $("#help").classList.remove("open");
      if (MOBILE() && $("#side").classList.contains("drawer")) { toggleSide(false); return; }
      if (S.query) { input.value = ""; runSearch(); }
      if (S.selected != null) select(null);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); input.focus(); input.select(); }
    else if (e.key === "f") fitVisible();
    else if (e.key === "?") $("#help").classList.toggle("open");
    else if (e.key === "[") toggleSide();
    else if (e.key === "0" || e.key === "1" || e.key === "2") { if (S.selected != null) setFocus(+e.key); }
  });

  new ResizeObserver(() => { sizeLabelCanvas(); updateSizeScale(); sigma.scheduleRender(); }).observe($("#stage"));
}

function themeChanged() {
  applyTheme(); paintNodes(); renderTypeRows(); renderCommunityRows();
  if (S.selected != null) renderPanel(S.selected);
  sigma.refresh({ skipIndexation: true });
}

function copy(text) {
  const done = () => toast("Path copied");
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallback());
  else fallback();
  function fallback() {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed: select the path by hand"); }
    ta.remove();
  }
}
let toastTimer = null;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 1600); }

const maxLayoutMs = (warm) => (warm ? 1500 : Math.min(15000, Math.max(5000, 3000 + n * 2)));

/* ------------------------------------------------------------------ 14. boot */

async function boot() {
  const msg = (t) => ($("#loadmsg").textContent = t);
  applyTheme();
  msg(`Reading ${fmt(n)} nodes and ${fmt(E.length)} edges…`); await nextFrame();
  buildGraph(); T.model = performance.now() - T.start;
  msg("Finding groups of related entities…"); await nextFrame();
  const t1 = performance.now(); const modularity = computeCommunities(); T.louvain = performance.now() - t1;
  paintNodes();
  msg("Placing nodes…"); await nextFrame();
  const warm = seedPositions(true) > 0.6;
  makeRenderer(); sizeLabelCanvas();
  buildControls(); wireControls(); wireSigmaEvents();
  recompute(); syncControls(); sigma.refresh();
  T.firstRender = performance.now() - T.start;
  $("#loading").classList.add("gone");
  setTimeout(() => $("#loading").remove(), 400);
  startLayout(maxLayoutMs(warm));
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash) { const i = N.findIndex((x) => x.key === hash); if (i >= 0) setTimeout(() => select(i, { fly: true }), 300); }
  window.__bg = { sigma, graph, N, E, S, T, layoutState, modularity, labels: () => lastLabelCount, draws: () => lastDraws, select, fitVisible, recompute, apply, seedPositions, startLayout, stopLayout };
  console.info(`[mdkg] ${n} nodes, ${E.length} edges; model ${Math.round(T.model)} ms, Louvain ${Math.round(T.louvain)} ms (${COMMS.length} groups, modularity ${modularity.toFixed(2)}), first render ${Math.round(T.firstRender)} ms`);
}

boot().catch((err) => {
  console.error(err);
  $("#loadmsg").textContent = "Something went wrong: " + err.message;
});
})();
