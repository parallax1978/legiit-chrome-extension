/** A. Click Potential: how much room organic results get on the Google results page in the current tab. */
import { SUMMARY_INSTRUCTIONS } from '@/ai/instructions';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BLOCK_LABELS,
  computeClickPotential,
  foldLabel,
  GRADE_METHOD,
  type ClickPotential,
  type FoldStatus,
  type ShareType,
} from '@/features/click-potential/metrics';
import { historyCsv, keywordKey, organicCsv, toSnapshot, type SnapshotRecord } from '@/features/click-potential/snapshot';
import { recordRun } from '@/features/shared/gating';
import { buildSerpPresence, summarisePresence } from '@/features/why-not-me/presence';
import { snapshotPayload } from '@/legiit/payloads';
import { slugify } from '@/lib/sanitize';
import { formatInt, formatPercent } from '@/lib/text';
import { SerpDataSchema, type SerpData } from '@/model/schemas';
import { sendToTab } from '@/panel/tabs';
import { deleteKeyword, deleteSnapshot, listKeywords, listSnapshots, saveSnapshot, type KeywordSummary } from '@/storage/db';
import { trackedBrands } from '@/storage/settings';
import { useConnection, useSettings, useTarget } from '../hooks';
import { Button, Card, Chip, EmptyState, ExtensionLink, ExternalLink, formatDateTime, Notice, Stat, type Tone } from '../kit';
import { AccessCard, CsvButton, SaveToLegiit, Summary } from '../shared';

export const TYPE_COLORS: Readonly<Record<ShareType, string>> = {
  organic: '#2456e6',
  ai_overview: '#8b5cf6',
  ad: '#ef4444',
  local_pack: '#10b981',
  featured_snippet: '#f59e0b',
  paa: '#64748b',
  video: '#ec4899',
  image: '#14b8a6',
  shopping: '#f97316',
  forum: '#0ea5e9',
  top_stories: '#84cc16',
  knowledge_panel: '#a3a3a3',
};

function foldTone(fold: FoldStatus | null): Tone {
  return fold === 'above' ? 'ok' : fold === 'partly' ? 'warn' : fold === 'below' ? 'bad' : 'neutral';
}

/** A scaled drawing of the top two screens of the results page, with the fold marked. */
function MiniMap({ serp }: { serp: SerpData }) {
  const { width, height } = serp.viewport;
  const shown = height * 2;
  const rects: { key: string; type: ShareType; x: number; y: number; w: number; h: number }[] = [];
  serp.blocks.forEach((block, i) => {
    if (block.rect) rects.push({ key: `b${i}`, type: block.type, x: block.rect.x, y: block.rect.y, w: block.rect.width, h: block.rect.height });
  });
  serp.organic.forEach((result) => {
    if (result.rect) rects.push({ key: `o${result.position}`, type: 'organic', x: result.rect.x, y: result.rect.y, w: result.rect.width, h: result.rect.height });
  });
  return (
    <svg className="minimap" viewBox={`0 0 ${width} ${shown}`} role="img" aria-label="Layout of the first two screens of the results page" data-testid="minimap">
      <rect x={0} y={height} width={width} height={height} fill="currentColor" opacity={0.05} />
      {rects
        .filter((r) => r.y < shown)
        .map((r) => (
          <rect key={r.key} x={r.x} y={r.y} width={r.w} height={Math.min(r.h, shown - r.y)} rx={6} fill={TYPE_COLORS[r.type]} opacity={r.type === 'organic' ? 0.9 : 0.75}>
            <title>{BLOCK_LABELS[r.type]}</title>
          </rect>
        ))}
      <line x1={0} x2={width} y1={height} y2={height} stroke="currentColor" strokeWidth={3} strokeDasharray="14 10" />
      <text x={width - 12} y={height - 12} textAnchor="end" fontSize={Math.round(width / 40)} fill="currentColor">
        fold ({height} px)
      </text>
    </svg>
  );
}

function ShareBar({ cp }: { cp: ClickPotential }) {
  return (
    <div className="stack">
      <div className="bar" aria-hidden="true">
        {cp.shares.map((s) => (
          <span key={s.type} style={{ width: `${s.share * 100}%`, background: TYPE_COLORS[s.type] }} />
        ))}
      </div>
      <div className="legend" data-testid="shares">
        {cp.shares.map((s) => (
          <span key={s.type}>
            <i style={{ background: TYPE_COLORS[s.type] }} />
            {s.label} <strong>{formatPercent(s.share, 1)}</strong>
          </span>
        ))}
        <span className="muted">Search box, navigation and empty space {formatPercent(cp.remainderShare, 1)}</span>
      </div>
    </div>
  );
}

