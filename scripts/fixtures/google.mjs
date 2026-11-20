/**
 * Synthetic Google results pages.
 *
 * The markup imitates the structure of real desktop results (ids such as
 * #rso / #center_col / #tads, the "a > h3" organic title pattern, data-text-ad,
 * data-initq, …) so the selector pack is exercised the way it is on live
 * pages. The content is invented. These are NOT captures of google.com; use
 * the dev-only "save this page as fixture" command to add real ones.
 */

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LAYOUT_CSS = `
  html,body{margin:0;padding:0}
  body{font:14px/1.58 arial,sans-serif;color:#202124;background:#fff}
  a{color:#1a0dab;text-decoration:none}
  h1.bNg8Rb,h2.bNg8Rb{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);margin:0}
  #searchform{height:132px;box-sizing:border-box;border-bottom:1px solid #ebebeb;padding:26px 0 0 180px}
  #searchform textarea{width:560px;height:44px;border:1px solid #dfe1e5;border-radius:24px;padding:10px 20px;box-sizing:border-box;font:16px arial;resize:none}
  #hdtb{margin-top:14px;font-size:13px;color:#5f6368;height:36px}
  #hdtb span{margin-right:22px}
  #cnt{padding-top:20px}
  #rcnt{display:flex;margin-left:180px;width:1100px}
  #center_col{width:652px;flex:none}
  #rhs{width:369px;margin-left:76px;flex:none}
  #rso > div, #taw, #botstuff > div, #bottomads{margin-bottom:28px}
  .g{margin:0}
  .yuRUbf a{display:block}
  .yuRUbf cite, .x2VHCd{font-style:normal;font-size:12px;color:#4d5156;display:block;line-height:18px}
  .VuuXrf{font-size:14px;color:#202124;display:block;line-height:20px}
  h3.LC20lb{font-size:20px;line-height:26px;font-weight:400;margin:4px 0 3px}
  .VwiC3b{line-height:22px;color:#4d5156;max-width:600px}
  .YzCcne{background:#f7f8fd;border-radius:16px;padding:20px 20px 16px}
  .Fzsovc{font-size:16px;font-weight:500;margin-bottom:12px}
  .LT6XE{font-size:16px;line-height:24px}
  .LT6XE ul{margin:10px 0;padding-left:22px}
  .zVKf0d{list-style:none;display:flex;gap:10px;padding:0;margin:14px 0 8px}
  .zVKf0d li{flex:1;border:1px solid #dadce0;border-radius:12px;padding:10px;height:76px;overflow:hidden;font-size:12px;background:#fff}
  .mNme1d{font-size:13px;color:#1a0dab;line-height:17px;margin-bottom:4px}
  .in7vHe{height:36px;line-height:36px;text-align:center;border:1px solid #dadce0;border-radius:18px;margin-top:8px}
  .aio-note{font-size:12px;color:#70757a;margin-top:10px}
  #tads, #tadsb{padding:0}
  .uEierd{margin-bottom:22px}
  .CCgQ5{font-size:20px;line-height:26px;color:#1a0dab;margin:2px 0}
  .U3A9Ac{font-weight:700;font-size:13px;color:#202124;margin-right:8px}
  .Va3FIb{line-height:22px;color:#4d5156}
  #Odp5De{border:1px solid #dadce0;border-radius:12px;overflow:hidden}
  .YzSd{font-size:20px;padding:14px 16px 10px}
  .lu-map{height:180px;background:#e8eaed}
  .VkpGBb{display:flex;justify-content:space-between;padding:12px 16px;border-top:1px solid #ebebeb;min-height:66px}
  .OSrXXb{font-size:16px;color:#202124}
  .rllt__details div{line-height:20px}
  g-more-link{display:block;padding:12px 16px;border-top:1px solid #ebebeb;text-align:center}
  .cUnQKe [role=heading], .uVMCKf > [role=heading], .s6JM6d > [role=heading], .img-pack > [role=heading]{font-size:20px;line-height:28px;margin-bottom:10px}
  .related-question-pair{border-top:1px solid #dadce0;height:48px;line-height:48px;font-size:16px}
  .vid-row{display:flex;gap:14px}
  video-voyager{display:block;width:208px}
  .vid-thumb{height:117px;background:#dadce0;border-radius:8px;margin-bottom:6px}
  video-voyager [role=heading]{font-size:14px;line-height:20px;color:#1a0dab;height:40px;overflow:hidden}
  .s6JM6d a{display:block;border-top:1px solid #ebebeb;padding:10px 0;min-height:44px}
  .s6JM6d [role=heading]{font-size:16px;line-height:22px}
  #iur{display:flex;gap:8px}
  #iur a{display:block;width:120px;height:90px;background:#dadce0;border-radius:8px}
  .ifM9O{border:1px solid #dadce0;border-radius:8px;padding:18px 20px}
  .hgKElc{font-size:16px;line-height:24px}
  .ifM9O .g{margin-top:14px}
  .kp-wholepage{border:1px solid #dadce0;border-radius:8px;padding:16px;min-height:360px}
  .kp-wholepage [data-attrid=title]{font-size:28px;line-height:36px}
  .commercial-unit-desktop-top{border:1px solid #dadce0;border-radius:8px;padding:12px;height:230px}
  .pla-row{display:flex;gap:10px;margin-top:8px}
  .pla-unit{width:140px;height:170px;border:1px solid #ebebeb;border-radius:8px;padding:6px;box-sizing:border-box;font-size:12px}
  #bres{font-size:14px}
  #footcnt{margin-top:40px;background:#f2f2f2;border-top:1px solid #dadce0;padding:14px 0 14px 180px;font-size:14px;color:#70757a;height:92px;box-sizing:border-box}
  #infoDiv{margin:80px 180px;font-size:16px;max-width:560px}
`;

