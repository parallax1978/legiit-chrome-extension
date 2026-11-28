/** D. New or Noise: which sentences of a page say something the competing pages do not. */
import { SUMMARY_INSTRUCTIONS } from '@/ai/instructions';
import type { BrandMatcher } from '@/brands/matcher';
import { useEffect, useMemo, useState } from 'react';
import type { PageDigest } from '@/extract/digest';
import { parseHtml } from '@/extract/html';
import { extractMainContent } from '@/extract/main-content';
import { CLASS_LABELS, classifySentences, explainNoise, type ComparisonPage, type NoiseReport, type SentenceClass } from '@/features/new-or-noise/classify';
import { noiseCsv } from '@/features/new-or-noise/csv';
import { contentSentences, textSentences, type SentenceUnit } from '@/features/new-or-noise/sentences';
import { recordRun } from '@/features/shared/gating';
import { checkGuessed } from '@/features/shared/guessed-page';
import { loadPages } from '@/features/shared/load-pages';
import { contentEditorPayload } from '@/legiit/payloads';
import { cutText, safeHttpUrl, slugify, stripWww } from '@/lib/sanitize';
import { formatPercent, titlesAgree } from '@/lib/text';
import { urlKey } from '@/lib/url';
import type { HighlightGroup } from '@/model/messages';
import { HighlightReplySchema, PageSnapshotSchema, type AddressSource, type HighlightReply } from '@/model/schemas';
import { isNeverRequested } from '@/net/guarded-fetch';
import { fetchPage } from '@/net/page-fetch';
import { requestAccess } from '@/net/permissions';
import { findResultsPages, sendToTab } from '@/panel/tabs';
import { getEngine } from '@/similarity/embedding-client';
import { listKeywords, pageCache } from '@/storage/db';
import { useConnection, useSettings, useTarget, useTask } from '../hooks';
import { Button, Card, Chip, EmptyState, ExternalLink, Field, formatDate, Notice, ProgressBar, Stat } from '../kit';
import { AccessCard, CsvButton, KeepAccess, PermissionLine, SaveToLegiit, Summary } from '../shared';

/** What is checked: the page in the tab, its selected text, a page named by its address, or pasted text. */
type Mode = 'page' | 'selection' | 'address' | 'pasted';
const MODE_LABELS: Readonly<Record<Mode, string>> = { page: 'This page', selection: 'Selected text', address: 'A page by its address', pasted: 'Pasted text' };
const MAX_COMPARISON_PAGES = 8;

interface ResultSource {
  id: string;
  label: string;
  keyword: string;
  urls: string[];
  /** For a page whose address is a guess: the title of the result, which the page must have (see checkGuessed). */
  expect: Record<string, string>;
  /** The user's own result on that results page, when a brand of theirs has one: the page they most likely want to check. */
  mine: { url: string; title: string; position: number; guessed: boolean } | null;
}

type ResultRow = { position: number; domain: string; url: string; title: string; address?: AddressSource; guess?: string | null };

interface NoiseResult {
  report: NoiseReport;
  digests: PageDigest[];
  fallbackReason: string | null;
  keyword: string;
  pageUrl: string | null;
  pageTitle: string;
  mode: Mode;
  /** When the comparison was made. */
  at: number;
  /** Set when the page that was checked may not be the page the user meant (its address was a guess). */
  note: string | null;
}

const CLASS_ORDER: SentenceClass[] = ['only', 'some', 'most'];
const CLASS_COLOR: Readonly<Record<SentenceClass, string>> = { most: '#94a3b8', some: '#eab308', only: '#34d399' };

/** "Page title | Site" → "Page title": a sensible first guess at the target keyword. */
function keywordFromTitle(title: string): string {
  const first = (title.split(/\s[|–—·]\s|\s-\s/)[0] ?? title).replace(/[?!.]+$/, '').trim();
  return cutText(first, 120).trim();
}

/**
 * The pages of a results list that can be compared. A result whose address is known is one. When Google hides
 * where a result leads, the line under its title can spell an address out: that is a guess, and the page is used
 * only when it has the title of the result. A result with neither cannot be compared: the home page of its site is
 * another page, and Google's own link is never requested.
 */
function comparablePages(organic: readonly ResultRow[]): { urls: string[]; expect: Record<string, string> } {
  const urls: string[] = [];
  const expect: Record<string, string> = {};
  for (const o of organic) {
    const address = o.address ?? 'link';
    if (address === 'link') urls.push(o.url);
    else if (address === 'site' && o.guess) {
      urls.push(o.guess);
      expect[o.guess] = o.title;
    }
  }
  return { urls, expect };
}