function HistoryTable({ snapshots, onDelete }: { snapshots: SnapshotRecord[]; onDelete: (id: string) => void }) {
  return (
    <div className="scroll-x">
      <table className="table" data-testid="history-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Viewport</th>
            <th className="num">1st organic</th>
            <th>Grade</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s) => (
            <tr key={s.id}>
              <td>
                {formatDateTime(s.takenAt)}
                {s.locationText && <div className="small muted">{s.locationText}</div>}
              </td>
              <td className="nowrap">
                {s.viewport.width}×{s.viewport.height}
              </td>
              <td className="num nowrap">{s.firstOrganicTop === null ? '—' : `${formatInt(s.firstOrganicTop)} px`}</td>
              <td>
                {s.gradeLetter} <span className="muted">({s.gradeScore})</span>
              </td>
              <td>
                <Button variant="link" small onClick={() => onDelete(s.id)} aria-label="Delete this snapshot">
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Saved snapshots for every keyword. Shown when the current tab is not a results page. */
function AllHistory() {
  const [keywords, setKeywords] = useState<KeywordSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<SnapshotRecord[]>([]);
  const reload = useCallback(async () => setKeywords(await listKeywords()), []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (open) void listSnapshots(open).then(setRows);
  }, [open]);

  if (keywords === null) return null;
  if (keywords.length === 0) {
    return (
      <Card title="History">
        <EmptyState title="No snapshots yet" testId="history-empty">
          Snapshots are saved on this device when you view Google results with this panel open.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card
      title="History"
      actions={<CsvButton filename="click-potential-history.csv" label="Export all" build={async () => historyCsv(await listSnapshots(undefined, 5000))} testId="history-export-all" />}
    >
      {keywords.map((k) => (
        <div className="item" key={k.keywordKey}>
          <div className="row between">
            <Button variant="link" onClick={() => setOpen(open === k.keywordKey ? null : k.keywordKey)}>
              {k.keyword}
            </Button>
            <span className="small muted nowrap">
              {k.count} · {k.latest.gradeLetter} · {formatDateTime(k.latest.takenAt)}
            </span>
          </div>
          {open === k.keywordKey && (
            <div className="stack" style={{ marginTop: 6 }}>
              <HistoryTable
                snapshots={rows}
                onDelete={async (id) => {
                  await deleteSnapshot(id);
                  setRows(await listSnapshots(k.keywordKey));
                  void reload();
                }}
              />
              <div className="row">
                <CsvButton filename={`click-potential-${slugify(k.keyword)}.csv`} label="Export history" build={() => historyCsv(rows)} />
                <Button
                  small
                  variant="danger"
                  onClick={async () => {
                    await deleteKeyword(k.keywordKey);
                    setOpen(null);
                    void reload();
                  }}
                >
                  Delete keyword
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

export function ClickPotentialTab() {
  const { access, epoch, refresh } = useTarget();
  const { settings, matcher } = useSettings();
  const { connection } = useConnection();
  const [serp, setSerp] = useState<SerpData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SnapshotRecord[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);

  const ready = access.status === 'ready' ? access : null;
  const onSerp = ready?.ping.agent === 'google' && ready.ping.serp;
  const tabId = ready?.tabId ?? null;

  useEffect(() => {
    let alive = true;
    setError(null);
    if (!onSerp || tabId === null) {
      setSerp(null);
      return;
    }
    sendToTab(tabId, { type: 'lens:get-serp' }, SerpDataSchema).then(
      (data) => alive && setSerp(data),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not read the results page'),
    );
    return () => {
      alive = false;
    };
  }, [onSerp, tabId, epoch]);

  const cp = useMemo(() => (serp ? computeClickPotential(serp, matcher) : null), [serp, matcher]);
  const snapshot = useMemo(
    () => (serp && cp ? toSnapshot(serp, cp, matcher.isEmpty ? null : summarisePresence(buildSerpPresence(serp, matcher))) : null),
    [serp, cp, matcher],
  );
  const key = serp ? keywordKey(serp.keyword) : null;

  const reloadHistory = useCallback(async () => {
    if (key) setHistory(await listSnapshots(key));
  }, [key]);

  // Save a snapshot of what is on screen (unless the user chose manual saving), then refresh the history list.
  useEffect(() => {
    if (!snapshot || !serp?.recognised || serp.mode !== 'web' || !cp?.measured) return;
    let alive = true;
    void (async () => {
      if (settings.snapshots.autoSave !== 'manual') {
        await saveSnapshot(snapshot);
        if (alive && savedId !== snapshot.id) {
          setSavedId(snapshot.id);
          void recordRun();
        }
      }
      if (alive) await reloadHistory();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, settings.snapshots.autoSave]);

  if (access.status === 'loading') return null;

  if (!onSerp) {
    return (
      <>
        {access.status === 'no-access' ? (
          <Notice testId="cp-not-serp">Click Potential measures Google results pages. Open a Google search in this tab to use it.</Notice>
        ) : (
          <Card>
            <EmptyState title="Open a Google results page" testId="cp-not-serp">
              Click Potential measures the results page in the current tab: where the first organic result starts and what takes up the first screen.
            </EmptyState>
          </Card>
        )}
        {access.status === 'no-access' && <AccessCard />}
        <AllHistory />
      </>
    );
  }

  if (error) {
    return (
      <Notice tone="error">
        {error}{' '}
        <Button variant="link" onClick={refresh}>
          Try again
        </Button>
      </Notice>
    );
  }
  if (!serp || !cp) return <Notice>Measuring this results page…</Notice>;

  if (serp.mode === 'ai-mode') {
    return (
      <Card>
        <EmptyState title="This is Google AI Mode" testId="cp-ai-mode">
          AI Mode has no classic results to measure. Open the Why Not Me tab to see which brands and sources the answer uses.
        </EmptyState>
      </Card>
    );
  }

  if (!serp.recognised) {
    return (
      <Card>
        <EmptyState title="This results page was not recognised" testId="cp-unrecognised">
          Google may be showing a consent screen, a verification check or a new layout. Nothing was measured.{' '}
          <ExtensionLink page="health.html">Open the selector health check</ExtensionLink>
        </EmptyState>
      </Card>
    );
  }

  const mineRows = cp.tracked.filter((t) => t.owner === 'mine');
  const explanation = cp.explanation;

  return (
    <>
      <Card
        title={`“${serp.keyword}”`}
        testId="cp-header"
        actions={
          <Button small onClick={refresh}>
            Measure again
          </Button>
        }
      >
        <div className="small muted">
          {serp.viewport.width}×{serp.viewport.height} viewport
          {serp.locationText ? ` · ${serp.locationText}` : ''} · {new URL(serp.url).hostname} · {formatDateTime(serp.capturedAt)}
        </div>
        <div className="grade" data-testid="cp-grade">
          <div className={`letter ${cp.grade.letter}`}>{cp.grade.letter}</div>
          <div className="stack" style={{ gap: 2 }}>
            <div className="row">
              <strong>Organic click potential</strong>
              <Chip tone="accent" title="An estimate from layout, not a click-through-rate prediction">
                Estimate
              </Chip>
            </div>
            <div className="small muted">
              {cp.grade.score}/100 · position −{cp.grade.positionPenalty} · displacement −{cp.grade.displacementPenalty}
            </div>
          </div>
        </div>
        <details>
          <summary className="small">How this is calculated</summary>
          <ul className="small" data-testid="cp-method">
            {GRADE_METHOD.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
        <div className="grid2">
          <Stat
            label="First organic result"
            testId="cp-first-organic"
            value={cp.firstOrganicTop === null ? 'none' : `${formatInt(cp.firstOrganicTop)} px`}
            sub={cp.firstOrganicTop === null ? 'No organic results found' : `${foldLabel(cp.firstOrganicFold)} · ${(cp.screensToFirstOrganic ?? 0).toFixed(1)} screens down`}
          />
          <Stat label="Organic share of first screen" testId="cp-organic-share" value={formatPercent(cp.organicShare, 1)} sub={`${cp.aboveFirstOrganic.length} block${cp.aboveFirstOrganic.length === 1 ? '' : 's'} above the first result`} />
        </div>
      </Card>

      <Card title="First screen">
        <MiniMap serp={serp} />
        <ShareBar cp={cp} />
      </Card>

      <Summary request={{ task: 'click-potential', instruction: SUMMARY_INSTRUCTIONS['click-potential'], facts: explanation, fallback: explanation }} testId="cp-summary" />

      {matcher.hasMine || matcher.hasCompetitors ? (
        <Card title="Tracked brands" testId="cp-tracked">
          {cp.tracked.length === 0 ? (
            <p className="muted">None of your tracked domains has an organic result on this page.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Brand</th>
                  <th className="num">#</th>
                  <th className="num">Top</th>
                  <th>Fold</th>
                </tr>
              </thead>
              <tbody>
                {cp.tracked.map((t) => (
                  <tr key={t.brandId} className={t.owner === 'mine' ? 'mine' : undefined}>
                    <td>
                      {t.name} <Chip tone={t.owner === 'mine' ? 'mine' : 'rival'}>{t.owner === 'mine' ? 'You' : 'Competitor'}</Chip>
                    </td>
                    <td className="num">{t.position}</td>
                    <td className="num nowrap">{t.top === null ? '—' : `${formatInt(t.top)} px`}</td>
                    <td>
                      <Chip tone={foldTone(t.fold)}>{t.fold === 'above' ? 'Above' : t.fold === 'partly' ? 'Cut' : t.fold === 'below' ? 'Below' : '—'}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {matcher.hasMine && mineRows.length === 0 && cp.tracked.length > 0 && <p className="small muted">Your own domains are not among the organic results on this page.</p>}
        </Card>
      ) : null}

      <Card
        title={`Organic results (${cp.organic.length})`}
        testId="cp-organic"
        actions={
          <div className="row">
            <CsvButton filename={`click-potential-${slugify(serp.keyword)}.csv`} build={() => organicCsv(serp, cp)} testId="cp-export" />
            {/* Only a page that was really measured, for a real query, is worth saving. */}
            {snapshot && cp.measured && snapshot.keyword !== '' && connection.client && (
              <SaveToLegiit
                method="saveVisibilitySnapshot"
                payload={() => snapshotPayload(snapshot, trackedBrands(settings))}
                send={(payload, businessId, options) => connection.client!.saveVisibilitySnapshot(businessId, payload, options)}
              />
            )}
          </div>
        }
      >
        <div className="scroll-x">
          <table className="table" data-testid="cp-organic-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Result</th>
                <th className="num">Top</th>
                <th>Fold</th>
              </tr>
            </thead>
            <tbody>
              {cp.organic.map((o) => (
                <tr key={o.position} className={o.owner === 'mine' ? 'mine' : undefined}>
                  <td className="num">{o.position}</td>
                  <td className="break">
                    <ExternalLink href={o.url}>{o.title}</ExternalLink>
                    <div className="small muted">
                      {o.domain} {o.owner && <Chip tone={o.owner === 'mine' ? 'mine' : 'rival'}>{o.owner === 'mine' ? 'You' : 'Competitor'}</Chip>} {o.listStyle && <Chip>List page</Chip>}
                    </div>
                  </td>
                  <td className="num nowrap">{o.top === null ? '—' : `${formatInt(o.top)} px`}</td>
                  <td>
                    <Chip tone={foldTone(o.fold)}>{o.fold === 'above' ? 'Above' : o.fold === 'partly' ? 'Cut' : o.fold === 'below' ? 'Below' : '—'}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="History for this keyword"
        testId="cp-history"
        actions={history.length > 0 ? <CsvButton filename={`click-potential-history-${slugify(serp.keyword)}.csv`} label="Export history" build={() => historyCsv(history)} testId="cp-history-export" /> : undefined}
      >
        {settings.snapshots.autoSave === 'manual' && snapshot && (
          <div className="row">
            <Button
              small
              onClick={async () => {
                await saveSnapshot(snapshot);
                void recordRun();
                await reloadHistory();
              }}
              data-testid="cp-save-snapshot"
            >
              Save snapshot
            </Button>
            <span className="small muted">Snapshots are saved only when you click.</span>
          </div>
        )}
        {history.length === 0 ? (
          <p className="muted">No snapshots saved for this keyword yet.</p>
        ) : (
          <HistoryTable
            snapshots={history}
            onDelete={async (id) => {
              await deleteSnapshot(id);
              await reloadHistory();
            }}
          />
        )}
        <p className="small muted">Stored on this device only. Compare snapshots taken with the same viewport size.</p>
      </Card>
    </>
  );
}
