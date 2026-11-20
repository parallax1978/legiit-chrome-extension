import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import { ConnectionProvider, SettingsProvider, TargetProvider } from '@/ui/hooks';
import { SaveHostProvider } from '@/ui/shared';
import '@/ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <ConnectionProvider>
        <SaveHostProvider>
          <TargetProvider>
            <App />
          </TargetProvider>
        </SaveHostProvider>
      </ConnectionProvider>
    </SettingsProvider>
  </StrictMode>,
);
