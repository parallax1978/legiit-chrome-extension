/** Building blocks shared by the feature tabs. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { legiitAiPayload, runProvider, type AiRequest } from '@/ai/provider';
import { PRODUCT_NAME, SUGGESTED_SHORTCUT } from '@/config/constants';
import { downloadText } from '@/lib/csv';
import { errorMessage } from '@/lib/async';
import { markUnavailable, noteFailure } from '@/legiit/connection';
import { isUnavailable, LegiitError, type LegiitMethod, type SaveOptions } from '@/legiit/client';
import type { SaveResult } from '@/legiit/types';
import { describeSites, hasAccess, requestAccess } from '@/net/permissions';
import { Button, Card, Chip, Dialog, ExternalLink, Lines, Notice } from './kit';
import { useAiProvider, useConnection, useSettings, useTarget } from './hooks';

/**
 * Shown when the panel cannot read the current tab.
 *
 * Chrome grants access to a page (activeTab) only when the user invokes the
 * extension: toolbar icon, keyboard shortcut or context menu. A click inside
 * the side panel does not count, and without access the panel cannot even
 * see the page's address, so it cannot ask for that site by name. Each of the
 * three ways below is a single action and gives access to this page only.
 */
export function AccessCard() {
  const { refresh } = useTarget();
  const [shortcut, setShortcut] = useState(SUGGESTED_SHORTCUT);
  useEffect(() => {
    chrome.commands
      ?.getAll()
      .then((commands) => setShortcut(commands.find((c) => c.name === '_execute_action')?.shortcut ?? ''))
      .catch(() => undefined);
  }, []);
  return (
    <Card title="Analyze this page" testId="access-card">
      <p>
        {PRODUCT_NAME} reads a page only when you ask it to. Chrome gives it access to this page when you do any one of these:
      </p>
      <ol>
        <li>
          <strong>Click the {PRODUCT_NAME} icon</strong> in the toolbar <img src="/icon/16.png" alt="" width={14} height={14} style={{ verticalAlign: '-2px' }} />
          <span className="muted"> (in the puzzle-piece menu if it is not pinned)</span>
        </li>
        <li>
          {shortcut ? (
            <>
              Press <span className="kbd">{shortcut}</span>
            </>
          ) : (
            <>
              Set a keyboard shortcut at <span className="mono">chrome://extensions/shortcuts</span>
            </>
          )}
        </li>
        <li>
          Right-click the page and choose <strong>Analyze this page with {PRODUCT_NAME}</strong>
        </li>
      </ol>
      <p className="small muted">
        Access lasts while you stay on this site in this tab. Clicks inside this panel cannot grant it, and Chrome pages and the Chrome Web Store can never be read.
      </p>
      <div className="row">
        <Button small onClick={refresh}>
          Check again
        </Button>
      </div>
    </Card>
  );
}

/** Offers standing access to the site in the current tab, so the panel works there without invoking each time. */
export function KeepAccess({ url }: { url: string }) {
  const [state, setState] = useState<'unknown' | 'temporary' | 'granted' | 'declined'>('unknown');
  useEffect(() => {
    let alive = true;
    void hasAccess(url).then((granted) => alive && setState(granted ? 'granted' : 'temporary'));
    return () => {
      alive = false;
    };
  }, [url]);
  if (state === 'unknown' || state === 'granted') return null;
  const site = describeSites([url])[0] ?? 'this site';
  return (
    <div className="small muted row" data-testid="keep-access">
      <span>Access to {site} is for this visit only.</span>
      <Button
        variant="link"
        small
        title={`Chrome will ask to let ${PRODUCT_NAME} read ${site} whenever this panel is open. You can remove it in Settings.`}
        onClick={async () => setState((await requestAccess([url])) ? 'granted' : 'declined')}
      >
        Always allow on {site}
      </Button>
      {state === 'declined' && <span>Not granted.</span>}
    </div>
  );
}

