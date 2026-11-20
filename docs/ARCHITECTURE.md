# Architecture

Legiit Lens is a Manifest V3 Chrome extension. Single purpose: *shows how visible a web page or brand is in Google results and AI answers, and what explains it.* Everything runs on the user's device; there is no backend of its own.

Read with: [DECISIONS.md](DECISIONS.md) (why), [PERMISSIONS.md](PERMISSIONS.md) (what each permission is used for), [QA.md](QA.md) (what to check by hand).

## The parts

```
                         the user's tab                                   extension
 ┌───────────────────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ Google results page                           │        │ service worker (background.ts)       │
 │   google.content.ts   measures, shows strip   │◀──────▶│   opens the panel on a user gesture  │
 │                                               │ config │   gives content scripts their config │
 │ ChatGPT / Gemini / Perplexity / Copilot       │ events │   stores snapshots                   │
 │   ai.content.ts       reads the answer on ask │        │   no network, no page data kept      │
 │                                               │        └──────────────────────────────────────┘
 │ any other page, after the user invoked Lens   │        ┌──────────────────────────────────────┐
 │   page-agent.ts       injected on demand      │◀──────▶│ side panel (sidepanel.html, React)   │
 └───────────────────────────────────────────────┘ tab    │   the five features + Settings       │
                                                  requests│   parses, compares, exports          │
        web.archive.org ◀── guarded fetch ────────────────│   fetches: Wayback, granted sites,   │
        sites the user granted ◀── guarded fetch ─────────│            Legiit when connected     │
        Legiit API (when connected) ◀── guarded fetch ────│   embed.worker.ts: on-device model   │
                                                          └──────────────────────────────────────┘
                                                          options · onboarding · health · print pages
```

| Context | File | What it does | What it cannot do |
|---|---|---|---|
| Service worker | `src/entrypoints/background.ts` | Turns the toolbar icon, shortcut and context menu into "open the panel on this tab"; answers content scripts (config, save snapshot, open panel); tells open results pages when settings change | Make network requests (it has no network API), read pages |
| Google content script | `src/entrypoints/google.content.ts` | Parses the results page, measures it, shows the strip, answers the panel | Read extension storage, fetch other sites |
| AI content script | `src/entrypoints/ai.content.ts` | Reads the latest answer and cited links when asked | Type into the page, send prompts, read storage |
| Page agent | `src/entrypoints/page-agent.ts` | Injected after activeTab or a site grant: page snapshot, same-site page fetch, brand colours and logo, highlighting | Run on a page the user did not invoke Lens on |
| Side panel | `src/entrypoints/sidepanel/` + `src/ui/` | All feature logic and UI, all cross-site fetching, exports | Read a tab without an agent answering in it |
| Embedding worker | `src/similarity/embed.worker.ts` | Sentence embeddings with the bundled model | Reach anything outside the package |
| Options, onboarding, health, print | `src/entrypoints/*/` | Settings in a tab; first-run explanation; selector health check; print-ready brief | |

The three in-page scripts share one implementation, `src/content/agent.ts`, and differ only in what they can answer.

## Messages

Defined in `src/model/messages.ts`, validated in `src/model/schemas.ts` (valibot). A receiver ignores any message whose type is not on its list or whose payload does not match its schema.

| Direction | Type | Examples |
|---|---|---|
| panel / service worker → tab | `TabRequest` | `lens:ping`, `lens:get-serp`, `lens:get-answer`, `lens:get-page`, `lens:fetch-same-origin`, `lens:get-brand-style`, `lens:highlight`, `lens:selector-health`, `lens:config-changed` |
| content script → service worker | `ContentEvent` | `lens:get-content-config`, `lens:save-snapshot`, `lens:open-panel`, `lens:set-strip-collapsed`, `lens:page-changed` |
| service worker → panel | `PanelEvent` | `lens:invoked` (which tab, which intent) |

Content-script events are accepted only when the sender's tab is on a Google Search or AI host. Web pages cannot message the extension: there is no `externally_connectable` and no `web_accessible_resources`.

