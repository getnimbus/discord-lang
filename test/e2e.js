// E2E: load the unpacked extension in Chromium, serve a mock Discord page, and a fake OpenAI-compatible API.
// Run with `npm test`. Screenshots land in test/output/.
const { chromium } = require("playwright");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

const EXT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "output");
fs.mkdirSync(OUT, { recursive: true });
const isVi = (s) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s);
const calls = [];

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { messages } = JSON.parse(body);
    const sys = messages[0].content;
    const user = messages[messages.length - 1].content;
    let content;
    if (sys.includes("translation engine")) {
      const { items } = JSON.parse(user);
      calls.push({ kind: "batch", n: items.length, auth: req.headers.authorization });
      content =
        "```json\n" +
        JSON.stringify({
          items: items.map((it) =>
            isVi(it.text) ? { id: it.id, lang: "vi", translation: `EN(${it.text})` } : { id: it.id, lang: "en", translation: null },
          ),
        }) +
        "\n```";
    } else if (sys.startsWith("Translate the user's")) {
      calls.push({ kind: "outgoing", text: user, sys });
      content = `VI(${user})`;
    } else if (sys.includes("ISO 639-1 code of the language")) {
      calls.push({ kind: "detect" });
      content = "vi";
    } else {
      calls.push({ kind: "test" });
      content = "ok";
    }
    setTimeout(() => {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
    }, sys.includes("translation engine") ? 700 : 0);
  });
});

