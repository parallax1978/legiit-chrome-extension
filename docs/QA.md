# Manual QA checklist

The automated tests (`npm test`, `npm run e2e`) run against fixtures: synthetic pages on `.example` domains. They prove the logic, the permission model and the network rules. They cannot prove that the selectors match today's Google and AI sites, and they cannot click Chrome's own prompts. This checklist covers what a person has to look at before a release.

Do it in **current stable Chrome**, in a clean profile, on at least one Windows and one macOS machine.

## 0. Setup

1. `npm install && npm run build`
2. `chrome://extensions` → Developer mode → **Load unpacked** → choose `dist/`.
3. The onboarding page opens once. Read it: does it say what the extension does, reads and never sends?
4. Pin the icon (puzzle-piece menu → pin).
5. Open Settings (toolbar icon → Settings tab, or the extension's options). Add your brand (name + domain) and two or three real competitors.

Keep three DevTools consoles open during the whole session and note anything in red:

- service worker: `chrome://extensions` → Legiit Lens → "service worker"
- side panel: right-click inside the panel → Inspect
- the page: F12 on the tab (content scripts log here)

- [ ] `chrome://extensions` shows no "Errors" button for Legiit Lens at the end of the session.

## 1. Install prompt and permissions

- [ ] The install dialog lists only: Google Search sites, chatgpt.com, gemini.google.com, perplexity.ai, copilot.microsoft.com, web.archive.org and the Legiit API host. It does **not** say "all sites" or "browsing history".
- [ ] `chrome://extensions` → Details → Site access shows no "On all sites".
- [ ] Settings → Privacy and data → "Sites you have granted" says "None".

## 2. Access to the current tab (the activeTab rule)

On an ordinary site (not Google, not an AI site):

- [ ] Open the panel from a Google tab first, then switch to the ordinary site: the panel shows the "Analyze this page" card, not the page's address.
- [ ] Click anything inside the panel: still no access.
- [ ] Click the toolbar icon: the panel shows the page's title within a second.
- [ ] Repeat with the keyboard shortcut shown on the card (default Alt+Shift+L). If the card says to set one, set it at `chrome://extensions/shortcuts` and check the card updates.
- [ ] Repeat with right-click → "Analyze this page with Legiit Lens".
- [ ] Follow a link to another page of the same site: the panel keeps working.
- [ ] Go to a different site in the same tab: the card is back.
- [ ] "Always allow on <site>": Chrome's prompt names only that site. Accept; reload the page; the panel reads it without invoking. The site is listed in Settings and "Remove" works.
- [ ] On `chrome://settings` and on the Chrome Web Store the card stays, with no error.
- [ ] Select some text → right-click → "Check the selected text with New or Noise": the panel opens on New or Noise with "Selected text" chosen.

## 3. Selectors against the live sites

**This is the most important section.** The bundled selector packs were written without access to the live sites.

Open `health.html` (Settings → "Selector health check"). For each page below: open it in another tab, press **Check now**, and look at the report.

Google (signed out and signed in; repeat a few on a country domain such as google.co.uk or google.de, and with a non-English interface):

- [ ] a query with an AI Overview (try an informational "how…" query)
- [ ] a query with ads on top (a commercial query such as "car insurance quote")
- [ ] a local query with a map pack ("dentist near me")
- [ ] a query with a featured snippet
- [ ] a query with People also ask, videos and images
- [ ] a shopping query
- [ ] AI Mode (`udm=50`)
- [ ] page 2 of results

AI sites, each with an answer that cites sources:

- [ ] chatgpt.com
- [ ] gemini.google.com
- [ ] perplexity.ai
- [ ] copilot.microsoft.com

For every report:

- [ ] "Required slots match". If a required slot says "nothing matched", the pack needs a new candidate.
- [ ] Slots that should be on the page (for example `aiOverview` on a page with an AI Overview) are not "not on this page".
- [ ] "fallback" chips are fine, but note them: the primary selector is out of date.

To fix a pack: `npm run dev`, load `.output/chrome-mv3-dev`, open the page, press **Alt+Shift+F** (development builds only) to save it as a fixture with every element's position, add it under `fixtures/`, add a candidate to `src/selectors/<site>.json`, bump `version`, and add a unit test. A hot fix without a release: paste the new pack on the health page ("Use a newer selector pack").

## 4. Strip above Google results

- [ ] It appears above the results as one row and does not cover anything.
- [ ] Ads, the AI Overview and results are all still there, in the same order, and work (click one ad label, expand the AI Overview, open a result).
- [ ] "Hide" collapses it; the choice survives a new search. "Show" brings it back.
- [ ] "Open panel" opens the side panel.
- [ ] Settings → untick "Show the summary strip": it disappears from open results pages without a reload.
- [ ] Resize the window and zoom (Ctrl +/−): the numbers update and the strip does not wrap badly.
- [ ] Dark mode (OS setting): strip and panel are readable.
- [ ] Add a brand in Settings while a results page is open: "You #n" appears on the strip without a reload.

## 5. Click Potential

On a results page where you know roughly what to expect:

- [ ] "First organic result" in px matches what you see: scroll so that result is at the top and compare with the page's scroll position (DevTools: `scrollY`).
- [ ] The first-screen diagram has the blocks in the right places and the right colours.
- [ ] Organic results are numbered as on the page; your domain and competitors are marked, with fold status.
- [ ] The grade is labelled "Estimate" and "How this is calculated" explains it.
- [ ] A snapshot is saved (History shows it) with viewport and location. Search again later: a second row.
- [ ] Export CSV opens cleanly in Excel and Google Sheets (accents, commas, no formulas executed).
- [ ] The page is not a normal web search (Images, News, AI Mode): the tab explains, no error.

## 6. Why Not Me

- [ ] On Google: surfaces list who appears where; "Competitors, not you" is right for at least three surfaces you check by eye.
- [ ] On each AI site: the latest answer's text and cited links are read (compare the count of cited pages with the page).
- [ ] "Scan sources": the line above the button names the sites; Chrome's prompt names the same sites; after "Allow" each page shows competitors named, whether you are named, and contact / author / submission links that really exist on the page.
- [ ] Press "Deny" on Chrome's prompt: "Permission was not granted, so nothing was fetched."
- [ ] For an AI answer, "Closest to the answer" passages are really on the cited page.
- [ ] Gap list sorts and exports.
- [ ] On an AI page the extension cannot read (or after the site changes): "Paste the answer instead" works.

## 7. Rewind

Needs web.archive.org (not reachable from the build environment, so this was never run live):

- [ ] Look up a well-archived page (a big site's product page). Captures load, at most 24 are read, a timeline appears.
- [ ] Pick one change and verify it by opening "View capture" for the two dates.
- [ ] "Compare two dates" shows field-by-field differences.
- [ ] "Changes in the 30 days before <date>" filters.
- [ ] A page that was never archived: "No captures found", no error.
- [ ] Look up the same page again: instant (cache).
- [ ] If the archive rate-limits (429): the panel waits and continues, or says to try later. No tight retry loop (watch the Network tab of the panel's DevTools).

## 8. New or Noise

- [ ] Open a Google results page for a keyword, then one of your articles for it; invoke the extension; "Use these results" offers that results page.
- [ ] Compare. First run takes a few seconds (model load); the method line says "on-device sentence embeddings".
- [ ] In the panel's DevTools Network tab: the only requests are the comparison pages and files from `chrome-extension://…/models` and `/ort`. Nothing to huggingface.co or a CDN.
- [ ] The "Only here" sentences really are unique; "Said by most" really are common knowledge. Spot-check five.
- [ ] "Highlight on the page" colours sentences without breaking the page's layout, menus or forms. "Remove highlights" restores it.
- [ ] Pasted text and pasted URLs work.
- [ ] A page behind a login or a paywall among the comparison pages is reported as unreadable, the rest still compare.
- [ ] A very long page (5,000+ words) finishes in reasonable time and the panel stays responsive (Cancel works).

## 9. Instant Brief

On two or three real small-business sites:

- [ ] Build. No Chrome prompt appears (it reads the site you are on).
- [ ] Name, phone, e-mail, address, hours, services and social profiles are right. Note anything wrong or missing.
- [ ] The logo and brand colours are the site's.
- [ ] Three avatars, each labelled "Draft".
- [ ] Issues are real (open a flagged page and check).
- [ ] Add competitors by hand and from an open results page.
- [ ] Export Markdown: agency name, no "Legiit" anywhere.
- [ ] Print / save as PDF: agency logo and name on top, clean page breaks, no "Legiit".
- [ ] A single-page site and a site that blocks fetches still produce a brief, with "n pages could not be read".

## 10. Legiit connection

With the mock server (until the real API exists):

1. `npm run mock`
2. `LEGIIT_API_BASE_URL=http://localhost:8787 npm run build`, reload the extension. (This build lists localhost as its Legiit host. Run a plain `npm run build` again before packaging a release.)
3. Settings → paste `demo-token` → Connect.

- [ ] Before connecting: the mock server's log shows no request at all, whatever you do in the extension.
- [ ] Connect: user name and plan shown; choose a business; brands and competitors are pre-filled and marked "From Command Center".
- [ ] "Save to Command Center" appears on Click Potential, the gap list, New or Noise ("Send to content editor") and the brief ("Open in Command Center").
- [ ] Each opens a dialog with the exact JSON. Cancel: nothing in the server log. Send: one POST whose body equals the dialog.
- [ ] "Rewrite with Legiit AI" asks first and shows what it will send.
- [ ] Token `limited-token`: buttons for missing features are not shown. Any other token (for example `invalid`): a clear error, nothing stored.
- [ ] Disconnect: token gone, pre-filled brands gone, no further requests in the server log.

When the real API exists: run `npm run api:check` against it first (see `docs/legiit-api/README.md`), then repeat this section with a build that points at it.

## 11. Chrome built-in AI (optional provider)

On a machine that meets Chrome's requirements (22 GB free disk; more than 4 GB VRAM, or 16 GB RAM and 4 cores):

- [ ] Settings → AI → tick the opt-in. Status says downloadable; "Download the model" shows progress.
- [ ] When ready, "In use now" says on-device AI, and "Rewrite with on-device AI" appears on summaries.
- [ ] A rewrite stays faithful to the facts above it. Untick: back to templates.

On a machine that does not: the opt-in says why and nothing else changes.

## 12. Privacy checks

- [ ] Open the side panel in a fresh profile: it asks for an email address, and nothing is sent before Start. Start with a new address: a free account is created and every tool opens. Then use every feature with the panel's and the service worker's Network tabs open. Destinations seen: lens.legiit.com, web.archive.org, the sites you granted, the site you built a brief on. Nothing else.
- [ ] Settings → "Network activity from this window" lists the same hosts.
- [ ] "Clear history", "Clear caches" and "Erase everything" do what they say (check Application → IndexedDB and Extension storage in DevTools).
- [ ] After "Erase everything", granted sites are gone from `chrome://extensions` → Details → Site access.

## 13. Before submitting to the store

- [ ] `npm run check && npm run e2e` pass on the commit being released.
- [ ] `version` in `package.json` is higher than the last upload.
- [ ] The Legiit API host in the manifest is final (changing it later re-prompts users).
- [ ] Real icons, promo tile and screenshots replace the placeholders (`store/README.md`).
- [ ] The privacy policy is hosted, its URL is in the dashboard, and the Limited Use statement is on that page.
- [ ] Privacy practices tab filled from `store/permission-justifications.md` and `store/data-usage.md`; remote code: "No".
- [ ] Upload `release.zip` (not a zip of the repository).
