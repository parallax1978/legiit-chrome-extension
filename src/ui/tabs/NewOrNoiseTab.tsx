/** D. New or Noise: which sentences of a page say something the competing pages do not. */
import { useEffect, useMemo, useState } from 'react';
import type { PageDigest } from '@/extract/digest';
import { parseHtml } from '@/extract/html';
import { extractMainContent } from '@/extract/main-content';
import { CLASS_LABELS, classifySentences, explainNoise, type ComparisonPage, type NoiseReport, type SentenceClass } from '@/features/new-or-noise/classify';
import { noiseCsv } from '@/features/new-or-noise/csv';
import { contentSentences, textSentences, type SentenceUnit } from '@/features/new-or-noise/sentences';
import { recordRun } from '@/features/shared/gating';
import { loadPages } from '@/features/shared/load-pages';
import { contentEditorPayload } from '@/legiit/payloads';
import { cutText, safeHttpUrl, slugify, stripWww } from '@/lib/sanitize';
import { formatPercent } from '@/lib/text';
import { urlKey } from '@/lib/url';
import type { HighlightGroup } from '@/model/messages';
import { HighlightReplySchema, PageSnapshotSchema, type HighlightReply } from '@/model/schemas';
import { fetchPage } from '@/net/page-fetch';
import { requestAccess } from '@/net/permissions';
import { findResultsPages, sendToTab } from '@/panel/tabs';
import { getEngine } from '@/similarity/embedding-client';
import { listKeywords, pageCache } from '@/storage/db';
import { useConnection, useTarget, useTask } from '../hooks';
import { Button, Card, Chip, EmptyState, ExternalLink, Field, formatDate, Notice, ProgressBar, Stat } from '../kit';
import { AccessCard, CsvButton, KeepAccess, PermissionLine, SaveToLegiit, Summary } from '../shared';

type Mode = 'page' | 'selection' | 'pasted';
const MAX_COMPARISON_PAGES = 8;

interface ResultSource {
  id: string;
  label: string;
  keyword: string;
  urls: string[];
}

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
}

const CLASS_ORDER: SentenceClass[] = ['only', 'some', 'most'];
const CLASS_COLOR: Readonly<Record<SentenceClass, string>> = { most: '#94a3b8', some: '#eab308', only: '#34d399' };

