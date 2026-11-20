/** Settings, shared by the side panel's Settings tab and the options page. */
import { useCallback, useEffect, useState } from 'react';
import { chromeModelAvailability, downloadChromeModel } from '@/ai/provider';
import { PRODUCT_NAME } from '@/config/constants';
import { LEGIIT_API_BASE_URL } from '@/config/runtime';
import { LegiitError } from '@/legiit/client';
import { applyBusinessDetails, clearBusinessDetails } from '@/legiit/prefill';
import type { LegiitBusiness } from '@/legiit/types';
import { errorMessage } from '@/lib/async';
import { randomId } from '@/lib/hash';
import { isSafeImageDataUrl, normalizeDomainInput } from '@/lib/sanitize';
import { siteOfPattern } from '@/lib/url';
import { networkLog, onNetworkLog } from '@/net/guarded-fetch';
import { grantedSites, revokeSites } from '@/net/permissions';
import { clearAllData, clearCaches, clearHistory, storageSummary, type StorageSummary } from '@/storage/db';
import { clearAllSettings, type StoredBrand } from '@/storage/settings';
import { useAiProvider, useConnection, useSettings } from './hooks';
import { Button, Card, Chip, ExtensionLink, Field, Notice, ProgressBar } from './kit';
import { SaveToLegiit } from './shared';

const splitList = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

function BrandEditor({ brand, kind, onChange, onRemove }: { brand: StoredBrand; kind: 'mine' | 'competitor'; onChange: (next: StoredBrand) => void; onRemove: () => void }) {
  const { connection } = useConnection();
  const [name, setName] = useState(brand.name);
  const [domains, setDomains] = useState(brand.domains.join(', '));
  const [aliases, setAliases] = useState(brand.aliases.join(', '));
  useEffect(() => {
    setName(brand.name);
    setDomains(brand.domains.join(', '));
    setAliases(brand.aliases.join(', '));
  }, [brand]);

  const commit = () => {
    const cleanDomains = [...new Set(splitList(domains).map((d) => normalizeDomainInput(d)).filter((d): d is string => d !== null))];
    const next: StoredBrand = { ...brand, name: name.trim() || brand.name, domains: cleanDomains, aliases: [...new Set(splitList(aliases))].slice(0, 30) };
    if (JSON.stringify(next) !== JSON.stringify(brand)) onChange(next);
    else setDomains(cleanDomains.join(', '));
  };

  return (
    <div className="item stack" data-testid={`brand-${kind}`}>
      <div className="row">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} aria-label="Brand name" placeholder="Brand name" style={{ flex: 1 }} data-testid="brand-name" />
        {brand.source === 'legiit' && <Chip tone="accent">From Command Center</Chip>}
        <Button small variant="danger" onClick={onRemove} aria-label={`Remove ${brand.name || 'brand'}`}>
          Remove
        </Button>
      </div>
      <div className="grid2">
        <Field label="Domains" hint="Comma-separated">
          <input type="text" value={domains} onChange={(e) => setDomains(e.target.value)} onBlur={commit} placeholder="example.com" data-testid="brand-domains" />
        </Field>
        <Field label="Also known as" hint="Other spellings">
          <input type="text" value={aliases} onChange={(e) => setAliases(e.target.value)} onBlur={commit} placeholder="Alias one, Alias two" data-testid="brand-aliases" />
        </Field>
      </div>
      {kind === 'competitor' && brand.source !== 'legiit' && brand.name && connection.client && (
        <div className="row">
          <SaveToLegiit
            method="addCompetitor"
            label="Add to Command Center"
            payload={() => ({ name: brand.name, domain: brand.domains[0] ?? null })}
            send={(payload, businessId) => connection.client!.addCompetitor(businessId, payload)}
          />
        </div>
      )}
    </div>
  );
}

