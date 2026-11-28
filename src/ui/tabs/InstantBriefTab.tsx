/** E. Instant Brief: a client brief built from the business website in the current tab. */
import { useCallback, useEffect, useState } from 'react';
import { briefRewriteRequest, rewriteBrief } from '@/ai/brief-rewrite';
import { legiitAiPayload } from '@/ai/provider';
import { displayName } from '@/brands/matcher';
import { ownHomeUrl } from '@/brands/own-site';
import { parseHtml } from '@/extract/html';
import { extractPageFacts } from '@/extract/page-facts';
import { composeBrief, withRewrites, type Brief, type BriefCompetitor } from '@/features/instant-brief/compose';
import { assembleSitePages, linksToRead, pickSitePages, sameDocument } from '@/features/instant-brief/crawl';
import { extractBusinessFacts } from '@/features/instant-brief/extract';
import { findIssues } from '@/features/instant-brief/issues';
import { briefToMarkdown } from '@/features/instant-brief/markdown';
import { searchEntries } from '@/features/instant-brief/search';
import { recordRun } from '@/features/shared/gating';
import { markUnavailable } from '@/legiit/connection';
import { workspacePayload } from '@/legiit/payloads';
import { mapLimit } from '@/lib/async';
import { downloadText } from '@/lib/csv';
import { randomId } from '@/lib/hash';
import { normalizeDomainInput, safeHttpUrl, slugify, stripWww } from '@/lib/sanitize';
import { pluralize } from '@/lib/text';
import { BrandStyleSchema, PageSnapshotSchema, SameOriginFetchReplySchema, type BrandStyle } from '@/model/schemas';
import { isSourcePage } from '@/net/guarded-fetch';
import { fetchPage } from '@/net/page-fetch';
import { requestAccess } from '@/net/permissions';
import { findResultsPages, sendToTab } from '@/panel/tabs';
import { deleteBrief, listBriefs, listKeywords, saveBrief } from '@/storage/db';
import { BriefSections } from '../BriefView';
import { useAiProvider, useConnection, useSettings, useTarget, useTask } from '../hooks';
import { Button, Card, Chip, Dialog, domainLabel, EmptyState, Field, formatDateTime, Notice, ProgressBar } from '../kit';
import { AccessCard, KeepAccess, PermissionLine, SaveToLegiit } from '../shared';

interface Candidate extends BriefCompetitor {
  checked: boolean;
}

