/**
 * Synthetic non-Google fixtures: AI answer pages, list pages, comparison
 * articles, a small business website and Wayback Machine captures.
 * Everything is invented and lives on reserved .example hosts.
 */
import { esc } from './google.mjs';

const page = ({ lang = 'en', head = '', body, title }) => `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${head}
</head>
<body>
${body}
</body>
</html>
`;

const BASE_CSS = `<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;color:#1f2933}main,article{max-width:760px;margin:0 auto;padding:24px}nav a,footer a{margin-right:14px}h1{font-size:32px;line-height:1.2}</style>`;

/* ------------------------------------------------------------------ */
/* AI answer pages                                                     */
/* ------------------------------------------------------------------ */

const ANSWER_INTRO =
  'Based on recent patient reviews and local guides, a few Austin dental practices are recommended again and again.';

export function chatgptPage() {
  return page({
    title: 'Best dentists in Austin - ChatGPT',
    head: BASE_CSS,
    body: `<div id="__next"><div class="flex h-full w-full">
<nav aria-label="Chat history"><a href="/c/older-chat">Dental cleaning basics</a><a href="/gpts">Explore GPTs</a></nav>
<main class="relative h-full w-full flex-1">
<div class="flex flex-col text-sm">
<article data-testid="conversation-turn-1" data-turn="user"><h5 class="sr-only">You said:</h5><div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">What is a dental cleaning?</div></div></article>
<article data-testid="conversation-turn-2" data-turn="assistant"><h6 class="sr-only">ChatGPT said:</h6><div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown prose w-full break-words"><p>A dental cleaning is a preventive visit where a hygienist removes plaque and tartar and polishes your teeth. An earlier answer mentioned <a href="https://www.nationaloralhealth.example/cleanings?utm_source=chatgpt.com" target="_blank" rel="noopener">National Oral Health</a>.</p></div></div></article>
<article data-testid="conversation-turn-3" data-turn="user"><h5 class="sr-only">You said:</h5><div data-message-author-role="user" data-message-id="u-2"><div class="whitespace-pre-wrap">Who are the best dentists in Austin?</div></div></article>
<article data-testid="conversation-turn-4" data-turn="assistant"><h6 class="sr-only">ChatGPT said:</h6><div data-message-author-role="assistant" data-message-id="a-2"><div class="markdown prose w-full break-words">
<p>${ANSWER_INTRO}</p>
<ol>
<li><strong>Lakeside Smiles</strong> is praised for gentle cleanings, same-week appointments and clear pricing for new patients. <span data-state="closed"><a href="https://www.austinhealthguide.example/best-dentists-austin?utm_source=chatgpt.com" target="_blank" rel="noopener" class="citation-pill">Austin Health Guide</a></span></li>
<li><strong>Capitol Dental Care</strong> is a downtown practice known for cosmetic work and evening hours. <span data-state="closed"><a href="https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care?utm_source=chatgpt.com" target="_blank" rel="noopener" class="citation-pill">SmileCompare</a></span></li>
<li><strong>Zilker Family Dentistry</strong> is a popular choice for families with young children.</li>
</ol>
<p>If cost matters most, ask each office about its new patient special before you book.</p>
</div></div>
<div class="sources-footer"><button type="button">Sources</button> <a href="https://texaslocalpicks.example/austin/top-rated-dentists?utm_source=chatgpt.com" target="_blank" rel="noopener">texaslocalpicks.example</a> <a href="https://help.openai.com/en/articles/sources" target="_blank">How sources work</a></div>
</article>
</div>
<form><div id="prompt-textarea" contenteditable="true" data-placeholder="Ask anything"></div></form>
</main></div></div>`,
  });
}

/** Same conversation in markup the selector pack does not know: exercises the "paste the answer" fallback. */
export function chatgptUnrecognisedPage() {
  return page({
    title: 'ChatGPT',
    head: BASE_CSS,
    body: `<div id="app"><div class="layout"><div class="thread"><div class="bubble human">Who are the best dentists in Austin?</div><div class="bubble bot"><p>${ANSWER_INTRO} Lakeside Smiles and Capitol Dental Care lead most lists.</p></div></div></div></div>`,
  });
}

