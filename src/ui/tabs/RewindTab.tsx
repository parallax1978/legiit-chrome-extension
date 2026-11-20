/** C. Rewind: what changed on a page over time, from Wayback Machine captures. */
import { SUMMARY_INSTRUCTIONS } from '@/ai/instructions';
import { useEffect, useMemo, useState } from 'react';
import { formatCaptureDate, viewCaptureUrl, type Capture } from '@/features/rewind/cdx';
import { buildTimeline, changesBefore, diffFacts, explainTimeline, FIELD_LABELS, FIELD_ORDER, wordDiff, type CaptureFacts, type FieldChange, type TimelineEntry } from '@/features/rewind/diff';
import { DEFAULT_SAMPLE_SIZE, loadCaptureFacts, loadCaptureIndex, sampleCaptures, toCaptureFacts, type RewindDeps } from '@/features/rewind/load';
import { recordRun } from '@/features/shared/gating';
import type { IndustryPulseEvent } from '@/legiit/types';
import { safeHttpUrl } from '@/lib/sanitize';
import { guardedFetch } from '@/net/guarded-fetch';
import { rewindCache } from '@/storage/db';
import { useConnection, useTarget, useTask } from '../hooks';
import { Button, Card, Chip, EmptyState, ExternalLink, Field, Notice, ProgressBar } from '../kit';
import { AccessCard, Summary } from '../shared';

const deps: RewindDeps = { fetch: (url, init) => guardedFetch(url, 'wayback', init), cache: rewindCache };

interface RewindResult {
  url: string;
  total: number;
  sampled: number;
  captures: CaptureFacts[];
  failed: number;
  timeline: TimelineEntry[];
}

function ChangeLine({ change }: { change: FieldChange }) {
  return (
    <li className="break">
      {change.summary} {!change.significant && <Chip>minor</Chip>}
    </li>
  );
}

function Entry({ entry }: { entry: TimelineEntry }) {
  return (
    <div className="item" data-testid="timeline-entry">
      <div className="row between">
        <span className="title">{formatCaptureDate(entry.to.capture.time)}</span>
        <ExternalLink href={viewCaptureUrl(entry.to.capture)} className="small">
          View capture
        </ExternalLink>
      </div>
      <div className="small muted">Changed some time after {formatCaptureDate(entry.from.capture.time)}</div>
      <ul className="small">
        {entry.changes.map((change) => (
          <ChangeLine key={change.field} change={change} />
        ))}
      </ul>
    </div>
  );
}

function TextDiff({ before, after }: { before: string | null; after: string | null }) {
  return (
    <span className="break">
      {wordDiff(before ?? '', after ?? '').map((token, i) =>
        token.type === 'same' ? (
          <span key={i}>{token.text} </span>
        ) : token.type === 'added' ? (
          <ins key={i} className="diff">
            {token.text}
          </ins>
        ) : (
          <del key={i} className="diff">
            {token.text}
          </del>
        ),
      )}
    </span>
  );
}