## How the panel reaches a page

`src/panel/tabs.ts`, `TargetProvider` in `src/ui/hooks.tsx`.

1. Ping the active tab. On Google results and the AI sites a content script answers.
2. No answer: try to inject `page-agent.js`. Chrome allows this only if the user invoked the extension on this tab (activeTab) or granted the site.
3. Still nothing: the tab shows the "Analyze this page" card. (Directly after an invocation the probe is repeated for about two seconds first; see DECISIONS D-39.)

Without the `tabs` permission the panel never sees a tab's address by itself; it learns it from the agent's answer. The panel follows the active tab, and re-probes on navigation and when the service worker reports an invocation.

## The five features

Feature logic is plain TypeScript under `src/features/`, with no browser APIs, so it is unit-tested directly. The tabs in `src/ui/tabs/` connect it to the page and the UI.

### A. Click Potential — `src/features/click-potential/`

`src/serp/parse.ts` turns the results page into `SerpData`: blocks (AI Overview, ads, local pack, featured snippet, People also ask, videos, images, shopping, forums, top stories, knowledge panel) and organic results, each with its rectangle in page coordinates. `metrics.ts` computes: where the first organic result starts, each block type's share of the first screen (union of rectangles, so overlaps are not counted twice), fold status for every organic result and tracked domain, and the grade (formula in `GRADE_METHOD`, shown in the UI, see DECISIONS D-17). `snapshot.ts` stores one record per keyword and moment (viewport, location text, positions) in IndexedDB and exports CSV.

### B. Why Not Me — `src/features/why-not-me/`

`presence.ts` marks, per surface, whether the user's brand and each competitor appear: AI Overview citations, organic, local pack, forums, videos on Google (including AI Mode); answer text and cited links on the AI sites (`src/answers/read.ts`). `scan.ts` picks the cited and list-style pages (at most 12), which the panel fetches after Chrome granted those sites; `analysePage` reports which competitors a page names, whether it names the user's brand, and contact, author and submission links (`src/extract/links.ts`). For AI answers, `passages.ts` finds the one or two passages of each page closest to the answer. `gap.ts` builds the sortable gap list and its CSV. "Paste the answer" (`answerFromPastedText`) covers pages whose markup is not recognised.

### C. Rewind — `src/features/rewind/`

`cdx.ts` builds the Wayback CDX query (`output=json`, `filter=statuscode:200`, `collapse=digest`), parses it and samples at most 24 captures. `load.ts` fetches raw captures (`id_`) two at a time with shared back-off, and caches. `src/extract/page-facts.ts` reads title, meta description, canonical, meta robots, H1–H3, main-content word count, internal and external link counts, JSON-LD types and hreflang count. `diff.ts` builds the dated timeline between consecutive distinct captures, a two-date comparison, and "changes in the N days before a date".

### D. New or Noise — `src/features/new-or-noise/`, `src/similarity/`

Main content is extracted with the bundled Readability (`src/extract/main-content.ts`) and split into sentences. `SimilarityEngine` has two implementations: `EmbeddingEngine` (worker, bundled MiniLM model) and `LexicalEngine` (stemmed word overlap). `classify.ts` labels each sentence by how many comparison pages contain a sentence above the threshold, computes the share of "only here" words, and lists points most competitors make that the page does not. If the model cannot load, the lexical engine is used and the UI says so. Highlighting on the live page is `src/content/highlighter.ts` (CSS Custom Highlight API; overlay fallback).

### E. Instant Brief — `src/features/instant-brief/`

`crawl.ts` picks up to 8 same-site navigation pages; the page agent fetches them inside the tab. `extract.ts` reads business name, phones, e-mails, addresses, service areas, services, social profiles, JSON-LD organisation data, logo, brand colours, a tone sample, testimonials and focus-keyword candidates. `issues.ts` lists on-page issues. `compose.ts` assembles the sections (Business, Offer, Customers with three draft avatars, Competitors, Search presence from saved Click Potential and Why Not Me data, Issues, Next steps). `markdown.ts` and the print page export it with the agency's name and logo.