export function geminiPage() {
  return page({
    title: 'Best dentists in Austin - Gemini',
    head: BASE_CSS,
    body: `<chat-app><main><chat-window><div class="conversation-container">
<user-query><div class="user-query-container"><div class="query-text"><p class="query-text-line">Who are the best dentists in Austin?</p></div></div></user-query>
<model-response><response-container><div class="response-content"><message-content class="model-response-text"><div class="markdown markdown-main-panel">
<p>${ANSWER_INTRO}</p>
<ul>
<li><b>Capitol Dental Care</b> – downtown, strong reviews for cosmetic dentistry and evening hours.</li>
<li><b>Lakeside Smiles</b> – gentle cleanings and same-week appointments.</li>
<li><b>Zilker Family Dentistry</b> – well liked by families with young children.</li>
</ul>
<p>Check that the office is in your insurance network before booking.</p>
</div></message-content></div>
<sources-list><div class="sources-header">Sources</div>
<a class="source-card-link" href="https://www.austinhealthguide.example/best-dentists-austin" target="_blank"><span class="source-title">10 Best Dentists in Austin (2026)</span><span class="source-site">Austin Health Guide</span></a>
<a class="source-card-link" href="https://texaslocalpicks.example/austin/top-rated-dentists" target="_blank"><span class="source-title">Top Rated Dentists in Austin, Texas</span><span class="source-site">Texas Local Picks</span></a>
<a class="source-card-link" href="https://www.capitoldentalcare.example/" target="_blank"><span class="source-title">Capitol Dental Care</span></a>
</sources-list></response-container></model-response>
</div></chat-window></main><a href="https://support.google.com/gemini">Help</a></chat-app>`,
  });
}

export function perplexityPage() {
  return page({
    title: 'best dentists in austin',
    head: BASE_CSS,
    body: `<div id="root"><main><div data-testid="thread-turn">
<h1 class="group/query" data-testid="query-text">best dentists in austin</h1>
<div data-testid="sources"><a class="source-card" href="https://www.austinhealthguide.example/best-dentists-austin" target="_blank">Austin Health Guide</a><a class="source-card" href="https://www.atxneighbors.example/dentist-recommendations" target="_blank">ATX Neighbors</a></div>
<div id="markdown-content-0" class="prose dark:prose-invert inline leading-normal">
<p>${ANSWER_INTRO} <a class="citation" href="https://www.austinhealthguide.example/best-dentists-austin" target="_blank" data-pplx-citation-url="https://www.austinhealthguide.example/best-dentists-austin">1</a></p>
<p>Neighbors in South Austin also recommend <b>BrightPath Dental</b> for gentle care, alongside <b>Lakeside Smiles</b>. <a class="citation" href="https://www.atxneighbors.example/dentist-recommendations" target="_blank">2</a></p>
<p><b>Capitol Dental Care</b> is the usual pick downtown.</p>
</div></div></main></div>`,
  });
}

export function copilotPage() {
  return page({
    title: 'Microsoft Copilot',
    head: BASE_CSS,
    body: `<div id="app"><main><div class="conversation">
<div data-testid="message-group"><div data-content="user-message">Who are the best dentists in Austin?</div></div>
<div data-testid="message-group"><div data-content="ai-message"><div class="space-y-3">
<p>${ANSWER_INTRO}</p>
<p><strong>Lakeside Smiles</strong> and <strong>Zilker Family Dentistry</strong> rank at the top of most local lists, and <strong>Capitol Dental Care</strong> is the usual downtown pick.</p>
</div></div>
<div data-testid="citation-list"><a href="https://texaslocalpicks.example/austin/top-rated-dentists" target="_blank">Texas Local Picks</a><a href="https://smilecompare.example/lakeside-smiles-vs-capitol-dental-care" target="_blank">SmileCompare</a></div>
</div></div></main></div>`,
  });
}

/* ------------------------------------------------------------------ */
/* List pages and competitor home pages (Why Not Me → Scan sources)    */
/* ------------------------------------------------------------------ */

function listEntry(n, name, text) {
  return `<h2>${n}. ${esc(name)}</h2>\n<p>${text}</p>`;
}

