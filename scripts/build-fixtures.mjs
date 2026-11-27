#!/usr/bin/env node
/**
 * Regenerates every file under /fixtures from the generators in
 * scripts/fixtures/*. The output is committed; tests read the files, they do
 * not run this script.
 *
 *   node scripts/build-fixtures.mjs
 *
 * Google fixtures are rendered once in Chromium at 1280x800 and every element
 * is stamped with its rectangle (data-lens-rect="x,y,w,h"), so unit tests can
 * check layout measurement without a browser. The dev-only "save this page as
 * fixture" command stamps captured pages the same way.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import * as g from './fixtures/google.mjs';
import * as p from './fixtures/pages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
const scenario = JSON.parse(await readFile(join(out, 'scenario.json'), 'utf8'));
const U = scenario.urls;

/** url → fixture file, consumed by the e2e route interceptor and by unit tests. */
const routes = [];
const files = new Map();

function add(file, contents, url, contentType = 'text/html; charset=utf-8') {
  files.set(file, contents);
  if (url) routes.push({ url, file, contentType });
}

/* ---------------------------- Google ---------------------------- */

const LIST_AHG = { url: 'https://www.austinhealthguide.example/best-dentists-austin', title: '10 Best Dentists in Austin (2026)', site: 'Austin Health Guide' };
const LIST_TLP = { url: 'https://texaslocalpicks.example/austin/top-rated-dentists', title: 'Top Rated Dentists in Austin, Texas', site: 'Texas Local Picks' };
const LIST_VS = { url: 'https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care', title: 'Lakeside Smiles vs Capitol Dental Care: Which Austin Dentist Is Better?', site: 'SmileCompare' };

const fullOrganic = [
  { ...LIST_AHG, crumb: 'https://www.austinhealthguide.example › best-dentists-austin', snippet: 'Our editors compared reviews, pricing and availability across more than sixty practices to rank the ten best dentists in Austin this year.' },
  { url: 'https://www.lakesidesmiles.example/', title: 'Lakeside Smiles | Family & Cosmetic Dentist in Austin, TX', site: 'Lakeside Smiles', crumb: 'https://www.lakesidesmiles.example', snippet: 'Gentle cleanings, same-week appointments and clear pricing. New patient special available.' },
  { ...LIST_TLP, crumb: 'https://texaslocalpicks.example › austin › top-rated-dentists', snippet: 'These Austin dental offices earned the highest verified ratings from local reviewers over the past twelve months.' },
  { url: 'https://www.capitoldentalcare.example/', title: 'Capitol Dental Care: Downtown Austin Dentist', site: 'Capitol Dental Care', crumb: 'https://www.capitoldentalcare.example', snippet: 'Cosmetic dentistry and evening hours two blocks from the Capitol.' },
  { ...LIST_VS, crumb: 'https://smilecompare.example › lakeside-smiles-vs-capitol-dental-care', snippet: 'A side-by-side comparison of the two most reviewed dental practices in Austin: price, hours, services and patient feedback.' },
  { url: 'https://www.brightpathdental.example/', title: 'BrightPath Dental | Gentle Dentistry in South Austin', site: 'BrightPath Dental', crumb: 'https://www.brightpathdental.example', snippet: 'Gentle, unhurried dental care for South Austin families. Cleanings, whitening, crowns and emergency visits.' },
  { url: 'https://www.atxneighbors.example/dentist-recommendations', title: 'Dentist recommendations from Austin neighbors', site: 'ATX Neighbors', crumb: 'https://www.atxneighbors.example › dentist-recommendations', snippet: 'We asked our members which dentist they would recommend to a new neighbor.' },
  { url: 'https://www.zilkerfamilydentistry.example/about', title: 'About Zilker Family Dentistry', site: 'Zilker Family Dentistry', crumb: 'https://www.zilkerfamilydentistry.example › about', snippet: 'A family practice next to Zilker Park, caring for children and parents since 2009.' },
  { url: 'https://www.texasdentalboard.example/find-a-dentist', title: 'Find a Licensed Dentist – Texas Dental Board', site: 'Texas Dental Board', crumb: 'https://www.texasdentalboard.example › find-a-dentist', snippet: 'Look up the licence status of any dentist practising in Texas.' },
];