/** Explanation lines from the deterministic templates, with an optional AI rewrite. */
export function Summary({ title = 'What explains it', request, testId }: { title?: string; request: AiRequest; testId?: string }) {
  const provider = useAiProvider();
  const { refreshCapabilities } = useConnection();
  const [lines, setLines] = useState<string[] | null>(null);
  const [writtenBy, setWrittenBy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const signature = request.fallback.join('\n');
  const current = useRef(signature);
  current.current = signature;

  useEffect(() => {
    // New facts: back to the template text.
    setLines(null);
    setWrittenBy(null);
    setNote(null);
  }, [signature]);

  const rewrite = async () => {
    if (!provider) return;
    setConfirming(false);
    setBusy(true);
    setNote(null);
    const asked = signature;
    try {
      const outcome = await runProvider(provider, request);
      if (outcome.endpointMissing) {
        // Legiit has no AI endpoint (yet): say so once, then stop offering it, like a save that cannot be received.
        markUnavailable('completeAI');
        refreshCapabilities();
      }
      // The facts on screen changed while the model was writing: its text belongs to the old ones.
      if (current.current !== asked) return;
      setLines(outcome.lines);
      setWrittenBy(outcome.fellBackBecause ? null : provider.label);
      if (outcome.endpointMissing) setNote('Legiit AI is not available yet. Showing the built-in summary.');
      else if (outcome.fellBackBecause) setNote(`${provider.label} could not be used (${outcome.fellBackBecause}). Showing the built-in summary.`);
    } finally {
      setBusy(false);
    }
  };

  const canRewrite = provider !== null && provider.id !== 'none';
  return (
    <Card
      title={title}
      testId={testId}
      actions={
        canRewrite ? (
          <Button small disabled={busy} onClick={() => (provider.remote ? setConfirming(true) : void rewrite())} data-testid="ai-rewrite">
            {busy ? 'Writing…' : `Rewrite with ${provider.id === 'legiit' ? 'Legiit AI' : 'on-device AI'}`}
          </Button>
        ) : undefined
      }
    >
      <Lines lines={lines ?? request.fallback} />
      <div className="small muted" data-testid="summary-source">
        {writtenBy ? `Rewritten by ${writtenBy} from the facts above. Check it before sharing.` : 'Built from the measured facts. No AI was used.'}
      </div>
      {note && <Notice tone="warn">{note}</Notice>}
      {confirming && (
        <Dialog
          title="Send to Legiit AI?"
          onClose={() => setConfirming(false)}
          testId="ai-confirm"
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void rewrite()} data-testid="ai-confirm-send">
                Send
              </Button>
            </>
          }
        >
          <p>This is exactly what will be sent to Legiit. Nothing else leaves your device.</p>
          <pre className="payload">{JSON.stringify(legiitAiPayload(request), null, 2)}</pre>
          <p className="small muted">Sent with it: your Legiit token and this extension’s version number.</p>
        </Dialog>
      )}
    </Card>
  );
}

const NOT_OFFERED = 'Legiit cannot receive this yet. Nothing was saved.';

/** One save the user asked for: what is sent, where, and how. */
interface SaveRequest {
  method: LegiitMethod;
  label: string;
  /** Names the thing that is saved (a snapshot, a brief…). The "Saved" mark belongs to it, not to the button. */
  subject: string;
  body: unknown;
  needsBusiness: boolean;
  send: (payload: unknown, businessId: string, options: SaveOptions) => Promise<SaveResult>;
}

interface SaveHostValue {
  /** Opens the dialog that shows the body. Nothing is sent before the user confirms there. */
  open: (request: SaveRequest) => void;
  /** The result of saving this thing, as long as it was saved into the business that is chosen now. */
  saved: (method: LegiitMethod, subject: string) => SaveResult | null;
  /** A dialog is open: no second one can be started. */
  busy: boolean;
}

const SaveHostContext = createContext<SaveHostValue | null>(null);

