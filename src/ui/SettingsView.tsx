/** Settings, shared by the side panel's Settings tab and the options page. */
import { useCallback, useEffect, useState } from 'react';
import { chromeModelAvailability, downloadChromeModel } from '@/ai/provider';
import { PRODUCT_NAME } from '@/config/constants';
import { LEGIIT_API_BASE_URL } from '@/config/runtime';
import { isUnavailable, LegiitError } from '@/legiit/client';
import { noteFailure } from '@/legiit/connection';
import { competitorPayload } from '@/legiit/payloads';
import { applyBusinessDetails, applyConnectedUser, clearBusinessDetails, unselectBusiness } from '@/legiit/prefill';
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
import { SignUpForm, VerifyCode } from './SignUp';

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
  // Each field follows its own stored value, so saving one field never resets another that is being typed in.
  const storedDomains = brand.domains.join(', ');
  const storedAliases = brand.aliases.join(', ');
  useEffect(() => setName(brand.name), [brand.name]);
  useEffect(() => setDomains(storedDomains), [storedDomains]);
  useEffect(() => setAliases(storedAliases), [storedAliases]);

  /** The brand as currently typed (the stored copy lags behind by one save). */
  const typed = (): StoredBrand => ({
    ...brand,
    name: name.trim() || brand.name,
    domains: [...new Set(splitList(domains).map((d) => normalizeDomainInput(d)).filter((d): d is string => d !== null))],
    aliases: [...new Set(splitList(aliases))].slice(0, 30),
  });

  const commit = () => {
    const next = typed();
    if (JSON.stringify(next) !== JSON.stringify(brand)) onChange(next);
    else setDomains(next.domains.join(', '));
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
            subject={`${brand.id}|${JSON.stringify(competitorPayload(typed()))}`}
            payload={() => competitorPayload(typed())}
            send={(payload, businessId, options) => connection.client!.addCompetitor(businessId, payload, options)}
          />
        </div>
      )}
    </div>
  );
}

