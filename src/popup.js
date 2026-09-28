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
  $("incoming").checked = s.incoming;
  $("outgoing").checked = s.outgoing;
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  if (!s.apiKey) setStatus("Add your API key to get started.");
  await initServer();
}

// ---------- events ----------

for (const id of ["enabled", "incoming", "outgoing"]) {
  $(id).addEventListener("change", (e) => dlSaveSettings({ [id]: e.target.checked }));
}
$("myLang").addEventListener("change", (e) => dlSaveSettings({ myLang: e.target.value }));

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
