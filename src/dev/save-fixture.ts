/**
 * DEVELOPMENT ONLY. Saves the current page as a test fixture.
 *
 * Every call site is guarded by `import.meta.env.DEV`, so production builds
 * contain neither this module nor the command that triggers it (checked by
 * the e2e suite). The fixture is a copy of the page with scripts removed and
 * every element stamped with its rectangle (data-lens-rect="x,y,w,h"), the
 * same format scripts/build-fixtures.mjs produces, so unit tests can replay
 * the real layout.
 */
export const DEV_FIXTURE_MARKER = 'lens-dev-save-fixture';

function stamp(live: Element, copy: Element): void {
  const rect = live.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    copy.setAttribute(
      'data-lens-rect',
      [rect.left + window.scrollX, rect.top + window.scrollY, rect.width, rect.height].map((n) => Math.round(n)).join(','),
    );
  }
  const liveChildren = live.children;
  const copyChildren = copy.children;
  for (let i = 0; i < liveChildren.length && i < copyChildren.length; i++) stamp(liveChildren[i]!, copyChildren[i]!);
}

export function saveFixture(): { ok: true; file: string; bytes: number } {
  const copy = document.documentElement.cloneNode(true) as Element;
  const liveBody = document.body;
  const copyBody = copy.querySelector('body');
  if (liveBody && copyBody) stamp(liveBody, copyBody);
  // Scripts and inline handlers are removed so the fixture is inert; our own strip is removed too.
  for (const el of copy.querySelectorAll('script, noscript, iframe, link[rel="preload"], link[rel="modulepreload"], [data-legiit-lens-strip]')) el.remove();
  for (const el of copy.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  }
  copy.setAttribute('data-lens-viewport', `${window.innerWidth}x${window.innerHeight}`);
  copy.setAttribute('data-lens-doc-height', String(Math.round(document.documentElement.scrollHeight)));
  copy.setAttribute('data-lens-source', location.href);
  copy.setAttribute('data-lens-saved', new Date().toISOString());
  const html = `<!doctype html>\n<!-- ${DEV_FIXTURE_MARKER}: saved from ${location.href.replace(/--/g, '- -')} -->\n${copy.outerHTML}\n`;
  const file = `${location.hostname.replace(/[^a-z0-9.-]/gi, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { ok: true, file, bytes: html.length };
}