export function austinHealthGuidePage() {
  const entries = [
    ['Lakeside Smiles', 'Lakeside Smiles is praised for gentle cleanings, same-week appointments and clear pricing for new patients. The office on Lakeshore Boulevard opens early on weekdays.'],
    ['Capitol Dental Care', 'Capitol Dental Care is a downtown practice known for cosmetic work and evening hours, which makes it a favourite with people who work near the Capitol.'],
    ['Zilker Family Dentistry', 'Zilker Family Dentistry is a popular choice for families with young children, with a play corner and patient hygienists.'],
    ['Barton Creek Dental Studio', 'A small studio with a strong reputation for crowns and implants.'],
    ['Mueller Modern Dentistry', 'A newer office in the Mueller district with online booking.'],
    ['Hyde Park Dental Arts', 'Long-established practice with many second-generation patients.'],
    ['East Side Smile Co.', 'Affordable cleanings and Spanish-speaking staff.'],
    ['Domain Dental Group', 'Large group practice with weekend hours.'],
    ['Travis Heights Dentistry', 'Known for calm treatment of anxious patients.'],
    ['Riverside Family Dental', 'Good value for families without insurance.'],
  ];
  return page({
    title: '10 Best Dentists in Austin (2026) – Austin Health Guide',
    head: `${BASE_CSS}<meta name="description" content="Our editors compared reviews, pricing and availability to rank the ten best dentists in Austin.">
<meta name="author" content="Maya Ortiz">`,
    body: `<header><nav><a href="/">Austin Health Guide</a><a href="/doctors">Doctors</a><a href="/dentists">Dentists</a><a href="/about">About</a></nav></header>
<main><article>
<h1>10 Best Dentists in Austin (2026)</h1>
<p class="byline">By <a rel="author" href="/authors/maya-ortiz">Maya Ortiz</a> · Updated March 2026</p>
<p>Finding a dentist you trust takes time. Our editors compared patient reviews, published pricing and appointment availability across more than sixty practices to rank the ten best dentists in Austin this year.</p>
<p>Every practice on this list accepts new patients and publishes its fees for a standard cleaning and exam.</p>
${entries.map(([name, text], i) => listEntry(i + 1, name, text)).join('\n')}
<h2>How we chose</h2>
<p>We weighted patient reviews at fifty percent, pricing transparency at thirty percent and availability at twenty percent. Practices cannot pay to be included.</p>
</article></main>
<footer><a href="/contact">Contact</a><a href="/suggest-a-dentist">Suggest a dentist</a><a href="/editorial-guidelines">Editorial guidelines</a><a href="mailto:editors@austinhealthguide.example">editors@austinhealthguide.example</a><a href="https://www.facebook.example/austinhealthguide">Facebook</a></footer>`,
  });
}

export function texasLocalPicksPage() {
  return page({
    title: 'Top Rated Dentists in Austin, Texas | Texas Local Picks',
    head: `${BASE_CSS}<meta name="description" content="The top rated dentists in Austin according to verified local reviews.">`,
    body: `<header><nav><a href="/">Texas Local Picks</a><a href="/austin">Austin</a><a href="/about-us">About us</a></nav></header>
<main><article>
<h1>Top Rated Dentists in Austin, Texas</h1>
<p>These Austin dental offices earned the highest verified ratings from local reviewers over the past twelve months.</p>
<ul>
<li><strong>Lakeside Smiles</strong> – 4.9 stars from 412 reviews. Reviewers mention gentle cleanings and same-week appointments.</li>
<li><strong>Capitol Dental Care</strong> – 4.8 stars from 367 reviews. Evening hours and cosmetic dentistry downtown.</li>
<li><strong>Mueller Modern Dentistry</strong> – 4.8 stars from 198 reviews.</li>
<li><strong>Hyde Park Dental Arts</strong> – 4.7 stars from 240 reviews.</li>
</ul>
<p>Ratings are refreshed every month. Businesses can claim a profile but cannot change their score.</p>
</article></main>
<footer><a href="/get-listed">Get listed</a><a href="/contact">Contact us</a><a href="mailto:hello@texaslocalpicks.example">hello@texaslocalpicks.example</a></footer>`,
  });
}

export function smileComparePage() {
  return page({
    title: 'Lakeside Smiles vs Capitol Dental Care: Which Austin Dentist Is Better?',
    head: `${BASE_CSS}<meta name="description" content="A side-by-side comparison of two of the most reviewed dentists in Austin.">`,
    body: `<header><nav><a href="/">SmileCompare</a><a href="/compare">All comparisons</a></nav></header>
<main><article>
<h1>Lakeside Smiles vs Capitol Dental Care: Which Austin Dentist Is Better?</h1>
<p>Lakeside Smiles and Capitol Dental Care are the two most reviewed dental practices in Austin. We compared them on price, hours, services and patient feedback.</p>
<h2>Price</h2>
<p>Lakeside Smiles offers a new patient special, while Capitol Dental Care charges a little more but includes X-rays in its exam fee.</p>
<h2>Hours</h2>
<p>Capitol Dental Care is a downtown practice known for cosmetic work and evening hours. Lakeside Smiles opens early and closes at five.</p>
<h2>Verdict</h2>
<p>Choose Lakeside Smiles for routine family care and Capitol Dental Care for cosmetic treatment.</p>
<p class="author">Written by <a href="/author/dev-patel/">Dev Patel</a></p>
</article></main>
<footer><a href="/write-for-us">Write for us</a><a href="/about">About</a></footer>`,
  });
}

export function atxNeighborsPage() {
  return page({
    title: 'Dentist recommendations from Austin neighbors',
    head: BASE_CSS,
    body: `<header><nav><a href="/">ATX Neighbors</a><a href="/topics">Topics</a></nav></header>
<main><article>
<h1>Dentist recommendations from Austin neighbors</h1>
<p>We asked our members which dentist they would recommend to a new neighbor. Two names came up more than any other.</p>
<p>Neighbors in South Austin recommend BrightPath Dental for gentle care and for hygienists who never rush an appointment.</p>
<p>North of the river, Lakeside Smiles was the most common answer, mostly for its early opening hours.</p>
<p>Have a recommendation of your own? Tell us about it.</p>
</article></main>
<footer><a href="/contact">Contact</a><a href="/submit-a-recommendation">Submit a recommendation</a></footer>`,
  });
}

