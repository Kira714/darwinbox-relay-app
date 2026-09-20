import { useEffect, useRef, type ReactNode } from 'react';
import { CheckCheck, X } from 'lucide-react';

export const label = (s: string) =>
  (s === 'excluded' ? 'Rejected' : s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const statusLabel: Record<string, string> = {
  queued: 'Queued',
  mapping: 'Mapping columns',
  processing: 'Validating data',
  review: 'Needs a person',
  delivering: 'Delivering records',
  completed: 'Migration complete',
  partial: 'Delivery needs attention',
  rolling_back: 'Rolling back',
  rolled_back: 'Rolled back',
  rollback_conflict: 'Rollback needs attention',
  error: 'Agent paused',
};
export const busyStatuses = ['queued', 'mapping', 'processing', 'delivering', 'rolling_back'];

export function time(v: string) {
  return new Date(v).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({
  icon = <CheckCheck size={25} />,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Stat({
  title,
  value,
  icon,
  note,
  tone = '',
}: {
  title: string;
  value: number;
  icon: ReactNode;
  note: string;
  tone?: string;
}) {
  return (
    <div className={`stat ${tone}`}>
      <div>
        <span>{title}</span>
        {icon}
      </div>
      <strong>{value.toString().padStart(2, '0')}</strong>
      <small>{note}</small>
    </div>
  );
}

const focusable = 'button, input, select, textarea, summary, a[href]';
export function Modal({
  title,
  close,
  wide,
  children,
}: {
  title: string;
  close: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>(focusable)?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key !== 'Tab') return;
      const elements = ref.current?.querySelectorAll<HTMLElement>(focusable);
      if (!elements?.length) return;
      const first = elements[0],
        last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close dialog" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