/** The first result of one of the user's own sites that has a page address, known or spelled out under its title. */
function ownResult(organic: readonly ResultRow[], matcher: BrandMatcher): ResultSource['mine'] {
  for (const o of organic) {
    if (!o.domain || !matcher.matchDomain(o.domain).some((hit) => hit.owner === 'mine')) continue;
    const address = o.address ?? 'link';
    if (address === 'link') return { url: o.url, title: o.title, position: o.position, guessed: false };
    if (address === 'site' && o.guess) return { url: o.guess, title: o.title, position: o.position, guessed: true };
  }
  return null;
}

/** "8 results", or how many of them have a page address when Google hides some. */
function resultCount(organic: readonly ResultRow[]): string {
  const usable = comparablePages(organic).urls.length;
  return usable === organic.length ? `${organic.length} results` : `${usable} of ${organic.length} results have a page address`;
}

function parseUrlList(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split(/[\s,]+/)) {
    const url = safeHttpUrl(line.trim());
    if (url && !urls.some((u) => urlKey(u) === urlKey(url))) urls.push(url);
  }
  return urls;
}

export function NewOrNoiseTab() {
  const { access, intent } = useTarget();
  const { connection } = useConnection();
  const { matcher, settings } = useSettings();
  const [mode, setMode] = useState<Mode>('page');
  const [addressText, setAddressText] = useState('');
  const [addressTouched, setAddressTouched] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [keywordTouched, setKeywordTouched] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [sourceKind, setSourceKind] = useState<'results' | 'urls'>('results');
  const [sources, setSources] = useState<ResultSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [urlText, setUrlText] = useState('');
  const [denied, setDenied] = useState(false);
  const [filter, setFilter] = useState<SentenceClass | 'all'>('all');
  const [highlight, setHighlight] = useState<HighlightReply | null>(null);
  const [highlightError, setHighlightError] = useState<string | null>(null);
  const task = useTask<NoiseResult>();

  const ready = access.status === 'ready' ? access : null;
  const onPage = ready?.ping.agent === 'page';
  const tabId = ready?.tabId ?? null;
  const pageUrl = onPage ? ready.ping.url : null;
  const pageTitle = onPage ? ready.ping.title : '';

  // "Check the selected text" from the context menu lands here in selection mode.
  useEffect(() => {
    if (intent?.intent === 'selection') setMode('selection');
  }, [intent]);

  // A results page or an AI answer is not a page to check. There the tool checks a page named by its address, so
  // that it works from the results page itself. Back on an ordinary page, it checks that page again.
  const accessReady = access.status === 'ready';
  useEffect(() => {
    if (!accessReady) return;
    setMode((current) => (!onPage && (current === 'page' || current === 'selection') ? 'address' : onPage && current === 'address' && !addressTouched ? 'page' : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessReady, onPage]);

  useEffect(() => {
    if (!keywordTouched && pageTitle) setKeyword(keywordFromTitle(pageTitle));
  }, [pageTitle, keywordTouched]);

  // Result pages that can supply the comparison set: open Google tabs first, then saved snapshots.
  const loadSources = async () => {
    const [open, saved] = await Promise.all([findResultsPages(), listKeywords()]);
    const list: ResultSource[] = [
      ...open.map((p) => ({ id: `tab-${p.tabId}`, label: `“${p.serp.keyword}” — open results page, ${resultCount(p.serp.organic)}`, keyword: p.serp.keyword, ...comparablePages(p.serp.organic), mine: ownResult(p.serp.organic, matcher) })),
      ...saved
        .filter((k) => !open.some((p) => p.serp.keyword.toLowerCase() === k.keyword.toLowerCase()))
        .slice(0, 20)
        .map((k) => ({ id: `snap-${k.latest.id}`, label: `“${k.keyword}” — saved ${formatDate(k.latest.takenAt)}, ${resultCount(k.latest.organic)}`, keyword: k.keyword, ...comparablePages(k.latest.organic), mine: ownResult(k.latest.organic, matcher) })),
    ];
    setSources(list);
    setSourceId((current) => {
      if (list.some((s) => s.id === current)) return current;
      const match = list.find((s) => s.keyword.toLowerCase() === keyword.trim().toLowerCase());
      return (match ?? list[0])?.id ?? '';
    });
  };
  useEffect(() => {
    void loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, matcher]);

  const source = sourceKind === 'results' ? (sources.find((s) => s.id === sourceId) ?? null) : null;
  // Until the user types an address, the box holds their own result on the chosen results page, or else the home
  // page of their site: the tool is ready to run as it opens.
  const homeUrl = useMemo(() => {
    const domain = settings.myBrands.flatMap((brand) => brand.domains).find((d) => d.trim() !== '');
    return domain ? (safeHttpUrl(`https://${domain.trim()}/`) ?? '') : '';
  }, [settings]);
  const ownUrl = source?.mine?.url ?? homeUrl;
  useEffect(() => {
    if (!addressTouched) setAddressText(ownUrl);
  }, [ownUrl, addressTouched]);
  // Without a page in the tab to name the keyword, the chosen results page does.
  const sourceKeyword = source?.keyword ?? '';
  useEffect(() => {
    if (!keywordTouched && !pageTitle && sourceKeyword) setKeyword(sourceKeyword);
  }, [sourceKeyword, pageTitle, keywordTouched]);

  /** The page to check in "address" mode: a web address that is not a Google or AI page. null while there is none. */
  const typed = mode === 'address' ? safeHttpUrl(addressText.trim()) : null;
  const checkUrl = typed && !isNeverRequested(new URL(typed).hostname) ? typed : null;
  const checkedUrl = mode === 'address' ? checkUrl : pageUrl;

  const comparisonUrls = useMemo(() => {
    const all = sourceKind === 'urls' ? parseUrlList(urlText) : (sources.find((s) => s.id === sourceId)?.urls ?? []);
    let ownHost = '';
    try {
      ownHost = checkedUrl ? stripWww(new URL(checkedUrl).hostname) : '';
    } catch {
      ownHost = '';
    }
    // The page's own site is not a competitor.
    return all.filter((u) => !ownHost || stripWww(new URL(u).hostname) !== ownHost).slice(0, MAX_COMPARISON_PAGES);
  }, [sourceKind, urlText, sources, sourceId, checkedUrl]);
  /** Every page that will be requested: the comparison pages, and in "address" mode the page to check. */
  const requestedUrls = useMemo(() => (checkUrl ? [checkUrl, ...comparisonUrls] : comparisonUrls), [checkUrl, comparisonUrls]);

  const needsPage = mode === 'page' || mode === 'selection';
  const hasTarget = mode === 'pasted' ? pasteText.trim().length > 0 : mode === 'address' ? checkUrl !== null : onPage;
  const canRun = comparisonUrls.length > 0 && hasTarget && task.status !== 'running';

  const compare = async () => {
    setDenied(false);
    setHighlight(null);
    setHighlightError(null);
    // First thing in the click handler: this is where Chrome shows its permission prompt.
    if (!(await requestAccess(requestedUrls))) {
      setDenied(true);
      return;
    }
    void recordRun();
    await task.run(async ({ signal, progress }) => {
      let target: SentenceUnit[];
      let checked = { url: mode === 'pasted' ? null : pageUrl, title: mode === 'pasted' ? 'Pasted text' : pageTitle };
      let note: string | null = null;
      if (mode === 'pasted') {
        target = textSentences(pasteText);
      } else if (mode === 'address') {
        if (!checkUrl) throw new Error('Type the address of the page to check.');
        progress(0, 0, 'Reading the page to check');
        const [page] = await loadPages([checkUrl], { fetchPage, cache: pageCache }, { signal });
        if (!page?.ok) throw new Error(`The page to check could not be read: ${page?.error ?? 'no answer'}. Check its address, or paste its text instead.`);
        target = contentSentences({ blocks: page.blocks });
        checked = { url: checkUrl, title: page.title || checkUrl };
        // The address of the user's own result can be a guess from the line under its title. The user sees the
        // address and chose to check it, so the page is checked; when it is called something else, that is said.
        const own = source?.mine;
        if (own?.guessed && urlKey(own.url) === urlKey(checkUrl) && !titlesAgree(own.title, page.titles && page.titles.length > 0 ? page.titles : [page.title])) {
          note = `Google hides the address of your result. This address comes from the line under its title, and the page there is called “${cutText(page.title || checkUrl, 90)}”. If that is not the page you meant, type its address.`;
        }
      } else {
        if (tabId === null) throw new Error('The page is not reachable. Analyze it again.');
        progress(0, 0, 'Reading this page');
        const snapshot = await sendToTab(tabId, { type: 'lens:get-page' }, PageSnapshotSchema);
        if (mode === 'selection') {
          if (!snapshot.selection.trim()) throw new Error('Select some text on the page first, then compare again.');
          target = textSentences(snapshot.selection);
        } else {
          target = contentSentences(extractMainContent(parseHtml(snapshot.html)));
        }
      }
      if (target.length === 0) throw new Error('No sentences of five words or more were found to check.');

      const loaded = await loadPages(comparisonUrls, { fetchPage, cache: pageCache }, { signal, onProgress: (done, total) => progress(done, total, 'Reading comparison pages') });
      // A page loaded from a guessed address counts only when it is the page the result names.
      const expect = sourceKind === 'results' ? (sources.find((s) => s.id === sourceId)?.expect ?? {}) : {};
      const digests = loaded.map((d) => checkGuessed(d, expect[d.url]));
      const pages: ComparisonPage[] = digests.filter((d) => d.ok).map((d) => ({ url: d.url, title: d.title, sentences: contentSentences({ blocks: d.blocks }) }));
      if (pages.length === 0) throw new Error('None of the comparison pages could be read.');
      if (pages.every((p) => p.sentences.length === 0)) throw new Error('The comparison pages had no readable text to compare with.');

      progress(0, 0, 'Loading the on-device model');
      const { engine, fallbackReason } = await getEngine();
      const report = await classifySentences(target, pages, engine, { signal, onProgress: (done, total) => progress(done, total, 'Comparing sentences') });
      return { report, digests, fallbackReason, keyword: keyword.trim(), pageUrl: checked.url, pageTitle: checked.title, mode, at: Date.now(), note };
    });
  };

  const result = task.result;
  const explanation = result ? explainNoise(result.report) : [];

  const toggleHighlight = async () => {
    if (!result || tabId === null) return;
    setHighlightError(null);
    try {
      if (highlight) {
        await sendToTab(tabId, { type: 'lens:clear-highlight' }, HighlightReplySchema);
        setHighlight(null);
      } else {
        const groups: HighlightGroup[] = (['most', 'some', 'only'] as const).map((kind) => ({
          kind,
          sentences: result.report.sentences.filter((s) => s.cls === kind).map((s) => s.text),
        }));
        setHighlight(await sendToTab(tabId, { type: 'lens:highlight', groups }, HighlightReplySchema));
      }
    } catch (error) {
      setHighlightError(error instanceof Error ? error.message : 'Could not highlight the page');
    }
  };

  const shown = result ? result.report.sentences.filter((s) => filter === 'all' || s.cls === filter) : [];

  return (
    <>
      <Card title="What to check" testId="noise-form">
        <div className="row" role="radiogroup" aria-label="What to check">
          {/* Only what can work here is offered: on a results page there is no page in the tab to check. */}
          {(onPage || !accessReady ? (['page', 'selection', 'address', 'pasted'] as const) : (['address', 'pasted'] as const)).map((value) => (
            <label key={value} className="row small">
              <input type="radio" name="noise-mode" checked={mode === value} onChange={() => setMode(value)} data-testid={`noise-mode-${value}`} />
              {MODE_LABELS[value]}
            </label>
          ))}
        </div>
        {mode === 'address' && (
          <Field
            label="Address of the page to check"
            hint={
              source?.mine && checkUrl && urlKey(checkUrl) === urlKey(source.mine.url)
                ? `Your result #${source.mine.position} on the chosen results page. Type another address to check another page.`
                : homeUrl && checkUrl && urlKey(checkUrl) === urlKey(homeUrl)
                  ? 'The home page of your site. Type another address to check another page.'
                  : typed && !checkUrl
                    ? 'A Google or AI page cannot be checked. Type the address of one of your own pages.'
                    : 'One of your own pages. It is read by your browser and compared with the results below.'
            }
          >
            <input
              type="url"
              value={addressText}
              onChange={(e) => {
                setAddressText(e.target.value);
                setAddressTouched(true);
              }}
              placeholder="https://example.com/your-page"
              data-testid="noise-address"
            />
          </Field>
        )}
        {needsPage &&
          (onPage ? (
            <div className="small break">
              <strong>{pageTitle || pageUrl}</strong>
              <div className="muted">{pageUrl}</div>
              {pageUrl && <KeepAccess url={pageUrl} />}
            </div>
          ) : access.status === 'ready' ? (
            <Notice testId="noise-wrong-page">Open the page you want to check in this tab. Google results and AI answer pages are sources, not pages to check.</Notice>
          ) : null)}
        {mode === 'pasted' && <textarea rows={5} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="Paste the text you want to check." aria-label="Text to check" data-testid="noise-paste" />}
        <Field label="Target keyword" hint="Used to pick the matching results page and to label exports.">
          <input
            type="text"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setKeywordTouched(true);
            }}
            data-testid="noise-keyword"
          />
        </Field>
      </Card>

      {needsPage && access.status === 'no-access' && <AccessCard />}

      <Card title="Compare against" testId="noise-compare">
        <div className="row" role="radiogroup" aria-label="Comparison set">
          <label className="row small">
            <input type="radio" name="noise-source" checked={sourceKind === 'results'} onChange={() => setSourceKind('results')} />
            Use these results
          </label>
          <label className="row small">
            <input type="radio" name="noise-source" checked={sourceKind === 'urls'} onChange={() => setSourceKind('urls')} data-testid="noise-source-urls" />
            Pasted URLs
          </label>
        </div>
        {sourceKind === 'results' ? (
          sources.length === 0 ? (
            <Notice testId="noise-no-results">
              Open a Google results page for your keyword in another tab, then{' '}
              <Button variant="link" onClick={() => void loadSources()}>
                look again
              </Button>
              . Or paste URLs instead.
            </Notice>
          ) : (
            <div className="row">
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Results page" data-testid="noise-results-select">
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button small onClick={() => void loadSources()}>
                Refresh
              </Button>
            </div>
          )
        ) : (
          <textarea rows={4} value={urlText} onChange={(e) => setUrlText(e.target.value)} placeholder={'https://example.com/a-competing-page\nhttps://example.org/another'} aria-label="Comparison URLs" data-testid="noise-urls" />
        )}
        {comparisonUrls.length > 0 && (
          <details>
            <summary className="small">{comparisonUrls.length} page{comparisonUrls.length === 1 ? '' : 's'} will be read</summary>
            <ul className="small break">
              {comparisonUrls.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </details>
        )}
        <PermissionLine urls={requestedUrls} purpose={checkUrl ? 'to compare your page with them' : 'to compare them with your page'} />
        <div className="row">
          <Button variant="primary" disabled={!canRun} onClick={() => void compare()} data-testid="noise-run">
            Compare
          </Button>
          {task.status === 'running' && (
            <Button small onClick={task.cancel}>
              Cancel
            </Button>
          )}
        </div>
        {denied && (
          <Notice tone="warn" testId="noise-denied">
            Permission was not granted, so nothing was fetched.
          </Notice>
        )}
        {task.status === 'running' && task.progress && <ProgressBar done={task.progress.done} total={task.progress.total} label={task.progress.label} />}
        {task.status === 'error' && (
          <Notice tone="error" testId="noise-error">
            {task.error}
          </Notice>
        )}
      </Card>

      {result && (
        <>
          {result.fallbackReason && (
            <Notice tone="warn" testId="noise-fallback">
              The on-device model could not be loaded ({result.fallbackReason}). Sentences were compared by shared words instead, which misses paraphrases.
            </Notice>
          )}
          <Card title="Result" testId="noise-result">
            {result.pageUrl && (
              <div className="small break" data-testid="noise-checked">
                Checked: <ExternalLink href={result.pageUrl}>{result.pageTitle || result.pageUrl}</ExternalLink>
              </div>
            )}
            {result.note && (
              <Notice tone="warn" testId="noise-guess-note">
                {result.note}
              </Notice>
            )}
            <div className="grid2">
              <Stat label="Words that are only here" value={formatPercent(result.report.share.only)} sub={`${result.report.words.only} of ${result.report.totalWords} words`} testId="noise-only-share" />
              <Stat label="Compared with" value={`${result.report.pagesCompared} page${result.report.pagesCompared === 1 ? '' : 's'}`} sub={`“most” = ${result.report.mostNeeds} or more`} />
            </div>
            <div className="bar" aria-hidden="true">
              {CLASS_ORDER.map((cls) => (
                <span key={cls} style={{ width: `${result.report.share[cls] * 100}%`, background: CLASS_COLOR[cls] }} />
              ))}
            </div>
            <div className="legend">
              {CLASS_ORDER.map((cls) => (
                <span key={cls}>
                  <i style={{ background: CLASS_COLOR[cls] }} />
                  {CLASS_LABELS[cls]} <strong>{formatPercent(result.report.share[cls])}</strong>
                </span>
              ))}
            </div>
            <p className="small muted" data-testid="noise-method">
              Method: {result.report.engineLabel}. A competing page “says” a sentence when its closest sentence scores {result.report.threshold} or higher (cosine similarity). Said by most: more than half of the pages. Said by some: at least one. Only here: none.
            </p>
            <div className="row">
              {/* Highlights go on the page in the tab: there is none for a page that was read by its address. */}
              {(result.mode === 'page' || result.mode === 'selection') && (
                <Button small onClick={() => void toggleHighlight()} data-testid="noise-highlight">
                  {highlight ? 'Remove highlights' : 'Highlight on the page'}
                </Button>
              )}
              <CsvButton filename={`new-or-noise-${slugify(result.keyword || result.pageTitle)}.csv`} build={() => noiseCsv(result.report, result.keyword, result.pageUrl)} testId="noise-export" />
              {connection.client && (
                <SaveToLegiit
                  method="sendToContentEditor"
                  label="Send to content editor"
                  subject={String(result.at)}
                  payload={() => contentEditorPayload({ targetKeyword: result.keyword, source: result.mode === 'address' ? 'page' : result.mode, pageUrl: result.pageUrl, pageTitle: result.mode === 'pasted' ? '' : result.pageTitle, capturedAt: result.at, report: result.report })}
                  send={(payload, businessId, options) => connection.client!.sendToContentEditor(businessId, payload, options)}
                />
              )}
            </div>
            {highlight && (
              <p className="small muted" data-testid="noise-highlight-status">
                Highlighted {highlight.applied} sentence{highlight.applied === 1 ? '' : 's'} on the page
                {highlight.missed > 0 ? ` (${highlight.missed} could not be located)` : ''} using {highlight.method === 'css-highlight' ? 'the CSS Custom Highlight API, which does not change the page’s structure' : 'an overlay'}.
              </p>
            )}
            {highlightError && <Notice tone="error">{highlightError}</Notice>}
          </Card>

          <Summary request={{ task: 'new-or-noise', instruction: SUMMARY_INSTRUCTIONS['new-or-noise'], facts: explanation, fallback: explanation }} testId="noise-summary" />

          <Card title={`Covered by most competitors, missing here (${result.report.missing.length})`} testId="noise-missing">
            {result.report.missing.length === 0 ? (
              <p className="muted">This page covers every point that most of the competing pages make.</p>
            ) : (
              result.report.missing.map((m) => (
                <div className="item" key={m.text}>
                  <div>{m.text}</div>
                  <div className="small muted">
                    On {m.pages} of {result.report.pagesCompared} pages · <ExternalLink href={m.urls[0]}>example</ExternalLink>
                  </div>
                </div>
              ))
            )}
          </Card>

          <Card
            title={`Sentences (${result.report.sentences.length})`}
            testId="noise-sentences"
            actions={
              <select value={filter} onChange={(e) => setFilter(e.target.value as SentenceClass | 'all')} aria-label="Filter sentences" data-testid="noise-filter">
                <option value="all">All</option>
                {CLASS_ORDER.map((cls) => (
                  <option key={cls} value={cls}>
                    {CLASS_LABELS[cls]}
                  </option>
                ))}
              </select>
            }
          >
            <div>
              {shown.map((s, i) => (
                <div className={`sentence cls-${s.cls}`} key={`${i}-${s.text.slice(0, 24)}`} data-testid={`sentence-${s.cls}`}>
                  {s.text}
                  <div className="small muted">
                    {CLASS_LABELS[s.cls]}
                    {s.pages > 0 ? ` · ${s.pages} of ${result.report.pagesCompared} pages` : ''} · closest match {formatPercent(Math.max(0, s.bestScore))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Comparison pages" testId="noise-pages">
            {result.digests.map((d) => (
              <div className="item small" key={d.url}>
                <div className="row between">
                  <ExternalLink href={d.url} className="break">
                    {d.title || d.url}
                  </ExternalLink>
                  {d.ok ? <Chip tone="ok">Read</Chip> : <Chip tone="warn">{d.error ?? 'Failed'}</Chip>}
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      {!result && task.status === 'idle' && mode === 'pasted' && pasteText.trim() === '' && (
        <Card>
          <EmptyState title="Paste text to check">Paste a draft or a section of a page, choose the results to compare against, then compare.</EmptyState>
        </Card>
      )}
    </>
  );
}
