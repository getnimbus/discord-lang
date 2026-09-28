const $ = (id) => document.getElementById(id);

let tabId = null;
let key = null;

function fillLangSelect(select, extraCodes = []) {
  const codes = [...new Set([...DL_LANGS, ...extraCodes.filter(Boolean)])];
  codes.sort((a, b) => dlLangName(a).localeCompare(dlLangName(b)));
  for (const code of codes) select.add(new Option(`${dlLangName(code)} (${code})`, code));
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`;
  $("status").title = text;
}

async function renderServer() {
  const g = await dlGetGuild(key);
  const sel = $("serverLang");
  sel.innerHTML = "";
  const detected = dlPickMainLang(g.counts) || (!g.locked && g.lang);
  sel.add(new Option(detected ? `Auto — ${dlLangName(detected)}` : "Auto — not detected yet", "auto"));
  fillLangSelect(sel, [g.lang]);
  sel.value = g.locked && g.lang ? g.lang : "auto";

  const total = Object.values(g.counts || {}).reduce((a, b) => a + b, 0);
  const top = Object.entries(g.counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, n]) => `${dlLangName(code)} ${Math.round((n / total) * 100)}%`)
    .join(" · ");
  $("serverStats").textContent = total
    ? `Seen ${total} messages: ${top}`
    : "Scroll through some messages and the main language will be learned automatically.";

  $("serverIncoming").checked = g.incoming !== false;
  $("serverOutgoing").checked = g.outgoing !== false;
}

async function initServer() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let ctx = null;
  try {
    ctx = await chrome.tabs.sendMessage(tab.id, { type: "getContext" });
  } catch {
    return; // not a Discord tab, or the page needs a reload after installing
  }
  if (!ctx?.guildKey) return;
  tabId = tab.id;
  key = ctx.guildKey;
  const g = await dlGetGuild(key);
  $("serverName").textContent = ctx.guildName || g.name || (key.startsWith("dm:") ? "Direct message" : key);
  $("server").hidden = false;
  $("noServer").hidden = true;
  await renderServer();
}

async function init() {
  const s = await dlGetSettings();
  $("enabled").checked = s.enabled;
  fillLangSelect($("myLang"), [s.myLang]);
  $("myLang").value = s.myLang;
  $("display").value = s.display;
  $("incoming").checked = s.incoming;
  $("outgoing").checked = s.outgoing;
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("priceIn").value = s.priceIn;
  $("priceOut").value = s.priceOut;
  if (!s.apiKey) setStatus("Add your API key to get started.");
  await Promise.all([initServer(), renderUsage()]);
}

// ---------- usage chart ----------

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_DAYS = 14;

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toLocaleDateString("en-CA");
}

function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const tickUsd = (v) => (v ? `$${Number(v.toPrecision(2))}` : "$0");

// Column path: square at the baseline, 4px rounded data-end.
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

async function renderUsage() {
  const [{ usage = {}, tcache = [] }, s] = await Promise.all([
    chrome.storage.local.get(["usage", "tcache"]),
    dlGetSettings(),
  ]);

  const month = Array.from({ length: 30 }, (_, i) => usage[dayKey(i)]);
  $("costToday").textContent = dlFormatUsd(dlDayCost(usage[dayKey(0)], s));
  $("cost30").textContent = dlFormatUsd(month.reduce((a, d) => a + dlDayCost(d, s), 0));
  $("calls30").textContent = dlCompact(month.reduce((a, d) => a + (d?.calls || 0), 0));
  $("cacheInfo").textContent = `${dlCompact(tcache.length)} translations cached`;

  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const key = dayKey(CHART_DAYS - 1 - i);
    const d = usage[key];
    return { key, d, cost: dlDayCost(d, s) };
  });

  // --- chart ---
  const svg = $("chart");
  svg.textContent = "";
  const W = svg.parentElement.clientWidth || 296;
  svg.setAttribute("width", W);
  const H = 118;
  const pad = { l: 38, r: 2, t: 6, b: 18 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const max = Math.max(...days.map((d) => d.cost));
  const step = max > 0 ? niceStep(max / 2) : 0.01;
  const top = step * Math.max(1, Math.ceil(max / step));
  const y = (v) => pad.t + plotH - (v / top) * plotH;

  for (let i = 0; i <= Math.round(top / step); i++) {
    const v = i * step;
    svg.append(svgEl("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const t = svgEl("text", { class: "axis-text", x: pad.l - 6, y: y(v) + 3, "text-anchor": "end" });
    t.textContent = tickUsd(v);
    svg.append(t);
  }

  const slot = plotW / CHART_DAYS;
  const barW = Math.min(24, slot - 4);
  days.forEach((day, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const h = Math.max(0, y(0) - y(day.cost));
    // Hit target is the whole column slot, bigger than the bar.
    const hit = svgEl("rect", { class: "hit", x: cx - slot / 2, y: pad.t, width: slot, height: plotH, tabindex: 0 });
    hit.setAttribute("aria-label", `${dayLabel(day.key)}: ${dlFormatUsd(day.cost)}, ${day.d?.calls || 0} calls`);
    const bar = svgEl("path", { class: "bar", d: h > 0 ? barPath(cx - barW / 2, y(0) - h, barW, h) : "" });
    const show = () => showTip(day, cx, h > 0 ? y(0) - h : y(0));
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("blur", hideTip);
    svg.append(hit, bar);

    if (i === 0 || i === Math.floor(CHART_DAYS / 2) || i === CHART_DAYS - 1) {
      const t = svgEl("text", {
        class: "axis-text",
        x: i === CHART_DAYS - 1 ? W - pad.r : i === 0 ? cx - slot / 2 : cx,
        y: H - 4,
        "text-anchor": i === CHART_DAYS - 1 ? "end" : i === 0 ? "start" : "middle",
      });
      t.textContent = i === CHART_DAYS - 1 ? "Today" : dayLabel(day.key);
      svg.append(t);
    }
  });

  // --- table view ---
  const tbody = $("usageTable").querySelector("tbody");
  tbody.textContent = "";
  const rows = days.filter((d) => d.d?.calls).reverse();
  if (!rows.length) {
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = 4;
    td.textContent = "No usage yet";
  }
  for (const day of rows) {
    const tr = tbody.insertRow();
    for (const v of [
      dayLabel(day.key),
      day.d.calls.toLocaleString("en-US"),
      dlCompact(day.d.in + day.d.out),
      dlFormatUsd(day.cost),
    ]) {
      tr.insertCell().textContent = v;
    }
  }
}

function showTip(day, x, barTop) {
  const tip = $("tip");
  tip.textContent = "";
  const value = document.createElement("strong");
  value.textContent = dlFormatUsd(day.cost);
  const meta = document.createElement("span");
  const tokens = day.d ? day.d.in + day.d.out : 0;
  meta.textContent = `${dayLabel(day.key)} · ${day.d?.calls || 0} calls · ${dlCompact(tokens)} tokens`;
  tip.append(value, meta);
  tip.hidden = false;
  // Keep the tooltip inside the popup horizontally.
  const half = tip.offsetWidth / 2;
  const W = $("chart").parentElement.clientWidth;
  tip.style.left = `${Math.min(Math.max(x, half), W - half)}px`;
  tip.style.top = `${barTop}px`;
}

function hideTip() {
  $("tip").hidden = true;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.usage || changes.tcache || changes.settings)) renderUsage();
});

// ---------- events ----------

for (const id of ["priceIn", "priceOut"]) {
  $(id).addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) dlSaveSettings({ [id]: v });
  });
}

$("clearCache").addEventListener("click", () => chrome.storage.local.remove("tcache"));

for (const id of ["enabled", "incoming", "outgoing"]) {
  $(id).addEventListener("change", (e) => dlSaveSettings({ [id]: e.target.checked }));
}
$("myLang").addEventListener("change", (e) => dlSaveSettings({ myLang: e.target.value }));
$("display").addEventListener("change", (e) => dlSaveSettings({ display: e.target.value }));

$("serverLang").addEventListener("change", async (e) => {
  const value = e.target.value;
  await dlUpdateGuild(key, (g) =>
    value === "auto" ? { ...g, locked: false, lang: dlPickMainLang(g.counts) } : { ...g, locked: true, lang: value },
  );
  await renderServer();
});

for (const [id, field] of [
  ["serverIncoming", "incoming"],
  ["serverOutgoing", "outgoing"],
]) {
  $(id).addEventListener("change", (e) => dlUpdateGuild(key, (g) => ({ ...g, [field]: e.target.checked })));
}

$("detectNow").addEventListener("click", async () => {
  const btn = $("detectNow");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "detectNow" });
    if (!res?.ok) throw new Error(res?.error || "Detection failed");
    await renderServer();
  } catch (err) {
    $("serverStats").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Detect";
  }
});

$("save").addEventListener("click", () => {
  const baseUrl = ($("baseUrl").value.trim() || DL_DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, "");
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim() || DL_DEFAULT_SETTINGS.model;

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return setStatus("Base URL is not a valid URL.", "err");
  }

  // Must be called synchronously inside the click handler (user gesture).
  const granted = chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);

  (async () => {
    $("save").disabled = true;
    setStatus("Testing…");
    try {
      if (!(await granted)) throw new Error(`Permission to reach ${origin} was denied.`);
      await dlSaveSettings({ baseUrl, apiKey, model });
      const res = await chrome.runtime.sendMessage({ type: "testConnection" });
      if (!res?.ok) throw new Error(res?.error || "No response");
      setStatus(`Connected ✓ (${model})`, "ok");
    } catch (err) {
      setStatus(err.message, "err");
    } finally {
      $("save").disabled = false;
    }
  })();
});

init();
