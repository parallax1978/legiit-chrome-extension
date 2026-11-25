# Chrome Web Store package

Everything needed to fill in the Developer Dashboard for Legiit Lens. The file to upload is `release.zip` in the repository root (made by `npm run build`).

## Contents

| File | Dashboard section | Status |
|---|---|---|
| `listing.md` | Store listing: name, summary, description, category | Ready to paste |
| `single-purpose.md` | Privacy practices: single purpose | Ready to paste |
| `permission-justifications.md` | Privacy practices: one justification per permission, remote-code declaration | Ready to paste |
| `data-usage.md` | Privacy practices: data usage and certifications | Recommended answers. **Needs review by whoever owns privacy at Legiit**; verify the checkbox labels in the dashboard |
| `limited-use.md` | Must be published on a website Legiit owns | Text ready. **Needs hosting** |
| `privacy-policy.md`, `privacy-policy.html` | Privacy practices: privacy policy URL | **Draft with placeholders. Needs legal review and hosting** |
| `reviewer-notes.md` | Submission: notes for the reviewer | Ready to paste after one live walk-through |
| `icons/` | Store listing: icon | **Placeholder artwork** |
| `promo/` | Store listing: promo tiles | **Placeholder artwork** |
| `screenshots/` | Store listing: screenshots | Generated from test fixtures |

## Placeholders

Nothing below is final brand material. Each item is marked so it cannot be mistaken for it.

| Asset | Why it is a placeholder | How to replace |
|---|---|---|
| `icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` (and the copies the extension ships in `public/icon/`) | Drawn by `scripts/make-icons.mjs`: a generic magnifier-and-bars mark, not Legiit's logo | Put the real icons in `public/icon/` (16, 32, 48, 128 px PNG) and `store/icons/`. For the 128 px store icon Google recommends 96×96 artwork with 16 px transparent padding |
| `promo/promo-small-440x280.png` | Generated; carries the words "placeholder artwork" in the corner | A 440×280 PNG or JPEG from Legiit's designers |
| `promo/promo-marquee-1400x560.png` (optional slot) | Same | A 1400×560 PNG or JPEG |
| `screenshots/*.png` | Real output of the extension, but on invented businesses (`.example` domains) and stand-in pages that only imitate the structure of Google and ChatGPT | Either keep them, or re-take on live pages once the selectors are verified. Store rules: 1 to 5 images, 1280×800 or 640×400, square corners, no padding |
| `privacy-policy.md` / `.html` | Five fields in `[SQUARE BRACKETS — placeholder]`, highlighted yellow in the HTML: effective date, legal entity, link to Legiit's own privacy policy, contact e-mail, postal address | Edit the Markdown, then run `npm run privacy:html` |
| Legiit API host `https://lens.legiit.com` | Decided (D-88); the API is not live yet | `src/config/constants.ts`, see `docs/DECISIONS.md` A-1 |
| Product name "Legiit Lens" | Working name | `PRODUCT_NAME` in `src/config/constants.ts`, then rebuild and regenerate images |

To regenerate the generated assets:

```bash
npm run icons
```

```bash
npm run screenshots
```

```bash
npm run privacy:html
```

## Submission steps (for a person)

1. Finish the checks in `docs/QA.md`, in particular section 3 (selectors on the live sites) and section 13.
2. Decide the final Legiit API host and name. Replace the placeholder assets.
3. `npm run check`, then `npm run e2e`, then upload `release.zip` from that build.
4. Store listing tab: paste from `listing.md`; upload icon, screenshots and promo tile.
5. Privacy practices tab: paste from `single-purpose.md` and `permission-justifications.md`; answer data usage from `data-usage.md`; tick the three certifications; enter the privacy-policy URL.
6. Host `privacy-policy.html` (with the placeholders filled in) on a Legiit domain. It contains the Limited Use statement.
7. Distribution tab: visibility and regions are a business decision.
8. Submit for review with the text from `reviewer-notes.md`.

Account requirements Google enforces and that cannot be done from this repository: a registered developer account with the one-time fee paid, 2-Step Verification switched on, and (for the "official URL" field) a site verified in Google Search Console.

## Facts checked against Google's documentation on 2026-11-20

- Summary (manifest `description`): at most 132 characters.
- Screenshots: 1 to 5, 1280×800 or 640×400.
- Small promo tile: 440×280. Marquee: 1400×560. PNG or JPEG.
- Store icon: 128×128 PNG.
- Package: at most 2 GB. `release.zip` is about 19 MB.
- Manifest fields (name, description, version) cannot be edited in the dashboard after upload; a new upload needs a higher version number.
