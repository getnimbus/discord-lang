// Shared helpers — loaded by the content script, popup, and background worker.
/* eslint-disable no-unused-vars */

const DL_DEFAULT_SETTINGS = {
  enabled: true,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  myLang: ((typeof navigator !== "undefined" && navigator.language) || "en").split("-")[0],
  incoming: true, // translate messages as they scroll into view
  outgoing: true, // translate what I type before sending
};

// Common languages offered in the UI. Anything ISO 639-1 works though.
const DL_LANGS = [
  "en", "vi", "zh", "ja", "ko", "es", "pt", "fr", "de", "it", "ru", "uk", "pl",
  "nl", "tr", "ar", "he", "fa", "hi", "id", "ms", "th", "tl", "sv", "no", "da",
  "fi", "cs", "ro", "hu", "el",
];

const DL_LANG_NAMES = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
})();

function dlLangName(code) {
  if (!code) return "Unknown";
  try {
    return (DL_LANG_NAMES && DL_LANG_NAMES.of(code)) || code;
  } catch {
    return code;
  }
}

function dlNormLang(code) {
  return String(code || "").trim().toLowerCase().split(/[-_]/)[0];
}

// Discord URLs look like /channels/<guildId>/<channelId>. DMs use "@me",
// so each DM conversation gets its own remembered language.
function dlGuildKeyFromPath(pathname) {
  const m = /^\/channels\/([^/]+)(?:\/([^/]+))?/.exec(pathname || "");
  if (!m) return null;
  if (m[1] === "@me") return m[2] ? `dm:${m[2]}` : null;
  return m[1];
}

async function dlGetSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DL_DEFAULT_SETTINGS, ...(settings || {}) };
}

async function dlSaveSettings(patch) {
  const current = await dlGetSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Per-server memory: { lang, locked, counts: {code: n}, name, incoming?, outgoing? }
async function dlGetGuilds() {
  const { guilds } = await chrome.storage.local.get("guilds");
  return guilds || {};
}

async function dlGetGuild(key) {
  const guilds = await dlGetGuilds();
  return guilds[key] || { lang: null, locked: false, counts: {} };
}

async function dlUpdateGuild(key, fn) {
  const guilds = await dlGetGuilds();
  const current = guilds[key] || { lang: null, locked: false, counts: {} };
  guilds[key] = fn(current) || current;
  await chrome.storage.local.set({ guilds });
  return guilds[key];
}

// Most frequently seen language wins, unless the user pinned one.
function dlPickMainLang(counts) {
  let best = null;
  let bestN = 0;
  for (const [code, n] of Object.entries(counts || {})) {
    if (n > bestN) {
      best = code;
      bestN = n;
    }
  }
  return best;
}
