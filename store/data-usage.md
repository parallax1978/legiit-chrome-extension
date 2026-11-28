# Data usage answers

For the Developer Dashboard → Privacy practices → "Data usage".

Two things to know before filling it in:

1. The Chrome Web Store counts data that is **processed or stored only on the device** as handled user data. It still has to be disclosed and covered by a privacy policy.
2. The exact wording of the checkboxes is not in Google's published documentation (it appears only in the dashboard). The categories below are the ones the dashboard has used; **check each label when you fill in the form**, and have the answers reviewed by whoever is responsible for privacy at Legiit.

## What the extension handles

| Data | Where it comes from | Stored | Leaves the device |
|---|---|---|---|
| Text, links and layout of Google results pages the user opens | the page, read by the content script | Snapshots (keyword, time, viewport, the location text Google prints on the page, result positions) in IndexedDB, when the panel is open or the user presses Save | Only if the user is connected to Legiit and confirms "Save to Command Center" |
| The latest answer and cited links on an AI site | the page, when the user opens the panel there | No | Only inside a gap list the user confirms saving to Legiit |
| Text and links of a page the user invoked the extension on | the page | Briefs in IndexedDB | Only inside a brief or a New or Noise result the user confirms sending to Legiit |
| Pages the user chose to scan, compare or brief | fetched by the browser after Chrome's permission prompt | A digest (title, text blocks, links) cached in IndexedDB | No |
| Wayback Machine captures | web.archive.org | Extracted facts cached in IndexedDB | The address being looked up is sent to web.archive.org |
| Tracked brands and competitors, agency name and logo | typed by the user, or pre-filled from their Legiit account | `chrome.storage.local` | No (they came from, or go to, the user's own Legiit account only through a confirmed save) |
| Legiit API token | pasted by the user | `chrome.storage.local`, closed to content scripts | Sent only to the Legiit API, as the request's authorisation |

There is no analytics, no advertising, no error reporting and no account of our own.

## Recommended answers

| Category (verify the label in the dashboard) | Answer | Why |
|---|---|---|
| Personally identifiable information | **Yes** | The e-mail address the user enters on the first screen, sent to Legiit, which keeps it and emails a code that connects the user's free Legiit account. When connected, the extension also displays the account name returned by Legiit and keeps it in memory only. |
| Health information | **No** | |
| Financial and payment information | **No** | |
| Authentication information | **Yes** | The Legiit API token the user pastes, stored on the device and sent only to the Legiit API |
| Personal communications | **No** | The extension does not read e-mail, messages or chats between people. It does read the question and the assistant's answer on an AI site when the user opens the panel there. *If counsel reads an AI conversation as a personal communication, answer Yes.* |
| Location | **Yes** | Click Potential records the place name Google prints on the results page (for example "Austin, Texas") with each snapshot, because results differ by location. It is not read from the device's location services |
| Web history | **Yes** | Snapshots record the search keyword, time and result addresses of Google results pages the user viewed with the panel open or chose to save. Stored on the device |
| User activity | **No** | No clicks, keystrokes, scrolling or mouse movement are recorded |
| Website content | **Yes** | The text, links and layout of pages the user asks the extension to analyze |

## Certifications

All three can be ticked truthfully:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

The only transfer is to Legiit's own service, on the user's explicit action, to provide the feature the user asked for.

## Privacy policy

- Field: the public URL where `store/privacy-policy.html` is hosted.
- The policy must be reachable without logging in, and must contain the Limited Use statement (`store/limited-use.md`; it is already in the policy text).