export function InstantBriefTab() {
  const { access } = useTarget();
  const { settings, matcher } = useSettings();
  const { connection, refreshCapabilities } = useConnection();
  const provider = useAiProvider();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [saved, setSaved] = useState<Brief[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [newName, setNewName] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [pullNote, setPullNote] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [confirmAi, setConfirmAi] = useState(false);
  /** Pages of the site that could not be read in the build that produced the brief on screen. */
  const [unread, setUnread] = useState<string[]>([]);
  const task = useTask<{ brief: Brief; unread: string[] }>();

  const ready = access.status === 'ready' ? access : null;
  const onPage = ready?.ping.agent === 'page';
  const tabId = ready?.tabId ?? null;
  const pageUrl = onPage ? ready.ping.url : null;
  const host = pageUrl ? domainLabel(pageUrl) : '';

  // Without a business website in the tab (a results page, an AI answer, a new tab), the site is named by its
  // address and read by the extension itself, after Chrome asked for that one site.
  const byAddress = !onPage && (access.status === 'ready' || access.status === 'none');
  const [siteText, setSiteText] = useState('');
  const [siteTouched, setSiteTouched] = useState(false);
  const [denied, setDenied] = useState(false);
  const ownSite = ownHomeUrl(settings.myBrands);
  useEffect(() => {
    if (!siteTouched) setSiteText(ownSite);
  }, [ownSite, siteTouched]);
  const typedSite = safeHttpUrl(siteText.trim());
  const siteUrl = typedSite && !isSourcePage(typedSite) ? typedSite : null;

  const reloadSaved = useCallback(async () => setSaved(await listBriefs()), []);
  useEffect(() => {
    void reloadSaved();
  }, [reloadSaved]);

  // Tracked competitors are offered first; the user decides which belong in this brief.
  useEffect(() => {
    setCandidates((current) => {
      // A competitor tracked without a name is called by its domain, here as everywhere else.
      const tracked: Candidate[] = settings.competitors.map((c) => ({ name: displayName(c), domain: c.domains[0] ?? null, source: 'tracked', checked: true }));
      const others = current.filter((c) => c.source !== 'tracked');
      return [...tracked.map((t) => ({ ...t, checked: current.find((c) => c.source === 'tracked' && c.name === t.name)?.checked ?? true })), ...others];
    });
  }, [settings.competitors]);

  const chosen = (): BriefCompetitor[] => candidates.filter((c) => c.checked).map(({ name, domain, source }) => ({ name, domain, source }));

  type Progress = (done: number, total: number, label: string) => void;
  type SiteRead = { url: string; pages: ReturnType<typeof assembleSitePages<Document>>['pages']; unread: string[]; style: BrandStyle | null };

  /** Reads the site through the tab that shows it: same site, no extra permission, no cookies. */
  const readThroughTab = async (tab: number, progress: Progress): Promise<SiteRead> => {
    progress(0, 0, 'Reading this page');
    const snapshot = await sendToTab(tab, { type: 'lens:get-page' }, PageSnapshotSchema);
    const currentDoc = parseHtml(snapshot.html);
    const links = pickSitePages(currentDoc, snapshot.url);
    const others = linksToRead(links, snapshot.url);
    progress(1, links.length, 'Reading site pages');
    const fetched = others.length > 0 ? await sendToTab(tab, { type: 'lens:fetch-same-origin', urls: others.map((l) => l.url) }, SameOriginFetchReplySchema) : { pages: [] };
    const { pages, unread: skipped } = assembleSitePages<Document>({ url: snapshot.url, doc: currentDoc }, links, fetched.pages, parseHtml, sameDocument);
    progress(links.length, links.length, 'Reading brand styling');
    let style: BrandStyle | null = null;
    try {
      style = await sendToTab(tab, { type: 'lens:get-brand-style' }, BrandStyleSchema);
    } catch {
      style = null;
    }
    return { url: snapshot.url, pages, unread: skipped, style };
  };

  /**
   * Reads a site that is in no tab, by its address: the same pages, fetched by the extension from the site the user
   * just granted, without cookies. The colours and the logo of the site need a rendered page, so they are left out.
   */
  const readByAddress = async (address: string, progress: Progress, signal: AbortSignal): Promise<SiteRead> => {
    progress(0, 0, 'Reading the website');
    const first = await fetchPage(address, { signal });
    if (!first.ok) throw new Error(`The website could not be read: ${first.error ?? 'no answer'}. Check the address, or open the website in a tab and build the brief there.`);
    const openUrl = safeHttpUrl(first.finalUrl) ?? address;
    const currentDoc = parseHtml(first.html);
    const links = pickSitePages(currentDoc, openUrl);
    const others = linksToRead(links, openUrl);
    progress(1, links.length, 'Reading site pages');
    const fetched = await mapLimit(others, 3, (link) => fetchPage(link.url, { signal }));
    const { pages, unread: skipped } = assembleSitePages<Document>({ url: openUrl, doc: currentDoc }, links, fetched, parseHtml, sameDocument);
    return { url: openUrl, pages, unread: skipped, style: null };
  };

  const build = async () => {
    const target = byAddress ? siteUrl : null;
    if (byAddress ? target === null : tabId === null) return;
    setAiNote(null);
    setDenied(false);
    // First thing in the click handler: this is where Chrome shows its prompt for the one site.
    if (target && !(await requestAccess([target]))) {
      setDenied(true);
      return;
    }
    void recordRun();
    void task
      .run(async ({ progress, signal }) => {
        const site = target ? await readByAddress(target, progress, signal) : await readThroughTab(tabId!, progress);
        const { pages, unread: skipped, style } = site;
        const snapshot = { url: site.url };
        const facts = extractBusinessFacts(pages, style);
        const issues = findIssues(pages.map((p) => ({ ...p, facts: extractPageFacts(p.doc, p.url) })));
        const siteDomain = stripWww(new URL(snapshot.url).hostname);
        const isTracked = matcher.matchDomain(siteDomain).some((h) => h.owner === 'mine');
        const search = searchEntries((await listKeywords()).map((k) => k.latest), siteDomain, isTracked);
        const built = composeBrief({ id: randomId('brief'), now: Date.now(), facts, issues, competitors: chosen(), search });
        await saveBrief(built);
        return { brief: built, unread: skipped };
      })
      .then((done) => {
        if (done) {
          setBrief(done.brief);
          setUnread(done.unread);
          void reloadSaved();
        }
      });
  };

  const updateCompetitors = async () => {
    if (!brief) return;
    const next = composeBrief({ id: brief.id, now: brief.createdAt, facts: brief.facts, issues: brief.issues, competitors: chosen(), search: brief.search });
    // Keep AI-written drafts if there were any, in the text of the brief as well as in its data.
    const merged = brief.writtenBy === 'template' ? next : withRewrites(next, { avatars: brief.avatars, nextSteps: brief.nextSteps, writtenBy: brief.writtenBy });
    await saveBrief(merged);
    setBrief(merged);
    void reloadSaved();
  };

  const pullFromResults = async () => {
    setPullNote(null);
    const pages = await findResultsPages();
    if (pages.length === 0) {
      setPullNote('No Google results page is open in this window.');
      return;
    }
    const found: Candidate[] = [];
    const siteHost = pageUrl ? stripWww(new URL(pageUrl).hostname) : '';
    for (const page of pages) {
      for (const result of page.serp.organic) {
        // Google can hide the site of a result: such a result names no competitor.
        if (!result.domain) continue;
        if (result.domain === siteHost || matcher.matchDomain(result.domain).some((h) => h.owner === 'mine')) continue;
        const known = [...candidates, ...found].some((c) => c.domain === result.domain);
        if (!known) found.push({ name: matcher.matchDomain(result.domain)[0]?.name ?? result.domain, domain: result.domain, source: 'results', checked: false });
      }
    }
    setCandidates((current) => [...current, ...found.slice(0, 15)]);
    setPullNote(found.length > 0 ? `Added ${Math.min(found.length, 15)} sites from “${pages[0]!.serp.keyword}”. Tick the ones that are real competitors.` : 'Every site on the open results page is already listed.');
  };

  const addManual = () => {
    const name = newName.trim();
    if (!name) return;
    setCandidates((current) => [...current, { name, domain: normalizeDomainInput(newDomain) ?? null, source: 'manual', checked: true }]);
    setNewName('');
    setNewDomain('');
  };

  const improve = async () => {
    if (!brief || !provider) return;
    setConfirmAi(false);
    setAiBusy(true);
    setAiNote(null);
    try {
      const outcome = await rewriteBrief(brief, provider);
      if (outcome.endpointMissing) {
        markUnavailable('completeAI');
        refreshCapabilities();
        setAiNote('Legiit AI is not available yet. The draft text is unchanged.');
      } else if (outcome.keptTemplateBecause) setAiNote(`${provider.label} could not be used (${outcome.keptTemplateBecause}). The draft text is unchanged.`);
      else {
        // The model can take a minute. The rewrite goes onto the brief as it is stored now, not as it was at the
        // click: a brief that was deleted meanwhile stays deleted, competitors that were changed meanwhile stay
        // changed, and the screen only changes if it still shows this brief.
        const latest = (await listBriefs()).find((stored) => stored.id === brief.id);
        if (!latest) return;
        const rewritten = withRewrites(latest, { avatars: outcome.brief.avatars, nextSteps: outcome.brief.nextSteps, writtenBy: outcome.brief.writtenBy });
        await saveBrief(rewritten);
        setBrief((current) => (current?.id === brief.id ? rewritten : current));
        void reloadSaved();
      }
    } finally {
      setAiBusy(false);
    }
  };

  const agency = { name: settings.agency.name, logoDataUrl: settings.agency.logoDataUrl };

  return (
    <>
      <Card title="Client brief" testId="brief-form">
        {onPage ? (
          <>
            <p>
              Build a brief for <strong>{host}</strong> from its own pages: business details, offer, draft customer avatars, issues and next steps.
            </p>
            <p className="small muted" data-testid="brief-disclosure">
              Reads up to 8 pages of {host} (home, about, services, contact, pricing, locations) through this tab, without cookies. Nothing is sent anywhere.
            </p>
            {pageUrl && <KeepAccess url={pageUrl} />}
          </>
        ) : byAddress ? (
          <>
            <p>Build a brief for a business from its own website: business details, offer, draft customer avatars, issues and next steps.</p>
            <Field
              label="Website of the business"
              hint={
                typedSite && !siteUrl
                  ? 'A Google or AI page is not a business website. Type the address of the website.'
                  : siteUrl && ownSite && siteUrl === ownSite
                    ? 'Your own site. Type the address of any business website, for example a client’s.'
                    : 'Reads up to 8 pages of the site (home, about, services, contact, pricing, locations), without cookies. Nothing is sent anywhere.'
              }
            >
              <input
                type="url"
                value={siteText}
                onChange={(e) => {
                  setSiteText(e.target.value);
                  setSiteTouched(true);
                }}
                placeholder="https://example.com"
                data-testid="brief-address"
              />
            </Field>
            {siteUrl && <PermissionLine urls={[siteUrl]} purpose="for this brief" />}
          </>
        ) : (
          <p className="muted">Open a business website to build a brief for it.</p>
        )}
        <div className="row">
          <Button variant="primary" disabled={(byAddress ? siteUrl === null : !onPage) || task.status === 'running'} onClick={() => void build()} data-testid="brief-build">
            {brief ? 'Build again' : 'Build brief'}
          </Button>
        </div>
        {denied && (
          <Notice tone="warn" testId="brief-denied">
            Permission was not granted, so nothing was fetched.
          </Notice>
        )}
        {task.status === 'running' && task.progress && <ProgressBar done={task.progress.done} total={task.progress.total} label={task.progress.label} />}
        {task.status === 'error' && (
          <Notice tone="error" testId="brief-error">
            {task.error}
          </Notice>
        )}
      </Card>

      {access.status === 'no-access' && <AccessCard />}

      <Card title="Competitors" testId="brief-competitors">
        {candidates.length === 0 && <p className="muted">No competitors yet. Add some below or pull them from an open Google results page.</p>}
        {candidates.map((c, i) => (
          <label className="check small" key={`${c.source}-${c.name}-${i}`}>
            <input type="checkbox" checked={c.checked} onChange={(e) => setCandidates((current) => current.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))} />
            <span className="break">
              {c.name} {c.domain && c.domain !== c.name && <span className="muted">({c.domain})</span>} {c.source === 'tracked' && <Chip>Tracked</Chip>}
              {c.source === 'results' && <Chip>From results</Chip>}
            </span>
          </label>
        ))}
        <div className="grid2">
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Competitor name" aria-label="Competitor name" data-testid="brief-competitor-name" />
          <input type="text" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="domain.com (optional)" aria-label="Competitor domain" />
        </div>
        <div className="row">
          <Button small onClick={addManual} disabled={!newName.trim()} data-testid="brief-competitor-add">
            Add
          </Button>
          <Button small onClick={() => void pullFromResults()} data-testid="brief-pull-results">
            Pull from open results page
          </Button>
          {brief && (
            <Button small onClick={() => void updateCompetitors()} data-testid="brief-update-competitors">
              Update brief
            </Button>
          )}
        </div>
        {pullNote && <p className="small muted">{pullNote}</p>}
      </Card>

      {brief && (
        <Card
          title={brief.businessName}
          testId="brief-result"
          actions={
            brief.facts.logoDataUrl ? <img src={brief.facts.logoDataUrl} alt={`${brief.businessName} logo`} style={{ maxHeight: 28, maxWidth: 110 }} data-testid="brief-logo" /> : undefined
          }
        >
          <div className="small muted">
            {formatDateTime(brief.createdAt)} · {pluralize(brief.facts.pages.length, 'page')} read · drafts written by{' '}
            {brief.writtenBy === 'template' ? 'built-in templates (no AI)' : brief.writtenBy === 'legiit' ? 'Legiit AI' : 'on-device AI'}
          </div>
          {unread.length > 0 && (
            <p className="small muted" data-testid="brief-unread">
              {pluralize(unread.length, 'page')} could not be read and {unread.length === 1 ? 'was' : 'were'} left out:{' '}
              {unread.map((url) => new URL(url).pathname).join(', ')}
            </p>
          )}
          {brief.facts.brandColors.length > 0 && (
            <div className="small" data-testid="brief-colors">
              {brief.facts.brandColors.map((c) => (
                <span key={c.hex} style={{ marginRight: 10 }} title={c.source}>
                  <span className="swatch" style={{ background: c.hex }} />
                  {c.hex}
                </span>
              ))}
            </div>
          )}
          <div className="row">
            <Button small onClick={() => downloadText(`client-brief-${slugify(brief.businessName)}.md`, 'text/markdown', briefToMarkdown(brief, agency))} data-testid="brief-markdown">
              Export Markdown
            </Button>
            <Button small onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?id=${encodeURIComponent(brief.id)}`) })} data-testid="brief-print">
              Print / save as PDF
            </Button>
            {provider && provider.id !== 'none' && (
              <Button small disabled={aiBusy} onClick={() => (provider.remote ? setConfirmAi(true) : void improve())} data-testid="brief-ai">
                {aiBusy ? 'Writing…' : `Improve drafts with ${provider.id === 'legiit' ? 'Legiit AI' : 'on-device AI'}`}
              </Button>
            )}
            {connection.client && (
              <SaveToLegiit
                method="createWorkspaceFromBrief"
                label="Open in Command Center"
                needsBusiness={false}
                // The same brief with other competitors, or rewritten by AI, has not been sent yet.
                subject={`${brief.id}|${brief.writtenBy}|${brief.competitors.map((c) => `${c.name}/${c.domain ?? ''}`).join(',')}`}
                payload={() => workspacePayload(brief, briefToMarkdown(brief, agency))}
                send={(payload, _businessId, options) => connection.client!.createWorkspaceFromBrief(payload, options)}
              />
            )}
          </div>
          {!agency.name && <p className="small muted">Add your agency name and logo in Settings to brand the exports.</p>}
          {aiNote && <Notice tone="warn">{aiNote}</Notice>}
          <div className="stack">
            <BriefSections brief={brief} />
          </div>
        </Card>
      )}

      {!brief && saved.length === 0 && task.status === 'idle' && !onPage && access.status !== 'no-access' && (
        <Card>
          <EmptyState title="No briefs yet" testId="brief-empty">
            Type the address of a business website above, or open the website in a tab, and build your first brief.
          </EmptyState>
        </Card>
      )}

      {saved.length > 0 && (
        <Card title="Saved briefs" testId="brief-saved">
          {saved.map((b) => (
            <div className="item row between" key={b.id}>
              <Button
                variant="link"
                onClick={() => {
                  setBrief(b);
                  setUnread([]);
                }}
              >
                {b.businessName}
              </Button>
              <span className="row small muted">
                {formatDateTime(b.createdAt)}
                <Button
                  variant="link"
                  small
                  onClick={async () => {
                    await deleteBrief(b.id);
                    if (brief?.id === b.id) setBrief(null);
                    void reloadSaved();
                  }}
                >
                  Delete
                </Button>
              </span>
            </div>
          ))}
        </Card>
      )}

      {confirmAi && brief && (
        <Dialog
          title="Send to Legiit AI?"
          onClose={() => setConfirmAi(false)}
          testId="ai-confirm"
          footer={
            <>
              <Button onClick={() => setConfirmAi(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void improve()} data-testid="ai-confirm-send">
                Send
              </Button>
            </>
          }
        >
          <p>This is exactly what will be sent to Legiit. Nothing else leaves your device.</p>
          <pre className="payload">{JSON.stringify(legiitAiPayload(briefRewriteRequest(brief)), null, 2)}</pre>
          <p className="small muted">Sent with it: your Legiit token and this extension’s version number.</p>
        </Dialog>
      )}
    </>
  );
}
