import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [out, setOut] = useState('idle');
  return (
    <div>
      <button
        id="run"
        onClick={() => {
          setOut('loading');
          const worker = new Worker(new URL('../../similarity/embed.worker.ts', import.meta.url), {
            type: 'module',
          });
          worker.onmessage = (e) => setOut(JSON.stringify(e.data));
          worker.onerror = (e) => setOut('worker error: ' + e.message);
          worker.postMessage({ type: 'embed', id: 1, texts: ['A dentist cleans teeth.', 'Dental hygienists clean your teeth.', 'Bananas are yellow.'] });
        }}
      >
        run
      </button>
      <pre id="out">{out}</pre>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
