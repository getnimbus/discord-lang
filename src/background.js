// Background worker: the only place that talks to the LLM API.
// Content scripts send it messages; doing the fetch here avoids CORS issues
// with third-party OpenAI-compatible providers.

if (typeof importScripts === "function" && typeof dlGetSettings === "undefined") {
  importScripts("shared.js");
}

// Daily usage totals: { "YYYY-MM-DD": { calls, in, out, billed, unbilledIn, unbilledOut } }.
// "billed" is the exact cost when the provider reports it (e.g. OpenRouter's usage.cost);
// otherwise tokens go in unbilled* and the popup prices them with your per-1M rates.
const USAGE_DAYS_KEPT = 90;
let usageChain = Promise.resolve();

function recordUsage(usage) {
  usageChain = usageChain
    .then(async () => {
      const day = new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
      const { usage: all = {} } = await chrome.storage.local.get("usage");
      const d = all[day] || { calls: 0, in: 0, out: 0, billed: 0, unbilledIn: 0, unbilledOut: 0 };
      const tin = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
      const tout = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
      d.calls += 1;
      d.in += tin;
      d.out += tout;
      if (typeof usage?.cost === "number") d.billed += usage.cost;
      else {
        d.unbilledIn += tin;
        d.unbilledOut += tout;
      }
      all[day] = d;
      for (const old of Object.keys(all).sort().slice(0, -USAGE_DAYS_KEPT)) delete all[old];
      await chrome.storage.local.set({ usage: all });
    })
    .catch(() => {});
}

async function chatComplete(settings, messages) {
  if (!settings.apiKey) throw new Error("No API key set. Open the Discord Lang popup to add one.");
  const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model: settings.model, messages }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`API ${res.status}: ${detail}`.slice(0, 300));
  }
  const data = await res.json();
  recordUsage(data?.usage);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("API returned no message content");
  return content.trim();
}

// Models sometimes wrap JSON in ```json fences or add chatter; dig the object out.
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(body.slice(start, end + 1));
}

const PRESERVE_RULES =
  "Preserve Discord markdown (**bold**, *italic*, ||spoilers||, > quotes, `code`, ```code blocks```), " +
  "mentions (@name, <@123>, <#123>, <@&123>), emoji codes (:name:, <:name:123>), and URLs exactly as-is. " +
  "Do not translate code.";

async function translateBatch(settings, items, target) {
  const targetName = dlLangName(target);
  const system =
    `You are a translation engine for Discord chat. For each item, detect its language as an ISO 639-1 code ` +
    `and translate it into ${targetName} (${target}). Keep the tone, slang and casualness natural. ` +
    `${PRESERVE_RULES} If an item is already in ${targetName}, or has nothing to translate, set "translation" to null. ` +
    `Reply with ONLY a JSON object of the form {"items":[{"id":"...","lang":"xx","translation":"..." or null}]} ` +
    `containing every input id.`;
  const content = await chatComplete(settings, [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ items }) },
  ]);
  const parsed = extractJson(content);
  const out = Array.isArray(parsed?.items) ? parsed.items : [];
  return out
    .filter((it) => it && typeof it.id === "string")
    .map((it) => ({
      id: it.id,
      lang: dlNormLang(it.lang) || null,
      translation: typeof it.translation === "string" && it.translation.trim() ? it.translation : null,
    }));
}

async function translateOutgoing(settings, text, target) {
  const targetName = dlLangName(target);
  const system =
    `Translate the user's Discord message into ${targetName}. Write it the way a native speaker would type in a ` +
    `casual chat, keeping the original meaning, tone and register. ${PRESERVE_RULES} ` +
    `If it is already in ${targetName}, return it unchanged. Output ONLY the message text — no quotes, notes or explanations.`;
  return chatComplete(settings, [
    { role: "system", content: system },
    { role: "user", content: text },
  ]);
}

async function detectMainLanguage(settings, samples) {
  const system =
    "You will receive a JSON array of chat messages from one Discord server. " +
    "Reply with ONLY the ISO 639-1 code of the language most of them are written in.";
  const content = await chatComplete(settings, [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(samples) },
  ]);
  const code = dlNormLang((/[a-z]{2,3}/i.exec(content) || [""])[0]);
  if (!code) throw new Error("Could not detect language");
  return code;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const settings = await dlGetSettings();
    switch (msg?.type) {
      case "translateBatch":
        return { items: await translateBatch(settings, msg.items, msg.target) };
      case "translateOutgoing":
        return { text: await translateOutgoing(settings, msg.text, msg.target) };
      case "detectMainLanguage":
        return { lang: await detectMainLanguage(settings, msg.samples) };
      case "testConnection":
        return { text: await chatComplete(settings, [{ role: "user", content: "Reply with the word: ok" }]) };
      default:
        throw new Error(`Unknown message type: ${msg?.type}`);
    }
  })().then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true; // keep the channel open for the async response
});