function TwoDateDiff({ captures }: { captures: CaptureFacts[] }) {
  const [from, setFrom] = useState(captures[0]?.capture.timestamp ?? '');
  const [to, setTo] = useState(captures[captures.length - 1]?.capture.timestamp ?? '');
  const a = captures.find((c) => c.capture.timestamp === from);
  const b = captures.find((c) => c.capture.timestamp === to);
  const changes = a && b ? diffFacts(a.facts, b.facts) : [];
  const byField = new Map(changes.map((c) => [c.field, c]));
  const option = (c: CaptureFacts) => (
    <option key={c.capture.timestamp} value={c.capture.timestamp}>
      {formatCaptureDate(c.capture.time)}
    </option>
  );
  return (
    <Card title="Compare two dates" testId="rewind-diff">
      <div className="grid2">
        <Field label="From">
          <select value={from} onChange={(e) => setFrom(e.target.value)} data-testid="diff-from">
            {captures.map(option)}
          </select>
        </Field>
        <Field label="To">
          <select value={to} onChange={(e) => setTo(e.target.value)} data-testid="diff-to">
            {captures.map(option)}
          </select>
        </Field>
      </div>
      {a && b && (
        <div className="scroll-x">
          <table className="table" data-testid="diff-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>{formatCaptureDate(a.capture.time)} → {formatCaptureDate(b.capture.time)}</th>
              </tr>
            </thead>
            <tbody>
              {FIELD_ORDER.map((field) => {
                const change = byField.get(field);
                const value = a.facts[field];
                return (
                  <tr key={field}>
                    <td className="nowrap">
                      {FIELD_LABELS[field]} {change && <Chip tone={change.significant ? 'warn' : 'neutral'}>changed</Chip>}
                    </td>
                    <td className="break">
                      {!change ? (
                        <span className="muted">{Array.isArray(value) ? value.join(' · ') || '(none)' : value === null || value === '' ? '(none)' : String(value)}</span>
                      ) : change.kind === 'text' ? (
                        <TextDiff before={change.before} after={change.after} />
                      ) : change.kind === 'list' ? (
                        <>
                          {change.removed.map((item) => (
                            <del key={`r-${item}`} className="diff" style={{ marginRight: 4 }}>
                              {item}
                            </del>
                          ))}
                          {change.added.map((item) => (
                            <ins key={`a-${item}`} className="diff" style={{ marginRight: 4 }}>
                              {item}
                            </ins>
                          ))}
                        </>
                      ) : (
                        <>
                          {change.before.toLocaleString('en-US')} → {change.after.toLocaleString('en-US')} <span className="muted">({change.delta > 0 ? '+' : ''}{change.delta.toLocaleString('en-US')})</span>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function RewindTab() {
  const { access } = useTarget();
  const { connection, can } = useConnection();
  const [url, setUrl] = useState('');
  const [sampleSize, setSampleSize] = useState(DEFAULT_SAMPLE_SIZE);
  const [filterDate, setFilterDate] = useState('');
  const [filterDays, setFilterDays] = useState(30);
  const [pulse, setPulse] = useState<IndustryPulseEvent[]>([]);
  const task = useTask<RewindResult>();

  const pageUrl = access.status === 'ready' ? access.ping.url : null;
  useEffect(() => {
    // Follow the tab until the user has loaded or typed something else.
    if (pageUrl && task.status === 'idle') setUrl(pageUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageUrl]);

  const pulseClient = can('getIndustryPulse') ? connection.client : null;
  useEffect(() => {
    let alive = true;
    if (!pulseClient) {
      setPulse([]);
      return;
    }
    pulseClient.getIndustryPulse().then(
      (data) => alive && setPulse(data.events.slice(0, 8)),
      () => alive && setPulse([]),
    );
    return () => {
      alive = false;
    };
  }, [pulseClient]);

  const lookUp = (forceRefresh = false) => {
    const target = safeHttpUrl(url.trim());
    if (!target) return;
    void recordRun();
    void task.run(async ({ signal, progress }) => {
      progress(0, 0, 'Asking the Wayback Machine');
      const { captures: all } = await loadCaptureIndex(target, deps, { signal, forceRefresh });
      const sample: Capture[] = sampleCaptures(all, sampleSize);
      const results = await loadCaptureFacts(sample, deps, { signal, onProgress: (done, total) => progress(done, total, 'Reading captures') });
      const captures = toCaptureFacts(results);
      return { url: target, total: all.length, sampled: sample.length, captures, failed: results.length - captures.length, timeline: buildTimeline(captures) };
    });
  };

  const result = task.result;
  const filtered = useMemo(() => {
    if (!result) return [];
    const date = filterDate ? Date.parse(`${filterDate}T00:00:00Z`) : Number.NaN;
    return Number.isNaN(date) ? result.timeline : changesBefore(result.timeline, date, filterDays);
  }, [result, filterDate, filterDays]);
  const explanation = result ? explainTimeline(result.timeline, result.captures.length) : [];
  const validUrl = safeHttpUrl(url.trim()) !== null;

  return (
    <>
      <Card title="Page history" testId="rewind-form">
        <Field label="Page address">
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/page" data-testid="rewind-url" />
        </Field>
        <div className="row">
          <Button variant="primary" disabled={!validUrl || task.status === 'running'} onClick={() => lookUp(false)} data-testid="rewind-load">
            Look up history
          </Button>
          <label className="small row">
            Captures to read
            <select value={sampleSize} onChange={(e) => setSampleSize(Number(e.target.value))} aria-label="Captures to read">
              {[12, 24, 48].map((n) => (
                <option key={n} value={n}>
                  up to {n}
                </option>
              ))}
            </select>
          </label>
          {task.status === 'running' && (
            <Button small onClick={task.cancel}>
              Cancel
            </Button>
          )}
        </div>
        <p className="small muted">Sends this address to the Internet Archive’s Wayback Machine (web.archive.org) and reads its saved copies. Nothing else is contacted.</p>
        {task.status === 'running' && task.progress && <ProgressBar done={task.progress.done} total={task.progress.total} label={task.progress.label} />}
        {task.status === 'error' && (
          <Notice tone="error" testId="rewind-error">
            {task.error}{' '}
            <Button variant="link" onClick={() => lookUp(true)}>
              Try again
            </Button>
          </Notice>
        )}
      </Card>

      {access.status === 'no-access' && !url && <AccessCard />}

      {result && result.total === 0 && (
        <Card>
          <EmptyState title="No captures found" testId="rewind-empty">
            The Wayback Machine has no saved copies of this exact address. Try the page without tracking parameters, or its home page.
          </EmptyState>
        </Card>
      )}

      {result && result.total > 0 && (
        <>
          <Card title="Captures" testId="rewind-captures">
            <div className="row">
              <Chip tone="accent">{result.total} distinct captures</Chip>
              <Chip>{result.captures.length} read</Chip>
              {result.failed > 0 && <Chip tone="warn">{result.failed} could not be read</Chip>}
            </div>
            <div className="small muted break">{result.url}</div>
            <details>
              <summary className="small">Captures that were read</summary>
              <div className="small">
                {result.captures.map((c) => (
                  <span key={c.capture.timestamp} style={{ marginRight: 8 }}>
                    <ExternalLink href={viewCaptureUrl(c.capture)}>{formatCaptureDate(c.capture.time)}</ExternalLink>
                  </span>
                ))}
              </div>
            </details>
          </Card>

          <Summary title="What changed" request={{ task: 'rewind', instruction: SUMMARY_INSTRUCTIONS.rewind, facts: explanation, fallback: explanation }} testId="rewind-summary" />

          <Card title="Timeline of changes" testId="rewind-timeline">
            <div className="row">
              <label className="small row">
                Changes in the
                <select value={filterDays} onChange={(e) => setFilterDays(Number(e.target.value))} aria-label="Days before the date" data-testid="filter-days">
                  {[7, 14, 30, 60, 90, 180, 365].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                days before
              </label>
              <input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} aria-label="Date" style={{ width: 'auto' }} data-testid="filter-date" />
              {filterDate && (
                <Button small onClick={() => setFilterDate('')}>
                  Show all
                </Button>
              )}
            </div>
            {pulse.length > 0 && (
              <div className="small" data-testid="pulse-presets">
                <span className="muted">Industry Pulse dates: </span>
                {pulse.map((event) => (
                  <Button key={`${event.date}-${event.title}`} variant="link" small onClick={() => setFilterDate(event.date)} title={event.title} style={{ marginRight: 8 }}>
                    {event.date}
                  </Button>
                ))}
              </div>
            )}
            {filtered.length === 0 ? (
              <p className="muted" data-testid="timeline-empty">
                {filterDate ? `No changes were captured in the ${filterDays} days before ${filterDate}.` : 'No on-page changes were found between the captures that were read.'}
              </p>
            ) : (
              <div>
                {[...filtered].reverse().map((entry) => (
                  <Entry key={entry.to.capture.timestamp} entry={entry} />
                ))}
              </div>
            )}
          </Card>

          {result.captures.length >= 2 && <TwoDateDiff captures={result.captures} />}
        </>
      )}
    </>
  );
}
