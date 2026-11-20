/** Shown once, when the extension is installed: what it does, what it reads, what it never sends. */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME, SINGLE_PURPOSE, SUGGESTED_SHORTCUT } from '@/config/constants';
import { updateSettings } from '@/storage/settings';
import { Button, Card } from '@/ui/kit';
import '@/ui/styles.css';

function Onboarding() {
  const [shortcut, setShortcut] = useState(SUGGESTED_SHORTCUT);
  useEffect(() => {
    void updateSettings((draft) => {
      draft.onboardingSeen = true;
    }).catch(() => undefined);
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

      <Card title="What it does" testId="onboarding-does">
        <ul>
          <li>
            <strong>Click Potential</strong> measures a Google results page: where the first organic result starts, and what takes up the first screen.
          </li>
          <li>
            <strong>Why Not Me</strong> shows where competitors appear and you do not, in Google results and in AI answers.
          </li>
          <li>
            <strong>Rewind</strong> shows how a page changed over time, using the Wayback Machine.
          </li>
          <li>
            <strong>New or Noise</strong> shows which sentences of a page say something its competitors do not.
          </li>
          <li>
            <strong>Instant Brief</strong> turns a business website into a client brief.
          </li>
        </ul>
        <p>Everything works without an account. Connecting a Legiit account is optional and only adds saving to Legiit Command Center.</p>
      </Card>

      <div className="cols">
        <Card title="What it reads" testId="onboarding-reads">
          <ul>
            <li>Google results pages you open. A small summary strip appears above the results; you can collapse it or switch it off.</li>
            <li>Answers on chatgpt.com, gemini.google.com, perplexity.ai and copilot.microsoft.com, when you open the panel on one of them.</li>
            <li>Any other page, only after you ask: click the toolbar icon, press {shortcut}, or right-click and choose “Analyze this page”.</li>
            <li>Pages you choose to scan or compare. Chrome asks you first, naming each site.</li>
            <li>Saved copies of a page at the Internet Archive (web.archive.org), when you look up its history.</li>
          </ul>
        </Card>
        <Card title="What it never sends" testId="onboarding-never">
          <ul>
            <li>No searches to Google and no prompts to AI sites. It only reads what is already on your screen.</li>
            <li>Nothing to Legiit unless you connect an account and click a save button. You are shown exactly what will be sent first.</li>
            <li>No analytics, no tracking, no cookies with any page it fetches.</li>
            <li>Your tracked brands, history and briefs stay on this device.</li>
          </ul>
        </Card>
      </div>

      <Card title="Start here" testId="onboarding-start">
        <ol>
          <li>Pin {PRODUCT_NAME}: open the puzzle-piece menu in the toolbar and click the pin.</li>
          <li>Add your brand and a few competitors in Settings, so the panel can mark who appears where.</li>
          <li>Search Google as usual. Use “Open panel” on the strip, or click the toolbar icon on any page.</li>
        </ol>
        <div className="row">
          <Button variant="primary" onClick={() => void chrome.runtime.openOptionsPage()} data-testid="onboarding-settings">
            Open settings
          </Button>
        </div>
      </Card>

      <Card title="Why Chrome lists these permissions">
        <ul className="small">
          <li>
            <strong>Google Search and four AI sites</strong>: to read the results or answer you opened there.
          </li>
          <li>
            <strong>web.archive.org</strong>: to look up page history for Rewind.
          </li>
          <li>
            <strong>The Legiit API</strong>: used only if you connect an account.
          </li>
          <li>
            <strong>Other sites</strong>: never granted at install. Requested one scan at a time, and listed (and removable) in Settings.
          </li>
        </ul>
      </Card>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Onboarding />
  </StrictMode>,
);
