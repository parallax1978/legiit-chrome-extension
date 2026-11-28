/**
 * The first screen and the code step. The email address opens the tools at once; the 6-digit code from the
 * email connects the Legiit account (a new one, or the one the address already has).
 */
import { useState } from 'react';
import { errorMessage } from '@/lib/async';
import { useConnection } from './hooks';
import { Button, Notice } from './kit';

/** One email address. Legiit keeps it and emails a code; the tools open as soon as Legiit has it. */
export function SignUpForm() {
  const { startSignup } = useConnection();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSignup(email);
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
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </div>
      {error && <Notice tone="error" testId="signup-error">{error}</Notice>}
      <p className="small muted">We email you a code to connect your free Legiit account. The tools open right away.</p>
    </form>
  );
}

/** The code from the email. Shown while an email address was given and no account is connected. */
export function VerifyCode() {
  const { signup, verifySignup, startSignup, cancelSignup } = useConnection();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  if (!signup) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      data-testid="verify"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && code.trim()) void run(() => verifySignup(code));
      }}
    >
      <p className="small">
        Enter the 6-digit code we sent to <strong data-testid="verify-email">{signup.email}</strong> to connect your free Legiit account.
      </p>
      <div className="row">
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" aria-label="Code from the email" data-testid="verify-code" />
        <Button type="submit" variant="primary" disabled={busy || !code.trim()} data-testid="verify-submit">
          {busy ? 'Checking…' : 'Verify'}
        </Button>
      </div>
      {error && <Notice tone="error" testId="verify-error">{error}</Notice>}
      <div className="row small">
        <button
          type="button"
          className="link-button"
          disabled={busy}
          data-testid="verify-resend"
          onClick={() =>
            void run(async () => {
              await startSignup(signup.email);
              setResent(true);
            })
          }
        >
          Send a new code
        </button>
        <button type="button" className="link-button" disabled={busy} onClick={() => void cancelSignup()} data-testid="verify-change-email">
          Use another email
        </button>
      </div>
      {resent && <p className="small muted" data-testid="verify-resent">A new code is on its way.</p>}
      <p className="small muted" data-testid="verify-help">
        No email after a minute? Look in your spam folder, or send a new code. The tools work in the meantime.
      </p>
    </form>
  );
}
