// Building blocks matching docs/design/preview.html.

import type { ReactNode } from "react";

import { describeError } from "@/lib/shared/errors.ts";

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="sub">{subtitle}</p>
    </>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="card">
      <div className="big">{value}</div>
      <div className="sm">{label}</div>
    </div>
  );
}

export type TagTone = "ok" | "w" | "b" | "p";

export function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  return <span className={`tag t-${tone}`}>{children}</span>;
}

export function DataTable({ caption, columns, rows }: {
  caption: string;
  columns: string[];
  rows: { key: string | number; cells: ReactNode[] }[];
}) {
  return (
    <div className="wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>{row.cells.map((cell, i) => <td key={i}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="sm">
      {label}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="sm">{children}</p>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert">
      <p>
        <Tag tone="b">Error</Tag> {describeError(error)}
      </p>
      {onRetry && (
        <button type="button" className="btn l" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
