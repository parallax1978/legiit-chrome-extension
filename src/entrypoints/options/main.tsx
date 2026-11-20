import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME } from '@/config/constants';
import { ConnectionProvider, SettingsProvider } from '@/ui/hooks';
import { SettingsView } from '@/ui/SettingsView';
import { SaveHostProvider } from '@/ui/shared';
import '@/ui/styles.css';

function OptionsPage() {
  return (
    <div className="page" data-testid="options-page">
      <div className="hero">
        <img src="/icon/128.png" alt="" />
        <div>
          <h1>{PRODUCT_NAME} settings</h1>
          <p className="muted">Tracked brands, export branding, the optional Legiit connection, AI and privacy.</p>
        </div>
      </div>
      <SettingsView />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <ConnectionProvider>
        <SaveHostProvider>
          <OptionsPage />
        </SaveHostProvider>
      </ConnectionProvider>
    </SettingsProvider>
  </StrictMode>,
);