function BrandsSection() {
  const { settings, update } = useSettings();
  const list = (kind: 'mine' | 'competitor') => (kind === 'mine' ? settings.myBrands : settings.competitors);
  const write = (kind: 'mine' | 'competitor', next: StoredBrand[]) =>
    update((draft) => {
      if (kind === 'mine') draft.myBrands = next;
      else draft.competitors = next;
    });
  const section = (kind: 'mine' | 'competitor', title: string, hint: string, addLabel: string) => (
    <Card title={title} testId={`brands-${kind}`}>
      <p className="small muted">{hint}</p>
      <div>
        {list(kind).map((brand) => (
          <BrandEditor
            key={brand.id}
            brand={brand}
            kind={kind}
            onChange={(next) => void write(kind, list(kind).map((b) => (b.id === brand.id ? next : b)))}
            onRemove={() => void write(kind, list(kind).filter((b) => b.id !== brand.id))}
          />
        ))}
      </div>
      <div className="row">
        <Button small onClick={() => void write(kind, [...list(kind), { id: randomId('brand'), name: '', domains: [], aliases: [], source: 'manual' }])} data-testid={`add-${kind}`}>
          {addLabel}
        </Button>
      </div>
    </Card>
  );
  return (
    <>
      {section('mine', 'My brands', 'Your own brand names and domains. Used to mark where you appear.', 'Add a brand')}
      {section('competitor', 'Competitors', 'Competitor names and domains. Used to mark where they appear and you do not.', 'Add a competitor')}
    </>
  );
}