export function competitorHomePage(name, tagline, extra) {
  return page({
    title: `${name} | ${tagline}`,
    head: `${BASE_CSS}<meta name="description" content="${esc(name)} – ${esc(tagline)}.">`,
    body: `<header><nav><a href="/">${esc(name)}</a><a href="/services">Services</a><a href="/new-patients">New patients</a><a href="/contact">Contact</a></nav></header>
<main>
<h1>${esc(name)}</h1>
<p>${esc(tagline)}. ${esc(extra)}</p>
<p>${esc(name)} has cared for Austin families for more than a decade. Book online or call the front desk to schedule a cleaning and exam.</p>
</main>
<footer><a href="/contact">Contact</a></footer>`,
  });
}

/* ------------------------------------------------------------------ */
/* Comparison articles (New or Noise)                                  */
/* ------------------------------------------------------------------ */

function article({ title, site, description, paragraphs }) {
  return page({
    title: `${title} | ${site}`,
    head: `${BASE_CSS}<meta name="description" content="${esc(description)}">`,
    body: `<header><nav><a href="/">${esc(site)}</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav></header>
<main><article>
<h1>${esc(title)}</h1>
${paragraphs.map((p) => (p.startsWith('## ') ? `<h2>${esc(p.slice(3))}</h2>` : `<p>${esc(p)}</p>`)).join('\n')}
</article></main>
<footer><p>© ${esc(site)}. This article is general information, not medical advice.</p></footer>`,
  });
}

/** The user's page. Mixes common points, less common points and statements found nowhere else. */
export function targetArticlePage() {
  return article({
    title: 'How Often Should You Get Your Teeth Cleaned?',
    site: 'BrightPath Dental',
    description: 'How often to book a professional dental cleaning, and when to come in more often.',
    paragraphs: [
      'Most people should have their teeth professionally cleaned every six months. A professional cleaning removes plaque and hardened tartar that brushing and flossing leave behind.',
      '## When to come in more often',
      'People with gum disease often need cleanings every three to four months. Smokers and people with diabetes have a higher risk of gum problems, so they may need cleanings more often.',
      '## What it costs',
      'Most dental insurance plans cover two cleanings per year.',
      '## How we do it at BrightPath',
      'At BrightPath Dental we use an air-polishing system that lifts stains without scraping. Our South Austin hygienists book fifty-minute appointments so nobody is rushed.',
      'In our 2025 patient survey, 68 percent of patients on a four-month schedule reported less bleeding when flossing. We send a text reminder three weeks before you are due, with a link to pick your own time.',
    ],
  });
}