/**
 * Owns the "send to Legiit" dialog for a whole extension page. It sits above the tabs, so a save that is under way
 * stays on screen whatever the user does meanwhile (the side panel follows the browser tab, and a tab's content is
 * removed when the user looks at another page): the user always sees whether it was saved, and a result is never
 * lost in a way that invites sending the same thing twice.
 */
export function SaveHostProvider({ children }: { children: ReactNode }) {
  const { can, refreshCapabilities } = useConnection();
  const { settings } = useSettings();
  const [request, setRequest] = useState<SaveRequest | null>(null);
  const [state, setState] = useState<{ status: 'idle' | 'sending' | 'error'; message?: string }>({ status: 'idle' });
  /** What was saved in this page: by method and subject. */
  const [marks, setMarks] = useState<Record<string, { result: SaveResult; businessId: string | null }>>({});
  /** The one-time key of the open dialog, and the business it was last sent for. */
  const attempt = useRef<{ key: string; sentTo: string | null }>({ key: '', sentTo: null });
  /** True while a dialog is open (known at once, before the next render). */
  const occupied = useRef(false);

  const businessId = settings.legiit.businessId;
  const sending = state.status === 'sending';
  const available = request ? can(request.method) : true;

  const open = useCallback((next: SaveRequest) => {
    // One dialog at a time: a second one could only be started from behind the first.
    if (occupied.current) return;
    occupied.current = true;
    attempt.current = { key: crypto.randomUUID(), sentTo: null };
    setState({ status: 'idle' });
    setRequest(next);
  }, []);

  /** While a send is under way the dialog stays, so its outcome is always seen. */
  const close = () => {
    if (sending) return;
    occupied.current = false;
    setRequest(null);
  };

  const confirm = async () => {
    if (request === null || sending) return;
    const target = request.needsBusiness ? (businessId ?? '') : '';
    // One key per save: sending again from this dialog repeats the key, so Legiit can avoid storing the item twice.
    // The same item for another business (chosen meanwhile on another page) is another save and gets its own key.
    if (attempt.current.sentTo !== null && attempt.current.sentTo !== target) attempt.current.key = crypto.randomUUID();
    attempt.current.sentTo = target;
    setState({ status: 'sending' });
    try {
      const result = await request.send(request.body, target, { idempotencyKey: attempt.current.key });
      setMarks((current) => ({ ...current, [`${request.method}|${request.subject}`]: { result, businessId: request.needsBusiness ? target : null } }));
      setState({ status: 'idle' });
      occupied.current = false;
      setRequest(null);
    } catch (error) {
      noteFailure(request.method, error);
      refreshCapabilities();
      const message = isUnavailable(error) ? NOT_OFFERED : error instanceof LegiitError ? error.message : errorMessage(error);
      setState({ status: 'error', message });
    }
  };

  const value = useMemo<SaveHostValue>(
    () => ({
      open,
      saved: (method, subject) => {
        const mark = marks[`${method}|${subject}`];
        return mark && (mark.businessId === null || mark.businessId === (businessId ?? '')) ? mark.result : null;
      },
      busy: request !== null,
    }),
    [open, marks, businessId, request],
  );

  return (
    <SaveHostContext.Provider value={value}>
      {children}
      {request && (
        <Dialog
          title={request.label}
          onClose={close}
          testId="save-dialog"
          footer={
            <>
              <Button disabled={sending} onClick={close} data-testid="save-cancel">
                Cancel
              </Button>
              <Button variant="primary" disabled={sending || !available || (request.needsBusiness && !businessId)} onClick={() => void confirm()} data-testid="save-confirm">
                {sending ? 'Sending…' : 'Send to Legiit'}
              </Button>
            </>
          }
        >
          {request.needsBusiness && !businessId ? (
            <Notice tone="warn">Choose a business under Settings → Legiit account first.</Notice>
          ) : (
            <p>
              This is exactly what will be sent to Legiit Command Center{request.needsBusiness && settings.legiit.businessName ? ` for ${settings.legiit.businessName}` : ''}. Nothing else leaves your device.
            </p>
          )}
          <pre className="payload" data-testid="save-payload">
            {JSON.stringify(request.body, null, 2)}
          </pre>
          <p className="small muted" data-testid="save-also-sent">
            Sent with it: your Legiit token, this extension’s version number, and a one-time number that stops an accidental repeat from being stored twice.
          </p>
          {state.status === 'error' ? (
            <Notice tone="error" testId="save-error">
              {state.message}
            </Notice>
          ) : (
            // Send is switched off whenever Legiit does not offer this; the reason is always next to it.
            !available && (
              <Notice tone="error" testId="save-error">
                {NOT_OFFERED}
              </Notice>
            )
          )}
        </Dialog>
      )}
    </SaveHostContext.Provider>
  );
}

