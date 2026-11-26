/** The first screen: one email address creates a free Legiit account and connects the extension to it. */
import { useState } from 'react';
import { errorMessage } from '@/lib/async';
import { useConnection } from './hooks';
import { Button, Notice } from './kit';

export function SignUpForm({ onUseToken }: { onUseToken?: () => void }) {
  const { signUp } = useConnection();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await signUp(email);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      data-testid="signup"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && email.trim()) void start();
      }}
    >
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" aria-label="Your email" data-testid="signup-email" />
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy || !email.trim()} data-testid="signup-start">
          {busy ? 'Creating your account…' : 'Start'}
        </Button>
      </div>
      {error && <Notice tone="error" testId="signup-error">{error}</Notice>}
      <p className="small muted">
        This creates your free Legiit account.
        {onUseToken && (
          <>
            {' '}
            Already have one?{' '}
            <button type="button" className="link-button" onClick={onUseToken} data-testid="signup-use-token">
              Connect it in Settings
            </button>
            .
          </>
        )}
      </p>
    </form>
  );
}
