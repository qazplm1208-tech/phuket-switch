import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { AlertCircle, ChevronRight, Inbox, LoaderCircle, RefreshCw, X, type LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';

export function Btn({
  icon: Icon,
  kind = 'secondary',
  busy,
  children,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`btn ${kind} ${className}`}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <LoaderCircle className="spin" size={14} /> : Icon ? <Icon size={14} /> : null}
      {children}
    </button>
  );
}
export function IconBtn({
  icon: Icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-btn ${props.className ?? ''}`}
      title={label}
      aria-label={label}
    >
      <Icon size={15} />
    </button>
  );
}
export function Badge({
  tone = 'muted',
  children,
  dot,
}: {
  tone?: string;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i className="dot" />}
      {children}
    </span>
  );
}
export function Toggle({
  on,
  change,
  label,
  disabled,
  gold,
}: {
  on: boolean;
  change: () => void;
  label: string;
  disabled?: boolean;
  gold?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={change}
      className={`toggle ${on ? 'on' : ''} ${gold ? 'gold' : ''}`}
    >
      <span />
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
  className = '',
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={'field ' + className}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Choices<T extends string>({
  label,
  items,
  value,
  change,
  tabs,
  disabled,
  className = '',
}: {
  label: string;
  items: ReadonlyArray<readonly [T, string]>;
  value: string;
  change: (v: T) => void;
  tabs?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`${tabs ? 'tabs' : 'segments'} ${className}`}
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
    >
      {items.map(([v, text], i) => (
        <button
          key={v}
          type="button"
          role={tabs ? 'tab' : undefined}
          aria-selected={tabs ? v === value : undefined}
          aria-pressed={tabs ? undefined : v === value}
          disabled={disabled}
          tabIndex={tabs && v !== value ? -1 : 0}
          className={v === value ? 'selected' : ''}
          onClick={() => change(v)}
          onKeyDown={(e) => {
            const next =
              e.key === 'ArrowRight'
                ? (i + 1) % items.length
                : e.key === 'ArrowLeft'
                  ? (i + items.length - 1) % items.length
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : -1;
            if (next >= 0) {
              e.preventDefault();
              (e.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
              change(items[next][0]);
            }
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
export function Section({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <div className="section-head">
      <div className="inline">
        <h2>{title}</h2>
        {count != null && <span className="count">{count}</span>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
export function Empty({
  title,
  note,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={21} />
      </span>
      <div>
        <strong>{title}</strong>
        {note && <p>{note}</p>}
      </div>
      {action}
    </div>
  );
}
export function Notice({
  children,
  retry,
  tone = 'amber',
}: {
  children: ReactNode;
  retry?: () => void;
  tone?: string;
}) {
  return (
    <div className={`notice ${tone}`} role="status">
      <AlertCircle size={15} />
      <span>{children}</span>
      {retry && <IconBtn icon={RefreshCw} label="重试" onClick={retry} />}
    </div>
  );
}
export function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="skeletons" role="status" aria-label="正在加载">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}
export function Modal({
  title,
  close,
  children,
  wide,
  busy = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const el = ref.current,
      before = document.activeElement;
    el?.showModal();
    return () => {
      el?.close();
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || busy) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
      }}
    >
      <header className="modal-head">
        <h2 id={id}>{title}</h2>
        <IconBtn icon={X} label="关闭" disabled={busy} onClick={close} />
      </header>
      <div className="modal-body">{children}</div>
    </dialog>,
    document.body,
  );
}
export function Disclosure({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary>
        <ChevronRight size={14} />
        <strong>{title}</strong>
        {meta && <small>{meta}</small>}
      </summary>
      <div>{children}</div>
    </details>
  );
}
export function Table({ heads, children }: { heads: string[]; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