const viTexts = [
  "xin chào mọi người, hôm nay thế nào?",
  "tối nay có ai chơi game không?",
  "mình vừa cập nhật bản mới rồi đó",
  "cảm ơn bạn nhiều lắm nhé",
];
const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Discord | #general | Test Server</title>
<style>body{background:#313338;color:#dbdee1;font:16px/1.375 system-ui;margin:0;padding:16px 16px 0} .emoji{width:22px;height:22px;vertical-align:bottom} .mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px} .repliedTextContent_x{font-size:13px;color:#949ba4} li{height:100px;list-style:none;border-bottom:1px solid #ccc} #list{margin:0;padding:0} #box{position:fixed;bottom:0;left:0;right:0;background:#eee}
[role=textbox]{min-height:30px;border:1px solid #000;padding:4px}</style></head><body>
<main><ol id="list">${Array.from({ length: 40 }, (_, i) => {
  const text = i % 5 === 4 ? `This message is written in plain English number ${i}` : viTexts[i % 4] + ` (${i})`;
  const rich = i === 0 ? `<span class="mention wrapper_x">@Chubby</span> <span>${text}</span> <img class="emoji" alt=":PANDA:" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Ccircle cx='5' cy='5' r='5' fill='orange'/%3E%3C/svg%3E">` : `<span>${text}</span>`;
  const reply = i === 2 ? `<div id="message-reply-context-2"><div class="repliedTextContent_x" id="message-content-r2">xin chào, đây là trả lời</div></div>` : "";
  return `<li id="chat-messages-222-${i}"><div>${reply}<h3>user${i}</h3><div id="message-content-${i}">${rich}</div></div></li>`;
}).join("")}</ol><div style="height:120px"></div></main>
<form id="box"><div role="textbox" data-slate-editor="true" contenteditable="true"><div data-slate-node="element"><span data-slate-string="true"></span></div></div></form>
<script>
  const ed = document.querySelector('[role=textbox]');
  window.sent = [];
  function setText(t){ ed.innerHTML = t.split('\\n').map(l => '<div data-slate-node="element"><span data-slate-string="true">'+l.replace(/</g,'&lt;')+'</span></div>').join(''); }
  window.setText = setText;
  ed.addEventListener('paste', e => { e.preventDefault(); setText(e.clipboardData.getData('text/plain')); });
  // Like React's root listener: bubbling handler that sends on Enter.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || !e.target.closest('[role=textbox]')) return;
    e.preventDefault();
    const text = [...ed.querySelectorAll('[data-slate-node=element]')].map(b => b.textContent).join('\\n');
    window.sent.push({ text, trusted: e.isTrusted, keyCode: e.keyCode });
    const id = 'sent' + window.sent.length;
    const li = document.createElement('li');
    li.innerHTML = '<div><div id="message-content-' + id + '"><span></span></div></div>';
    li.querySelector('span').textContent = text;
    document.getElementById('list').appendChild(li);
    setText('');
  });
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-prof-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route("https://discord.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MOCK_HTML }),
  );
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  await sw.evaluate(
    (s) => chrome.storage.local.set({ settings: s }),
    { apiKey: "sk-test", baseUrl: `http://localhost:${port}/v1`, model: "fake", myLang: "en", enabled: true, incoming: true, outgoing: true },
  );

  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("  [page error]", m.text()));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto("https://discord.com/channels/111/222");
  await page.waitForSelector(".dlt-pending", { timeout: 3000 }).catch(() => null);
  const pendingNow = await page.evaluate(() => document.querySelectorAll(".dlt-pending").length);
  await page.screenshot({ path: path.join(OUT, "shot-pending.png") });
  await sleep(2500);

  const state = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[id^="message-content-"]')].map((el) => ({
        id: el.id.replace("message-content-", ""),
        tr: (() => {
          const b = [el.previousElementSibling, el.nextElementSibling].find((x) => x?.classList.contains("dlt-translation"));
          return b ? b.textContent : null;
        })(),
        pos: el.previousElementSibling?.classList.contains("dlt-translation") ? "above" : el.nextElementSibling?.classList.contains("dlt-translation") ? "below" : null,
        original: el.classList.contains("dlt-original"),
        lang: el.dataset.dltLang || null,
        pending: el.classList.contains("dlt-pending"),
      })),
    );

  let s = await state();
  const byId = (id) => s.find((m) => m.id === String(id));
  check("shimmer shown while translating", pendingNow > 0, `${pendingNow} pending`);
  check("no shimmer left after translating", s.every((m) => !m.pending));
  check("top Vietnamese message translated", byId(0).tr?.includes("EN(@Chubby xin chào"), byId(0).tr);
  check("translation is on top, original demoted", byId(0).pos === "above" && byId(0).original && byId(0).lang === "VI", JSON.stringify(byId(0)));
  const rich = await page.evaluate(() => {
    const box = document.getElementById("message-content-0").previousElementSibling;
    return { img: box.querySelector("img.emoji")?.alt, mention: box.querySelector(".mention")?.textContent };
  });
  check("emoji + mention rendered in translation", rich.img === ":PANDA:" && rich.mention === "@Chubby", JSON.stringify(rich));
  check("reply preview left alone", byId("r2").tr === null && !byId("r2").original);
  await page.screenshot({ path: path.join(OUT, "shot.png") });
  s = s.filter((m) => m.id !== "r2");
  check("English message not translated", s[4].tr === null);
  check("offscreen message (#35) not translated yet", s[35].tr === null);
  const batchCalls = calls.filter((c) => c.kind === "batch");
  check("uses Bearer API key", batchCalls[0]?.auth === "Bearer sk-test");
  const sentEnglishToApi = batchCalls.reduce((a, c) => a + c.n, 0);
  console.log(`  batches: ${batchCalls.length}, items sent: ${sentEnglishToApi}`);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2000);
  s = (await state()).filter((m) => m.id !== "r2");
  check("message #36 translated after scrolling", s[36].tr && s[36].tr.includes("EN("), s[36].tr);

  await sleep(1800); // tally flush
  const guilds = await sw.evaluate(() => chrome.storage.local.get("guilds").then((r) => r.guilds));
  check("server language remembered as vi", guilds?.["111"]?.lang === "vi", JSON.stringify(guilds?.["111"]));
  check("server name remembered", guilds?.["111"]?.name === "Test Server", guilds?.["111"]?.name);

  // Persistent LRU: reload the tab; translations come back from cache without API calls.
  await sleep(5500); // cache save debounce
  const beforeReload = calls.filter((c) => c.kind === "batch").length;
  await page.reload();
  await page.waitForSelector(".dlt-translation", { timeout: 5000 }).catch(() => null);
  await sleep(1500);
  const afterReload = calls.filter((c) => c.kind === "batch").length;
  const reloaded = (await state()).filter((m) => m.tr);
  check("after reload, translations come from the persistent cache", reloaded.length >= 5 && afterReload === beforeReload,
    `${reloaded.length} translated, ${afterReload - beforeReload} new batch calls`);
  const tcacheLen = await sw.evaluate(() => chrome.storage.local.get("tcache").then((r) => (r.tcache || []).length));
  check("cache persisted to storage", tcacheLen > 0, `${tcacheLen} entries`);

  // Outgoing: type, press Enter (trusted key press).
  await page.evaluate(() => window.setText("hey everyone, who wants to play tonight?"));
  await page.click('[role=textbox]');
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await sleep(1500);
  let sent = await page.evaluate(() => window.sent);
  check("outgoing message translated and sent", sent[0]?.text === "VI(hey everyone, who wants to play tonight?)", JSON.stringify(sent));
  check("only one send happened", sent.length === 1);
  check("outgoing prompt targets Vietnamese", calls.find((c) => c.kind === "outgoing")?.sys.includes("into Vietnamese"));

  // Multi-line message.
  await page.evaluate(() => window.setText("line one here\nline two here"));
  await page.click('[role=textbox]');
  await page.keyboard.press("Enter");
  await sleep(1500);
  sent = await page.evaluate(() => window.sent);
  check("multi-line message translated", sent[1]?.text === "VI(line one here\nline two here)", JSON.stringify(sent[1]));

  // Alt+Enter sends raw.
  await page.evaluate(() => window.setText("send this raw please"));
  await page.click('[role=textbox]');
  await page.keyboard.press("Alt+Enter");
  await sleep(500);
  sent = await page.evaluate(() => window.sent);
  check("Alt+Enter sends untranslated", sent[2]?.text === "send this raw please", JSON.stringify(sent[2]));

  // Shift+Enter must not send.
  await page.evaluate(() => window.setText("newline test"));
  await page.click('[role=textbox]');
  await page.keyboard.press("Shift+Enter");
  await sleep(300);
  sent = await page.evaluate(() => window.sent);
  check("Shift+Enter does not send", sent.length === 3);

  // Already in the server language -> sent as-is without an API call.
  const before = calls.filter((c) => c.kind === "outgoing").length;
  await page.evaluate(() => window.setText("mọi người ơi, tối nay mình sẽ chơi game cùng nhau nhé, ai tham gia không?"));
  await page.click('[role=textbox]');
  await page.keyboard.press("Enter");
  await sleep(1000);
  sent = await page.evaluate(() => window.sent);
  const after = calls.filter((c) => c.kind === "outgoing").length;
  check("Vietnamese draft sent as-is", sent[3]?.text?.startsWith("mọi người ơi"), JSON.stringify(sent[3]));
  console.log(`  outgoing API calls for that one: ${after - before} (0 if local detection caught it)`);

  // Edited message gets re-translated.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
  await page.evaluate(() => (document.querySelector("#message-content-1 span").textContent = "bài này hay quá trời luôn"));
  await sleep(1500);
  s = (await state()).filter((m) => m.id !== "r2");
  check("edited message re-translated", s[1].tr?.includes("EN(bài này hay"), s[1].tr);

  // Change my language -> translations reset and re-requested with new target.
  const nBefore = calls.length;
  await sw.evaluate(() => chrome.storage.local.get("settings").then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, myLang: "fr" } })));
  await sleep(1500);
  s = (await state()).filter((m) => m.id !== "r2");
  check("changing my language re-translates", calls.length > nBefore && s[0].tr?.includes("EN(") && s[0].lang === "VI", JSON.stringify(s[0]));

  // Switch to original-on-top: re-renders from cache, no API calls.
  const nCalls = calls.length;
  await sw.evaluate(() => chrome.storage.local.get("settings").then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, display: "original" } })));
  await sleep(600);
  s = (await state()).filter((m) => m.id !== "r2");
  check("display=original puts translation below", s[0].pos === "below" && !s[0].original && s[0].tr?.includes("VI → FR"), JSON.stringify(s[0]));
  check("display switch made no API calls", calls.length === nCalls);

  // Replace mode: only the translation, original hidden.
  const setDisplay = (display) =>
    sw.evaluate((display) => chrome.storage.local.get("settings").then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, display } })), display);
  await setDisplay("replace");
  await sleep(600);
  let rep = await page.evaluate(() => {
    const el = document.getElementById("message-content-0");
    const box = el.previousElementSibling;
    return { hidden: getComputedStyle(el).display === "none", main: box?.classList.contains("dlt-main"), text: box?.textContent, title: box?.title };
  });
  check("replace mode hides the original, shows only the translation", rep.hidden && rep.main && rep.text.startsWith("EN(@Chubby"), JSON.stringify(rep));
  check("replace mode keeps the original on hover", rep.title.includes("Original: @Chubby xin chào"), rep.title);
  // Editing a hidden original still re-translates it.
  await page.evaluate(() => (document.querySelector("#message-content-3 span").textContent = "hôm nay trời đẹp quá"));
  await sleep(1500);
  rep = await page.evaluate(() => document.getElementById("message-content-3").previousElementSibling?.textContent);
  check("replace mode: edited hidden message re-translated", rep?.includes("EN(hôm nay trời đẹp quá)"), rep);
  await page.screenshot({ path: path.join(OUT, "shot-replace.png") });
  const nCalls2 = calls.length;
  await setDisplay("translated");
  await sleep(600);
  rep = await page.evaluate(() => {
    const el = document.getElementById("message-content-0");
    return { shown: getComputedStyle(el).display !== "none", original: el.classList.contains("dlt-original") };
  });
  check("switching back from replace shows the original again", rep.shown && rep.original && calls.length === nCalls2, JSON.stringify(rep));

  // Disable -> translations removed, Enter passes straight through.
  await sw.evaluate(() => chrome.storage.local.get("settings").then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, enabled: false } })));
  await sleep(500);
  s = await state();
  check("disabling removes translations", s.every((m) => m.tr === null));
  await page.evaluate(() => window.setText("plain passthrough message"));
  await page.click('[role=textbox]');
  await page.keyboard.press("Enter");
  await sleep(300);
  sent = await page.evaluate(() => window.sent);
  check("disabled: Enter sends original", sent[4]?.text === "plain passthrough message" && sent[4].trusted, JSON.stringify(sent[4]));

  // Usage recorded for today.
  const today = new Date().toLocaleDateString("en-CA");
  const usage = await sw.evaluate(() => chrome.storage.local.get("usage").then((r) => r.usage));
  check("usage recorded per day", usage?.[today]?.calls === calls.length && usage[today].in === 1000 * calls.length,
    JSON.stringify(usage?.[today]));

  // Popup with 14 days of seeded usage.
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => {
    const usage = {};
    for (let i = 0; i < 20; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (i === 5 || i === 9) continue; // quiet days
      const n = Math.round(40 + 60 * Math.abs(Math.sin(i * 1.7)));
      usage[d.toLocaleDateString("en-CA")] = { calls: n, in: n * 900, out: n * 180, billed: 0, unbilledIn: n * 900, unbilledOut: n * 180 };
    }
    return chrome.storage.local.set({ usage });
  });
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 1100 });
  popup.on("pageerror", (e) => console.log("  [popup error]", e.message));
  await popup.goto(`chrome-extension://${extId}/src/popup.html`);
  await sleep(500);
  const bars = await popup.evaluate(() => [...document.querySelectorAll("#chart .bar")].filter((b) => b.getAttribute("d")).length);
  check("chart draws a bar per active day", bars === 12, `${bars} bars`);
  const hits = await popup.$$("#chart .hit");
  await hits[13].hover();
  await sleep(150);
  const tip = await popup.evaluate(() => ({ hidden: document.getElementById("tip").hidden, text: document.getElementById("tip").textContent }));
  check("hover tooltip shows cost for today", !tip.hidden && tip.text.startsWith("$"), tip.text);
  const usageBox = await popup.$("#usage");
  await usageBox.screenshot({ path: path.join(OUT, "usage.png") });
  await popup.screenshot({ path: path.join(OUT, "popup.png"), fullPage: true });
  await popup.click("#clearCache");
  await sleep(300);
  const cleared = await sw.evaluate(() => chrome.storage.local.get("tcache").then((r) => r.tcache)); console.log("  tcache after clear:", JSON.stringify(cleared)?.slice(0, 80));
  check("Clear cache empties the persistent cache", !cleared?.length);

  console.log(`\n${failures ? failures + " FAILED" : "ALL PASSED"}; API calls: ${JSON.stringify(calls.map((c) => c.kind))}`);
  await ctx.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
