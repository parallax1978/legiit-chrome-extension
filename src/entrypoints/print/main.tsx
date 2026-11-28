/**
 * Print-ready client brief. Opened from Instant Brief; "Print / save as PDF"
 * uses Chrome's own print dialog (choose "Save as PDF"). White-label: the
 * agency's name and logo, no Legiit branding.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Brief } from '@/features/instant-brief/compose';
import { getBrief } from '@/storage/db';
import { DEFAULT_SETTINGS, getSettings, type Settings } from '@/storage/settings';
import { BriefSections } from '@/ui/BriefView';
import { Button } from '@/ui/kit';
import '@/ui/styles.css';

function PrintPage() {
  const [brief, setBrief] = useState<Brief | null | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('id') ?? '';
    void Promise.all([getBrief(id), getSettings()]).then(([found, loaded]) => {
      setBrief(found ?? null);
      setSettings(loaded);
      if (found) document.title = `Client brief: ${found.businessName}`;
    });
  }, []);

  if (brief === undefined) return null;
  if (brief === null) {
    return (
      <div className="page" data-testid="print-missing">
        <h1>Brief not found</h1>
        <p>This brief is no longer stored on this device. Build it again from “Site brief”.</p>
      </div>
    );
  }
  const date = new Date(brief.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <>
      <div className="printbar">
        <Button variant="primary" onClick={() => window.print()} data-testid="print-button">
          Print / save as PDF
        </Button>
        <span className="small muted">In the print dialog, choose “Save as PDF” as the destination.</span>
      </div>
      <article className="brief" data-testid="print-brief">
        <header className="cover">
          <div>
            <h1>Client brief: {brief.businessName}</h1>
            <div>
              {settings.agency.name ? `Prepared by ${settings.agency.name} · ` : ''}
              {date}
            </div>
            <div className="small">{brief.siteUrl}</div>
          </div>
          {settings.agency.logoDataUrl && <img src={settings.agency.logoDataUrl} alt={settings.agency.name ? `${settings.agency.name} logo` : 'Agency logo'} data-testid="print-agency-logo" />}
        </header>
        <BriefSections brief={brief} />
      </article>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrintPage />
  </StrictMode>,
);