/** One organic result. */
export function organic({ url, title, site, crumb, snippet }) {
  return `<div class="MjjYud"><div class="g Ww4FFb vt6azd" data-hveid="CAU${Math.abs(hash(url)) % 9000}QAA" lang="en"><div class="tF2Cxc"><div class="yuRUbf"><div><span><a href="${esc(url)}" data-ved="2ahUKE${Math.abs(hash(url)) % 99999}" ping="/url?sa=t&amp;source=web&amp;url=${encodeURIComponent(url)}"><br><div class="notranslate"><span class="VuuXrf">${esc(site)}</span><cite class="qLRx3b tjvcx" role="text">${esc(crumb)}</cite></div><h3 class="LC20lb MBeuO DKV0Md">${esc(title)}</h3></a></span></div></div><div class="VwiC3b yXK7lf p4wth r025kc" style="-webkit-line-clamp:2"><span>${esc(snippet)}</span></div></div></div></div>`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function adUnit({ title, landing, domain, description }) {
  const click = `https://www.googleadservices.com/pagead/aclk?sa=L&ai=DChcSEwi${Math.abs(hash(landing))}&adurl=${encodeURIComponent(`${landing}?gclid=EAIaIQobChMI-fixture`)}`;
  return `<div class="uEierd" data-text-ad="1"><div class="vdQmEd fP1Qef"><div class="v5yQqb"><a class="sVXRqc" href="${esc(click)}" data-rw="${esc(click)}" data-pcu="${esc(landing)}" data-dtld="${esc(domain)}"><div class="d8lRkd"><span class="U3A9Ac qV8iec">Sponsored</span><span class="x2VHCd OSrXXb ob9lvb" role="text">${esc(landing)}</span></div><div class="CCgQ5 vCa9Yd QfkTvb N8QANc Va3FIb" role="heading" aria-level="3"><span>${esc(title)}</span></div></a></div></div><div class="Va3FIb r025kc lVm3ye">${esc(description)}</div></div>`;
}

export function adsBlock(id, units) {
  const inner = `<div id="${id}" aria-label="Ads" role="region"><h1 class="bNg8Rb">Ads</h1>${units.map(adUnit).join('')}</div>`;
  return id === 'tads' ? `<div id="taw"><div id="tvcap">${inner}</div></div>` : `<div id="bottomads">${inner}</div>`;
}

export function aiOverview({ paragraphs, bullets, sources }) {
  return `<div class="MjjYud"><div class="YzCcne" data-attrid="AIOverview" jscontroller="fixture"><div class="nk9vdc"><div class="Fzsovc" role="heading" aria-level="2">AI Overview</div></div><div class="LT6XE">${paragraphs
    .map((p) => `<div class="WaaZC"><span>${p}</span></div>`)
    .join('')}<ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul></div><ul class="zVKf0d">${sources
    .map(
      (s) =>
        `<li><a href="${esc(s.url)}#:~:text=${encodeURIComponent(s.title.slice(0, 12))}"><div class="mNme1d">${esc(s.title)}</div><div>${esc(s.site)}</div></a></li>`,
    )
    .join('')}</ul><div class="in7vHe" role="button" aria-expanded="false">Show more</div><div class="aio-note">Generative AI is experimental. <a href="https://support.google.com/websearch?p=ai_overviews">Learn more</a></div></div></div>`;
}

export function localPack(places) {
  return `<div class="MjjYud"><div id="Odp5De" class="M8OgIe"><div class="e4xoPb"><div class="YzSd" role="heading" aria-level="2">Places</div></div><div class="lu-map" aria-label="Map"></div><div class="rlfl__tls rl_tls">${places
    .map(
      (p, i) =>
        `<div class="VkpGBb"><div class="cXedhc"><a class="vwVdIc" role="link" tabindex="0" data-cid="${7000 + i}"><div class="rllt__details"><div class="dbg0pd" role="heading" aria-level="3"><span class="OSrXXb">${esc(p.name)}</span></div><div>${esc(p.rating)} · Dentist</div><div>${esc(p.address)} · ${esc(p.phone)}</div></div></a></div><div class="acts"><a class="yYlJEf Q7PwXb L48Cpd" href="${esc(p.website)}">Website</a> <a href="/maps/dir//${encodeURIComponent(p.name)}">Directions</a></div></div>`,
    )
    .join('')}</div><g-more-link><a href="/search?q=dentists&amp;udm=1">More places</a></g-more-link></div></div>`;
}

export function peopleAlsoAsk(keyword, questions) {
  return `<div class="MjjYud"><div class="cUnQKe" data-initq="${esc(keyword)}" data-hveid="CDQQAQ"><div class="Wt5Tfe"><div role="heading" aria-level="2"><span class="mgAbYb">People also ask</span></div>${questions
    .map(
      (q) =>
        `<div class="related-question-pair" data-q="${esc(q)}"><div role="button" aria-expanded="false" tabindex="0"><span>${esc(q)}</span></div></div>`,
    )
    .join('')}</div></div></div>`;
}

export function videoBlock(videos) {
  return `<div class="MjjYud"><div class="uVMCKf"><div role="heading" aria-level="2"><span>Videos</span></div><div class="vid-row">${videos
    .map(
      (v) =>
        `<video-voyager><div><a href="${esc(v.url)}" aria-label="${esc(`${v.title} by ${v.channel} on YouTube`)}"><div class="vid-thumb"></div><div role="heading" aria-level="3">${esc(v.title)}</div><span>YouTube · ${esc(v.channel)}</span></a></div></video-voyager>`,
    )
    .join('')}</div></div></div>`;
}

export function forumBlock(threads) {
  // Deliberately no stable id or data attribute: found through its heading text.
  return `<div class="MjjYud"><div class="s6JM6d"><div role="heading" aria-level="2"><span>Discussions and forums</span></div>${threads
    .map(
      (t) =>
        `<a href="${esc(t.url)}"><div role="heading" aria-level="3">${esc(t.title)}</div><span>${esc(t.meta)}</span></a>`,
    )
    .join('')}</div></div>`;
}

export function imageBlock(urls) {
  return `<div class="MjjYud"><div class="img-pack"><div role="heading" aria-level="2">Images</div><div id="iur">${urls
    .map((u) => `<a href="${esc(u)}" aria-label=""></a>`)
    .join('')}</div></div></div>`;
}

export function featuredSnippet({ answer, url, title, site, crumb }) {
  return `<div class="MjjYud"><block-component><div class="ifM9O"><div class="xpdopen"><h2 class="bNg8Rb">Featured snippet from the web</h2><div class="IZ6rdc" data-attrid="wa:/description"><span class="hgKElc">${answer}</span></div><div class="g"><div class="yuRUbf"><a href="${esc(url)}#:~:text=featured"><div class="notranslate"><span class="VuuXrf">${esc(site)}</span><cite>${esc(crumb)}</cite></div><h3 class="LC20lb">${esc(title)}</h3></a></div></div></div></div></block-component></div>`;
}

export function shoppingBlock(products) {
  return `<div class="commercial-unit-desktop-top"><div role="heading" aria-level="2">Sponsored products</div><div class="pla-row">${products
    .map(
      (p) =>
        `<div class="pla-unit" data-pla="1"><a href="https://www.googleadservices.com/pagead/aclk?sa=L&amp;adurl=${encodeURIComponent(p.url)}" data-dtld="${esc(p.domain)}">${esc(p.title)}</a><div>${esc(p.price)}</div><div>${esc(p.domain)}</div></div>`,
    )
    .join('')}</div></div>`;
}

export function knowledgePanel({ title, description, sourceUrl }) {
  return `<div class="kp-wholepage"><div data-attrid="title" role="heading" aria-level="2">${esc(title)}</div><div data-attrid="description"><span>${esc(description)}</span> <a href="${esc(sourceUrl)}">Wikipedia</a></div></div>`;
}

/** Assembles a full results page. */
export function serpPage({ keyword, top = '', results = [], bottom = '', bottomAds = '', rhs = '', location = 'Austin, Texas' }) {
  return `<!doctype html>
<html lang="en" itemscope itemtype="http://schema.org/SearchResultsPage">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(keyword)} - Google Search</title>
<style>${LAYOUT_CSS}</style>
</head>
<body id="gsr">
<div id="searchform"><form action="/search" role="search"><textarea name="q" class="gLFyf" rows="1" aria-label="Search">${esc(keyword)}</textarea></form><div id="hdtb" role="navigation"><span>All</span><span>Images</span><span>Videos</span><span>News</span><span>Maps</span></div></div>
<div id="main"><div id="cnt"><div id="rcnt">
<div id="center_col">
${top}
<div id="res" role="main"><div id="search"><div data-hveid="CAEQAA"><h1 class="bNg8Rb">Search Results</h1>
<div id="rso">
${results.join('\n')}
</div></div></div></div>
<div id="botstuff">${bottom}<div id="bres"><div role="heading" aria-level="2">People also search for</div><a href="/search?q=related+one">related search one</a> · <a href="/search?q=related+two">related search two</a></div></div>
${bottomAds}
</div>
<div id="rhs">${rhs}</div>
</div></div></div>
<div id="footcnt"><div id="fbar"><div class="fbar b2hzT"><span class="Q8LRLc">United States</span></div><div class="fbar"><div id="swml"><span id="Wprf1b">${esc(location)}</span> - <span>From your IP address</span> - <a href="/setprefs?hl=en">Update location</a></div></div></div></div>
</body>
</html>
`;
}

/**
 * "Class churn" transform: what a results page looks like after Google
 * renames every class and drops the data attributes and block ids the pack
 * prefers. Only the long-lived layout ids and visible heading text survive,
 * so parsing must succeed through the fallback candidates.
 */
export function churn(html) {
  const keepIds = new Set(['gsr', 'main', 'cnt', 'rcnt', 'center_col', 'res', 'search', 'rso', 'botstuff', 'rhs', 'footcnt', 'searchform']);
  let n = 0;
  const renamed = new Map();
  const rename = (cls) => {
    if (!renamed.has(cls)) renamed.set(cls, `zz${(n++).toString(36)}Q`);
    return renamed.get(cls);
  };
  let out = html;
  // Rename classes in the stylesheet and in markup consistently so the layout is unchanged.
  out = out.replace(/class="([^"]*)"/g, (_m, classes) => `class="${classes.split(/\s+/).filter(Boolean).map(rename).join(' ')}"`);
  out = out.replace(/<style>([\s\S]*?)<\/style>/, (_m, css) => {
    let styled = css;
    for (const [from, to] of renamed) styled = styled.replace(new RegExp(`\\.${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), `.${to}`);
    return `<style>${styled}</style>`;
  });
  // Drop block-level ids (keep the structural ones) and re-point their CSS at a data-free hook.
  out = out.replace(/ id="([^"]+)"/g, (m, id) => (keepIds.has(id) ? m : ` data-was="${rename(`id-${id}`)}"`));
  out = out.replace(/<style>([\s\S]*?)<\/style>/, (_m, css) => {
    let styled = css;
    for (const [from, to] of renamed) {
      if (from.startsWith('id-')) styled = styled.replace(new RegExp(`#${from.slice(3)}(?![\\w-])`, 'g'), `[data-was="${to}"]`);
    }
    return `<style>${styled}</style>`;
  });
  // Remove the data attributes the primary selectors rely on.
  out = out.replace(/ data-(text-ad|attrid|initq|q|cid|pcu|rw|dtld|hveid|ved|pla)="[^"]*"/g, '');
  // Custom elements become plain divs (with a neutral hook so the fixture keeps its layout).
  const custom = { 'video-voyager': 'vv', 'block-component': 'bc', 'g-more-link': 'gml' };
  for (const [tag, hook] of Object.entries(custom)) {
    out = out.replace(new RegExp(`<${tag}\\b`, 'g'), `<div data-x="${hook}"`);
    out = out.replace(new RegExp(`</${tag}>`, 'g'), '</div>');
    out = out.replace(/<style>([\s\S]*?)<\/style>/, (_m, css) =>
      `<style>${css.replace(new RegExp(`(^|[\\s,}])${tag}(?=[\\s{,[])`, 'g'), `$1[data-x="${hook}"]`)}</style>`,
    );
  }
  return out;
}
