# Limited Use statement

The Chrome Web Store User Data Policy requires an affirmative statement, **on a website the publisher owns**, that the extension's use of user data complies with the Limited Use requirements. Put the statement below on the page that hosts the privacy policy (it is already included in `store/privacy-policy.md` and `.html`), and ideally on the product page.

## Statement

```
Legiit Lens's use of information it reads or receives complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.
```

## What we commit to (plain language)

1. **Allowed use.** Legiit Lens uses the data it handles only to provide and improve its single purpose: showing how visible a web page or brand is in Google results and AI answers, and what explains it.
2. **Allowed transfer.** Data leaves the device only when a user who has connected their Legiit account clicks a save action and confirms what will be sent. It goes to Legiit's own service and nowhere else. We do not transfer user data to other third parties, except where needed to comply with the law or as part of a merger or acquisition with the user's consent.
3. **No advertising.** We do not use or transfer user data for personalised, re-targeted or interest-based advertising.
4. **No human reading.** Nobody at Legiit reads data the extension handles on the device; it never reaches us. Data a user saves to their Legiit account is handled under Legiit's privacy policy and is not read by people except with the user's consent, for security purposes, to comply with the law, or in aggregated and anonymised form for internal operations.
5. **Web browsing activity.** The extension reads pages only as required for the feature the user is using at that moment. It keeps no record of browsing beyond the snapshots, briefs and caches the user creates, which stay on the device and can be erased in Settings.

## How the code backs this up

| Commitment | Evidence |
|---|---|
| Nothing leaves the device without a confirmed save | `e2e/network.spec.ts`, `e2e/legiit.spec.ts` |
| The only destinations are web.archive.org, sites the user granted, and Legiit when connected | `e2e/network.spec.ts`, `docs/PERMISSIONS.md` |
| The user sees exactly what is sent | `SaveToLegiit` in `src/ui/shared.tsx`; the tests compare the request body with the dialog |
| No analytics | no analytics code or host in the package (`e2e/build.spec.ts` lists every address in the code) |