function AgencySection() {
  const { settings, update } = useSettings();
  const [name, setName] = useState(settings.agency.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(settings.agency.name), [settings.agency.name]);

  const onFile = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError('Use a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > 300_000) {
      setError('The logo must be smaller than 300 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (!isSafeImageDataUrl(reader.result)) {
        setError('That file could not be used as a logo.');
        return;
      }
      const dataUrl = reader.result;
      void update((draft) => {
        draft.agency.logoDataUrl = dataUrl;
      });
    };
    reader.onerror = () => setError('The file could not be read.');
    reader.readAsDataURL(file);
  };

  return (
    <Card title="Agency (for exports)" testId="settings-agency">
      <p className="small muted">Client briefs are exported with your agency’s name and logo, and no {PRODUCT_NAME} or Legiit branding.</p>
      <Field label="Agency name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void update((draft) => {
            draft.agency.name = name.trim().slice(0, 160);
          })}
          data-testid="agency-name"
        />
      </Field>
      <div className="row">
        {settings.agency.logoDataUrl && <img src={settings.agency.logoDataUrl} alt="Agency logo" style={{ maxHeight: 40, maxWidth: 140 }} data-testid="agency-logo" />}
        <label className="btn small">
          {settings.agency.logoDataUrl ? 'Replace logo' : 'Upload logo'}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onFile(e.target.files?.[0])} data-testid="agency-logo-input" />
        </label>
        {settings.agency.logoDataUrl && (
          <Button small variant="danger" onClick={() => void update((draft) => {
            draft.agency.logoDataUrl = null;
          })}>
            Remove logo
          </Button>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

function LegiitSection() {
  const { connection, loading, connect, disconnect, can } = useConnection();
  const { settings, update } = useSettings();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<LegiitBusiness[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const client = connection.client;
  const canList = can('listBusinesses');

  useEffect(() => {
    let alive = true;
    if (!client || !canList) {
      setBusinesses([]);
      return;
    }
    client.listBusinesses().then(
      (list) => alive && setBusinesses(list),
      () => alive && setBusinesses([]),
    );
    return () => {
      alive = false;
    };
  }, [client, canList]);

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await connect(token);
      setToken('');
    } catch (e) {
      setError(e instanceof LegiitError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseBusiness = async (id: string) => {
    setNote(null);
    if (!client) return;
    if (!id) {
      await update((draft) => clearBusinessDetails(draft));
      return;
    }
    try {
      const details = await client.getBusinessDetails(id);
      await update((draft) => applyBusinessDetails(draft, details));
      setNote(`Tracked brands and ${details.competitors.length} competitor${details.competitors.length === 1 ? '' : 's'} were pre-filled from ${details.name}.`);
    } catch (e) {
      setNote(`Could not load that business: ${errorMessage(e)}`);
    }
  };

  return (
    <Card title="Legiit account (optional)" testId="settings-legiit">
      <p className="small muted">
        Everything works without an account. Connecting only adds “Save to Command Center” and pre-fills your tracked brands. With no account connected, {PRODUCT_NAME} never contacts Legiit.
      </p>
      {loading ? (
        <p className="muted">Checking…</p>
      ) : connection.status === 'connected' && connection.session ? (
        <>
          <div className="row" data-testid="legiit-connected">
            <Chip tone="ok">Connected</Chip>
            <span>
              {connection.session.user.name}
              {connection.session.plan ? ` · ${connection.session.plan}` : ''}
            </span>
          </div>
          {canList && (
            <Field label="Business" hint="Saves go to this business, and its brand names and competitors are pre-filled.">
              <select value={settings.legiit.businessId ?? ''} onChange={(e) => void chooseBusiness(e.target.value)} data-testid="legiit-business">
                <option value="">Choose a business…</option>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {note && <Notice tone="ok">{note}</Notice>}
          {settings.legiit.focusKeywords.length > 0 && (
            <div className="small">
              <strong>Focus keywords:</strong> {settings.legiit.focusKeywords.join(' · ')}
            </div>
          )}
          <div className="row">
            <Button small variant="danger" onClick={() => void disconnect()} data-testid="legiit-disconnect">
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="API token" hint="Paste a token from Legiit Command Center.">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} data-testid="legiit-token" />
          </Field>
          <div className="row">
            <Button variant="primary" disabled={busy || !token.trim()} onClick={() => void onConnect()} data-testid="legiit-connect">
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
            <span className="small muted">Connects to {new URL(LEGIIT_API_BASE_URL).host}</span>
          </div>
          {(error ?? connection.error) && (
            <Notice tone="error" testId="legiit-error">
              {error ?? connection.error}
            </Notice>
          )}
        </>
      )}
    </Card>
  );
}

function AiSection() {
  const { settings, update } = useSettings();
  const provider = useAiProvider();
  const [availability, setAvailability] = useState<LanguageModelAvailability | 'unsupported' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => setAvailability(await chromeModelAvailability()), []);
  useEffect(() => {
    void check();
  }, [check]);

  const download = async () => {
    setError(null);
    setProgress(0);
    try {
      await downloadChromeModel(setProgress);
      await check();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const status: Record<string, string> = {
    unsupported: 'This browser does not offer built-in AI.',
    unavailable: 'This device does not meet Chrome’s requirements for built-in AI.',
    downloadable: 'Available after a one-time model download.',
    downloading: 'Chrome is downloading the model.',
    available: 'Ready on this device.',
  };

  return (
    <Card title="AI" testId="settings-ai">
      <p className="small muted">
        Every feature gives a complete result without AI. A model only rewrites the built-in summaries. Order: Legiit AI when connected, then Chrome’s built-in AI if you opt in, otherwise templates.
      </p>
      <div className="row" data-testid="ai-provider">
        <strong>In use now:</strong> <Chip tone="accent">{provider?.label ?? 'Checking…'}</Chip>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.ai.chromePromptOptIn}
          onChange={(e) => void update((draft) => {
            draft.ai.chromePromptOptIn = e.target.checked;
          })}
          data-testid="ai-optin"
        />
        <span>
          Use Chrome’s built-in AI (runs on this device)
          <span className="small muted" style={{ display: 'block' }}>
            {availability ? status[availability] : 'Checking…'} Chrome downloads a multi-gigabyte model once and needs about 22 GB of free disk space. Nothing you analyze is sent anywhere.
          </span>
        </span>
      </label>
      {settings.ai.chromePromptOptIn && (availability === 'downloadable' || availability === 'downloading') && (
        <div className="row">
          <Button small onClick={() => void download()} disabled={progress !== null} data-testid="ai-download">
            {progress !== null ? 'Downloading…' : 'Download the model'}
          </Button>
        </div>
      )}
      {progress !== null && <ProgressBar done={Math.round(progress * 100)} total={100} label="Model download" />}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

function PrivacySection() {
  const { settings, update } = useSettings();
  const [sites, setSites] = useState<string[]>([]);
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [, setTick] = useState(0);

  const reload = useCallback(async () => {
    setSites(await grantedSites().catch(() => []));
    setSummary(await storageSummary().catch(() => null));
  }, []);
  useEffect(() => {
    void reload();
    const stop = onNetworkLog(() => setTick((n) => n + 1));
    const onPermissions = () => void reload();
    chrome.permissions.onAdded.addListener(onPermissions);
    chrome.permissions.onRemoved.addListener(onPermissions);
    return () => {
      stop();
      chrome.permissions.onAdded.removeListener(onPermissions);
      chrome.permissions.onRemoved.removeListener(onPermissions);
    };
  }, [reload]);

  const log = networkLog();
  const hosts = new Map<string, number>();
  for (const entry of log) hosts.set(entry.host, (hosts.get(entry.host) ?? 0) + 1);

  return (
    <>
      <Card title="Google results" testId="settings-strip">
        <label className="check">
          <input
            type="checkbox"
            checked={settings.strip.enabled}
            onChange={(e) => void update((draft) => {
              draft.strip.enabled = e.target.checked;
            })}
            data-testid="strip-enabled"
          />
          <span>Show the summary strip above Google results</span>
        </label>
        <Field label="Save Click Potential snapshots" hint="Snapshots are stored on this device only.">
          <select
            value={settings.snapshots.autoSave}
            onChange={(e) => void update((draft) => {
              draft.snapshots.autoSave = e.target.value as typeof settings.snapshots.autoSave;
            })}
            data-testid="autosave"
          >
            <option value="panel">When I view a results page with this panel open</option>
            <option value="always">For every Google results page I open</option>
            <option value="manual">Only when I click Save</option>
          </select>
        </Field>
      </Card>

      <Card title="Privacy and data" testId="settings-privacy">
        <ul className="small">
          <li>{PRODUCT_NAME} reads only pages you open. It never sends searches to Google or prompts to AI sites.</li>
          <li>Nothing leaves this device unless you click a save action while connected to Legiit, and you see exactly what is sent first.</li>
          <li>There is no analytics or tracking.</li>
        </ul>
        <div>
          <h3>Sites you have granted</h3>
          {sites.length === 0 ? (
            <p className="small muted" data-testid="sites-empty">
              None. Sites are requested one scan at a time, and only when you start the scan.
            </p>
          ) : (
            <>
              <div data-testid="sites-list">
                {sites.map((pattern) => (
                  <div className="row between small item" key={pattern}>
                    <span>{siteOfPattern(pattern)}</span>
                    <Button variant="link" small onClick={async () => { await revokeSites([pattern]); void reload(); }}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <Button small onClick={async () => { await revokeSites(sites); void reload(); }} data-testid="sites-remove-all">
                Remove all site access
              </Button>
            </>
          )}
        </div>
        <div>
          <h3>Stored on this device</h3>
          {summary && (
            <p className="small" data-testid="storage-summary">
              {summary.snapshots} snapshot{summary.snapshots === 1 ? '' : 's'} · {summary.briefs} brief{summary.briefs === 1 ? '' : 's'} · {summary.waybackCaptures} cached Wayback capture{summary.waybackCaptures === 1 ? '' : 's'} · {summary.cachedPages} cached page{summary.cachedPages === 1 ? '' : 's'}
            </p>
          )}
          <div className="row">
            <Button small onClick={async () => { await clearCaches(); void reload(); }}>
              Clear caches
            </Button>
            <Button small onClick={async () => { await clearHistory(); void reload(); }} data-testid="clear-history">
              Clear history
            </Button>
            <Button
              small
              variant="danger"
              onClick={async () => {
                await clearAllData();
                await revokeSites(sites);
                await clearAllSettings();
                location.reload();
              }}
              data-testid="erase-all"
            >
              Erase everything
            </Button>
          </div>
        </div>
        <div>
          <h3>Network activity from this window</h3>
          {log.length === 0 ? (
            <p className="small muted" data-testid="network-empty">
              No requests have been made since this window opened.
            </p>
          ) : (
            <ul className="small" data-testid="network-log">
              {[...hosts].map(([host, count]) => (
                <li key={host}>
                  {host} · {count} request{count === 1 ? '' : 's'}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="row small">
          <ExtensionLink page="onboarding.html">What {PRODUCT_NAME} reads and never sends</ExtensionLink>
          <ExtensionLink page="health.html">Selector health check</ExtensionLink>
        </div>
      </Card>
    </>
  );
}

export function SettingsView() {
  const { loaded } = useSettings();
  if (!loaded) return null;
  return (
    <>
      <BrandsSection />
      <AgencySection />
      <LegiitSection />
      <AiSection />
      <PrivacySection />
    </>
  );
}
