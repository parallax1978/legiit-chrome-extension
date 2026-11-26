/** The side panel: six tabs over one target page. */
import { useEffect, useState } from 'react';
import { PRODUCT_NAME } from '@/config/constants';
import { AI_SITES } from '@/config/sites';
import { currentGate, type GateState } from '@/features/shared/gating';
import { prunePageCache } from '@/storage/db';
import { useConnection, useTarget } from './hooks';
import { Card, Chip, Notice } from './kit';
import { SettingsView } from './SettingsView';
import { SignUpForm } from './SignUp';
import { ClickPotentialTab } from './tabs/ClickPotentialTab';
import { InstantBriefTab } from './tabs/InstantBriefTab';
import { NewOrNoiseTab } from './tabs/NewOrNoiseTab';
import { RewindTab } from './tabs/RewindTab';
import { WhyNotMeTab } from './tabs/WhyNotMeTab';

const TABS = [
  ['click', 'Click Potential'],
  ['why', 'Why Not Me'],
  ['rewind', 'Rewind'],
  ['noise', 'New or Noise'],
  ['brief', 'Instant Brief'],
  ['settings', 'Settings'],
] as const;

type TabId = (typeof TABS)[number][0];

function initialTab(): TabId {
  const requested = new URLSearchParams(location.search).get('view');
  return TABS.some(([id]) => id === requested) ? (requested as TabId) : 'click';
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
  const [chosenByUser, setChosenByUser] = useState(new URLSearchParams(location.search).has('view'));
  const { access, intent } = useTarget();
  const { connection } = useConnection();
  const [gate, setGate] = useState<GateState | null>(null);
  const connected = connection.status === 'connected';

  useEffect(() => {
    void prunePageCache().catch(() => undefined);
  }, []);

  useEffect(() => {
    void currentGate(connected).then(setGate);
  }, [connected, tab]);

  // Until the user picks a tab, open the one that fits the page:
  // Google results → Click Potential, an AI answer → Why Not Me, any other page → Instant Brief.
  const agent = access.status === 'ready' ? access.ping.agent : null;
  useEffect(() => {
    if (chosenByUser || agent === null) return;
    setTab(agent === 'ai' ? 'why' : agent === 'page' ? 'brief' : 'click');
  }, [agent, chosenByUser]);

  // "Check the selected text" from the context menu.
  useEffect(() => {
    if (intent?.intent === 'selection') setTab('noise');
  }, [intent]);

  const choose = (id: TabId) => {
    setTab(id);
    setChosenByUser(true);
  };
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
        <div className="tabs" role="tablist" aria-label={`${PRODUCT_NAME} features`}>
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" type="button" className="tab" aria-selected={tab === id} onClick={() => choose(id)} data-testid={`tab-${id}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <main className="content" role="tabpanel" data-testid={`panel-${tab}`}>
        {gated ? (
          gate?.limit === 0 ? (
            <Card title="Enter your email to start" testId="gate">
              <SignUpForm onUseToken={() => choose('settings')} />
            </Card>
          ) : (
            <Card title="Create your free account to continue" testId="gate">
              <Notice tone="warn">You have used your {gate?.limit} free runs. Enter your email to keep going.</Notice>
              <SignUpForm onUseToken={() => choose('settings')} />
            </Card>
          )
        ) : (
          <>
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
