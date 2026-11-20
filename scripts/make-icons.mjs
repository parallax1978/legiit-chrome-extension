#!/usr/bin/env node
/**
 * Renders the PLACEHOLDER icon set and promo tile from inline SVG.
 *
 * These are stand-in brand assets so the extension builds and the store
 * package is complete. Replace them with real Legiit artwork before
 * submission (keep the same file names and pixel sizes).
 *
 *   node scripts/make-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The mark: a lens ring over three rising bars. `pad` is transparent padding in a 128 box. */
function markSvg(size, pad) {
  const inner = 128 - pad * 2;
  const scale = inner / 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d3a8a"/>
      <stop offset="1" stop-color="#0f1f4d"/>
    </linearGradient>
  </defs>
  <g transform="translate(${pad} ${pad}) scale(${scale})">
    <rect width="128" height="128" rx="28" fill="url(#g)"/>
    <rect x="34" y="62" width="11" height="22" rx="3" fill="#7dd3fc"/>
    <rect x="50" y="48" width="11" height="36" rx="3" fill="#38bdf8"/>
    <rect x="66" y="36" width="11" height="48" rx="3" fill="#ffffff"/>
    <circle cx="56" cy="58" r="34" fill="none" stroke="#ffffff" stroke-width="9"/>
    <line x1="81" y1="83" x2="104" y2="106" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>
  </g>
</svg>`;
}

function promoHtml(width, height, title, subtitle) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px}
    body{display:flex;align-items:center;gap:${Math.round(width * 0.05)}px;padding:0 ${Math.round(width * 0.07)}px;box-sizing:border-box;
      background:linear-gradient(135deg,#0f1f4d,#1d3a8a 60%,#2563eb);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    h1{margin:0;font-size:${Math.round(height * 0.17)}px;letter-spacing:-0.02em}
    p{margin:${Math.round(height * 0.03)}px 0 0;font-size:${Math.round(height * 0.07)}px;line-height:1.3;opacity:.9}
    .tag{position:absolute;right:10px;bottom:8px;font-size:10px;opacity:.55}
  </style></head><body>
    ${markSvg(Math.round(height * 0.46), 0)}
    <div><h1>${title}</h1><p>${subtitle}</p></div>
    <div class="tag">placeholder artwork</div>
  </body></html>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  async function renderSvg(svg, size, outPath) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, await page.screenshot({ omitBackground: true, type: 'png' }));
    console.log('wrote', outPath.replace(`${root}/`, ''));
  }

  // Extension icons. Small sizes are full bleed; 128 follows the store rule of
  // 96x96 artwork inside 16px of transparent padding.
  for (const size of [16, 32, 48]) {
    await renderSvg(markSvg(size, 0), size, join(root, 'public', 'icon', `${size}.png`));
  }
  await renderSvg(markSvg(128, 16), 128, join(root, 'public', 'icon', '128.png'));

  // Store copies.
  for (const size of [16, 32, 48]) {
    await renderSvg(markSvg(size, 0), size, join(root, 'store', 'icons', `icon-${size}.png`));
  }
  await renderSvg(markSvg(128, 16), 128, join(root, 'store', 'icons', 'icon-128.png'));

  // Promo tiles.
  for (const [w, h, name] of [
    [440, 280, 'promo-small-440x280.png'],
    [1400, 560, 'promo-marquee-1400x560.png'],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(
      promoHtml(w, h, 'Legiit Lens', 'See how visible you are in Google results and AI answers, and why.'),
    );
    const out = join(root, 'store', 'promo', name);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await page.screenshot({ type: 'png' }));
    console.log('wrote', out.replace(`${root}/`, ''));
  }
} finally {
  await browser.close();
}
