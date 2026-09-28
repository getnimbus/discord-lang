// Content script for discord.com
//  - Incoming: translates messages into your language as they scroll into view.
//  - Outgoing: on Enter, translates your draft into the server's main language and sends it.
//  - Memory: tallies detected languages per server; the most common one becomes the server's language.

(() => {
  const MSG_SEL = '[id^="message-content-"]';
  const EDITOR_SEL = '[role="textbox"][data-slate-editor="true"]';
  const BATCH_SIZE = 15;
  const MAX_INFLIGHT = 2;
  const MAX_CACHE = 3000;

  let settings = { ...DL_DEFAULT_SETTINGS };
  let guilds = {};

  const cache = new Map(); // `${target}|${text}` -> { lang, translation }
  const queue = new Map(); // messageId -> { el, text, guildKey }
  const observed = new WeakSet();
  const visible = new WeakSet();
  const countedIds = new Set(); // messages already counted toward a server's language tally
  let pendingTally = {}; // guildKey -> { code: n }
  let inflight = 0;
  let flushTimer = null;
  let sending = false; // true while we replay Enter ourselves
  let busy = false;

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const guildKey = () => dlGuildKeyFromPath(location.pathname);
  const guildInfo = (key) => (key && guilds[key]) || { lang: null, locked: false, counts: {} };
  const messageId = (el) => el.id.slice("message-content-".length);

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res?.ok) return reject(new Error(res?.error || "Unknown error"));
          resolve(res);
        });
      } catch (err) {
        // Happens after the extension is reloaded while Discord stays open.
        reject(new Error("Extension was updated — reload Discord."));
      }
    });
  }

  function guildName() {
    const parts = document.title.split("|").map((s) => s.trim()).filter(Boolean);
    const rest = parts.filter((p) => p !== "Discord" && !p.startsWith("#"));
    return rest[rest.length - 1] || parts[parts.length - 1] || "";
  }

  // Text of a node, with emoji images turned into their alt text (":smile:").
  function nodeText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    // Skip the "(edited)" marker and our own UI.
    if (node.tagName === "TIME" || node.classList.contains("dlt-translation")) return "";
    if ([...node.classList].some((c) => c.startsWith("timestamp"))) return "";
    let out = "";
    for (const child of node.childNodes) out += nodeText(child);
    return out;
  }

  const clean = (s) => s.replace(/[​﻿]/g, "").trim();
  const hasLetters = (s) => /\p{L}/u.test(s);

  // Quick local language check (Chrome/Firefox built-in CLD). Saves API calls
  // for messages already in your language.
  function detectLocal(text) {
    return new Promise((resolve) => {
      try {
        if (!chrome.i18n?.detectLanguage || text.length < 12) return resolve(null);
        chrome.i18n.detectLanguage(text, (res) => {
          const top = res?.languages?.[0];
          resolve(res?.isReliable && top && top.percentage >= 80 ? dlNormLang(top.language) : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function cacheSet(key, value) {
    cache.set(key, value);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  // ---------- toast ----------

  let toastEl = null;
  let toastTimer = null;
  let lastErrorAt = 0;

  function toast(text, kind = "info", ms = 3500) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "dlt-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.dataset.kind = kind;
    toastEl.classList.add("dlt-show");
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastEl.classList.remove("dlt-show"), ms);
  }

  function toastError(err) {
    // Don't spam: at most one incoming-translation error every 20s.
    if (Date.now() - lastErrorAt < 20000) return;
    lastErrorAt = Date.now();
    toast(`Discord Lang: ${err.message || err}`, "error", 6000);
  }

  // ---------- language memory ----------

  function tally(key, messageIdOrNull, lang) {
    if (!key || !lang) return;
    if (messageIdOrNull) {
      if (countedIds.has(messageIdOrNull)) return;
      countedIds.add(messageIdOrNull);
    }
    const bucket = (pendingTally[key] ||= {});
    bucket[lang] = (bucket[lang] || 0) + 1;
    scheduleTallyFlush();
  }

  let tallyTimer = null;
  function scheduleTallyFlush() {
    clearTimeout(tallyTimer);
    tallyTimer = setTimeout(flushTally, 1500);
  }

  async function flushTally() {
    clearTimeout(tallyTimer);
    const batch = pendingTally;
    pendingTally = {};
    const current = guildKey();
    const all = await dlGetGuilds();
    for (const [key, counts] of Object.entries(batch)) {
      const g = all[key] || { lang: null, locked: false, counts: {} };
      g.counts = { ...(g.counts || {}) };
      for (const [code, n] of Object.entries(counts)) g.counts[code] = (g.counts[code] || 0) + n;
      if (!g.locked) g.lang = dlPickMainLang(g.counts);
      if (key === current) g.name = guildName() || g.name;
      all[key] = g;
    }
    guilds = all;
    await chrome.storage.local.set({ guilds: all });
  }

  function visibleSamples(limit = 20) {
    const out = [];
    for (const el of document.querySelectorAll(MSG_SEL)) {
      const t = clean(nodeText(el));
      if (t.length >= 4 && hasLetters(t)) out.push(t.slice(0, 200));
    }
    return out.slice(-limit);
  }

  // Server language for outgoing messages. Falls back to asking the model
  // about the messages on screen if we haven't learned it yet.
  async function resolveServerLang(key) {
    await flushTally();
    const g = guildInfo(key);
    if (g.lang) return g.lang;
    const samples = visibleSamples();
    if (samples.length < 3) return null;
    const { lang } = await send({ type: "detectMainLanguage", samples });
    await dlUpdateGuild(key, (cur) => {
      if (!cur.lang) cur.lang = lang;
      cur.name = guildName() || cur.name;
      return cur;
    });
    guilds = await dlGetGuilds();
    return guildInfo(key).lang;
  }

  // ---------- incoming translation ----------

  function incomingEnabled() {
    if (!settings.enabled || !settings.incoming) return false;
    return guildInfo(guildKey()).incoming !== false;
  }

  function render(el, text, result) {
    let box = el.nextElementSibling;
    if (!box || !box.classList.contains("dlt-translation")) box = null;
    if (!el.isConnected || clean(nodeText(el)) !== text) return; // message changed or left the DOM

    if (!result?.translation) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.className = "dlt-translation";
      const badge = document.createElement("span");
      badge.className = "dlt-badge";
      const body = document.createElement("span");
      body.className = "dlt-text";
      box.append(badge, body);
      el.insertAdjacentElement("afterend", box);
    }
    const from = (result.lang || "?").toUpperCase();
    box.querySelector(".dlt-badge").textContent = `${from} → ${settings.myLang.toUpperCase()}`;
    box.querySelector(".dlt-badge").title = `Translated from ${dlLangName(result.lang)} by Discord Lang`;
    box.querySelector(".dlt-text").textContent = result.translation;
  }

  async function enqueue(el) {
    if (!incomingEnabled()) return;
    const text = clean(nodeText(el));
    if (!text || !hasLetters(text)) return;
    if (el.dataset.dltSrc === text) return; // already handled this exact text
    el.dataset.dltSrc = text;

    const id = messageId(el);
    const key = guildKey();
    const target = settings.myLang;
    const cacheKey = `${target}|${text}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      tally(key, id, hit.lang);
      return render(el, text, hit);
    }

    const local = await detectLocal(text);
    if (local && local === target) {
      const result = { lang: local, translation: null };
      cacheSet(cacheKey, result);
      tally(key, id, local);
      return render(el, text, result);
    }

    queue.set(id, { el, text, guildKey: key, target });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 250);
  }

  async function flush() {
    while (queue.size && inflight < MAX_INFLIGHT) {
      const batch = [];
      for (const [id, item] of queue) {
        queue.delete(id);
        batch.push({ id, ...item });
        if (batch.length >= BATCH_SIZE) break;
      }
      inflight++;
      translateBatch(batch).finally(() => {
        inflight--;
        if (queue.size) scheduleFlush();
      });
    }
  }

  async function translateBatch(batch) {
    const target = batch[0].target;
    try {
      const res = await send({
        type: "translateBatch",
        target,
        items: batch.map((b) => ({ id: b.id, text: b.text.slice(0, 2000) })),
      });
      const byId = new Map(res.items.map((it) => [it.id, it]));
      for (const b of batch) {
        const it = byId.get(b.id);
        if (!it) {
          delete b.el.dataset.dltSrc; // let it retry next time it scrolls into view
          continue;
        }
        const result = { lang: it.lang, translation: it.lang === target ? null : it.translation };
        cacheSet(`${b.target}|${b.text}`, result);
        tally(b.guildKey, b.id, it.lang);
        const el = b.el.isConnected ? b.el : document.getElementById(`message-content-${b.id}`);
        if (el) render(el, b.text, result);
      }
    } catch (err) {
      for (const b of batch) delete b.el.dataset.dltSrc;
      toastError(err);
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visible.add(entry.target);
          enqueue(entry.target);
        } else {
          visible.delete(entry.target);
        }
      }
    },
    { rootMargin: "300px 0px" },
  );

  const dirty = new Set();
  const fresh = new Set();
  let scanScheduled = false;

  function contentHost(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return el?.closest?.(MSG_SEL) || null;
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      for (const el of fresh) {
        if (!observed.has(el)) {
          observed.add(el);
          io.observe(el);
        }
      }
      fresh.clear();
      // Edited messages: re-translate if on screen.
      for (const el of dirty) if (visible.has(el)) enqueue(el);
      dirty.clear();
    });
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        if (n.matches(MSG_SEL)) fresh.add(n);
        for (const el of n.querySelectorAll(MSG_SEL)) fresh.add(el);
      }
      const host = contentHost(m.target);
      if (host) dirty.add(host);
    }
    if (fresh.size || dirty.size) scheduleScan();
  });

  function resetTranslations() {
    queue.clear();
    for (const box of document.querySelectorAll(".dlt-translation")) box.remove();
    for (const el of document.querySelectorAll(MSG_SEL)) {
      delete el.dataset.dltSrc;
      if (visible.has(el)) enqueue(el);
    }
  }

  // ---------- outgoing translation ----------

  function editorText(editor) {
    const blocks = editor.querySelectorAll(':scope > [data-slate-node="element"]');
    if (!blocks.length) return clean(editor.innerText || "");
    return [...blocks].map((b) => nodeText(b).replace(/[​﻿]/g, "")).join("\n").trim();
  }

  function autocompleteOpen(editor) {
    if (editor.getAttribute("aria-expanded") === "true") return true;
    const scope = editor.closest("form") || editor.parentElement;
    return !!scope?.querySelector('[class*="autocomplete"] [role="option"], [class*="autocomplete"] [role="button"]');
  }

  async function replaceEditorText(editor, text) {
    editor.focus();
    document.execCommand("selectAll", false);
    await sleep(30); // let Slate sync its selection from the DOM

    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(50);

    const norm = (s) => s.replace(/\s+/g, " ").trim();
    if (norm(editorText(editor)) === norm(text)) return true;

    // Fallback for editors that ignore synthetic paste.
    document.execCommand("selectAll", false);
    await sleep(30);
    document.execCommand("insertText", false, text);
    await sleep(50);
    return norm(editorText(editor)) === norm(text);
  }

  function pressEnter(editor) {
    sending = true;
    try {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    } finally {
      sending = false;
    }
  }

  async function onKeyDown(e) {
    if (sending || e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    const editor = e.target?.closest?.(EDITOR_SEL);
    if (!editor || !settings.enabled || !settings.outgoing) return;
    if (autocompleteOpen(editor)) return;

    const key = guildKey();
    if (guildInfo(key).outgoing === false) return;

    const original = editorText(editor);
    if (!original || !hasLetters(original) || original.startsWith("/")) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    if (busy) return;

    // Alt+Enter: send exactly what I typed.
    if (e.altKey) return pressEnter(editor);

    busy = true;
    editor.classList.add("dlt-busy");
    try {
      const target = await resolveServerLang(key);
      if (!target) {
        toast("Server language not known yet — sent as typed. Set it in the Discord Lang popup.", "info", 5000);
        return pressEnter(editor);
      }
      const local = await detectLocal(original);
      if (local && local === target) return pressEnter(editor);

      toast(`Translating to ${dlLangName(target)}…`, "info", 0);
      const { text } = await send({ type: "translateOutgoing", text: original, target });
      const translated = text.replace(/^["“]|["”]$/g, "").trim();
      if (editorText(editor) !== original) {
        toast("Message changed while translating — not sent.", "error");
        return;
      }
      if (!translated || translated === original) {
        toastEl?.classList.remove("dlt-show");
        return pressEnter(editor);
      }
      const ok = await replaceEditorText(editor, translated);
      if (!ok) {
        toast("Couldn't insert the translation into the chat box — not sent.", "error", 6000);
        return;
      }
      pressEnter(editor);
      toast(`Sent in ${dlLangName(target)}`, "ok", 2000);
    } catch (err) {
      toast(`Translation failed — not sent. ${err.message || err}`, "error", 7000);
    } finally {
      busy = false;
      editor.classList.remove("dlt-busy");
    }
  }

  // ---------- wiring ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.guilds) guilds = changes.guilds.newValue || {};
    if (changes.settings) {
      const prev = settings;
      settings = { ...DL_DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (prev.myLang !== settings.myLang || (!prev.enabled && settings.enabled) || (!prev.incoming && settings.incoming)) {
        cache.clear();
        resetTranslations();
      } else if (!settings.enabled || !settings.incoming) {
        queue.clear();
        for (const box of document.querySelectorAll(".dlt-translation")) box.remove();
        for (const el of document.querySelectorAll(MSG_SEL)) delete el.dataset.dltSrc;
      }
    }
    // Incoming toggled for the current server from the popup.
    if (changes.guilds) {
      const key = guildKey();
      const before = changes.guilds.oldValue?.[key]?.incoming;
      const after = changes.guilds.newValue?.[key]?.incoming;
      if (before !== after) {
        if (after === false) {
          queue.clear();
          for (const box of document.querySelectorAll(".dlt-translation")) box.remove();
          for (const el of document.querySelectorAll(MSG_SEL)) delete el.dataset.dltSrc;
        } else {
          resetTranslations();
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "getContext") {
      sendResponse({ guildKey: guildKey(), guildName: guildName() });
    } else if (msg?.type === "detectNow") {
      const key = guildKey();
      const samples = visibleSamples(30);
      if (!key || samples.length < 3) {
        sendResponse({ ok: false, error: "Not enough messages on screen to detect." });
        return;
      }
      send({ type: "detectMainLanguage", samples })
        .then(async ({ lang }) => {
          await dlUpdateGuild(key, (cur) => ({ ...cur, lang, locked: true, name: guildName() || cur.name }));
          sendResponse({ ok: true, lang });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  (async () => {
    settings = await dlGetSettings();
    guilds = await dlGetGuilds();
    window.addEventListener("keydown", onKeyDown, true);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    for (const el of document.querySelectorAll(MSG_SEL)) fresh.add(el);
    scheduleScan();
  })();
})();
