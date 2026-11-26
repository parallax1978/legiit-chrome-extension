# Permission justifications

For the Developer Dashboard → Privacy practices. One field per permission. Each text is written to be pasted as is. The code behind every line is listed in `docs/PERMISSIONS.md`.

## activeTab

```
Lets the extension read the page in the current tab only after the user invokes it there (toolbar icon, keyboard shortcut or the "Analyze this page" context-menu item). It is used to learn the page's address (Rewind) and to read the page's text, links and styling (New or Noise, Instant Brief). Access ends when the tab leaves that site. We use activeTab so that the extension never needs standing access to all sites.
```

## scripting

```
Used with activeTab to inject one script that is part of the extension package (page-agent.js) into the tab the user invoked the extension on. The script reads the page's text, links and styling and returns them to the side panel. No remote or generated code is injected.
```

## storage

```
Stores the user's settings on their device: tracked brand and competitor names and domains, agency name and logo for exports, display preferences, and, if the user connects a Legiit account, their API token. Nothing is synced. Extension storage is restricted to trusted contexts so content scripts cannot read it.
```

## sidePanel

```
The extension's main interface is a side panel that shows the analysis next to the page being analyzed. The panel is opened when the user clicks the toolbar icon, uses the keyboard shortcut or context menu, or presses "Open panel" on the summary strip.
```

## contextMenus

```
Adds two context-menu items: "Analyze this page with Legiit Lens" (opens the panel for the current page) and "Check the selected text with New or Noise" (analyzes the selected text). A context-menu click is one of the user gestures that grants activeTab, and it works when the toolbar icon is not pinned.
```

## Host permission: web.archive.org

```
The Rewind feature shows how a page changed over time. When the user looks up a page, the extension requests that page's capture list and archived copies from the Internet Archive's Wayback Machine (web.archive.org) and compares them on the user's device. Only the address of the page being looked up is sent.
```

## Host permission: lens.legiit.com

```
The Legiit API. The extension's first screen sends the email address the user enters to this host, to create the user's free Legiit account. After that it reads the user's own account data (their businesses and tracked competitors) and saves a result to Legiit Command Center when the user clicks a save button and confirms a dialog that shows exactly what will be sent.
```

## Content scripts: Google Search domains

```
The extension measures the Google results page the user opened: the position and size of ads, AI Overviews, local packs and organic results, and whether the user's tracked brands appear. A content script reads the page and adds a small, collapsible summary strip above the results. It does not send queries, does not modify or hide results or ads, and sends nothing off the device. Match patterns cannot contain a wildcard top-level domain, so each Google country domain is listed, limited to the /search path.
```

## Content scripts: chatgpt.com, gemini.google.com, perplexity.ai, copilot.microsoft.com

```
The extension shows whether the user's brand and their competitors are mentioned in an AI answer the user is viewing, and which sources the answer cites. A content script reads the latest answer on the page when the user opens the side panel there. It never types into the page or sends prompts, and sends nothing off the device.
```

## Optional host permissions: *://*/*

```
Never granted at install. Two features read pages the user chooses: "Scan sources" (the pages a results page or AI answer cites) and "New or Noise" (the pages competing with the user's article). These sites are only known at run time, so the extension asks Chrome for those specific sites, by name, when the user starts the scan, after telling them which sites and why. The user can decline, and can remove any granted site in the extension's settings. The wildcard itself is never requested.
```

## Remote code

Select: **No, I am not using remote code.**

```
All JavaScript and WebAssembly is included in the package. The extension loads no remote scripts, uses no eval, and fetches no code. The on-device language model and its WebAssembly runtime (ONNX Runtime) are bundled files; 'wasm-unsafe-eval' in the content security policy is needed only to compile that bundled WebAssembly. Data fetched at run time (web pages, Wayback Machine captures, Legiit account data) is parsed as data and never executed.
```