## Selector packs

`src/selectors/<site>.json`: `{ site, version, slots }`. A slot is an ordered list of candidates (`css`, optional `text` pattern, optional `closest`); `resolve()` returns the elements of the first candidate that matches. Required slots are flagged. `health.html` runs every slot against open pages and shows which candidate matched, and stores a pasted newer pack as an override (validated; used only if newer; never executed).

To fix a site after a markup change: open the page, open the health check, see which slot is missing, add a candidate to the JSON, bump `version`.

## Storage

| Where | What | Notes |
|---|---|---|
| `chrome.storage.local` | settings, Legiit token (own key), selector overrides, run counter | closed to content scripts; `src/storage/settings.ts`; writes are serialised with a Web Lock |
| `chrome.storage.session` | last invocation | cleared when the browser closes |
| IndexedDB `legiit-lens` | snapshots, briefs, Wayback index and capture facts, fetched-page digests | `src/storage/db.ts`; clearable in Settings |

Nothing is synced. "Erase everything" in Settings clears all three and removes site grants.

## Network

Two `fetch` call sites in the whole package:

1. `src/net/guarded-fetch.ts`, used by extension pages. Purposes `wayback`, `legiit`, `page`; each is checked against its allowed origin or against Chrome's granted host permissions, before the request and after redirects. No cookies, no referrer.
2. `src/content/same-origin-fetch.ts`, used inside a tab, locked to that tab's own origin.

ESLint rejects network APIs anywhere else. The service worker has none. See PERMISSIONS.md for the table of destinations and `e2e/network.spec.ts` for the proof.

## AI providers — `src/ai/provider.ts`

One interface (`AiProvider.complete`), chosen in order by `pickProvider`:

1. `LegiitAiProvider` when connected and the account has the `ai` capability. Remote: needs a click and shows its request.
2. `ChromePromptProvider` when the user opted in and `LanguageModel.availability()` is `available`. On device.
3. `TemplateProvider`: returns the deterministic text.

Callers always pass the facts and the template text (`fallback`). If a model fails or returns nothing usable, the template text is shown and the card says why. The prompt marks facts as untrusted data and tells the model to ignore instructions inside them.

## Legiit — `src/legiit/`

- `client.ts`: the `LegiitClient` interface (ten methods) and the capability each needs.
- `http-client.ts`: real HTTP against `LEGIIT_API_BASE_URL`. Replies are read tolerantly and never trusted: unknown fields are ignored, integer ids and numeric text are accepted, over-long values are cut, an unreadable list entry is skipped, a reply over 5 MB is not read. 401 → `unauthorised` (`definite` only when the agreed error body came with it); 404 with `error.code` "not_found" on a path that names a business → `rejected`; any other 404, 405 or 501 → `unavailable`; other 4xx → `rejected` with the server's message; 5xx → `server`. Bodies are capped at 1 MB; the time limit covers the whole reply: 20 s, 60 s for AI. A redirect is never followed (`guardedFetch` uses `redirect: 'manual'` for the Legiit host).
- `mock-client.ts`: fixtures, for unit tests. `mock-server/`: the same contract over HTTP for development (`npm run mock`) and for the end-to-end tests.
- `auth.ts`: `AuthProvider`. v1 is a pasted token; OAuth means adding one class here.
- `payloads.ts`: builds each save payload once; the dialog shows it and the client sends it. `limits.ts` holds the size limits the builders enforce; a unit test keeps them equal to the contract.
- `connection.ts`: the connection state. A confirmed 401 deletes the token; any other failure keeps it (`tokenKept`) so the panel can say "Legiit not connected" and offer "Try again". Endpoints that answer "not built" are hidden per extension page.
- `prefill.ts`: tracked brands and competitors from Business Details; forgets the chosen business when another Legiit user connects.
- `docs/legiit-api/`: the handoff kit for the Legiit backend team. `openapi.yaml` is the contract (OpenAPI 3.1), `reference.md` and `openapi.examples.json` (the contract with the examples built in, for Postman and similar tools) are generated from it, `examples/` are real requests built by the payload code and real replies of the mock server, and `tests/api/` is the conformance check (`npm run api:check`, started by `scripts/api-check.mjs`). Unit tests keep all of them in step with the client and the mock server; `npm run api:examples` refreshes the generated files.

