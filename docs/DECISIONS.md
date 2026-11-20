# Decisions

Every call made without asking, why it was made, and where it lives in the code. Three parts:

1. [What the official docs say that differs from the brief](#1-what-the-official-docs-say-that-differs-from-the-brief)
2. [Decisions](#2-decisions)
3. [Assumptions that a person must confirm](#3-assumptions-that-a-person-must-confirm)

Docs were read on 2026-11-20. Behaviour marked "tested" was checked in Chromium 153 (the browser the end-to-end suite runs in), not taken from the docs.

---

## 1. What the official docs say that differs from the brief

| # | Brief | What the docs (and tests) say | What was done |
|---|---|---|---|
| 1 | "When the panel has no access to the current tab, show a one-click 'Analyze this page' that obtains access properly." | The activeTab page lists four gestures that grant access: executing the action, a context-menu item, a keyboard shortcut, an omnibox suggestion. A click inside a side panel is not one of them. Tested: a button in the panel never grants access, and without access `tabs.query` returns no URL, so the panel cannot even ask Chrome for that one site by name. | The one click is the **toolbar icon** (its tooltip is "Analyze this page with Legiit Lens"), the **keyboard shortcut**, or the **context-menu item "Analyze this page with Legiit Lens"**. Each is a single action. When the panel has no access it shows an "Analyze this page" card that names these three, with the shortcut Chrome actually assigned. See D-02 and D-03. |
| 2 | The side panel is the main surface (implies opening it from the toolbar icon). | `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` is the documented way to open the panel from the icon. Tested: with that setting the click does **not** fire `action.onClicked` and does **not** grant activeTab. The docs do not mention this. | The setting is not used. `action.onClicked` opens the panel with `sidePanel.open()` inside the gesture, which grants activeTab and opens the panel in the same click. `sidePanel.open()` needs Chrome 116, so `minimum_chrome_version` is 116. |
| 3 | "Chrome built-in Prompt API, only if the user opts in and availability is ready." | The API is the global `LanguageModel` (extensions: Chrome 138+). No manifest permission and no origin-trial token; the old `aiLanguageModelOriginTrial` permission is expired and must not be listed. `availability()` returns `unavailable`, `downloadable`, `downloading` or `available`; there is no "ready" state. A first download needs a user gesture, about 22 GB of free disk space and either more than 4 GB of VRAM or 16 GB RAM with 4 cores. | Provider 2 is used only when the user ticked the opt-in **and** `availability()` is `available`. The download is started only from a button in Settings (a user gesture) with progress shown. The hardware note is shown next to the opt-in. No permission was added. |
| 4 | "'wasm-unsafe-eval' only if required" | Allowed values for `script-src` on extension pages are `'self'`, `'none'`, `'wasm-unsafe-eval'` (and localhost for unpacked builds). `'unsafe-eval'` is refused at install. Under the default policy WebAssembly is disabled. | It is required: ONNX Runtime compiles a WebAssembly binary. `script-src 'self' 'wasm-unsafe-eval'`, nothing else. The build fails if `script-src` is anything else (`scripts/package-release.mjs`). |
| 5 | "Read … offscreen documents" | One offscreen document per extension; only the `runtime` API is available inside it; needs the `offscreen` permission. | Not used, so the permission is not requested. Everything that would need one (DOMParser, a Web Worker for the embedding model) runs in the side panel page, which is open whenever a feature runs. See D-07. |
| 6 | "Match patterns have no TLD wildcard" | Confirmed, in those words: list each TLD. | One list, `src/config/google-domains.ts`: the 187 domains from `google.com/supported_domains`. The manifest patterns are generated from it. |
| 7 | "Everything else is optional_host_permissions, requested at the moment of use" | Documented pattern: put `https://*/*` in `optional_host_permissions`, then `permissions.request()` any specific origin found at run time. Must be called from a user gesture. Paths in patterns are ignored. Not in the docs, found by testing: a requested pattern must fit inside **one** optional pattern. With `https://*/*` and `http://*/*` listed separately, Chrome refuses `*://*.example.com/*` with "Only permissions specified in the manifest may be requested". | `optional_host_permissions: ["*://*/*"]`, which covers http and https in one pattern. Requests always name specific sites (`*://*.example.com/*`), never the wildcard. See D-10. |
| 8 | "Remote JSON (selectors) allowed only as data." | Confirmed: a remote configuration file is allowed as long as all logic is in the package. | Not used in v1: there is no agreed endpoint to fetch packs from, and a second required host would be needed. Packs ship in the package; a newer pack can be pasted on the health-check page. See D-15. |
| 9 | "summary within the current character limit" | The manifest `description` is limited to 132 characters and is what the store shows as the summary. No limit is stated for the detailed description. | The single-purpose sentence (96 characters) is the manifest description. The build fails above 132. |
| 10 | "Check the store's size limit." | "The maximum supported file size for an extension package is 2GB." | `release.zip` is 19.3 MB (38.5 MB unpacked). Almost all of it is the embedding model (21.9 MB) and its WebAssembly runtime (13.6 MB). The build prints the sizes and fails above the limit. |
| 11 | Data-usage answers for the store | Local-only processing still counts as handling user data: it must be disclosed and needs a privacy policy. The Limited Use statement must be on a website the publisher owns. The checkbox labels on the Privacy practices tab are not in the docs text (only in screenshots). | `store/data-usage.md` answers by data type and says which labels to verify in the dashboard. Hosting the policy and the Limited Use statement is on the human list. |
| 12 | Five 1280×800 screenshots | 1 to 5 screenshots, 1280×800 or 640×400, square corners, full bleed. | Generated at exactly 1280×800 with no frame or padding. |

Other facts from the docs that shaped the design:

- `sidePanel.open()` "may only be called in response to a user action", which includes a gesture on a content script. Tested: the strip's "Open panel" button (content script → service worker → `sidePanel.open({ tabId })`) works.
- activeTab "lasts while the user is on that page, and is revoked when the user navigates away". Tested: navigation within the same origin keeps it; leaving the origin revokes it and going back does not restore it; it is granted only if the tab is the active one.
- Content scripts are bound by the same-origin policy even when the extension has host permissions. So cross-site reading is done by the side panel page, and the content script only ever reads its own site (D-11).
- None of the five permissions shows an install warning according to the permissions list. The install prompt comes from the host access: Google Search, the four AI sites, web.archive.org and the Legiit API host.

---

## 2. Decisions

### Platform and access

**D-01 · Build tool: WXT (0.21.5), not Vite + CRXJS.**
WXT is under active development with frequent releases, builds on current Vite (8), and covers what this extension needs without plugins of its own: side panel and options entry points, content scripts, an unlisted script for on-demand injection, a generated manifest and a zip. Generating the manifest from code is what lets the Google domain list live in one TypeScript file. Both tools build with Vite, so moving later is cheap. `wxt.config.ts`.

**D-02 · The toolbar icon has no popup; `action.onClicked` opens the side panel.**
This is what makes one click do both things the brief needs: grant activeTab and open the panel (row 2 above). `src/entrypoints/background.ts` (`invoke`). Tested in `e2e/access.spec.ts`.

**D-03 · No fake "Analyze" button in the panel.**
A button that cannot grant access would look broken. The panel's "Analyze this page" card (`AccessCard` in `src/ui/shared.tsx`) explains the three one-action ways and re-checks access. Once the user has invoked the extension the panel can see the address, and offers "Always allow on example.com", which asks Chrome for that one site so the panel keeps working there without invoking again (`KeepAccess`). Considered and rejected: `permissions.addHostAccessRequest()` (the user still has to click in the toolbar, and its prompt depends on a Chrome UI that is not on for everyone); asking for all sites from the panel (against rule 2).

**D-04 · `contextMenus` is requested.**
The brief allows it "only if needed". It is: a context-menu item is one of the few gestures that grant activeTab (the extension offers three: icon, shortcut, context menu), it works when the icon is not pinned, and "Check the selected text with New or Noise" needs the selection. Two items, created in `createMenus()`.

**D-05 · No `tabs` permission.**
`tabs.query` and `tabs.sendMessage` work without it; only the URL and title are withheld. The panel learns about a page from the agent running in it (`src/panel/tabs.ts`). This keeps "Read your browsing history" out of the install prompt.

**D-06 · Three agents, one protocol.**
`google.content.ts` and `ai.content.ts` are static content scripts. `page-agent.ts` is injected with `scripting.executeScript` only after activeTab or a site grant. All three answer the same validated requests (`src/content/agent.ts`, `src/model/messages.ts`). Content scripts get their settings from the service worker, because extension storage is closed to them (D-21).

**D-07 · No offscreen document, and the service worker does no work.**
The service worker opens the panel, hands configuration to content scripts and stores snapshots. It contains no network API at all (checked on the built file). Parsing, fetching and the embedding worker live in the side panel page. Result: no `offscreen` permission, and nothing depends on the service worker staying alive.

**D-08 · AI sites are read only when the panel asks.**
On load the AI content script only registers a message listener (and asks the service worker whether a newer selector pack was saved). It reads the latest answer when the panel sends a request, so opening ChatGPT without using Lens reads nothing. The Google script measures on load because the strip has to show something.

**D-39 · After an invocation the panel retries for about two seconds.**
Found by running the suite repeatedly: right after the extension is invoked, Chrome can still refuse the panel's first attempt to read the page. This was seen about once in a hundred invocations, on a loaded machine, in Chromium 153, with the action triggered through the DevTools protocol; the likely cause is that the grant reaches the page's process slightly after the click event reaches the extension. Whether a real toolbar click can hit the same gap is not known, and the cost of being wrong is a user left on "No access" right after clicking the icon. A refusal that directly follows an invocation is therefore not treated as final: the probe is repeated after 100, 250, 500 and 1200 ms (`INVOKED_RETRY_DELAYS_MS` in `src/ui/hooks.tsx`). Without an invocation a refusal is final at once. Tested in `e2e/access.spec.ts`.

### Network and data

**D-09 · One guarded way out.**
Extension pages have a single `fetch` call site, `src/net/guarded-fetch.ts`. Every request states a purpose: `wayback` (must be `https://web.archive.org`), `legiit` (must be the Legiit origin) or `page` (Chrome must hold a host permission for that site, checked with `permissions.contains` right before the request, and again for the final URL after redirects). Requests are sent without cookies and without a referrer. ESLint forbids `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource` anywhere else; `e2e/build.spec.ts` counts the call sites in the built files.

**D-10 · Site grants are per registrable host, with subdomains: `*://*.example.com/*`.**
A page's links, redirects and `www`/non-`www` variants would otherwise need a second prompt. The UI names every site before Chrome's prompt and says why (`PermissionLine`). Granted sites are listed and removable in Settings. Caveat: the host is taken as written minus `www.`, without a public-suffix list, so a page on `blog.example.com` grants `*.blog.example.com` only.

**D-11 · Instant Brief reads the site from inside the tab.**
The up-to-8 navigation pages are fetched by the content script in the tab the user invoked the extension on (`src/content/same-origin-fetch.ts`). A same-origin request needs no permission beyond the activeTab grant the user just gave, so building a brief causes no extra prompt. The reader refuses any address on another origin, drops redirects that leave the site, and sends no cookies. This is the second and last `fetch` call site in the package. In the words of the definition of done, these are "pages fetched after an explicit permission grant": the grant is activeTab, given for that site by the user's own invocation.

**D-12 · Wayback: 24 captures, 2 at a time, back off on 429.**
As specified. Captures are sampled evenly across the history, always keeping the first and last (`sampleCaptures`). Raw captures (`id_`) are fetched so the archive's banner and link rewriting are not measured. A 429 or 503 pauses all requests (honouring `Retry-After`), with up to 4 retries. The index and each capture's facts are cached in IndexedDB.

**D-13 · Snapshots are saved when the panel is open on the results page.**
The brief says "save a snapshot per keyword". Saving one for every Google search would quietly build a search history, so the default is: save when the user looks at a results page with the panel open, or presses Save on the strip. Settings offers "for every results page" and "only when I click Save".

**D-14 · Disconnecting removes what came from the account.**
"Disconnect" deletes the token and the brands, competitors, focus keywords and avatars that were pre-filled from Command Center. Brands the user typed stay.

### Reading pages

**D-15 · Selector packs: bundled, versioned, overridable by pasting.**
One JSON file per site in `src/selectors/`. Each slot has ordered candidates (CSS, optional text pattern, optional `closest`); the first that matches wins. The health-check page shows per open page which candidate matched, and accepts a newer pack pasted as JSON. A pasted pack is validated, stored on the device, used only if its version is newer than the bundled one, and is never executed: it is selectors and text patterns. Fetching packs from a server is left for when there is an endpoint (row 8).

**D-16 · The strip sits before the results container and is subtracted from measurements.**
It is inserted as a sibling before `#rcnt`, in a closed shadow root, as one row. Nothing of Google's is hidden, moved or restyled; results move down by exactly the strip's height. Positions are reported minus that height, so the numbers are the page as Google laid it out. Tested: with and without the strip, Google's markup is byte-identical and every block keeps its size and x position.

**D-17 · The grade formula.**
`score = 100 − position penalty (0–60) − displacement penalty (0–40)`. Position: how far down the first screen the first organic result starts; at or below the fold is the full 60. Displacement: the share of first-screen result pixels that is not organic. A ≥ 85, B ≥ 70, C ≥ 50, D ≥ 30, F below. Knowledge panels are beside the results and not counted. It is labelled "estimate" everywhere, and the method is shown in the panel (`GRADE_METHOD`). It is a layout measure, not a click-through prediction; the 60/40 weights are a judgement call and easy to change in `src/features/click-potential/metrics.ts`.

**D-18 · Featured snippet is its own block.**
A result shown as a featured snippet is counted as "featured snippet", not as organic result 1. Otherwise a page would look like it had lots of organic room when the first plain result is far down.

**D-19 · New or Noise thresholds.**
A competing page "says" a sentence when its closest sentence has cosine similarity ≥ 0.72. "Said by most" means more than half of the pages that could be read; "said by some" at least one; "only here" none. Passages for Why Not Me use ≥ 0.50. The fallback without the model compares stemmed word sets (overlap ≥ 0.50, passages ≥ 0.30) and says so in the UI. The values were calibrated on the fixture corpus with the real model (`tests/unit/embedding-model.test.ts`): paraphrases score 0.75–0.95, unrelated sentences below 0.3. Sentences under five words are ignored.

**D-20 · The model ships in the repository and the package.**
`Xenova/all-MiniLM-L6-v2`, 8-bit quantized (22 MB, Apache-2.0), pinned by revision and SHA-256 in `models.lock.json`; the build verifies the hashes. Run with transformers.js 4.3.2 and ONNX Runtime's WebAssembly backend only, single-threaded (threads need cross-origin isolation, which an extension page does not have). Only one of ONNX Runtime's four binaries is shipped (`ortSingleWasm` in `wxt.config.ts`), which keeps about 70 MB out of the package. Remote models are disabled, and the worker replaces `fetch` (and the library's own reference to it) with one that refuses anything outside the package.

### Safety

**D-21 · Extension storage is closed to content scripts.**
`storage.local.setAccessLevel('TRUSTED_CONTEXTS')`. The Legiit token, tracked brands and settings cannot be read from a compromised page's content-script context.

**D-22 · Page content never reaches `innerHTML`.**
Fetched HTML is parsed with `DOMParser` into an inert document and read. UI is React (text nodes) or `textContent`. ESLint forbids `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `dangerouslySetInnerHTML`. Every message between contexts is checked against a list of types and a schema (`src/model/schemas.ts`, valibot); content scripts' messages are accepted only from the Google and AI hosts. CSV cells that start with `=`, `+`, `-` or `@` are prefixed so a spreadsheet does not run them. Logos are accepted only as PNG, JPEG, WebP or GIF data URLs (no SVG).

**D-23 · CSP allows inline styles, not inline scripts.**
`style-src 'self' 'unsafe-inline'`. Parsing fetched pages with `DOMParser` otherwise logs a CSP error for every `style` attribute in them. Scripts stay at `'self' 'wasm-unsafe-eval'`. Images are limited to the package and data/blob URLs, so the panel never loads a remote image.

**D-24 · Readable output.**
`minify: false`, no source maps, no obfuscation. A reviewer can read `dist/` directly; the package is dominated by the model, so minifying would save little.

### Product

**D-25 · Highlighting uses the CSS Custom Highlight API.**
Ranges are registered with `CSS.highlights` and styled by an adopted stylesheet. No node is added or wrapped. The fallback (browsers without the API) is one overlay element in a closed shadow root. Tested: the page's DOM is byte-identical before, during and after.

**D-26 · PDF is "print to PDF".**
`print.html` renders the brief with print CSS, agency name and logo, and no Legiit branding; the user chooses "Save as PDF" in Chrome's print dialog. A PDF library would add weight for a worse result than the browser's own. The Markdown export is equally white-label.

**D-27 · Three template avatars, labelled draft.**
With no AI, avatars come from templates keyed on what was found (business type, services, areas, testimonials). They are labelled "Draft" in the UI, Markdown, print page and the Legiit payload (`draft: true`).

**D-28 · AI only rewrites; it never measures.**
Every "What explains it" card is built from measured facts by templates. A model, when available, is given only those facts and asked to rewrite them. The card says who wrote it.

**D-29 · Legiit AI needs a click and shows its request.**
Being connected is not consent to send. "Rewrite with Legiit AI" opens a dialog with the exact JSON; nothing is sent until "Send". Same pattern as every save (rule 4).

**D-30 · What you see is what is sent.**
`src/legiit/payloads.ts` builds each payload once; the dialog shows that object and the client sends that object. The end-to-end tests compare the bytes on the wire with the text in the dialog.

**D-31 · Endpoints that are not there are hidden.**
The session lists capabilities; a method whose capability is missing has no button. If a request comes back 404, 405 or 501 anyway, the button disappears for the session.

**D-32 · Gating is one constant.**
`REQUIRE_ACCOUNT_AFTER_FREE_RUNS` in `src/config/constants.ts`: `false` (shipped) or a number of free runs. While it is `false` nothing is counted or stored.

**D-33 · No analytics, no error reporting.**
None in v1, as specified. Settings shows the hosts contacted from the current window so a user can check.

### Tests

**D-34 · Fixtures are synthetic.**
All fixture pages are written by `scripts/build-fixtures.mjs`: invented businesses on the reserved `.example` domain, in markup modelled on the real sites' structure. No page was copied from Google or an AI site, and the tests never contact them. Consequence: the selector packs are a best effort and **must be checked against the live sites** before release (see `docs/QA.md`). The dev-only "save this page as fixture" command exists for exactly that.

**D-35 · Tests that need a site grant run against a copy of the build with the fixture domains pre-granted.**
Chrome's permission prompt cannot be answered by automation (the `--apps-gallery-install-auto-confirm-for-tests` switch does not apply to it; tried). For those tests the harness copies `dist/` and adds `*://*.example/*` to `host_permissions`; nothing else differs. Everything else, including all access and network tests, runs against `dist/` as built. Declining the prompt is tested by answering it in the page (`network.spec.ts`).

The pre-granted copy hides one thing, and it did hide a real bug during development: whether Chrome accepts the request in the first place (row 7 above). So `e2e/access.spec.ts` also watches the real `chrome.permissions.request` call in the unmodified build for all three places that ask ("Scan sources", "Compare", "Always allow on this site") and requires it to be waiting for the user, with exactly the sites the UI named. What remains for a person: clicking "Allow" once on a live page (`docs/QA.md`, sections 2 and 6).

**D-36 · Web archive tests run on fixtures only.**
web.archive.org is not reachable from the build environment. CDX parsing, sampling, back-off and diffing are tested against recorded-format fixtures; one manual check against the live archive is in `docs/QA.md`.

**D-37 · TypeScript 6, strict.**
`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Explicit imports only (WXT auto-imports are off) so every dependency of a file is visible in it.

**D-38 · The development build is not the release build.**
`npm run dev` produces `.output/chrome-mv3-dev`. For hot reloading WXT adds things to that manifest that the release does not have: the `tabs` permission, `http://localhost/*`, a reload shortcut, localhost in the CSP, and content scripts registered at run time instead of in the manifest. The dev build also carries the fixture-saver shortcut. Permissions, the install prompt and the activeTab behaviour must therefore be judged on `dist/` only; every check in `scripts/package-release.mjs` and `e2e/` runs against `dist/`.

### The Legiit API contract

The API did not exist when the extension was built. These decisions shape the contract the Legiit backend team builds from (`docs/legiit-api/`).

**D-40 · The contract is the source of truth, and everything around it is generated from it or tested against it.**
`docs/legiit-api/openapi.yaml` states a meaning and a limit for every field. `reference.md` is generated from it. The example requests are built by the payload code from the test fixtures, the example replies come from the mock server, and unit tests fail when the client, the mock server, the limits in the code, the examples or the reference drift from the contract. `npm run api:check` runs the same client code against a real server.

**D-41 · Tolerant in what it reads, exact in what it sends.**
An installed extension cannot be changed quickly, so replies are read loosely: unknown fields and unknown capability names are ignored, optional fields may be missing or null, an id may be an integer, over-long text and lists are cut. A reply that lacks a required field is refused as a whole. A save counts as saved only when the reply is JSON with an `id`: an empty 2xx could be a login page or a proxy, and "Saved" must not be shown for it. Requests are the opposite: every field is always present, and nothing exceeds its stated limit.

**D-42 · Only 401 means "this token is bad".**
A 401 on the session check deletes the token. A 403 used to do the same; it now shows the server's message and keeps the token, because backends commonly answer 403 for plan limits, and that must not disconnect the user.

**D-43 · "This business does not exist" is told apart from "this endpoint does not exist".**
Both are 404. The first carries `error.code: "not_found"` and is shown as an error; the feature stays. Any other 404, 405 or 501 means the endpoint is not built: the user is told, then the feature is hidden until the page is reopened. Before this, a deleted business made the save button disappear without a word.

**D-44 · Every save carries an `Idempotency-Key`.**
A random UUID, created when the save dialog opens and repeated for every send from that dialog, so a retry after a timeout need not store the item twice. It is a header, not part of the body the user reviews, so the dialog says that the token, the extension's version and a one-time number go with the body, and so does the privacy policy.

**D-45 · Hard limits on everything that is sent.**
`src/legiit/limits.ts` holds the maximum length of every text and list; the payload builders enforce them, and a test keeps them equal to the contract. No body is larger than 1 MB (the client refuses to send more), which is the default request limit of nginx. All text is made valid Unicode before sending: a cut can no longer leave half an emoji, which strict JSON stores refuse.

**D-46 · Codes for machines, text for people.**
Where the server may want to act on a value, the payload carries a code and not an English label: `above`/`partly`/`below` for the fold, `surfaceId` next to the gap list's display label, `code` next to an issue's title.

**D-47 · A competitor has one shape everywhere: `name` and `domains`.**
Business Details already returned `domains` as a list; the add-competitor body and the brief sent a single `domain`. They now match.

**D-48 · A snapshot lists every tracked brand.**
Brands with no organic result on the page are sent with `position: null`, so "not ranking" is stated and does not have to be inferred from a missing entry. `resultsOffset` says which results page was measured.

**D-49 · A content analysis says what was checked and when; a brief says which brief it is.**
The content-editor body carries `source` (page, selection or pasted text) and `capturedAt`, and `pagesCompared` always equals the number of `comparedUrls`. The workspace body carries the extension's own `briefId`, so a brief that is sent again can be recognised.

**D-50 · 20 seconds for a reply, 60 for AI, never from cache.**
The time limit covers the whole reply, not only its headers. Requests are sent with `cache: 'no-store'`, so a session or a business is always read fresh. Nothing is retried automatically.

**D-51 · The mock server is the reference implementation.**
It validates every request body against the contract and implements the recommended behaviours (idempotency keys, no duplicate competitors, the two kinds of 404). The conformance check is run against it in the unit tests, so the check itself is known to pass against a correct server.

---

## 3. Assumptions that a person must confirm

| # | Assumption | Where to change it |
|---|---|---|
| A-1 | The Legiit API is at `https://api.legiit.com`. It is a **required host in the manifest**; changing a required host later re-prompts every user, so settle it before the first submission. | `DEFAULT_LEGIIT_API_BASE_URL` in `src/config/constants.ts`, or `LEGIIT_API_BASE_URL` at build time |
| A-2 | The endpoint paths, payloads, capability names and bearer-token auth in `docs/legiit-api/openapi.yaml`. They were written from the brief's method list; the Legiit backend team builds the API from that contract (see `docs/legiit-api/README.md`). | `src/legiit/http-client.ts`, `src/legiit/types.ts`, `src/legiit/payloads.ts`, the contract |
| A-3 | Command Center links returned by save endpoints (`url` in the response) are safe to show as "Open in Command Center". | `SaveToLegiit` in `src/ui/shared.tsx` |
| A-4 | Product name "Legiit Lens", publisher "Legiit". | `src/config/constants.ts` |
| A-5 | The shortcut Alt+Shift+L is free on users' machines. Chrome silently drops a suggested shortcut that is taken; the panel then tells the user where to set one. | `SUGGESTED_SHORTCUT` |
| A-6 | Minimum Chrome 116. | `MINIMUM_CHROME_VERSION` |
| A-7 | The Google and AI-site selectors match the live sites. Unverified (D-34). | `src/selectors/*.json` |
| A-8 | The privacy policy's contact address, company name and effective date (placeholders marked in the file). | `store/privacy-policy.md` and `.html` |
| A-9 | No endpoint exists for saving Rewind timelines; none was in the brief's method list, so Rewind has no "Save to Command Center". Industry Pulse is used as date presets in Rewind. | `src/ui/tabs/RewindTab.tsx` |
| A-10 | Icons, promo tiles and screenshots are placeholders (marked). | `store/`, `scripts/make-icons.mjs` |
