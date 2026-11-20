/**
 * Selector health check. Runs every slot of the selector packs against the
 * Google and AI pages you have open and shows which candidate matched, so a
 * markup change is easy to spot and to fix with a new pack (data, not code).
 */
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME } from '@/config/constants';
import { parseOrNull, PingReplySchema, SelectorHealthSchema, type SelectorHealth } from '@/model/schemas';
import { BUNDLED_PACKS, getPack, PACK_SITES, type PackSite } from '@/selectors';
import { compareVersions, validatePack } from '@/selectors/resolve';
import { getSelectorOverrides, setSelectorOverride } from '@/storage/settings';
import { Button, Card, Chip, Field, Notice } from '@/ui/kit';
import '@/ui/styles.css';

interface TabReport {
  tabId: number;
  title: string;
  health: SelectorHealth;
}

function HealthPage() {
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [reports, setReports] = useState<TabReport[] | null>(null);
  const [site, setSite] = useState<PackSite>('google');
  const [json, setJson] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async () => setOverrides(await getSelectorOverrides()), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const check = async () => {
    const tabs = await chrome.tabs.query({});
    const found: TabReport[] = [];
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          const ping = parseOrNull(PingReplySchema, await chrome.tabs.sendMessage(tab.id, { type: 'lens:ping' }));
          if (!ping || ping.agent === 'page') return;
          const health = parseOrNull(SelectorHealthSchema, await chrome.tabs.sendMessage(tab.id, { type: 'lens:selector-health' }));
          if (health) found.push({ tabId: tab.id, title: ping.title || ping.url, health });
        } catch {
          // Tabs without a Legiit Lens content script do not answer.
        }
      }),
    );
    setReports(found.sort((a, b) => a.tabId - b.tabId));
  };

  const saveOverride = async () => {
    setMessage(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setMessage({ tone: 'error', text: 'That is not valid JSON.' });
      return;
    }
    const pack = validatePack(parsed, site);
    if (!pack) {
      setMessage({ tone: 'error', text: `Not a valid selector pack for “${site}”. It needs site, version and slots with candidates.` });
      return;
    }
    if (compareVersions(pack.version, BUNDLED_PACKS[site].version) <= 0) {
      setMessage({ tone: 'error', text: `Version ${pack.version} is not newer than the bundled ${BUNDLED_PACKS[site].version}, so it would be ignored.` });
      return;
    }
    await setSelectorOverride(site, pack);
    await reload();
    setJson('');
    setMessage({ tone: 'ok', text: `Saved. ${site} pages opened from now on use version ${pack.version}. Reload open pages to apply it.` });
  };

  const reportText = (reports ?? [])
    .map((r) => `${r.health.site} ${r.health.packVersion} ${r.health.url}\n${r.health.slots.map((s) => `  ${s.matched === 0 ? (s.required ? 'MISSING ' : 'none    ') : s.candidateIndex > 0 ? 'fallback' : 'ok      '} ${s.slot} matched=${s.matched} candidate=${s.candidateIndex + 1}/${s.candidates}`).join('\n')}`)
    .join('\n\n');

  return (
    <div className="page" data-testid="health-page">
      <div className="hero">
        <img src="/icon/128.png" alt="" />
        <div>
          <h1>Selector health check</h1>
          <p className="muted">
            {PRODUCT_NAME} finds things on Google and AI pages with selector packs: one versioned JSON file per site, each slot with fallbacks. This page shows whether they still match.
          </p>
        </div>
      </div>

      <Card title="Selector packs" testId="health-packs">
        <table className="table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Bundled version</th>
              <th>In use</th>
              <th className="num">Slots</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {PACK_SITES.map((s) => {
              const active = getPack(s, overrides);
              const overridden = active.version !== BUNDLED_PACKS[s].version;
              return (
                <tr key={s}>
                  <td>{s}</td>
                  <td className="mono">{BUNDLED_PACKS[s].version}</td>
                  <td className="mono">
                    {active.version} {overridden && <Chip tone="accent">override</Chip>}
                  </td>
                  <td className="num">{Object.keys(active.slots).length}</td>
                  <td>
                    {overridden && (
                      <Button small onClick={async () => { await setSelectorOverride(s, null); void reload(); }}>
                        Remove override
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card
        title="Check open pages"
        testId="health-check"
        actions={
          <Button variant="primary" small onClick={() => void check()} data-testid="health-run">
            Check now
          </Button>
        }
      >
        <p className="small muted">Open a Google results page or an AI answer in another tab, then check. Only pages with a {PRODUCT_NAME} content script are listed.</p>
        {reports !== null && reports.length === 0 && <Notice testId="health-none">No Google results or AI answer pages are open.</Notice>}
        {(reports ?? []).map((report) => {
          const missing = report.health.slots.filter((s) => s.required && s.matched === 0);
          return (
            <div key={report.tabId} className="stack" data-testid="health-report">
              <div className="row">
                <strong>{report.health.site}</strong>
                <span className="mono">{report.health.packVersion}</span>
                {missing.length === 0 ? <Chip tone="ok">Required slots match</Chip> : <Chip tone="bad">{missing.length} required slot{missing.length === 1 ? '' : 's'} not matching</Chip>}
              </div>
              <div className="small muted break">{report.title}</div>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th className="num">Matches</th>
                      <th>Candidate used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.health.slots.map((slot) => (
                      <tr key={slot.slot}>
                        <td>
                          {slot.slot} {slot.required && <Chip>required</Chip>}
                        </td>
                        <td className="num">{slot.matched}</td>
                        <td className="break">
                          {slot.matched === 0 ? (
                            <Chip tone={slot.required ? 'bad' : 'neutral'}>{slot.required ? 'nothing matched' : 'not on this page'}</Chip>
                          ) : (
                            <>
                              <Chip tone={slot.candidateIndex === 0 ? 'ok' : 'warn'}>{slot.candidateIndex === 0 ? 'primary' : `fallback ${slot.candidateIndex + 1} of ${slot.candidates}`}</Chip>{' '}
                              <span className="mono">{slot.candidate}</span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
        {reports !== null && reports.length > 0 && (
          <Field label="Report as text" hint="Copy this into a support request.">
            <textarea readOnly rows={8} value={reportText} className="mono" data-testid="health-text" />
          </Field>
        )}
      </Card>

      <Card title="Use a newer selector pack" testId="health-override">
        <p className="small muted">
          A pack is data only: CSS selectors and text patterns. Paste a newer pack to fix a site after a markup change without waiting for an update. It is validated, stored on this device and never executed as code.
        </p>
        <Field label="Site">
          <select value={site} onChange={(e) => setSite(e.target.value as PackSite)} data-testid="override-site">
            {PACK_SITES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Selector pack (JSON)">
          <textarea rows={8} value={json} onChange={(e) => setJson(e.target.value)} className="mono" spellCheck={false} data-testid="override-json" />
        </Field>
        <div className="row">
          <Button variant="primary" small disabled={!json.trim()} onClick={() => void saveOverride()} data-testid="override-save">
            Save override
          </Button>
        </div>
        {message && (
          <Notice tone={message.tone} testId="override-message">
            {message.text}
          </Notice>
        )}
      </Card>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HealthPage />
  </StrictMode>,
);