## Build and packaging

`npm run build`: verify the model files against `models.lock.json` → `wxt zip` → `scripts/package-release.mjs` checks the hard rules on the built manifest and files, copies the build to `dist/` and the zip to `release.zip`, and prints sizes.

Not minified, no source maps. One WebAssembly binary. Development-only code (the fixture saver and its shortcut) is behind `import.meta.env.DEV` and absent from production builds.

## Tests

| Layer | Where | Runs |
|---|---|---|
| Unit (Vitest, jsdom) | `tests/unit/` — 20 files, 324 tests | every parser, extractor, differ and classifier against `/fixtures`; the real bundled model on the fixture articles; storage; the Legiit client against the contract; the store package and these documents |
| End-to-end (Playwright) | `e2e/` — 10 spec files, 110 tests | the built extension in Chromium; real URLs intercepted and served from `/fixtures`; real activeTab through the DevTools protocol; Chrome's real permission request |
| Store screenshots | `e2e/store/` | `npm run screenshots` |

`e2e/lens.ts` is the harness: it loads `dist/`, records every request from every context, and never lets one reach the network.

## Directory map

```
src/
  config/        product constants, Google domains, AI sites
  lib/           sanitising, URLs, text, CSV, rectangles
  model/         message types and schemas
  brands/        brand and competitor matching
  selectors/     selector packs (JSON) and the resolver
  serp/          Google results parser
  answers/       AI answer reader
  extract/       HTML → facts (main content, page facts, links, digest)
  features/      the five features (no browser APIs)
  similarity/    embedding worker, engines, thresholds
  net/           guarded fetch, permissions, page fetch
  storage/       settings (chrome.storage) and IndexedDB
  legiit/        client interface, HTTP and mock clients, payloads
  ai/            provider interface and the three providers
  content/       code that runs inside pages
  panel/         how the panel finds and talks to a tab
  ui/            React components
  entrypoints/   one file or folder per extension context
  dev/           development-only fixture saver
fixtures/        synthetic pages and API responses used by all tests
tests/unit/      unit tests
e2e/             end-to-end tests and the harness
mock-server/     local mock of the Legiit API
scripts/         model fetch/verify, fixtures, icons, packaging
store/           Chrome Web Store listing material
docs/            this file, decisions, permissions, QA, API contract
```

## Common changes

| To… | Change |
|---|---|
| add a Google country domain | `src/config/google-domains.ts` (a unit test guards the list's shape) |
| fix a selector | the site's JSON in `src/selectors/`, bump `version` |
| change the Legiit host | `DEFAULT_LEGIIT_API_BASE_URL` in `src/config/constants.ts`, or build with `LEGIIT_API_BASE_URL=…` |
| replace the token with OAuth | a new `AuthProvider` in `src/legiit/auth.ts`, used in `connection.ts` |
| add a Legiit method | `client.ts` (interface + capability), `http-client.ts`, `mock-client.ts`, `mock-server/handlers.mjs`, the contract |
| switch on account gating | `REQUIRE_ACCOUNT_AFTER_FREE_RUNS` in `src/config/constants.ts` |
| change similarity thresholds | `src/similarity/engine.ts` (and re-run `tests/unit/embedding-model.test.ts`) |
| change the grade | `src/features/click-potential/metrics.ts` (`GRADE_METHOD` is the text shown to users) |
| update the model | `scripts/fetch-model.mjs --write-lock`, commit `public/models` and `models.lock.json` |
| rename the product | `PRODUCT_NAME` in `src/config/constants.ts` |
