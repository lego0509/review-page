import { ReactNode } from 'react';
import clsx from 'clsx';

interface SectionCardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function SectionCard({ title, subtitle, children, className }: SectionCardProps) {
  return (
    <section className={clsx('section-card space-y-4', className)}>
      {(title || subtitle) && (
        <header className="space-y-1">
          {title && <h2 className="section-heading">{title}</h2>}
          {subtitle && <p className="subtext">{subtitle}</p>}
        </header>
      )}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export default SectionCard;