function BrandsSection() {
  const { settings, update } = useSettings();
  const list = (kind: 'mine' | 'competitor') => (kind === 'mine' ? settings.myBrands : settings.competitors);
  /** Applies a change to the stored list (not to the copy on screen), so edits made elsewhere are kept. */
  const edit = (kind: 'mine' | 'competitor', change: (brands: StoredBrand[]) => StoredBrand[]) =>
    update((draft) => {
      if (kind === 'mine') draft.myBrands = change(draft.myBrands);
      else draft.competitors = change(draft.competitors);
    });
  const add = (kind: 'mine' | 'competitor') => {
    const fresh: StoredBrand = { id: randomId('brand'), name: '', domains: [], aliases: [], source: 'manual' };
    void edit(kind, (brands) => [...brands, fresh]);
  };
  const section = (kind: 'mine' | 'competitor', title: string, hint: string, addLabel: string) => (
    <Card title={title} testId={`brands-${kind}`}>
      <p className="small muted">{hint}</p>
      <div>
        {list(kind).map((brand) => (
          <BrandEditor
            key={brand.id}
            brand={brand}
            kind={kind}
            onChange={(next) => void edit(kind, (brands) => brands.map((b) => (b.id === brand.id ? next : b)))}
            onRemove={() => void edit(kind, (brands) => brands.filter((b) => b.id !== brand.id))}
          />
        ))}
      </div>
      <div className="row">
        <Button small onClick={() => add(kind)} data-testid={`add-${kind}`}>
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
  const { connection, loading, connect, retry, disconnect, can, refreshCapabilities, signup } = useConnection();
  const { settings, update } = useSettings();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<LegiitBusiness[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const client = connection.client;
  const canList = can('listBusinesses');

  useEffect(() => {
    let alive = true;
    setBusinesses(null);
    setListError(null);
    if (!client || !canList) return;
    client.listBusinesses().then(
      (list) => alive && setBusinesses(list),
      (e: unknown) => {
        if (!alive) return;
        // The list stays "not known": an account whose list could not be read is not an account without businesses.
        if (isUnavailable(e)) {
          // Legiit does not offer the list (yet): the drop-down goes away, like any other feature that is not there.
          noteFailure('listBusinesses', e);
          refreshCapabilities();
        } else {
          setListError(`Could not load your businesses: ${errorMessage(e)}`);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [client, canList, refreshCapabilities]);

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await connect(token);
      setToken('');
      setNote(null);
      const userId = next.session?.user.id;
      if (userId) await update((draft) => applyConnectedUser(draft, userId));
    } catch (e) {
      setError(e instanceof LegiitError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** "Try again": the token in the field when one was typed, otherwise the one that is stored. */
  const tryAgain = () => {
    if (token.trim()) {
      void onConnect();
      return;
    }
    setError(null);
    void retry();
  };

  const onDisconnect = async () => {
    setNote(null);
    setError(null);
    await disconnect();
    // Nothing from the account stays behind: brands, competitors, focus keywords and avatars that were pre-filled.
    await update((draft) => clearBusinessDetails(draft));
  };

  const chooseBusiness = async (id: string) => {
    setNote(null);
    if (!client) return;
    if (!id) {
      // Only the business is unselected: the user stays connected, and stays known.
      await update((draft) => unselectBusiness(draft));
      return;
    }
    try {
      // The id the user chose is the one that is kept and used for saves, whatever form the reply gives it in.
      const details = { ...(await client.getBusinessDetails(id)), id };
      await update((draft) => applyBusinessDetails(draft, details));
      setNote({ tone: 'ok', text: `Tracked brands and ${details.competitors.length} competitor${details.competitors.length === 1 ? '' : 's'} were pre-filled from ${details.name || 'this business'}.` });
    } catch (e) {
      setNote({ tone: 'error', text: `Could not load that business: ${isUnavailable(e) ? 'Legiit does not offer business details yet.' : errorMessage(e)}` });
    }
  };

  const stored = settings.legiit.businessId;
  /** The list was read and the chosen business is not in it (also when the list is empty). */
  const gone = businesses !== null && stored !== null && !businesses.some((b) => b.id === stored);
  const user = connection.session?.user;

  return (
    <Card title="Legiit account" testId="settings-legiit">
      {loading ? (
        <p className="muted">Checking…</p>
      ) : connection.status === 'connected' && connection.session ? (
        <>
          <div className="row" data-testid="legiit-connected">
            <Chip tone="ok">Connected</Chip>
            <span>
              {user?.name.trim() || user?.email?.trim() || 'Legiit account'}
              {connection.session.plan ? ` · ${connection.session.plan}` : ''}
            </span>
          </div>
          {canList && (
            <Field label="Business" hint="Saves go to this business, and its brand names and competitors are pre-filled.">
              <select value={gone ? '' : (stored ?? '')} onChange={(e) => void chooseBusiness(e.target.value)} data-testid="legiit-business">
                <option value="">Choose a business…</option>
                {/* While the list is loading, or could not be loaded, the chosen business still shows as chosen. */}
                {stored !== null && businesses === null && <option value={stored}>{settings.legiit.businessName || stored}</option>}
                {(businesses ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name || b.domain || b.id}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {listError && (
            <Notice tone="error" testId="legiit-businesses-error">
              {listError}
            </Notice>
          )}
          {gone && (
            <Notice tone="warn" testId="legiit-business-gone">
              {settings.legiit.businessName || 'The business you chose'} is no longer in this Legiit account.{' '}
              {businesses.length > 0 ? 'Choose a business again.' : 'Saves cannot reach it any more.'}
            </Notice>
          )}
          {canList && !listError && businesses !== null && businesses.length === 0 && (
            <p className="small muted" data-testid="legiit-no-businesses">
              This Legiit account has no businesses yet. Add one in Command Center, then open this page again.
            </p>
          )}
          {note && (
            <Notice tone={note.tone} testId="legiit-business-note">
              {note.text}
            </Notice>
          )}
          {settings.legiit.focusKeywords.length > 0 && (
            <div className="small">
              <strong>Focus keywords:</strong> {settings.legiit.focusKeywords.join(' · ')}
            </div>
          )}
          <div className="row">
            <Button small variant="danger" onClick={() => void onDisconnect()} data-testid="legiit-disconnect">
              Disconnect
            </Button>
            <span className="small muted">Removes the token and everything pre-filled from Command Center from this device.</span>
          </div>
        </>
      ) : (
        <>
          {signup ? <VerifyCode /> : <SignUpForm />}
          <p className="small muted">Or paste a token: create one under Account Settings → Legiit Lens API on legiit.com.</p>
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
          {connection.tokenKept && !busy && (
            // A token is still stored: nothing has to be pasted again to try once more. When another token was typed
            // into the field, "Try again" tries that one, not the one stored before.
            <>
              <div className="row">
                <Button small onClick={tryAgain} data-testid="legiit-retry">
                  Try again
                </Button>
                <span className="small muted" data-testid="legiit-kept">
                  {token.trim() ? 'The token stored before is still on this device.' : 'Your token is still stored on this device.'}
                </span>
              </div>
              <div className="row">
                <Button small variant="danger" onClick={() => void onDisconnect()} data-testid="legiit-forget">
                  Remove the token
                </Button>
                <span className="small muted">Deletes the stored token and everything pre-filled from Command Center from this device.</span>
              </div>
            </>
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
          onChange={(e) => {
            const checked = e.target.checked;
            void update((draft) => {
              draft.ai.chromePromptOptIn = checked;
            });
          }}
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
            onChange={(e) => {
              const checked = e.target.checked;
              void update((draft) => {
                draft.strip.enabled = checked;
              });
            }}
            data-testid="strip-enabled"
          />
          <span>Show the summary strip above Google results</span>
        </label>
        <Field label="Save Click Potential snapshots" hint="Snapshots are stored on this device only.">
          <select
            value={settings.snapshots.autoSave}
            onChange={(e) => {
              const mode = e.target.value as typeof settings.snapshots.autoSave;
              void update((draft) => {
                draft.snapshots.autoSave = mode;
              });
            }}
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