/** "Page title | Site" → "Page title": a sensible first guess at the target keyword. */
function keywordFromTitle(title: string): string {
  const first = (title.split(/\s[|–—·]\s|\s-\s/)[0] ?? title).replace(/[?!.]+$/, '').trim();
  return cutText(first, 120).trim();
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
  const [mode, setMode] = useState<Mode>('page');
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

  useEffect(() => {
    if (!keywordTouched && pageTitle) setKeyword(keywordFromTitle(pageTitle));
  }, [pageTitle, keywordTouched]);

  // Result pages that can supply the comparison set: open Google tabs first, then saved snapshots.
  const loadSources = async () => {
    const [open, saved] = await Promise.all([findResultsPages(), listKeywords()]);
    const list: ResultSource[] = [
      ...open.map((p) => ({ id: `tab-${p.tabId}`, label: `“${p.serp.keyword}” — open results page, ${p.serp.organic.length} results`, keyword: p.serp.keyword, urls: p.serp.organic.map((o) => o.url) })),
      ...saved
        .filter((k) => !open.some((p) => p.serp.keyword.toLowerCase() === k.keyword.toLowerCase()))
        .slice(0, 20)
        .map((k) => ({ id: `snap-${k.latest.id}`, label: `“${k.keyword}” — saved ${formatDate(k.latest.takenAt)}, ${k.latest.organic.length} results`, keyword: k.keyword, urls: k.latest.organic.map((o) => o.url) })),
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
  }, [tabId]);

  const comparisonUrls = useMemo(() => {
    const all = sourceKind === 'urls' ? parseUrlList(urlText) : (sources.find((s) => s.id === sourceId)?.urls ?? []);
    let ownHost = '';
    try {
      ownHost = pageUrl ? stripWww(new URL(pageUrl).hostname) : '';
    } catch {
      ownHost = '';
    }
    // The page's own site is not a competitor.
    return all.filter((u) => !ownHost || stripWww(new URL(u).hostname) !== ownHost).slice(0, MAX_COMPARISON_PAGES);
  }, [sourceKind, urlText, sources, sourceId, pageUrl]);

  const needsPage = mode !== 'pasted';
  const canRun = comparisonUrls.length > 0 && (needsPage ? onPage : pasteText.trim().length > 0) && task.status !== 'running';

  const compare = async () => {
    setDenied(false);
    setHighlight(null);
    setHighlightError(null);
    // First thing in the click handler: this is where Chrome shows its permission prompt.
    if (!(await requestAccess(comparisonUrls))) {
      setDenied(true);
      return;
    }
    void recordRun();
    await task.run(async ({ signal, progress }) => {
      let target: SentenceUnit[];
      if (mode === 'pasted') {
        target = textSentences(pasteText);
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

      const digests = await loadPages(comparisonUrls, { fetchPage, cache: pageCache }, { signal, onProgress: (done, total) => progress(done, total, 'Reading comparison pages') });
      const pages: ComparisonPage[] = digests.filter((d) => d.ok).map((d) => ({ url: d.url, title: d.title, sentences: contentSentences({ blocks: d.blocks }) }));
      if (pages.length === 0) throw new Error('None of the comparison pages could be read.');
      if (pages.every((p) => p.sentences.length === 0)) throw new Error('The comparison pages had no readable text to compare with.');

      progress(0, 0, 'Loading the on-device model');
      const { engine, fallbackReason } = await getEngine();
      const report = await classifySentences(target, pages, engine, { signal, onProgress: (done, total) => progress(done, total, 'Comparing sentences') });
      return { report, digests, fallbackReason, keyword: keyword.trim(), pageUrl: mode === 'pasted' ? null : pageUrl, pageTitle: mode === 'pasted' ? 'Pasted text' : pageTitle, mode, at: Date.now() };
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
          {(
            [
              ['page', 'This page'],
              ['selection', 'Selected text'],
              ['pasted', 'Pasted text'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="row small">
              <input type="radio" name="noise-mode" checked={mode === value} onChange={() => setMode(value)} data-testid={`noise-mode-${value}`} />
              {label}
            </label>
          ))}
        </div>
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
        <PermissionLine urls={comparisonUrls} purpose="to compare them with your page" />
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
              {result.mode !== 'pasted' && (
                <Button small onClick={() => void toggleHighlight()} data-testid="noise-highlight">
                  {highlight ? 'Remove highlights' : 'Highlight on the page'}
                </Button>
              )}
              <CsvButton filename={`new-or-noise-${slugify(result.keyword || result.pageTitle)}.csv`} build={() => noiseCsv(result.report, result.keyword, result.pageUrl)} testId="noise-export" />
              {connection.client && (
                <SaveToLegiit
                  method="sendToContentEditor"
                  label="Send to content editor"
                  payload={() => contentEditorPayload({ targetKeyword: result.keyword, source: result.mode, pageUrl: result.pageUrl, pageTitle: result.mode === 'pasted' ? '' : result.pageTitle, capturedAt: result.at, report: result.report })}
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

          <Summary request={{ task: 'new-or-noise', instruction: 'Explain how much of this page is new compared with competing pages, and what it should add.', facts: explanation, fallback: explanation }} testId="noise-summary" />

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

      {!result && task.status === 'idle' && !needsPage && pasteText.trim() === '' && (
        <Card>
          <EmptyState title="Paste text to check">Paste a draft or a section of a page, choose the results to compare against, then compare.</EmptyState>
        </Card>
      )}
    </>
  );
}
