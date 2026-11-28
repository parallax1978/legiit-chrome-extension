/** Shown once, when the extension is installed: what it does, what it reads, what it never sends. */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME, SINGLE_PURPOSE, SUGGESTED_SHORTCUT } from '@/config/constants';
import { getLegiitToken, onLegiitTokenChanged } from '@/storage/settings';
import { ConnectionProvider, SettingsProvider, useConnection } from '@/ui/hooks';
import { Card, Notice } from '@/ui/kit';
import { SignUpForm, VerifyCode } from '@/ui/SignUp';
import '@/ui/styles.css';

/** The email first: it opens the tools, and the code from the email connects the free Legiit account. */
function SignUpCard() {
  const { connection, signup } = useConnection();
  // This page reads no session. A stored token, from here or from another page, means the account is connected.
  const [hasToken, setHasToken] = useState(false);
  useEffect(() => {
    const read = () => void getLegiitToken().then((token) => setHasToken(token !== null));
    read();
    return onLegiitTokenChanged(read);
  }, []);
  if (connection.status === 'connected' || hasToken) {
    return (
      <Card title="You are all set" testId="onboarding-signup">
        <Notice tone="ok">Your Legiit account is connected. Every tool is ready.</Notice>
      </Card>
    );
  }
  return (
    <Card title={signup ? 'Check your email' : 'Enter your email to start'} testId="onboarding-signup">
      {signup ? <VerifyCode /> : <SignUpForm />}
    </Card>
  );
}

function Onboarding() {
  const [shortcut, setShortcut] = useState(SUGGESTED_SHORTCUT);
  useEffect(() => {
    chrome.commands
      ?.getAll()
      .then((commands) => setShortcut(commands.find((c) => c.name === '_execute_action')?.shortcut || SUGGESTED_SHORTCUT))
      .catch(() => undefined);
  }, []);

  return (
    <div className="page" data-testid="onboarding">
      <div className="hero">
        <img src="/icon/128.png" alt="" />
        <div>
          <h1>Welcome to {PRODUCT_NAME}</h1>
          <p className="muted">{SINGLE_PURPOSE}</p>
        </div>
      </div>

      <SignUpCard />

      <Card title="How to use it" testId="onboarding-start">
        <p>Open a Google results page, or click the {PRODUCT_NAME} icon on any page. Nothing to set up.</p>
      </Card>

      <details className="card" data-testid="onboarding-details">
        <summary>What it does, what it reads, and what it never sends</summary>
        <div data-testid="onboarding-does">
          <ul>
            <li>
              <strong>Overview</strong> tells you in plain words where you stand on the page you are looking at, and what to do next. It also keeps a list of your keywords and how your place in them changes.
            </li>
            <li>
              <strong>This search</strong> measures a Google results page: where the first result starts, and what takes up the first screen.
            </li>
            <li>
              <strong>Who’s beating me</strong> shows where competitors appear and you do not, in Google results and in AI answers.
            </li>
            <li>
              <strong>Content check</strong> shows which sentences of a page say something the pages it competes with do not.
            </li>
            <li>
              <strong>What changed</strong> shows how a page changed over time, using the Wayback Machine.
            </li>
            <li>
              <strong>Site brief</strong> turns a business website into a client brief.
            </li>
          </ul>
          <p>Your email opens every tool. The code we email you connects your free Legiit account, which adds saving to Legiit Command Center.</p>
        </div>
        <div data-testid="onboarding-reads">
          <p>
            <strong>What it reads</strong>
          </p>
          <ul>
            <li>Google results pages you open. A small summary strip appears above the results; you can collapse it or switch it off.</li>
            <li>Answers on chatgpt.com, gemini.google.com, perplexity.ai and copilot.microsoft.com, when you open the panel on one of them.</li>
            <li>Any other page, only after you ask: click the toolbar icon, press {shortcut}, or right-click and choose “Analyze this page”.</li>
            <li>Pages you choose to scan or compare. Chrome asks you first, naming each site.</li>
            <li>Saved copies of a page at the Internet Archive (web.archive.org), when you look up its history.</li>
          </ul>
        </div>
        <div data-testid="onboarding-never">
          <p>
            <strong>What it never sends</strong>
          </p>
          <ul>
            <li>No searches to Google and no prompts to AI sites. It only reads what is already on your screen.</li>
            <li>Nothing you analyze goes to Legiit unless you click a save button. You are shown exactly what will be sent first. When you sign up, Legiit gets your email address and the code.</li>
            <li>No analytics, no tracking, no cookies with any page it fetches.</li>
            <li>Your tracked brands, history and briefs stay on this device.</li>
          </ul>
        </div>
        <div>
          <p>
            <strong>Why Chrome lists these permissions</strong>
          </p>
          <ul className="small">
            <li>
              <strong>Google Search and four AI sites</strong>: to read the results or answer you opened there.
            </li>
            <li>
              <strong>web.archive.org</strong>: to look up page history for “What changed”.
            </li>
            <li>
              <strong>The Legiit API</strong>: your free Legiit account (your email, the code, and the saves you confirm).
            </li>
            <li>
              <strong>Other sites</strong>: never granted at install. Requested one scan at a time, and listed (and removable) in Settings.
            </li>
          </ul>
        </div>
      </details>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <ConnectionProvider checkSession={false}>
        <Onboarding />
      </ConnectionProvider>
    </SettingsProvider>
  </StrictMode>,
);
