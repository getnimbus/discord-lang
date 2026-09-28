# Discord Lang

Browser extension that auto-translates Discord (web) using any **OpenAI-compatible** API with your own key.

- **Read**: messages are translated into your language as they scroll into view, with a shimmer while a translation is in flight. Three layouts (popup → *Show*):
  - *Translation, original small below* (default)
  - *Translation only*: replaces the original so it reads as if the sender wrote it. Hover to see the original.
  - *Original, translation below*
- **Cache**: translations are kept in an LRU cache keyed by message id (5,000 entries, saved across reloads). Scrolling back or reloading Discord doesn't spend API calls again. Edited messages are detected by a text hash and re-translated.
- **Cost**: the popup charts your spend per day for the last 14 days, with a table view. It uses the provider's reported cost when there is one (e.g. OpenRouter). Otherwise it's tokens × the per-1M prices you set (defaults are gpt-4o-mini's list prices).
- **Remember**: it tallies the language of every message it sees per server (and per DM). The most common one becomes that server's main language. You can pin it manually.
- **Write**: press Enter and your message is translated into the server's main language, then sent.
  - <kbd>Alt</kbd>+<kbd>Enter</kbd> sends exactly what you typed.
  - Slash commands (`/…`) and messages already in the server's language are sent as-is.
  - If translation fails, nothing is sent and your draft stays in the box.

## Install (from a shared zip)

1. Unzip `discord-lang-<version>.zip` into a folder you'll keep. Chrome loads the extension from that folder, so don't delete it.
2. **Chrome / Edge / Brave / Arc**: open `chrome://extensions`, turn on *Developer mode* (top right), click *Load unpacked*, and pick the unzipped folder (the one that contains `manifest.json`).
3. **Firefox (121+)**: open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and pick the `.zip` itself. Firefox removes temporary add-ons when it restarts.

Then open the extension popup and fill in:

| Field    | Example                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------- |
| Base URL | `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (Ollama) |
| API key  | `sk-…`                                                                                         |
| Model    | `gpt-4o-mini` or any model your provider has                                                   |

Click **Save & test**. If Discord was already open, reload the tab.

## Per-server controls (popup, on a Discord tab)

- **Main language**: *Auto* (learned from what you read) or pinned to a specific language. **Detect** asks the model to classify the messages on screen and pins the result.
- Turn incoming or outgoing translation on or off for just that server.

## Notes

- Messages you read or send go to whichever API provider you configure.
- To cut API calls, the browser's built-in language detector skips messages that are clearly already in your language.
- It relies on Discord's DOM (`[id^="message-content-"]` for messages, the Slate `[role="textbox"]` editor for input). A Discord UI update can break it.
- Discord's terms don't allow client modifications. This extension only changes what you see and what you type, but use it at your own risk.

## Development

Plain JavaScript, no build step: the browser loads the files straight from this repo.

### Setup

```sh
git clone git@github.com:getnimbus/discord-lang.git
cd discord-lang
npm install                      # only needed for tests (Playwright)
npx playwright install chromium  # first time only
```

Load the repo folder with *Load unpacked* as above.

### Edit → reload loop

| You changed                                   | To see it                                                      |
| --------------------------------------------- | -------------------------------------------------------------- |
| `src/content.js`, `src/content.css`, `src/shared.js` | Click ↻ on the extension in `chrome://extensions`, then reload the Discord tab |
| `src/background.js`, `manifest.json`          | Click ↻ on the extension                                        |
| `src/popup.*`                                 | Just reopen the popup                                           |

Debugging:
- **Content script**: DevTools on the Discord tab, then pick the *Discord Lang* context in the console's context dropdown.
- **Background worker**: click *service worker* on the extension's card in `chrome://extensions`.
- **Popup**: right-click the popup and choose *Inspect*.

### Layout

```
manifest.json        MV3 manifest (Chrome + Firefox)
src/shared.js        settings/storage helpers, loaded everywhere
src/background.js    the only code that calls the LLM API; records daily usage
src/content.js       runs on discord.com: incoming translation, language memory, Enter hook, LRU cache
src/content.css      translation layout, shimmer, toast
src/popup.*          settings, per-server controls, cost chart
icons/               icon.svg / icon-small.svg sources and the rendered PNGs
test/e2e.js          end-to-end test (mock Discord page + fake API)
scripts/package.sh   builds the shareable zip
```

### Test

```sh
npm test
```

This loads the extension into headless Chromium and runs it against a mock Discord page and a fake OpenAI-compatible server. It covers incoming and outgoing translation, language memory, the display modes, the cache, and cost tracking. Screenshots go to `test/output/`. It doesn't exercise the real Discord DOM, so after changing selectors, check on discord.com too.

### Package for sharing

```sh
npm run package   # → dist/discord-lang-<version>.zip
```

The zip contains only `manifest.json`, `src/`, and the icon PNGs. Bump `version` in `manifest.json` before packaging a new release.

