/**
 * Overview: the first thing the panel shows. One sentence on what the page in the tab means for the user, a few
 * facts, and what to do next, in plain words. The tools hold the detail; each next step opens the tool that does it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { extractPageFacts } from '@/extract/page-facts';
import { parseHtml } from '@/extract/html';
import { findIssues } from '@/features/instant-brief/issues';
import { keywordRows, type KeywordRow } from '@/features/overview/keywords';
import { buildAnswerOverview, buildPageOverview, buildResultsOverview, type Overview, type ToolId } from '@/features/overview/overview';
import { CROWDING_LABELS, CROWDING_MEANING, daysAgo } from '@/features/overview/words';
import { buildAnswerPresence, buildSerpPresence } from '@/features/why-not-me/presence';
import { randomId } from '@/lib/hash';
import { normalizeDomainInput } from '@/lib/sanitize';
import { AnswerDataSchema, PageSnapshotSchema, type AnswerData } from '@/model/schemas';
import { sendToTab } from '@/panel/tabs';
import { listSnapshots } from '@/storage/db';
import type { SnapshotRecord } from '@/features/click-potential/snapshot';
import { useSettings, useTarget } from '../hooks';
import { Button, Card, Chip, ExtensionLink, ExternalLink, Notice, type Tone } from '../kit';
import { useResultsPage } from '../results-page';
import { AccessCard } from '../shared';

const TONE_CHIP: Readonly<Record<'open' | 'crowded' | 'very-crowded', Tone>> = { open: 'ok', crowded: 'warn', 'very-crowded': 'bad' };

/** The one question the Overview needs answered to speak about "you": which site is the user's. */
function MySite() {
  const { update } = useSettings();
  const [value, setValue] = useState('');
  const domain = normalizeDomainInput(value);
  const save = async () => {
    if (!domain) return;
    const label = domain.split('.')[0] ?? domain;
    await update((draft) => {
      draft.myBrands = [...draft.myBrands, { id: randomId('brand'), name: label.charAt(0).toUpperCase() + label.slice(1), domains: [domain], aliases: [], source: 'manual' }];
    });
  };
  return (
    <Card title="Which site is yours?" testId="overview-my-site">
      <p className="small">Tell Lens once, and every page is read for where you stand on it.</p>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="yoursite.com" aria-label="Your website" data-testid="my-site-input" />
        <Button type="submit" variant="primary" disabled={!domain} data-testid="my-site-save">
          Save
        </Button>
      </form>
    </Card>
  );
}

