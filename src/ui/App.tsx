/**
 * The side panel over one target page. It opens on the Overview: what the page means for the user, in plain words.
 * The five tools hold the detail and are one click away; Settings is the third place.
 */
import { useEffect, useState } from 'react';
import { PRODUCT_NAME } from '@/config/constants';
import { AI_SITES } from '@/config/sites';
import { currentGate, type GateState } from '@/features/shared/gating';
import { prunePageCache } from '@/storage/db';
import { useConnection, useTarget } from './hooks';
import { Card, Chip, Notice } from './kit';
import { SettingsView } from './SettingsView';
import { SignUpForm, VerifyCode } from './SignUp';
import type { ToolId } from '@/features/overview/overview';
import { ClickPotentialTab } from './tabs/ClickPotentialTab';
import { InstantBriefTab } from './tabs/InstantBriefTab';
import { NewOrNoiseTab } from './tabs/NewOrNoiseTab';
import { OverviewTab } from './tabs/OverviewTab';
import { RewindTab } from './tabs/RewindTab';
import { WhyNotMeTab } from './tabs/WhyNotMeTab';

/** The tools, named for what the user gets from each. The ids are the ones links and tests open them by. */
export const TOOLS: readonly (readonly [ToolId, string, string])[] = [
  ['click', 'This search', 'What fills the results page, and where each result sits'],
  ['why', 'Who’s beating me', 'Where competitors show up and you do not'],
  ['noise', 'Content check', 'Whether a page says anything the pages it competes with do not'],
  ['rewind', 'What changed', 'How a page changed over time'],
  ['brief', 'Site brief', 'A report on a business website'],
];

type TabId = 'overview' | ToolId | 'settings';
const isTool = (id: TabId): id is ToolId => id !== 'overview' && id !== 'settings';

function initialTab(): TabId {
  const requested = new URLSearchParams(location.search).get('view');
  return requested === 'overview' || requested === 'settings' || TOOLS.some(([id]) => id === requested) ? (requested as TabId) : 'overview';
}

function TargetLine() {
  const { access } = useTarget();
  if (access.status === 'loading') return <div className="target">Looking at the current tab…</div>;
  if (access.status === 'none') return <div className="target">No page to look at.</div>;
  if (access.status === 'no-access') {
    return (
      <div className="target" data-testid="target-line">
        <Chip tone="warn">No access to this page yet</Chip>
      </div>
    );
  }
  const { ping } = access;
  const kind = ping.agent === 'google' ? (ping.serp ? 'Google results' : 'Google') : ping.agent === 'ai' && ping.site ? AI_SITES[ping.site].label : 'Page';
  return (
    <div className="target" data-testid="target-line">
      <Chip tone="accent">{kind}</Chip>
      <span className="title" title={ping.url}>
        {ping.title || ping.url}
      </span>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>(initialTab);
  /** The tool "Tools" opens: the last one the user had open, else the one that fits the page. */
  const [lastTool, setLastTool] = useState<ToolId | null>(() => {
    const first = initialTab();
    return isTool(first) ? first : null;
  });
  const { access, intent } = useTarget();
  const { connection, signup } = useConnection();
  const [gate, setGate] = useState<GateState | null>(null);
  const connected = connection.status === 'connected';

  useEffect(() => {
    void prunePageCache().catch(() => undefined);
  }, []);

  // The tools open as soon as Legiit has the email address; the account follows with the code.
  const unlocked = connected || signup !== null;
  useEffect(() => {
    void currentGate(unlocked).then(setGate);
  }, [unlocked, tab]);

  // The tool that fits the page: Google results → This search, an AI answer → Who's beating me, any other page → Site brief.
  const agent = access.status === 'ready' ? access.ping.agent : null;
  const fittingTool: ToolId = agent === 'ai' ? 'why' : agent === 'page' ? 'brief' : 'click';

  const choose = (id: TabId) => {
    setTab(id);
    if (isTool(id)) setLastTool(id);
  };

  // "Check the selected text" from the context menu.
  useEffect(() => {
    if (intent?.intent === 'selection') {
      setTab('noise');
      setLastTool('noise');
    }
  }, [intent]);
  const gated = gate?.gated === true && tab !== 'settings';

  return (
    <div className="app">
      <div className="topbar">
        <div className="brandrow">
          <img src="/icon/48.png" alt="" />
          <span className="name">{PRODUCT_NAME}</span>
          <span className="spacer" />
          {connected && (
            <span data-testid="connection-chip">
              <Chip tone="ok">Legiit connected</Chip>
            </span>
          )}
          {!connected && connection.error && (
            // A token is stored but Legiit could not be reached or refused it: say so here, not only in Settings.
            <button type="button" className="chip-button" onClick={() => choose('settings')} title={`${connection.error} Open Settings.`} data-testid="connection-problem">
              <Chip tone="warn">Legiit not connected</Chip>
            </button>
          )}
        </div>
        <TargetLine />
        <div className="tabs" role="tablist" aria-label={`${PRODUCT_NAME} sections`}>
          <button role="tab" type="button" className="tab" aria-selected={tab === 'overview'} onClick={() => choose('overview')} data-testid="tab-overview">
            Overview
          </button>
          <button role="tab" type="button" className="tab" aria-selected={isTool(tab)} onClick={() => choose(lastTool ?? fittingTool)} data-testid="tab-tools">
            Tools
          </button>
          <button role="tab" type="button" className="tab" aria-selected={tab === 'settings'} onClick={() => choose('settings')} data-testid="tab-settings">
            Settings
          </button>
        </div>
        {isTool(tab) && (
          <div className="tools" role="tablist" aria-label="Tools">
            {TOOLS.map(([id, label, what]) => (
              <button key={id} role="tab" type="button" className="tool" aria-selected={tab === id} onClick={() => choose(id)} title={what} data-testid={`tab-${id}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <main className="content" role="tabpanel" data-testid={`panel-${tab}`}>
        {gated ? (
          <Card title={gate?.limit === 0 ? 'Enter your email to start' : 'Enter your email to keep going'} testId="gate">
            {gate?.limit !== 0 && <Notice tone="warn">You have used your {gate?.limit} free runs.</Notice>}
            <SignUpForm />
            <p className="small muted">
              Already have a Legiit account? Enter its email: the code connects it.{' '}
              <button type="button" className="link-button" onClick={() => choose('settings')} data-testid="signup-use-token">
                Or paste a token in Settings
              </button>
              .
            </p>
          </Card>
        ) : (
          <>
            {!connected && signup && tab !== 'settings' && (
              <Card title="Connect your free Legiit account" testId="verify-card">
                <VerifyCode />
              </Card>
            )}
            {tab === 'overview' && <OverviewTab onOpen={choose} />}
            {tab === 'click' && <ClickPotentialTab />}
            {tab === 'why' && <WhyNotMeTab onOpenSettings={() => choose('settings')} />}
            {tab === 'rewind' && <RewindTab />}
            {tab === 'noise' && <NewOrNoiseTab />}
            {tab === 'brief' && <InstantBriefTab />}
            {tab === 'settings' && <SettingsView />}
          </>
        )}
      </main>
    </div>
  );
}