const aioParts = {
  paragraphs: [
    'Several Austin dental practices are recommended again and again in patient reviews and local guides. <b>Lakeside Smiles</b> is praised for gentle cleanings and same-week appointments, while <b>Capitol Dental Care</b> is a downtown practice known for cosmetic work and evening hours.',
    'Families with young children often choose <b>Zilker Family Dentistry</b>.',
  ],
  bullets: ['Check that the office accepts your insurance.', 'Ask about new patient specials before you book.'],
  sources: [
    LIST_AHG,
    { url: 'https://www.lakesidesmiles.example/', title: 'Lakeside Smiles | Family & Cosmetic Dentist', site: 'Lakeside Smiles' },
    LIST_TLP,
    { url: 'https://www.capitoldentalcare.example/', title: 'Capitol Dental Care: Downtown Austin Dentist', site: 'Capitol Dental Care' },
  ],
};
const aio = g.aiOverview(aioParts);

const places = [
  { name: 'Lakeside Smiles', rating: '4.9 ★ (412)', address: '1200 Lakeshore Blvd', phone: '(512) 555-0101', website: 'https://www.lakesidesmiles.example/' },
  { name: 'Capitol Dental Care', rating: '4.8 ★ (367)', address: '815 Congress Ave', phone: '(512) 555-0188', website: 'https://www.capitoldentalcare.example/' },
  { name: 'Zilker Family Dentistry', rating: '4.8 ★ (301)', address: '2105 Barton Springs Rd', phone: '(512) 555-0163', website: 'https://www.zilkerfamilydentistry.example/' },
];

const topAds = g.adsBlock('tads', [
  { title: 'Lakeside Smiles – New Patient Special $79', landing: 'https://www.lakesidesmiles.example/new-patients', domain: 'lakesidesmiles.example', description: 'Exam, cleaning and X-rays for new patients. Same-week appointments.' },
  { title: 'Dental Plans From $9/Month – Save on Any Dentist', landing: 'https://www.dentalplansnow.example/austin', domain: 'dentalplansnow.example', description: 'Compare discount dental plans accepted across Austin.' },
]);
const bottomAds = g.adsBlock('tadsb', [
  { title: 'Capitol Dental Care – Evening Appointments Downtown', landing: 'https://www.capitoldentalcare.example/book', domain: 'capitoldentalcare.example', description: 'Open until 8pm Tuesday and Thursday.' },
]);

const paaFull = g.peopleAlsoAsk(scenario.keywords.full, [
  'How much does a dentist cost in Austin?',
  'Who is the highest rated dentist in Austin?',
  'How do I choose a good dentist?',
  'Do Austin dentists accept new patients?',
]);

const videos = g.videoBlock([
  { url: 'https://www.youtube.com/watch?v=fx1lakeside', title: 'How to Choose a Dentist in Austin', channel: 'Lakeside Smiles' },
  { url: 'https://www.youtube.com/watch?v=fx2capitol', title: 'Austin Dentist Office Tour | Capitol Dental Care', channel: 'Capitol Dental Care' },
  { url: 'https://www.youtube.com/watch?v=fx3brightpath', title: 'Meet the BrightPath Dental Team', channel: 'BrightPath Dental' },
]);

const forums = g.forumBlock([
  { url: 'https://www.reddit.com/r/Austin/comments/fixture1/best_dentist_in_austin/', title: 'Best dentist in Austin? : r/Austin', meta: 'Reddit · r/Austin · 48 comments · "Lakeside Smiles has been great for us"' },
  { url: 'https://www.atxmoms.example/forum/dentist-recommendations-south-austin', title: 'Dentist recommendations for South Austin?', meta: 'ATX Moms · 21 replies' },
  { url: 'https://www.askaustin.example/q/who-is-the-best-dentist-in-austin', title: 'Who is the best dentist in Austin?', meta: 'AskAustin · 9 answers · "Capitol Dental Care for cosmetic work"' },
]);

const fullResults = (overview) => [
    overview,
    g.localPack(places),
    ...fullOrganic.slice(0, 3).map(g.organic),
    paaFull,
    ...fullOrganic.slice(3, 6).map(g.organic),
    videos,
    ...fullOrganic.slice(6, 8).map(g.organic),
    forums,
    ...fullOrganic.slice(8).map(g.organic),
];
const serpFull = g.serpPage({ keyword: scenario.keywords.full, top: topAds, results: fullResults(aio), bottomAds });
// The same results as Google serves them when it hides where its links lead (seen live in November 2026).
const serpHidden = g.hideLinks(
  g.serpPage({ keyword: scenario.keywords.hidden, top: topAds, results: fullResults(g.aiOverview({ ...aioParts, withData: true })), bottomAds }),
);