function Answer({ overview, onOpen }: { overview: Overview; onOpen: (tool: ToolId) => void }) {
  return (
    <>
      <Card testId="overview-answer">
        <div className={`verdict ${overview.tone}`} data-testid="overview-headline">
          {overview.headline}
        </div>
        {overview.crowding && (
          <div className="row small">
            <Chip tone={TONE_CHIP[overview.crowding]} title={CROWDING_MEANING[overview.crowding]}>
              This search: {CROWDING_LABELS[overview.crowding].toLowerCase()}
            </Chip>
            <span className="muted">{CROWDING_MEANING[overview.crowding]}</span>
          </div>
        )}
        {overview.facts.length > 0 && (
          <ul className="facts" data-testid="overview-facts">
            {overview.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )}
        {overview.kind === 'results' && (
          <div className="small">
            <Button variant="link" onClick={() => onOpen('click')} data-testid="overview-details">
              See the whole page, result by result
            </Button>
          </div>
        )}
      </Card>
      {overview.steps.length > 0 && (
        <Card title="What to do next" testId="overview-steps">
          <ol className="steps">
            {overview.steps.map((step) => (
              <li key={step.id} data-testid={`step-${step.id}`}>
                <div>{step.text}</div>
                <div className="row small">
                  {step.open && (
                    <Button small variant="primary" onClick={() => onOpen(step.open!.tool)} data-testid={`step-open-${step.id}`}>
                      {step.open.label}
                    </Button>
                  )}
                  {step.legiit && <ExternalLink href={step.legiit.url}>{step.legiit.label}</ExternalLink>}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}

function rankWords(row: KeywordRow, hasMine: boolean): { text: string; change: string; tone: Tone } {
  // Without a site of the user's own there is no "you" to place.
  if (row.rank === undefined || !hasMine) return { text: '—', change: '', tone: 'neutral' };
  if (row.rank === null) return { text: 'Not on page 1', change: row.entered === 'out' ? 'fell off' : '', tone: row.entered === 'out' ? 'bad' : 'neutral' };
  const change = row.entered === 'in' ? 'new' : row.moved === null || row.moved === 0 ? '' : row.moved > 0 ? `▲ ${row.moved}` : `▼ ${-row.moved}`;
  return { text: `#${row.rank}`, change, tone: row.entered === 'in' || (row.moved ?? 0) > 0 ? 'ok' : (row.moved ?? 0) < 0 ? 'bad' : 'neutral' };
}

const AI_WORDS: Readonly<Record<KeywordRow['ai'], string>> = { in: 'In the AI answer', out: 'Not in the AI answer', none: 'No AI answer', unknown: '' };

function MyKeywords({ reloadOn, hasMine }: { reloadOn: number; hasMine: boolean }) {
  const [snapshots, setSnapshots] = useState<SnapshotRecord[] | null>(null);
  const [all, setAll] = useState(false);
  const reload = useCallback(async () => setSnapshots(await listSnapshots()), []);
  useEffect(() => {
    void reload();
  }, [reload, reloadOn]);
  const rows = useMemo(() => keywordRows(snapshots ?? []), [snapshots]);
  if (snapshots === null) return null;
  const shown = all ? rows : rows.slice(0, 6);
  const now = Date.now();
  return (
    <Card title="My keywords" testId="overview-keywords">
      {rows.length === 0 ? (
        <p className="muted small" data-testid="keywords-empty">
          Every Google search you look at with this panel open is listed here, with where you stand and how that changes.
        </p>
      ) : (
        <>
          <div className="scroll-x">
            <table className="table">
              <tbody>
                {shown.map((row) => {
                  const rank = rankWords(row, hasMine);
                  return (
                    <tr key={row.keywordKey} data-testid="keyword-row">
                      <td className="break">
                        <ExternalLink href={row.searchUrl}>{row.keyword}</ExternalLink>
                        <div className="small muted">
                          Checked {daysAgo(row.checkedAt, now)}
                          {AI_WORDS[row.ai] ? ` · ${AI_WORDS[row.ai]}` : ''}
                        </div>
                      </td>
                      <td className="num nowrap">
                        <strong>{rank.text}</strong>
                        {rank.change && (
                          <div>
                            <Chip tone={rank.tone}>{rank.change}</Chip>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > shown.length && (
            <Button variant="link" onClick={() => setAll(true)}>
              Show all {rows.length}
            </Button>
          )}
          <p className="small muted">
            {hasMine ? 'A keyword is updated each time you search it: Lens never searches Google itself. Click a keyword to search it again.' : 'Tell Lens which site is yours to see your place for each keyword.'}
          </p>
        </>
      )}
    </Card>
  );
}

export function OverviewTab({ onOpen }: { onOpen: (tool: ToolId) => void }) {
  const { access, epoch } = useTarget();
  const { matcher } = useSettings();
  const results = useResultsPage();
  const [answer, setAnswer] = useState<AnswerData | null>(null);
  const [page, setPage] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = access.status === 'ready' ? access : null;
  const agent = ready?.ping.agent ?? null;
  const tabId = ready?.tabId ?? null;
  const pageUrl = agent === 'page' ? (ready?.ping.url ?? null) : null;

  // An AI answer page: the answer and its sources.
  useEffect(() => {
    let alive = true;
    setAnswer(null);
    if (agent !== 'ai' || tabId === null) return;
    sendToTab(tabId, { type: 'lens:get-answer' }, AnswerDataSchema).then(
      (data) => alive && setAnswer(data),
      () => alive && setAnswer(null),
    );
    return () => {
      alive = false;
    };
  }, [agent, tabId, epoch]);

  // An ordinary page: a quick check of its basics.
  useEffect(() => {
    let alive = true;
    setPage(null);
    setError(null);
    if (agent !== 'page' || tabId === null || !pageUrl) return;
    sendToTab(tabId, { type: 'lens:get-page' }, PageSnapshotSchema).then(
      (snapshot) => {
        if (!alive) return;
        const doc = parseHtml(snapshot.html);
        const facts = extractPageFacts(doc, snapshot.url);
        let kind: 'home' | 'other' = 'other';
        try {
          kind = new URL(snapshot.url).pathname === '/' ? 'home' : 'other';
        } catch {
          kind = 'other';
        }
        const issues = findIssues([{ url: snapshot.url, kind, doc, facts }]);
        const imagesWithoutAlt = [...doc.querySelectorAll('img')].filter((img) => !(img.getAttribute('alt') ?? '').trim() && img.getAttribute('role') !== 'presentation').length;
        const isMine = matcher.matchDomain(snapshot.url).some((hit) => hit.owner === 'mine');
        setPage(buildPageOverview({ url: snapshot.url, title: snapshot.title, facts, issues, imagesWithoutAlt, isMine }));
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not read this page'),
    );
    return () => {
      alive = false;
    };
  }, [agent, tabId, pageUrl, epoch, matcher]);

  const overview: Overview | null = useMemo(() => {
    if (results.onSerp) {
      const { serp, cp, presence } = results;
      if (!serp || !cp || !presence || !serp.recognised) return null;
      return serp.mode === 'ai-mode' ? buildAnswerOverview(buildSerpPresence(serp, matcher), matcher) : buildResultsOverview(serp, cp, presence, matcher);
    }
    if (agent === 'ai') return answer?.recognised ? buildAnswerOverview(buildAnswerPresence(answer, matcher), matcher) : null;
    return page;
  }, [results, agent, answer, page, matcher]);

  if (access.status === 'loading') return null;

  const unread =
    results.onSerp && results.serp && !results.serp.recognised
      ? 'results'
      : agent === 'ai' && answer !== null && !answer.recognised
        ? 'answer'
        : null;
  const nothingHere = !overview && !unread && !results.onSerp && agent !== 'ai' && agent !== 'page';

  return (
    <>
      {!matcher.hasMine && <MySite />}
      {(results.error ?? error) && <Notice tone="error">{results.error ?? error}</Notice>}
      {overview && <Answer overview={overview} onOpen={onOpen} />}
      {!overview && results.onSerp && !results.error && !unread && <Notice testId="overview-reading">Reading this results page…</Notice>}
      {unread === 'results' && (
        <Notice tone="warn" testId="overview-unread">
          This Google page was not recognised, so nothing was read. Google may be showing a consent screen or a check. <ExtensionLink page="health.html">Open the selector health check</ExtensionLink>
        </Notice>
      )}
      {unread === 'answer' && (
        <Notice tone="warn" testId="overview-unread">
          The answer on this page could not be read by itself.{' '}
          <Button variant="link" onClick={() => onOpen('why')}>
            Paste it instead
          </Button>
          .
        </Notice>
      )}
      {access.status === 'no-access' && <AccessCard />}
      {nothingHere && access.status !== 'no-access' && (
        <Card title="Start with a search" testId="overview-start">
          <p>Search Google for something you want to be found for. Lens reads the results page and tells you where you stand, who is ahead of you and what to do about it.</p>
          <p className="small muted">It also reads answers on ChatGPT, Gemini, Perplexity and Copilot, and checks any page you open.</p>
        </Card>
      )}
      <MyKeywords reloadOn={results.stored} hasMine={matcher.hasMine} />
    </>
  );
}
