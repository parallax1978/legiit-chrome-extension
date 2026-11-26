# Notes for the Chrome Web Store reviewer

Paste into the "Additional instructions / notes for reviewers" field at submission. No account, login or payment is needed to test anything below.

```
WHAT IT IS
Legiit Lens is an SEO analysis tool. Single purpose: it shows how visible a web page or brand is in Google results and AI answers, and what explains it. All five features serve that purpose. The first screen asks for an email address and creates a free Legiit account; then every feature works.

HOW TO TEST (about 5 minutes)

1. After install an onboarding page opens. Pin the extension. The first time the side panel opens, it asks for an email address: enter any address you can receive mail at and click Start. A free Legiit account is created for it.
2. Click Potential: search anything on google.com. A thin "Legiit Lens" strip appears above the results (it can be hidden). Click "Open panel" on the strip: the side panel shows where the first organic result starts and what fills the first screen.
3. Why Not Me: in the panel open Settings and add a brand and a competitor (name + domain). Go back to the results page and open the "Why Not Me" tab. "Scan sources" asks Chrome for permission to read the specific cited sites it lists; you can decline.
4. Access to other pages: open any normal website and look at the panel. It says it has no access. Click the toolbar icon (or press Alt+Shift+L, or right-click > "Analyze this page with Legiit Lens"): the panel now shows that page. This is activeTab; there is no standing access to all sites.
5. Instant Brief: on a business website, after step 4, open "Instant Brief" > "Build brief".
6. Rewind: open "Rewind" > "Look up history". It reads the Internet Archive (web.archive.org).
7. New or Noise: with a Google results tab open, go to an article that ranks for that search, invoke the extension, open "New or Noise" > "Compare". Chrome asks for the competing sites by name.

PERMISSIONS
- activeTab + scripting: read the current page only after the user invokes the extension on it. One packaged file (page-agent.js) is injected; no remote or generated code.
- storage: settings on the device (chrome.storage.local, restricted to trusted contexts).
- sidePanel: the main UI.
- contextMenus: "Analyze this page" and "Check the selected text". A context-menu click is one of the gestures that grants activeTab.
- Host permissions: only web.archive.org (Rewind) and lens.legiit.com (the Legiit account: created from the email on the first screen, then used for saves the user confirms).
- Content scripts: Google Search (/search on each Google country domain; match patterns cannot use a wildcard TLD) and chatgpt.com, gemini.google.com, perplexity.ai, copilot.microsoft.com. They only read the page the user opened. No automated queries are sent to Google or any AI site, and Google's ads and results are never hidden, moved or restyled. The strip is added above the results inside a closed shadow root.
- optional_host_permissions (*://*/*): never granted at install and never requested as a wildcard. Specific sites are requested at the moment the user starts a scan, after the UI names them and says why. Granted sites are listed and removable under Settings > Privacy and data.

REMOTE CODE: NONE
All JavaScript and WebAssembly is in the package. The build is not minified so it can be read directly.
- 'wasm-unsafe-eval' is in the CSP only to compile the bundled ONNX Runtime WebAssembly (/ort) that runs a bundled sentence-embedding model (/models, all-MiniLM-L6-v2) on the device for the "New or Noise" feature.
- The bundled transformers.js / ONNX Runtime libraries contain the strings "huggingface.co" and "cdn.jsdelivr.net" as their default download locations. They are never contacted: remote models are disabled (env.allowRemoteModels = false), paths point into the package, and the worker replaces fetch with one that rejects any address outside the extension (see src/similarity/embed.worker.ts in the source, assets/embed.worker-*.js in the package).
- Selector definitions are JSON data files in the package.

DATA
- No analytics, no ads, no tracking, no remote logging.
- The email address entered on the first screen is sent once to lens.legiit.com to create the user's free Legiit account. The extension then reads the account (name, plan, businesses) from that host.
- Data the user analyzes is sent to lens.legiit.com only when the user clicks a save button and confirms a dialog that shows the exact JSON.
- Other requests go only to web.archive.org, to sites the user granted for a scan, and to the site the user builds a brief on (same-origin requests from that tab). All are plain GETs without cookies.
- Settings > Privacy and data lists the hosts contacted and offers "Erase everything".

LEGIIT ACCOUNT
The first screen creates a free account from an email address. Someone who already has a Legiit account connects it under Settings with an API token from Legiit Command Center instead.

CHROME BUILT-IN AI (OPTIONAL)
Off by default. If the user opts in under Settings > AI and Chrome's on-device model is available, summaries can be rewritten on the device with the Prompt API. No permission is needed for it and no data leaves the device.
```

## Before pasting

- Check the shortcut (Alt+Shift+L) and the Legiit host (lens.legiit.com) still match the build.
- If the real Legiit API is live, add a test token and business for the reviewer, or keep the "not required for review" paragraph.
- The steps were written against the code, not a live review. Walk through them once on live Google with the release build (`docs/QA.md`).
