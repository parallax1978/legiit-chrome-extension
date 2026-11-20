/** B. Why Not Me: where competitors appear and you do not, on Google results and in AI answers. */
import { useEffect, useMemo, useState } from 'react';
import { answerFromPastedText } from '@/answers/read';
import { loadPages } from '@/features/shared/load-pages';
import { recordRun } from '@/features/shared/gating';
import { buildGapRows, gapCsv, sortGapRows, type GapRow, type GapSortKey } from '@/features/why-not-me/gap';
import { matchPassages } from '@/features/why-not-me/passages';
import {
  answerSiteLabel,
  buildAnswerPresence,
  buildSerpPresence,
  explainPresence,
  type Presence,
  type SurfacePresence,
  type SurfaceStatus,
} from '@/features/why-not-me/presence';
import { analysePage, pickAnswerTargets, pickSerpTargets, type PageScan, type ScanTarget } from '@/features/why-not-me/scan';
import { gapPayload } from '@/legiit/payloads';
import { slugify } from '@/lib/sanitize';
import { formatPercent } from '@/lib/text';
import { AnswerDataSchema, SerpDataSchema, type AnswerData, type SerpData } from '@/model/schemas';
import { fetchPage } from '@/net/page-fetch';
import { requestAccess } from '@/net/permissions';
import { sendToTab } from '@/panel/tabs';
import { getEngine } from '@/similarity/embedding-client';
import { pageCache } from '@/storage/db';
import { useConnection, useSettings, useTarget, useTask } from '../hooks';
import { Button, Card, Chip, EmptyState, ExternalLink, Notice, ProgressBar, type Tone } from '../kit';
import { AccessCard, BrandsNeeded, CsvButton, PermissionLine, SaveToLegiit, Summary } from '../shared';

const STATUS: Readonly<Record<SurfaceStatus, { label: string; tone: Tone }>> = {
  both: { label: 'You and competitors', tone: 'accent' },
  'only-you': { label: 'Only you', tone: 'ok' },
  'only-competitors': { label: 'Competitors, not you', tone: 'bad' },
  neither: { label: 'No tracked brand', tone: 'neutral' },
  absent: { label: 'Not on this page', tone: 'neutral' },
};

