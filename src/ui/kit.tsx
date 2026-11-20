/** Small presentational components. Everything renders text through React, so page-derived strings are always escaped. */
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { safeHttpUrl } from '@/lib/sanitize';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'link'; small?: boolean };

export function Button({ variant = 'default', small, className, type = 'button', ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' ? variant : '', small ? 'small' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...rest} />;
}

export function Card({ title, actions, children, testId }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="card" data-testid={testId}>
      {(title || actions) && (
        <header>
          <h2>{title}</h2>
          {actions}
        </header>
      )}
      <div className="body">{children}</div>
    </section>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'mine' | 'rival' | 'accent';

export function Chip({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip${tone === 'neutral' ? '' : ` ${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ tone = 'info', children, testId }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode; testId?: string }) {
  return (
    <div className={`notice${tone === 'info' ? '' : ` ${tone}`}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>
      {children}
    </div>
  );
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label?: string }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="stack" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label ?? 'Progress'}>
      <div className="progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="small muted">
        {label ? `${label} ` : ''}
        {total > 0 ? `${done} of ${total}` : ''}
      </span>
    </div>
  );
}

export function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, children, testId }: { title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A link that only ever points at http(s) (or a mailto: address the extractor validated). Opens in a new tab. */
export function ExternalLink({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  const safe = href && /^mailto:[^\s?]+$/i.test(href) ? href : safeHttpUrl(href ?? '');
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

/** A link to one of the extension's own pages (onboarding, health check, options). */
export function ExtensionLink({ page, children }: { page: string; children: ReactNode }) {
  return (
    <a href={chrome.runtime.getURL(page)} target="_blank" rel="noopener">
      {children}
    </a>
  );
}

export function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <ul>
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

/** How many dialogs are open. While one is, the page behind it cannot be used: not by mouse, not by keyboard. */
let openDialogs = 0;

/**
 * A modal dialog. It is drawn outside the page (in a portal) and the page itself is made inert while it is open,
 * so that Tab cannot reach a button behind it. Focus moves into the dialog and returns to where it was.
 */
export function Dialog({ title, children, footer, onClose, testId }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; testId?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const page = document.getElementById('root');
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialogs += 1;
    page?.setAttribute('inert', '');
    box.current?.focus();
    return () => {
      openDialogs -= 1;
      if (openDialogs === 0) page?.removeAttribute('inert');
      if (before?.isConnected) before.focus();
    };
  }, []);
  return createPortal(
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} data-testid={testId} tabIndex={-1} ref={box}>
        <header>
          <h2>{title}</h2>
        </header>
        <div className="body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {hint && <span className="hint">{hint}</span>}
      {children}
    </label>
  );
}

export function domainLabel(url: string | null | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
