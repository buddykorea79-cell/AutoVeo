import type {ReactNode} from "react";

interface PageHeadProps {
  readonly actions?: ReactNode;
  readonly eyebrow: string;
  readonly lede?: string;
  readonly title: string;
}

export const PageHead = ({actions, eyebrow, lede, title}: PageHeadProps) => (
  <header className="page-head">
    <div>
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      {lede === undefined ? null : <p className="lede">{lede}</p>}
    </div>
    {actions === undefined ? null : <div className="btn-row">{actions}</div>}
  </header>
);

interface EmptyStateProps {
  readonly action?: ReactNode;
  readonly body: string;
  readonly title: string;
}

export const EmptyState = ({action, body, title}: EmptyStateProps) => (
  <section className="empty">
    <h2>{title}</h2>
    <p>{body}</p>
    {action}
  </section>
);