export const COMPARISON_ARTICLES = [
  {
    file: 'capitoldentalcare-how-often-teeth-cleaning.html',
    url: 'https://www.capitoldentalcare.example/blog/how-often-teeth-cleaning',
    html: () =>
      article({
        title: 'How Often Should You Get Your Teeth Cleaned?',
        site: 'Capitol Dental Care',
        description: 'Our downtown Austin dentists explain how often to schedule a cleaning.',
        paragraphs: [
          'Dentists generally recommend a professional teeth cleaning every six months. Cleanings remove plaque and tartar that regular brushing and flossing cannot reach.',
          'If you have gum disease, your dentist may recommend a cleaning every three or four months.',
          '## What happens at the visit',
          'A routine cleaning usually takes 30 to 60 minutes. Dental X-rays are usually taken once a year during a cleaning visit. A fluoride treatment is often applied at the end of the cleaning.',
          'Our downtown office offers evening appointments on Tuesdays and Thursdays for people who work near the Capitol.',
        ],
      }),
  },
  {
    file: 'smilehealthdaily-teeth-cleaning-frequency.html',
    url: 'https://www.smilehealthdaily.example/teeth-cleaning-frequency',
    html: () =>
      article({
        title: 'Teeth Cleaning Frequency: What Dentists Recommend',
        site: 'Smile Health Daily',
        description: 'How many dental cleanings a year do you need? Here is what dentists recommend.',
        paragraphs: [
          'For most adults, a professional cleaning twice a year is the standard recommendation. During a cleaning, the hygienist removes tartar and plaque that brushing at home misses.',
          'Smokers and people with diabetes have a higher risk of gum problems and may need more frequent cleanings.',
          '## Children',
          'Children should have their first dental visit by their first birthday.',
          '## At the appointment',
          'Most offices take X-rays about once a year at a cleaning appointment. Many hygienists finish the cleaning with a fluoride treatment.',
          'Electric toothbrushes with pressure sensors can help people who brush too hard.',
        ],
      }),
  },
  {
    file: 'lakesidesmiles-dental-cleaning-schedule.html',
    url: 'https://www.lakesidesmiles.example/blog/dental-cleaning-schedule',
    html: () =>
      article({
        title: 'Your Dental Cleaning Schedule, Explained',
        site: 'Lakeside Smiles',
        description: 'A simple guide to how often you should book a dental cleaning.',
        paragraphs: [
          'Most patients should schedule a professional dental cleaning every six months. Patients with periodontal disease usually need cleanings every three to four months.',
          'Dental insurance typically pays for two cleanings a year.',
          '## Kids and cleanings',
          'A child should see the dentist for the first time by age one.',
          '## What to expect',
          'X-rays are typically taken once a year as part of a cleaning visit. A standard cleaning appointment lasts between 30 and 60 minutes.',
          'Lakeside Smiles opens at seven on weekdays so you can come in before work.',
        ],
      }),
  },
  {
    file: 'familydentalfacts-how-often-dental-cleaning.html',
    url: 'https://www.familydentalfacts.example/how-often-dental-cleaning',
    html: () =>
      article({
        title: 'How Often Do You Really Need a Dental Cleaning?',
        site: 'Family Dental Facts',
        description: 'The evidence behind the six-month dental cleaning rule.',
        paragraphs: [
          'The usual advice is to get your teeth professionally cleaned every six months. Professional cleanings get rid of the plaque and tartar your toothbrush leaves behind.',
          'Those with gum disease may need to come in every three to four months.',
          '## For parents',
          'Babies should have a first dental visit by the time they turn one.',
          '## After the cleaning',
          'The appointment often ends with a fluoride treatment.',
          'Some researchers argue that low-risk adults could safely stretch the interval to once a year.',
        ],
      }),
  },
  {
    file: 'nationaloralhealth-cleanings.html',
    url: 'https://www.nationaloralhealth.example/cleanings',
    html: () =>
      article({
        title: 'Dental Cleanings: Frequency and Benefits',
        site: 'National Oral Health',
        description: 'How often adults and children need professional dental cleanings.',
        paragraphs: [
          'Most people need a professional cleaning about every six months. A cleaning removes the plaque and tartar that daily brushing and flossing leave behind.',
          '## Children',
          'Children should visit a dentist by age one.',
          '## The visit',
          'Expect dental X-rays roughly once a year during one of your cleanings. A routine cleaning takes about 30 to 60 minutes.',
          'Community water fluoridation has reduced tooth decay nationwide since the 1940s.',
        ],
      }),
  },
];

/* ------------------------------------------------------------------ */
/* Business website (Instant Brief)                                    */
/* ------------------------------------------------------------------ */

const SITE_ORIGIN = 'https://www.brightpathdental.example';

const SITE_JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': ['Dentist', 'LocalBusiness'],
      '@id': `${SITE_ORIGIN}/#business`,
      name: 'BrightPath Dental',
      url: `${SITE_ORIGIN}/`,
      logo: `${SITE_ORIGIN}/assets/brightpath-logo.png`,
      image: `${SITE_ORIGIN}/assets/office.jpg`,
      telephone: '+1-512-555-0142',
      email: 'hello@brightpathdental.example',
      priceRange: '$$',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '2410 South Lamar Blvd, Suite 120',
        addressLocality: 'Austin',
        addressRegion: 'TX',
        postalCode: '78704',
        addressCountry: 'US',
      },
      areaServed: ['South Austin', 'Zilker', 'Barton Hills', 'Travis Heights'],
      openingHours: ['Mo-Th 07:30-17:30', 'Fr 08:00-14:00'],
      sameAs: [
        'https://www.facebook.example/brightpathdental',
        'https://www.instagram.example/brightpathdental',
      ],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9', reviewCount: '286' },
    },
    { '@type': 'WebSite', '@id': `${SITE_ORIGIN}/#website`, url: `${SITE_ORIGIN}/`, name: 'BrightPath Dental' },
  ],
};

const SITE_CSS = `<style>
:root{--brand:#0e7c86;--brand-dark:#0a5a62;--accent:#f4a340}
body{font:16px/1.6 "Nunito",system-ui,sans-serif;margin:0;color:#1f2933;background:#fff}
header.site{background:var(--brand);color:#fff;padding:14px 32px;display:flex;align-items:center;gap:28px}
header.site a{color:#fff;text-decoration:none;font-weight:600}
header.site img.logo{height:40px;width:150px;background:#fff;border-radius:6px}
main{max-width:860px;margin:0 auto;padding:32px}
h1{font-size:36px;line-height:1.2;color:var(--brand-dark)}
h2{color:var(--brand-dark)}
.btn{display:inline-block;background:var(--accent);color:#1f2933;padding:12px 22px;border-radius:999px;font-weight:700;text-decoration:none}
.testimonial{border-left:4px solid var(--accent);margin:18px 0;padding:6px 18px;background:#fff8ee}
footer.site{background:#0a5a62;color:#e6f4f5;padding:24px 32px}
footer.site a{color:#e6f4f5;margin-right:16px}
</style>`;