function useSaveHost(): SaveHostValue {
  const value = useContext(SaveHostContext);
  if (!value) throw new Error('SaveHostProvider is missing');
  return value;
}

/**
 * "Save to Command Center". Hidden unless a Legiit account is connected and
 * the endpoint is available. The dialog (in SaveHostProvider) shows the exact
 * payload and sends that same object only after the user confirms.
 */
export function SaveToLegiit<T>({
  method,
  label = 'Save to Command Center',
  subject,
  payload,
  send,
  needsBusiness = true,
  testId,
}: {
  method: LegiitMethod;
  label?: string;
  /** Names what is saved, so that "Saved" is shown for that thing only: an id, or a short signature of the content. */
  subject: string;
  /** Built when the dialog opens, so it reflects what is on screen. */
  payload: () => T;
  send: (payload: T, businessId: string, options: SaveOptions) => Promise<SaveResult>;
  needsBusiness?: boolean;
  testId?: string;
}) {
  const { can } = useConnection();
  const host = useSaveHost();
  // The button goes away when Legiit turns out not to offer this. An open dialog stays, so the user reads why.
  if (!can(method)) return null;
  const result = host.saved(method, subject);
  const start = () =>
    host.open({ method, label, subject, body: payload(), needsBusiness, send: (body, businessId, options) => send(body as T, businessId, options) });
  return (
    <>
      <Button small disabled={host.busy} onClick={start} data-testid={testId ?? `save-${method}`}>
        {label}
      </Button>
      {result && (
        <span className="small" data-testid="save-result">
          <Chip tone="ok">Saved</Chip> {result.url && <ExternalLink href={result.url}>Open in Command Center</ExternalLink>}
        </span>
      )}
    </>
  );
}

export function CsvButton({
  filename,
  build,
  label = 'Export CSV',
  testId,
}: {
  filename: string;
  build: () => string | Promise<string>;
  label?: string;
  testId?: string;
}) {
  return (
    <Button small onClick={async () => downloadText(filename, 'text/csv', await build())} data-testid={testId}>
      {label}
    </Button>
  );
}

/** One line of explanation shown right where a site permission is about to be requested. */
export function PermissionLine({ urls, purpose }: { urls: readonly string[]; purpose: string }) {
  const sites = describeSites(urls);
  if (sites.length === 0) return null;
  const shown = sites.slice(0, 6).join(', ');
  return (
    <p className="small muted" data-testid="permission-line">
      Chrome will ask to let {PRODUCT_NAME} read {sites.length === 1 ? 'this site' : `these ${sites.length} sites`} ({shown}
      {sites.length > 6 ? `, and ${sites.length - 6} more` : ''}) {purpose}. Pages are fetched by your browser without cookies; nothing is sent to Legiit.
    </p>
  );
}

export function BrandsNeeded({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <Notice tone="warn" testId="brands-needed">
      Add your brand and at least one competitor to see who appears where.{' '}
      <Button variant="link" onClick={onOpenSettings}>
        Open Settings
      </Button>
    </Notice>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="stack">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