function SurfaceRow({ surface }: { surface: SurfacePresence }) {
  const mineItems = surface.items.filter((i) => i.mine.length > 0);
  return (
    <div className="item" data-testid={`surface-${surface.id}`}>
      <div className="row between">
        <span className="title">{surface.label}</span>
        <Chip tone={STATUS[surface.status].tone}>{STATUS[surface.status].label}</Chip>
      </div>
      {surface.present && (
        <div className="small" style={{ marginTop: 4 }}>
          {surface.minePresent ? (
            <div>
              <Chip tone="mine">You</Chip>{' '}
              {mineItems.length > 0 ? mineItems.map((i) => (i.position && surface.id === 'organic' ? `#${i.position}` : i.title)).join(', ') : 'named in the text'}
            </div>
          ) : null}
          {surface.competitorNames.length > 0 && (
            <div style={{ marginTop: 3 }}>
              {surface.competitorNames.map((name) => (
                <span key={name} style={{ marginRight: 4 }}>
                  <Chip tone="rival">{name}</Chip>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScanResult({ scan }: { scan: PageScan }) {
  return (
    <div className="item" data-testid="scan-result">
      <div className="title break">
        <ExternalLink href={scan.target.url}>{scan.title || scan.target.domain}</ExternalLink>
      </div>
      <div className="small muted">
        {scan.target.domain} · {scan.target.foundIn}
      </div>
      {!scan.ok ? (
        <Notice tone="warn">Could not read this page: {scan.error}</Notice>
      ) : (
        <div className="stack small" style={{ marginTop: 4 }}>
          <div className="row">
            {scan.myBrandPresent ? <Chip tone="ok">Names you</Chip> : <Chip tone="bad">Does not name you</Chip>}
            {scan.competitors.length === 0 ? (
              <span className="muted">No tracked competitor named</span>
            ) : (
              scan.competitors.map((c) => (
                <Chip key={c.name} tone="rival">
                  {c.name} ×{c.mentions}
                </Chip>
              ))
            )}
          </div>
          {scan.contacts.length > 0 && (
            <div>
              <strong>Who to contact:</strong>{' '}
              {scan.contacts.map((c, i) => (
                <span key={`${c.kind}-${c.url}`}>
                  {i > 0 ? ' · ' : ''}
                  <ExternalLink href={c.url}>{c.label}</ExternalLink> <span className="muted">({c.kind})</span>
                </span>
              ))}
            </div>
          )}
          {scan.passages.length > 0 && (
            <div className="stack">
              <strong>Closest to the answer:</strong>
              {scan.passages.map((p, i) => (
                <div className="quote" key={i} data-testid="passage">
                  {p.text}
                  <div className="muted">
                    {formatPercent(p.score)} similar to: “{p.answerSentence}”
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SORTS: { key: GapSortKey; label: string }[] = [
  { key: 'priority', label: 'Priority' },
  { key: 'surface', label: 'Surface' },
  { key: 'position', label: 'Position' },
  { key: 'competitors', label: 'Competitor count' },
  { key: 'domain', label: 'Domain' },
];

function GapTable({ rows }: { rows: GapRow[] }) {
  return (
    <div data-testid="gap-list">
      {rows.map((row) => (
        <div className="item" key={row.id} data-testid="gap-row">
          <div className="row between">
            <Chip tone="accent">{row.surface}</Chip>
            <span className="row">
              {row.actionable && <Chip tone="ok">You could get on this</Chip>}
              {row.scanned && <Chip>Scanned</Chip>}
            </span>
          </div>
          <div className="title break" style={{ marginTop: 3 }}>
            {row.url ? <ExternalLink href={row.url}>{row.title}</ExternalLink> : row.title}
          </div>
          <div className="small muted break">
            {row.domain ? `${row.domain} · ` : ''}
            {row.evidence}
          </div>
          {row.contacts.length > 0 && (
            <div className="small">
              {row.contacts.slice(0, 4).map((c, i) => (
                <span key={`${c.kind}-${c.url}`}>
                  {i > 0 ? ' · ' : ''}
                  <ExternalLink href={c.url}>{c.label}</ExternalLink>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function WhyNotMeTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { access, epoch, refresh } = useTarget();
  const { matcher } = useSettings();
  const { connection } = useConnection();
  const [serp, setSerp] = useState<SerpData | null>(null);
  const [answer, setAnswer] = useState<AnswerData | null>(null);
  const [pasted, setPasted] = useState<AnswerData | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: GapSortKey; direction: 'asc' | 'desc' }>({ key: 'priority', direction: 'desc' });
  const scanTask = useTask<{ scans: PageScan[]; engineNote: string | null }>();
  const [denied, setDenied] = useState(false);

  const ready = access.status === 'ready' ? access : null;
  const agent = ready?.ping.agent ?? null;
  const tabId = ready?.tabId ?? null;
  const onSerp = agent === 'google' && ready?.ping.serp === true;

  useEffect(() => {
    let alive = true;
    setError(null);
    setSerp(null);
    setAnswer(null);
    if (tabId === null) return;
    if (onSerp) {
      sendToTab(tabId, { type: 'lens:get-serp' }, SerpDataSchema).then(
        (data) => alive && setSerp(data),
        (e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not read the results page'),
      );
    } else if (agent === 'ai') {
      sendToTab(tabId, { type: 'lens:get-answer' }, AnswerDataSchema).then(
        (data) => alive && setAnswer(data),
        (e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not read the answer'),
      );
    }
    return () => {
      alive = false;
    };
  }, [tabId, onSerp, agent, epoch]);

  // A pasted answer takes over until it is cleared.
  const activeAnswer = pasted ?? (answer?.recognised ? answer : null);
  const presence: Presence | null = useMemo(() => {
    if (activeAnswer) return buildAnswerPresence(activeAnswer, matcher);
    if (serp?.recognised) return buildSerpPresence(serp, matcher);
    return null;
  }, [activeAnswer, serp, matcher]);

  const answerForPassages = activeAnswer ?? serp?.aiAnswer ?? null;
  const targets: ScanTarget[] = useMemo(() => {
    if (activeAnswer) return pickAnswerTargets(activeAnswer, answerSiteLabel(activeAnswer.site), { matcher });
    if (serp?.recognised) return pickSerpTargets(serp, { matcher });
    return [];
  }, [activeAnswer, serp, matcher]);

  const presenceKey = presence ? `${presence.site}|${presence.subject}|${presence.capturedAt}` : '';
  useEffect(() => {
    scanTask.reset();
    setDenied(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceKey]);

  const scanResult = scanTask.result;
  const scans = useMemo(() => scanResult?.scans ?? [], [scanResult]);
  const rows = useMemo(() => (presence ? sortGapRows(buildGapRows(presence, scans), sort.key, sort.direction) : []), [presence, scans, sort]);
  const explanation = useMemo(() => (presence ? explainPresence(presence, matcher) : []), [presence, matcher]);

  const scan = async () => {
    const urls = targets.map((t) => t.url);
    setDenied(false);
    // Must be the first thing in the click handler: Chrome shows its permission prompt here.
    if (!(await requestAccess(urls))) {
      setDenied(true);
      return;
    }
    void recordRun();
    await scanTask.run(async ({ signal, progress }) => {
      progress(0, urls.length, 'Reading pages');
      const digests = await loadPages(urls, { fetchPage, cache: pageCache }, { signal, onProgress: (done, total) => progress(done, total, 'Reading pages') });
      let passages = new Map<string, PageScan['passages']>();
      let engineNote: string | null = null;
      if (answerForPassages && answerForPassages.text) {
        progress(urls.length, urls.length, 'Comparing passages');
        const { engine, fallbackReason } = await getEngine();
        if (fallbackReason) engineNote = `The on-device model was not available (${fallbackReason}); passages were matched by shared words.`;
        passages = await matchPassages(
          answerForPassages.text,
          digests.filter((d) => d.ok).map((d) => ({ key: d.url, blocks: d.blocks })),
          engine,
          2,
          { signal },
        );
      }
      return { scans: targets.map((t, i) => analysePage(t, digests[i]!, matcher, passages.get(t.url) ?? [])), engineNote };
    });
  };

  const pasteBox = (
    <details open={answer !== null && !answer.recognised && !pasted} data-testid="paste-box">
      <summary>Paste an answer instead</summary>
      <div className="stack">
        <textarea
          rows={5}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="Paste the AI answer here, including any links it cites."
          aria-label="Pasted answer"
          data-testid="paste-text"
        />
        <div className="row">
          <Button small variant="primary" disabled={!pasteText.trim()} onClick={() => setPasted(answerFromPastedText(pasteText, Date.now()))} data-testid="paste-analyze">
            Analyze pasted answer
          </Button>
          {pasted && (
            <Button
              small
              onClick={() => {
                setPasted(null);
                setPasteText('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </details>
  );

  if (access.status === 'loading') return null;

  if (!presence) {
    const unrecognisedAnswer = agent === 'ai' && answer !== null && !answer.recognised;
    const unrecognisedSerp = onSerp && serp !== null && !serp.recognised;
    return (
      <>
        {error && <Notice tone="error">{error}</Notice>}
        {unrecognisedAnswer ? (
          <Notice tone="warn" testId="wnm-unrecognised">
            The answer on this page could not be read automatically. Paste it below instead.
          </Notice>
        ) : unrecognisedSerp ? (
          <Notice tone="warn" testId="wnm-unrecognised">
            This Google page was not recognised, so there is nothing to compare.
          </Notice>
        ) : (
          <Card>
            <EmptyState title="Open Google results or an AI answer" testId="wnm-empty">
              Why Not Me works on Google results (including AI Mode) and on answers at chatgpt.com, gemini.google.com, perplexity.ai and copilot.microsoft.com.
            </EmptyState>
          </Card>
        )}
        <Card title="Any other AI answer">{pasteBox}</Card>
        {access.status === 'no-access' && <AccessCard />}
      </>
    );
  }

  const scanSites = targets.map((t) => t.url);
  return (
    <>
      {matcher.isEmpty && <BrandsNeeded onOpenSettings={onOpenSettings} />}
      <Card
        title={presence.subject ? `“${presence.subject}”` : presence.sourceLabel}
        testId="wnm-presence"
        actions={
          <Button small onClick={refresh}>
            Read again
          </Button>
        }
      >
        <div className="small muted">
          {presence.sourceLabel}
          {pasted ? ' · from pasted text' : ''}
        </div>
        <div>
          {presence.surfaces.map((surface) => (
            <SurfaceRow key={surface.id} surface={surface} />
          ))}
        </div>
      </Card>

      <Summary request={{ task: 'why-not-me', instruction: 'Explain where this brand is missing while competitors are present, and what explains it.', facts: explanation, fallback: explanation }} testId="wnm-summary" />

      <Card title="Scan sources" testId="wnm-scan">
        {targets.length === 0 ? (
          <p className="muted">There are no cited pages or list-style results to scan here.</p>
        ) : (
          <>
            <p>
              Read the {targets.length} cited and list-style page{targets.length === 1 ? '' : 's'} to see which competitors each one names, whether it names you, and who to contact.
            </p>
            <PermissionLine urls={scanSites} purpose="for this scan" />
            <div className="row">
              <Button variant="primary" disabled={scanTask.status === 'running'} onClick={() => void scan()} data-testid="scan-sources">
                {scanTask.status === 'done' ? 'Scan again' : 'Scan sources'}
              </Button>
              {scanTask.status === 'running' && (
                <Button small onClick={scanTask.cancel}>
                  Cancel
                </Button>
              )}
            </div>
            {denied && (
              <Notice tone="warn" testId="scan-denied">
                Permission was not granted, so nothing was fetched.
              </Notice>
            )}
            {scanTask.status === 'running' && scanTask.progress && <ProgressBar done={scanTask.progress.done} total={scanTask.progress.total} label={scanTask.progress.label} />}
            {scanTask.status === 'error' && <Notice tone="error">{scanTask.error}</Notice>}
            {scanTask.result?.engineNote && <Notice tone="warn">{scanTask.result.engineNote}</Notice>}
            {scans.length > 0 && (
              <div data-testid="scan-results">
                {scans.map((s) => (
                  <ScanResult key={s.target.url} scan={s} />
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title={`Gap list (${rows.length})`}
        testId="wnm-gaps"
        actions={
          rows.length > 0 ? (
            <div className="row">
              <CsvButton filename={`gap-list-${slugify(presence.subject || presence.sourceLabel)}.csv`} build={() => gapCsv(presence, rows)} testId="gap-export" />
              {connection.client && (
                <SaveToLegiit method="saveGapList" payload={() => gapPayload(presence, rows)} send={(payload, businessId) => connection.client!.saveGapList(businessId, payload)} />
              )}
            </div>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <p className="muted" data-testid="gap-empty">
            {matcher.hasCompetitors ? 'No gaps found: wherever a tracked competitor appears here, you do too.' : 'Add competitors in Settings to build a gap list.'}
          </p>
        ) : (
          <>
            <div className="row small">
              <label htmlFor="gap-sort">Sort by</label>
              <select id="gap-sort" value={sort.key} onChange={(e) => setSort({ key: e.target.value as GapSortKey, direction: e.target.value === 'priority' || e.target.value === 'competitors' ? 'desc' : 'asc' })} data-testid="gap-sort">
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button small onClick={() => setSort((s) => ({ ...s, direction: s.direction === 'asc' ? 'desc' : 'asc' }))} aria-label="Reverse the sort order">
                {sort.direction === 'asc' ? 'Ascending' : 'Descending'}
              </Button>
            </div>
            <GapTable rows={rows} />
          </>
        )}
      </Card>

      {(agent === 'ai' || pasted || !onSerp) && <Card title="Any other AI answer">{pasteBox}</Card>}
    </>
  );
}