function sitePage({ path, title, description, body, extraHead = '', jsonLd = true }) {
  return page({
    title,
    head: `${description ? `<meta name="description" content="${esc(description)}">\n` : ''}<link rel="canonical" href="${SITE_ORIGIN}${path}">
<meta name="theme-color" content="#0e7c86">
<meta property="og:site_name" content="BrightPath Dental">
<link rel="icon" href="/favicon.ico">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(SITE_JSON_LD)}</script>\n` : ''}${extraHead}${SITE_CSS}`,
    body: `<header class="site"><a href="/" class="brand"><img class="logo" src="/assets/brightpath-logo.png" alt="BrightPath Dental logo" width="150" height="40"></a>
<nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a> <a href="/services">Services</a> <a href="/pricing">Pricing</a> <a href="/locations">Locations</a> <a href="/blog/how-often-teeth-cleaning">Blog</a> <a href="/contact">Contact</a></nav>
<a class="btn" href="/contact">Book a visit</a></header>
<main>
${body}
</main>
<footer class="site"><p>BrightPath Dental · 2410 South Lamar Blvd, Suite 120, Austin, TX 78704 · <a href="tel:+15125550142">(512) 555-0142</a> · <a href="mailto:hello@brightpathdental.example">hello@brightpathdental.example</a></p>
<p><a href="https://www.facebook.example/brightpathdental">Facebook</a><a href="https://www.instagram.example/brightpathdental">Instagram</a><a href="/privacy">Privacy</a><a href="/careers">Careers</a></p></footer>`,
  });
}

export const SITE_PAGES = [
  {
    file: 'index.html',
    path: '/',
    html: () =>
      sitePage({
        path: '/',
        title: 'BrightPath Dental | Gentle Dentistry in South Austin',
        description: 'Gentle, unhurried dental care for South Austin families. Cleanings, whitening, crowns and emergency visits.',
        body: `<h1>Gentle dentistry for South Austin families</h1>
<p>We believe a dental visit should never feel rushed. At BrightPath Dental you get a full fifty minutes with your hygienist, clear prices before any work starts, and a team that remembers your name.</p>
<p><a class="btn" href="/contact">Book a visit</a></p>
<h2>What we do</h2>
<ul><li><a href="/services#cleanings">Cleanings and exams</a></li><li><a href="/services/teeth-whitening">Teeth whitening</a></li><li><a href="/services#crowns">Crowns and fillings</a></li><li><a href="/services#emergency">Emergency dentistry</a></li></ul>
<h2>What our patients say</h2>
<blockquote class="testimonial"><p>“I used to dread the dentist. The BrightPath team explained every step and I never felt rushed.”</p><cite>— Priya R., Zilker</cite></blockquote>
<blockquote class="testimonial"><p>“They saw my son the same day he chipped a tooth. Kind, fast and fairly priced.”</p><cite>— Marcus T., Travis Heights</cite></blockquote>
<p>Proudly serving South Austin, Zilker, Barton Hills and Travis Heights since 2014.</p>
<img src="/assets/office.jpg" width="640" height="360">`,
      }),
  },
  {
    file: 'about.html',
    path: '/about',
    html: () =>
      sitePage({
        path: '/about',
        title: 'About Us | BrightPath Dental',
        description: 'Meet Dr. Elena Vargas and the BrightPath Dental team in South Austin.',
        body: `<h1>About BrightPath Dental</h1>
<p>Dr. Elena Vargas opened BrightPath Dental in 2014 with a simple idea: give every patient enough time. We are a small, independent practice, not part of a chain.</p>
<p>Our team of two dentists and four hygienists lives in the neighborhoods we serve. We keep our schedule light on purpose, so appointments start on time and nobody is hurried out of the chair.</p>
<h2>Our promise</h2>
<p>You will always see the price before we begin. If we would not recommend a treatment to our own family, we will not recommend it to you.</p>`,
      }),
  },
  {
    file: 'services.html',
    path: '/services',
    html: () =>
      sitePage({
        path: '/services',
        title: 'Dental Services in Austin | BrightPath Dental',
        description: 'Cleanings, teeth whitening, crowns, fillings, Invisalign and emergency dentistry in South Austin.',
        body: `<h1>Dental services</h1>
<h2 id="cleanings">Cleanings and exams</h2><p>A fifty-minute visit with air-polishing, a full exam and X-rays once a year.</p>
<h2>Teeth whitening</h2><p>In-office whitening in a single visit, or custom take-home trays. <a href="/services/teeth-whitening">Learn about teeth whitening</a>.</p>
<h2 id="crowns">Crowns and fillings</h2><p>Tooth-coloured fillings and same-week porcelain crowns.</p>
<h2>Invisalign</h2><p>Clear aligners with a free first scan.</p>
<h2 id="emergency">Emergency dentistry</h2><p>Same-day appointments for toothaches, chipped teeth and lost fillings.</p>
<h2>Children's dentistry</h2><p>First visits from age one, with a patient, friendly team.</p>`,
      }),
  },
  {
    file: 'pricing.html',
    path: '/pricing',
    html: () =>
      sitePage({
        path: '/pricing',
        title: 'Pricing',
        description: '',
        body: `<h1>Pricing</h1>
<p>We publish our fees so there are no surprises.</p>
<table><tr><th>Service</th><th>Fee</th></tr><tr><td>New patient exam, cleaning and X-rays</td><td>$129</td></tr><tr><td>Routine cleaning</td><td>$95</td></tr><tr><td>In-office teeth whitening</td><td>$299</td></tr><tr><td>Emergency exam</td><td>$75</td></tr></table>
<p>No insurance? Our membership plan covers two cleanings a year for $24 a month.</p>`,
      }),
  },
  {
    file: 'locations.html',
    path: '/locations',
    html: () =>
      sitePage({
        path: '/locations',
        title: 'Locations | BrightPath Dental',
        description: 'Find BrightPath Dental on South Lamar in Austin, Texas.',
        body: `<h1>Our location</h1>
<h1>Visit us on South Lamar</h1>
<address>BrightPath Dental<br>2410 South Lamar Blvd, Suite 120<br>Austin, TX 78704</address>
<p>Free parking behind the building. We are five minutes from Zilker Park and serve patients from South Austin, Zilker, Barton Hills and Travis Heights.</p>
<p>Hours: Monday to Thursday 7:30 am to 5:30 pm, Friday 8 am to 2 pm.</p>`,
      }),
  },
  {
    file: 'contact.html',
    path: '/contact',
    html: () =>
      sitePage({
        path: '/contact',
        title: 'Contact BrightPath Dental | Book a Visit',
        description: 'Call (512) 555-0142 or email us to book a dental visit in South Austin.',
        body: `<h1>Contact us</h1>
<p>Call <a href="tel:+15125550142">(512) 555-0142</a> or email <a href="mailto:hello@brightpathdental.example">hello@brightpathdental.example</a>. For billing questions write to <a href="mailto:billing@brightpathdental.example">billing@brightpathdental.example</a>.</p>
<form action="/contact" method="post"><label>Name <input name="name"></label><label>Phone <input name="phone"></label><button type="submit">Request a call</button></form>`,
      }),
  },
];