const plainOrganic = [
  { url: 'https://www.capitoldentalcare.example/blog/how-often-teeth-cleaning', title: 'How Often Should You Get Your Teeth Cleaned? | Capitol Dental Care', site: 'Capitol Dental Care', crumb: 'https://www.capitoldentalcare.example › blog', snippet: 'Dentists generally recommend a professional teeth cleaning every six months.' },
  { url: 'https://www.smilehealthdaily.example/teeth-cleaning-frequency', title: 'Teeth Cleaning Frequency: What Dentists Recommend', site: 'Smile Health Daily', crumb: 'https://www.smilehealthdaily.example › teeth-cleaning-frequency', snippet: 'For most adults, a professional cleaning twice a year is the standard recommendation.' },
  { url: 'https://www.lakesidesmiles.example/blog/dental-cleaning-schedule', title: 'Your Dental Cleaning Schedule, Explained – Lakeside Smiles', site: 'Lakeside Smiles', crumb: 'https://www.lakesidesmiles.example › blog', snippet: 'Most patients should schedule a professional dental cleaning every six months.' },
  { url: 'https://www.familydentalfacts.example/how-often-dental-cleaning', title: 'How Often Do You Really Need a Dental Cleaning?', site: 'Family Dental Facts', crumb: 'https://www.familydentalfacts.example › how-often-dental-cleaning', snippet: 'The usual advice is to get your teeth professionally cleaned every six months.' },
  { url: U.targetArticle, title: 'How Often Should You Get Your Teeth Cleaned? – BrightPath Dental', site: 'BrightPath Dental', crumb: 'https://www.brightpathdental.example › blog', snippet: 'Most people should have their teeth professionally cleaned every six months.' },
  { url: 'https://www.nationaloralhealth.example/cleanings', title: 'Dental Cleanings: Frequency and Benefits', site: 'National Oral Health', crumb: 'https://www.nationaloralhealth.example › cleanings', snippet: 'Most people need a professional cleaning about every six months.' },
  { url: 'https://www.zilkerfamilydentistry.example/blog/cleaning-faq', title: 'Dental Cleaning FAQ | Zilker Family Dentistry', site: 'Zilker Family Dentistry', crumb: 'https://www.zilkerfamilydentistry.example › blog', snippet: 'Answers to the questions parents ask most about dental cleanings.' },
  { url: 'https://www.texasdentalboard.example/patients/cleanings', title: 'Patient Guide: Professional Cleanings', site: 'Texas Dental Board', crumb: 'https://www.texasdentalboard.example › patients', snippet: 'What a licensed hygienist does during a professional cleaning.' },
];
const serpPlain = g.serpPage({ keyword: scenario.keywords.plain, results: plainOrganic.map(g.organic) });

