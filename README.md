# Legiit Lens

A Chrome extension (Manifest V3) for SEO professionals and agencies.

> Shows how visible a web page or brand is in Google results and AI answers, and what explains it.

Everything works without an account and runs on the device. A Legiit account is optional and only adds saving to Legiit Command Center.

"Legiit Lens" is a working name, set in one place: `PRODUCT_NAME` in `src/config/constants.ts`.

## What it does

| Tab | On | What you get |
|---|---|---|
| **Click Potential** | a Google results page | Where the first organic result starts, what fills the first screen (AI Overview, ads, local pack, …), where each result and tracked domain sits relative to the fold, an estimated grade with its formula, history per keyword, CSV |
| **Why Not Me** | Google results, ChatGPT, Gemini, Perplexity, Copilot | Where competitors appear and you do not. "Scan sources" reads the cited and list-style pages (after Chrome asks you) and shows who each one names and who to contact. Gap list, CSV |
| **Rewind** | any page address | A dated timeline of on-page changes from the Wayback Machine: title, description, canonical, robots, headings, word count, links, JSON-LD, hreflang |
| **New or Noise** | an article or any text | Which sentences say something the competing pages do not, measured with a small model that runs in the browser. Highlights on the page, CSV |
| **Instant Brief** | a business website | A client brief built from up to 8 pages of the site: business facts, offer, three draft avatars, competitors, search presence, issues, next steps. Markdown and print-ready PDF with your agency's name and logo |

Plus a thin summary strip above Google results, a settings page, an onboarding page and a selector health check.

## Requirements

- Node.js 22 or newer
- Chrome 116 or newer to run the extension
- The end-to-end tests use Playwright's Chromium (`npx playwright install chromium` on a fresh machine)

## Quick start

```bash
npm install
```

```bash
npm run build
```

Then open `chrome://extensions`, switch on Developer mode, choose **Load unpacked** and pick the `dist/` folder.

`npm run build` writes two things:

- `dist/` — the unpacked extension
- `release.zip` — the file to upload to the Chrome Web Store

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development build with reload. Load `.output/chrome-mv3-dev` as an unpacked extension |
| `npm test` | Unit tests (Vitest): every parser, extractor, differ and classifier against `/fixtures` |
| `npm run e2e` | Builds, then runs the end-to-end tests (Playwright) against `dist/` |
| `npm run e2e:only` | End-to-end tests without rebuilding |
| `npm run build` | Production build → `dist/` and `release.zip`, with the store rules checked |
| `npm run check` | Type check, lint, unit tests |
| `npm run mock` | Local mock of the Legiit API on `http://localhost:8787` |
| `npm run screenshots` | Regenerates the store screenshots in `store/screenshots/` |
| `npm run fixtures` | Regenerates the test fixtures |
| `npm run icons` | Regenerates the placeholder icons and promo tiles |
| `npm run model:fetch` | Downloads the embedding model named in `models.lock.json` (already in the repository) |

The development build (`npm run dev`) is for working on the code only. WXT adds the `tabs` permission, localhost access and a reload shortcut to it for hot reloading, so check permissions and the install prompt on `dist/`, never on the dev build.

## Trying the Legiit connection

There is no real Legiit API yet. The extension talks to an interface (`src/legiit/client.ts`); the proposed endpoints are in `docs/legiit-api-contract.yaml`.

```bash
npm run mock
```

```bash
LEGIIT_API_BASE_URL=http://localhost:8787 npm run dev
```

In the extension: Settings → Legiit account → paste `demo-token` → Connect. `limited-token` simulates an account with fewer features; `invalid` is rejected.

## Configuration

All in `src/config/constants.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `PRODUCT_NAME` | `Legiit Lens` | Name everywhere, including the manifest |
| `DEFAULT_LEGIIT_API_BASE_URL` | `https://api.legiit.com` | The Legiit API. **An assumption**; it becomes a required host in the manifest. Override at build time with `LEGIIT_API_BASE_URL` |
| `REQUIRE_ACCOUNT_AFTER_FREE_RUNS` | `false` | Account gating. `false` = off. A number = free runs before a Legiit account is required |
| `SUGGESTED_SHORTCUT` | `Alt+Shift+L` | Keyboard shortcut that invokes the extension |
| `MINIMUM_CHROME_VERSION` | `116` | |

Google country domains are in `src/config/google-domains.ts`. Selectors are in `src/selectors/*.json`.

## Privacy, in short

- It reads only pages you open. It never sends a query to Google or a prompt to an AI site.
- Nothing leaves the device unless you click a save action while connected to Legiit, and you are shown exactly what will be sent.
- No analytics.
- Network destinations: web.archive.org (Rewind), sites you grant when you start a scan, the site you build a brief on, and the Legiit API when connected. `e2e/network.spec.ts` proves it.
- Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, `contextMenus`. No access to all sites at install. Each permission is mapped to code in `docs/PERMISSIONS.md`.

## Documentation

| File | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | How the parts fit together |
| `docs/DECISIONS.md` | Every decision and assumption, and where the official docs differ from the original brief |
| `docs/PERMISSIONS.md` | Every permission and host, mapped to the code that uses it |
| `docs/QA.md` | Manual checklist for live pages |
| `docs/legiit-api-contract.yaml` | OpenAPI contract for the Legiit endpoints the extension expects |
| `store/` | Chrome Web Store listing, justifications, privacy policy, reviewer notes, images |

## Before releasing

The tests run on synthetic fixtures. Three things need a person:

1. Check the selectors against live Google and the four AI sites (`docs/QA.md`, section 3).
2. Replace the assumed Legiit API host and contract with the real ones.
3. Replace the placeholder brand assets and host the privacy policy (`store/README.md`).

## Third-party software

The package includes React, transformers.js, ONNX Runtime Web, Mozilla Readability, idb, valibot and the `all-MiniLM-L6-v2` model. Licences are in `public/THIRD-PARTY-NOTICES.txt`, which ships inside the extension.