/* ------------------------------------------------------------------ */
/* Wayback Machine captures (Rewind)                                   */
/* ------------------------------------------------------------------ */

const REWIND_URL = `${SITE_ORIGIN}/services/teeth-whitening`;

function words(n, seed) {
  const pool =
    'whitening treatment enamel shade stain coffee visit gel tray light safe dentist appointment results sensitivity smile brighter gentle lasting professional custom plan patient care comfort minutes session schedule consult cost touch-up habit rinse polish'.split(
      ' ',
    );
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[(i * 7 + seed * 13 + ((i * i) % 5)) % pool.length]);
  return out.join(' ');
}

function capture(v) {
  const jsonLd = v.jsonLd.map((type) => ({ '@context': 'https://schema.org', '@type': type, name: 'BrightPath Dental' }));
  return page({
    title: v.title,
    head: `<meta name="description" content="${esc(v.description)}">
<link rel="canonical" href="${esc(v.canonical)}">
${v.robots ? `<meta name="robots" content="${esc(v.robots)}">\n` : ''}${v.hreflang
      .map((h) => `<link rel="alternate" hreflang="${h}" href="${SITE_ORIGIN}/${h === 'en' ? '' : `${h}/`}services/teeth-whitening">`)
      .join('\n')}
${jsonLd.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}`,
    body: `<header><nav>${Array.from({ length: v.internalNav }, (_, i) => `<a href="/nav-${i}">Nav ${i}</a>`).join('')}</nav></header>
<main><article>
<h1>${esc(v.h1)}</h1>
<p>${words(Math.max(40, Math.round(v.words * 0.25)), 1)}.</p>
${v.h2
  .map(
    (h, i) =>
      `<h2>${esc(h)}</h2>\n${(v.h3[h] ?? []).map((s) => `<h3>${esc(s)}</h3>\n<p>${words(18, i + 5)}.</p>`).join('\n')}\n<p>${words(Math.round((v.words * 0.75) / v.h2.length) - (v.h3[h]?.length ?? 0) * 18, i + 2)}.</p>`,
  )
  .join('\n')}
<p>${Array.from({ length: v.external }, (_, i) => `<a href="https://partner${i}.example/ref">Partner ${i}</a>`).join(' ')}</p>
</article></main>
<footer><a href="/contact">Contact</a></footer>`,
  });
}