const featuredOrganic = [
  { url: 'https://www.smilehealthdaily.example/whitening-longevity', title: 'How Long Do Whitening Results Last? 7 Factors', site: 'Smile Health Daily', crumb: 'https://www.smilehealthdaily.example › whitening-longevity', snippet: 'Coffee, red wine and smoking shorten whitening results.' },
  { url: 'https://www.lakesidesmiles.example/services/whitening', title: 'Teeth Whitening – Lakeside Smiles', site: 'Lakeside Smiles', crumb: 'https://www.lakesidesmiles.example › services', snippet: 'One-hour in-office whitening with results that last.' },
  { url: 'https://www.brightpathdental.example/services/teeth-whitening', title: 'Teeth Whitening in South Austin | $299 In-Office | BrightPath Dental', site: 'BrightPath Dental', crumb: 'https://www.brightpathdental.example › services', snippet: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.' },
  { url: 'https://www.familydentalfacts.example/whitening-top-questions', title: 'Top 10 Teeth Whitening Questions, Answered', site: 'Family Dental Facts', crumb: 'https://www.familydentalfacts.example › whitening-top-questions', snippet: 'From sensitivity to cost: the ten questions patients ask most.' },
  { url: 'https://www.nationaloralhealth.example/whitening', title: 'Tooth Whitening: Safety and Effectiveness', site: 'National Oral Health', crumb: 'https://www.nationaloralhealth.example › whitening', snippet: 'What the evidence says about professional and at-home whitening.' },
  { url: 'https://www.zilkerfamilydentistry.example/whitening', title: 'Whitening for Teens and Adults | Zilker Family Dentistry', site: 'Zilker Family Dentistry', crumb: 'https://www.zilkerfamilydentistry.example › whitening', snippet: 'Custom trays for the whole family.' },
];
const serpFeatured = g.serpPage({
  keyword: scenario.keywords.featured,
  results: [
    g.featuredSnippet({
      answer: 'Professional teeth whitening typically lasts <b>six months to three years</b>, depending on diet, smoking and how well you care for your teeth afterwards.',
      url: 'https://www.capitoldentalcare.example/blog/whitening-how-long',
      title: 'How Long Does Teeth Whitening Last? | Capitol Dental Care',
      site: 'Capitol Dental Care',
      crumb: 'https://www.capitoldentalcare.example › blog',
    }),
    g.peopleAlsoAsk(scenario.keywords.featured, [
      'Is teeth whitening permanent?',
      'How can I make whitening last longer?',
      'How often can you whiten your teeth?',
      'Does whitening damage enamel?',
    ]),
    ...featuredOrganic.slice(0, 3).map(g.organic),
    g.imageBlock(['https://www.smilehealthdaily.example/img/before-after', 'https://www.lakesidesmiles.example/gallery', 'https://www.familydentalfacts.example/img/shades', 'https://www.nationaloralhealth.example/img/whitening']),
    ...featuredOrganic.slice(3).map(g.organic),
  ],
  rhs: g.knowledgePanel({
    title: 'Tooth whitening',
    description: 'Tooth whitening is the process of lightening the colour of human teeth.',
    sourceUrl: 'https://en.encyclopedia.example/wiki/Tooth_whitening',
  }),
});

const localOrganic = [
  { url: 'https://www.austinemergencydental.example/', title: 'Austin Emergency Dental – Open 7 Days', site: 'Austin Emergency Dental', crumb: 'https://www.austinemergencydental.example', snippet: 'Walk-in emergency dental care, open late seven days a week.' },
  { url: 'https://www.brightpathdental.example/emergency-dentist', title: 'Emergency Dentist in South Austin | BrightPath Dental', site: 'BrightPath Dental', crumb: 'https://www.brightpathdental.example › emergency-dentist', snippet: 'Same-day appointments for toothaches, chipped teeth and lost fillings.' },
  { url: 'https://www.austinhealthguide.example/emergency-dentists', title: 'Best Emergency Dentists in Austin: 6 Options Compared', site: 'Austin Health Guide', crumb: 'https://www.austinhealthguide.example › emergency-dentists', snippet: 'Six Austin offices that will see you the same day.' },
  { url: 'https://www.capitoldentalcare.example/emergency', title: 'Dental Emergencies | Capitol Dental Care', site: 'Capitol Dental Care', crumb: 'https://www.capitoldentalcare.example › emergency', snippet: 'Call our downtown office for urgent dental care.' },
  { url: 'https://www.nationaloralhealth.example/dental-emergencies', title: 'What Counts as a Dental Emergency?', site: 'National Oral Health', crumb: 'https://www.nationaloralhealth.example › dental-emergencies', snippet: 'When to call a dentist and when to go to the emergency room.' },
];
const serpLocal = g.serpPage({
  keyword: scenario.keywords.local,
  top: g.adsBlock('tads', [
    { title: 'Emergency Dentist Austin – Seen Today | Lakeside Smiles', landing: 'https://www.lakesidesmiles.example/emergency', domain: 'lakesidesmiles.example', description: 'Same-day emergency visits. Call now.' },
    { title: 'Capitol Dental Care – Urgent Dental Care Downtown', landing: 'https://www.capitoldentalcare.example/emergency', domain: 'capitoldentalcare.example', description: 'Evening emergency appointments.' },
    { title: '24 Hour Dentist Austin – No Insurance Needed', landing: 'https://www.24hrdentalatx.example/', domain: '24hrdentalatx.example', description: 'Open nights and weekends.' },
  ]),
  results: [
    g.localPack([
      { name: 'Capitol Dental Care', rating: '4.8 ★ (367)', address: '815 Congress Ave', phone: '(512) 555-0188', website: 'https://www.capitoldentalcare.example/' },
      { name: 'Austin Emergency Dental', rating: '4.6 ★ (188)', address: '4400 N Lamar Blvd', phone: '(512) 555-0119', website: 'https://www.austinemergencydental.example/' },
      { name: 'Zilker Family Dentistry', rating: '4.8 ★ (301)', address: '2105 Barton Springs Rd', phone: '(512) 555-0163', website: 'https://www.zilkerfamilydentistry.example/' },
    ]),
    ...localOrganic.slice(0, 2).map(g.organic),
    g.peopleAlsoAsk(scenario.keywords.local, ['What is considered a dental emergency?', 'How much is an emergency dentist visit?', 'Can I go to the ER for a toothache?']),
    ...localOrganic.slice(2).map(g.organic),
  ],
});

const serpAiMode = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${g.esc(scenario.keywords.full)} - Google Search</title>
<style>body{font:16px/1.6 arial,sans-serif;margin:0}#searchform{height:96px;border-bottom:1px solid #ebebeb}main{max-width:820px;margin:24px auto}.aimode-query{font-size:22px;margin:18px 0}.aimode-answer{background:#f7f8fd;border-radius:16px;padding:20px}.src a{display:block;margin:6px 0}</style></head>
<body>
<div id="searchform"><form action="/search"><textarea name="q">${g.esc(scenario.keywords.full)}</textarea></form></div>
<main role="main"><div data-subtree="aimc">
<div class="aimode-query" data-aimode-query>dentist near zilker park</div>
<div data-subtree="aimfl"><p>An earlier answer about Zilker Park dentists mentioned <a href="https://www.zilkerfamilydentistry.example/">Zilker Family Dentistry</a>.</p></div>
<div class="aimode-query" data-aimode-query>${g.esc(scenario.keywords.full)}</div>
<div data-subtree="aimfl">
<p>Austin has several well-reviewed dental practices. <b>Lakeside Smiles</b> is praised for gentle cleanings and same-week appointments, and <b>Capitol Dental Care</b> is a downtown practice known for cosmetic work and evening hours.</p>
<ul><li><b>Zilker Family Dentistry</b> is a popular choice for families with young children.</li><li>Compare published prices before booking.</li></ul>
<div class="src"><a href="https://www.austinhealthguide.example/best-dentists-austin#:~:text=Lakeside">10 Best Dentists in Austin (2026)</a><a href="https://texaslocalpicks.example/austin/top-rated-dentists?utm_source=google">Top Rated Dentists in Austin, Texas</a><a href="https://www.capitoldentalcare.example/">Capitol Dental Care</a></div>
<p><a href="https://support.google.com/websearch?p=aimode">Learn more about AI Mode</a></p>
</div>
</div></main>
</body></html>
`;

const serpUnrecognised = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>https://www.google.com/search?q=blocked+query</title><style>#infoDiv{margin:80px 180px;font:16px arial}</style></head>
<body><div id="infoDiv"><p>Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.</p><form id="captcha-form" action="index" method="post"><input type="hidden" name="q" value=""></form></div></body></html>
`;

add('google/serp-full.html', serpFull, U.serpFull);
add('google/serp-plain.html', serpPlain, U.serpPlain);
add('google/serp-featured.html', serpFeatured, U.serpFeatured);
add('google/serp-local.html', serpLocal, U.serpLocal);
add('google/serp-churn.html', g.churn(serpFull), U.serpChurn);
add('google/serp-hidden-links.html', serpHidden, U.serpHidden);
add('google/serp-ai-mode.html', serpAiMode, U.serpAiMode);
add('google/serp-unrecognised.html', serpUnrecognised, U.serpUnrecognised);

/* ---------------------------- AI sites ---------------------------- */

add('ai/chatgpt.html', p.chatgptPage(), U.chatgpt);
add('ai/chatgpt-unrecognised.html', p.chatgptUnrecognisedPage(), U.chatgptUnrecognised);
add('ai/gemini.html', p.geminiPage(), U.gemini);
add('ai/perplexity.html', p.perplexityPage(), U.perplexity);
add('ai/copilot.html', p.copilotPage(), U.copilot);

/* ---------------------------- List pages ---------------------------- */

add('lists/austinhealthguide-best-dentists.html', p.austinHealthGuidePage(), LIST_AHG.url);
add('lists/texaslocalpicks-top-dentists.html', p.texasLocalPicksPage(), LIST_TLP.url);
add('lists/smilecompare-lakeside-vs-capitol.html', p.smileComparePage(), LIST_VS.url);
add('lists/atxneighbors-dentist-recommendations.html', p.atxNeighborsPage(), 'https://www.atxneighbors.example/dentist-recommendations');
add(
  'lists/lakesidesmiles-home.html',
  p.competitorHomePage('Lakeside Smiles', 'Family & Cosmetic Dentist in Austin, TX', 'Gentle cleanings, same-week appointments and clear pricing for new patients.'),
  'https://www.lakesidesmiles.example/',
);
add(
  'lists/capitoldentalcare-home.html',
  p.competitorHomePage('Capitol Dental Care', 'Downtown Austin Dentist', 'Cosmetic dentistry and evening hours two blocks from the Capitol.'),
  'https://www.capitoldentalcare.example/',
);

/* ---------------------------- Articles ---------------------------- */

add('articles/brightpath-how-often-teeth-cleaning.html', p.targetArticlePage(), U.targetArticle);
for (const a of p.COMPARISON_ARTICLES) add(`articles/${a.file}`, a.html(), a.url);

/* ---------------------------- Business site ---------------------------- */

for (const sp of p.SITE_PAGES) add(`site/${sp.file}`, sp.html(), `${p.SITE_ORIGIN}${sp.path}`);

/* ---------------------------- Wayback ---------------------------- */

const cdxRoutes = {};
add('wayback/cdx-teeth-whitening.json', `${JSON.stringify(p.rewindCdx(), null, 1)}\n`);
cdxRoutes[U.rewindPage] = 'wayback/cdx-teeth-whitening.json';
add('wayback/cdx-empty.json', '[]\n');
cdxRoutes[U.noCapturesPage] = 'wayback/cdx-empty.json';
add('wayback/cdx-large.json', `${JSON.stringify(p.largeCdx(), null, 1)}\n`);
cdxRoutes[U.site] = 'wayback/cdx-large.json';
for (const c of p.rewindCaptures()) {
  add(`wayback/captures/${c.timestamp}.html`, c.html, `https://web.archive.org/web/${c.timestamp}id_/${U.rewindPage}`);
}

/* ---------------------------- Misc ---------------------------- */

add(
  'misc/plain-page.html',
  p.htmlPage({ title: 'Hello', body: '<main><h1>Hello</h1><p>A very small page with almost nothing on it.</p></main>' }),
  U.plainPage,
);

/* ---------------------------- Write + stamp ---------------------------- */

for (const dir of ['google', 'ai', 'lists', 'articles', 'site', 'wayback', 'misc']) {
  await rm(join(out, dir), { recursive: true, force: true });
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const pg = await context.newPage();

  // A tiny logo image for the business-site fixture.
  await pg.setViewportSize({ width: 150, height: 40 });
  await pg.setContent('<body style="margin:0;background:#0e7c86;color:#fff;font:700 18px system-ui;display:flex;align-items:center;justify-content:center;height:40px">BrightPath</body>');
  const logo = await pg.screenshot({ type: 'png' });
  await mkdir(join(out, 'site', 'assets'), { recursive: true });
  await writeFile(join(out, 'site', 'assets', 'brightpath-logo.png'), logo);
  await pg.setViewportSize({ width: 1280, height: 800 });

  for (const [file, contents] of files) {
    let finalContents = contents;
    if (file.startsWith('google/')) {
      await pg.setContent(contents, { waitUntil: 'load' });
      finalContents = await pg.evaluate(() => {
        for (const el of document.body.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            el.setAttribute(
              'data-lens-rect',
              [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height].map((n) => Math.round(n)).join(','),
            );
          }
        }
        document.documentElement.setAttribute('data-lens-viewport', `${window.innerWidth}x${window.innerHeight}`);
        document.documentElement.setAttribute('data-lens-doc-height', String(Math.round(document.documentElement.scrollHeight)));
        return `<!doctype html>\n${document.documentElement.outerHTML}\n`;
      });
    }
    const dest = join(out, file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, finalContents);
  }
} finally {
  await browser.close();
}

routes.push({ url: `${p.SITE_ORIGIN}/assets/brightpath-logo.png`, file: 'site/assets/brightpath-logo.png', contentType: 'image/png' });

const manifest = {
  about: 'Generated by scripts/build-fixtures.mjs. Maps real-looking URLs to fixture files for the e2e route interceptor.',
  routes: routes.sort((a, b) => a.url.localeCompare(b.url)),
  cdx: cdxRoutes,
};
await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${files.size + 1} fixture files and manifest.json (${routes.length} routes)`);