const V1 = {
  title: 'Teeth Whitening in Austin | BrightPath Dental',
  description: 'Professional teeth whitening in South Austin. Brighter teeth in a single visit.',
  canonical: REWIND_URL,
  robots: '',
  h1: 'Professional Teeth Whitening',
  h2: ['How it works', 'Pricing', 'FAQ'],
  h3: {},
  words: 620,
  internalNav: 6,
  external: 1,
  jsonLd: ['Dentist', 'FAQPage'],
  hreflang: [],
};

/** Each capture differs from the previous one in a way an SEO would care about. */
export const REWIND_VERSIONS = [
  { timestamp: '20230310101112', v: V1 },
  {
    timestamp: '20230902083000',
    v: { ...V1, description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h2: ['How it works', 'Before and after', 'Pricing', 'FAQ'], words: 740 },
  },
  {
    timestamp: '20240218141500',
    v: { ...V1, title: 'Teeth Whitening Austin TX – From $199 | BrightPath Dental', description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h2: ['How it works', 'Before and after', 'Pricing', 'FAQ'], words: 740, internalNav: 11 },
  },
  {
    timestamp: '20240805070000',
    v: { ...V1, title: 'Teeth Whitening Austin TX – From $199 | BrightPath Dental', description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h2: ['How it works', 'Before and after', 'Pricing'], words: 480, internalNav: 11, jsonLd: ['Dentist'] },
  },
  {
    timestamp: '20250120120000',
    v: { ...V1, title: 'Teeth Whitening Austin TX – From $199 | BrightPath Dental', description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h2: ['How it works', 'Before and after', 'Pricing'], words: 480, internalNav: 11, jsonLd: ['Dentist'], canonical: `${SITE_ORIGIN}/`, robots: 'noindex, follow' },
  },
  {
    timestamp: '20250315090000',
    v: { ...V1, title: 'Teeth Whitening Austin TX – From $199 | BrightPath Dental', description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h2: ['How it works', 'Before and after', 'Pricing'], words: 480, internalNav: 11, jsonLd: ['Dentist'], hreflang: ['en', 'es'] },
  },
  {
    timestamp: '20251102160000',
    v: { ...V1, title: 'Teeth Whitening Austin TX – From $199 | BrightPath Dental', description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h1: 'Teeth Whitening in South Austin', h2: ['How it works', 'Before and after', 'Pricing'], h3: { 'How it works': ['In-office whitening', 'Take-home trays'] }, words: 780, internalNav: 11, jsonLd: ['Dentist', 'Service'], hreflang: ['en', 'es'] },
  },
  {
    timestamp: '20260621110000',
    v: { ...V1, title: 'Teeth Whitening in South Austin | $299 In-Office | BrightPath Dental', description: 'In-office and take-home teeth whitening in South Austin, from a dentist who never rushes.', h1: 'Teeth Whitening in South Austin', h2: ['How it works', 'Before and after', 'Pricing'], h3: { 'How it works': ['In-office whitening', 'Take-home trays'] }, words: 780, internalNav: 11, external: 4, jsonLd: ['Dentist', 'Service'], hreflang: ['en', 'es'] },
  },
];

export function rewindCaptures() {
  return REWIND_VERSIONS.map(({ timestamp, v }) => ({ timestamp, html: capture(v) }));
}

const CDX_HEADER = ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];

function digest(i) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (let k = 0; k < 32; k++) out += alphabet[(i * 17 + k * 11 + ((i * k) % 7)) % alphabet.length];
  return out;
}

export function rewindCdx() {
  return [CDX_HEADER, ...REWIND_VERSIONS.map(({ timestamp }, i) => [timestamp, REWIND_URL, 'text/html', '200', digest(i), String(9000 + i * 311)])];
}

/** 60 distinct captures spread over five years: exercises sampling down to 24. */
export function largeCdx() {
  const rows = [CDX_HEADER];
  for (let i = 0; i < 60; i++) {
    const date = new Date(Date.UTC(2021, 0, 5 + i * 31, 6 + (i % 12), (i * 7) % 60, (i * 13) % 60));
    const ts = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    rows.push([ts, 'https://www.brightpathdental.example/', 'text/html', '200', digest(100 + i), String(15000 + i * 97)]);
  }
  return rows;
}

export { REWIND_URL, SITE_ORIGIN, page as htmlPage };
