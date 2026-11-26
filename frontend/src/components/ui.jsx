import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">
          Kristallball operations
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          {title}
        </h1>
        {description && <p className="mt-2 max-w-3xl text-sm text-slate-600">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Panel({ title, description, actions, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || description || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            {title && <h2 className="font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Notice({ children, tone = "error" }) {
  if (!children) return null;
  const success = tone === "success";
  const Icon = success ? CheckCircle2 : AlertCircle;
  return (
    <div
      role={success ? "status" : "alert"}
      className={`mb-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
        success
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-rose-200 bg-rose-50 text-rose-900"
      }`}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function LoadingState({ label = "Loading data" }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-slate-500" role="status">
      <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
      {label}…
    </div>
  );
}

export function EmptyState({ children = "No records found." }) {
  return <p className="py-10 text-center text-sm text-slate-500">{children}</p>;
}

export function DataTable({ columns, rows, rowKey = "id", emptyMessage }) {
  if (rows.length === 0) return <EmptyState>{emptyMessage}</EmptyState>;
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="whitespace-nowrap px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 first:pl-0"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, index) => (
            <tr key={row[rowKey] ?? index} className="align-top">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className="whitespace-nowrap px-3 py-3 text-slate-700 first:pl-0"
                >
                  {column.render ? column.render(row) : row[column.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label, children, hint, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/15 disabled:cursor-not-allowed disabled:bg-slate-100";

export function Button({ children, variant = "primary", className = "", ...props }) {
  const styles = variant === "secondary"
    ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
    : variant === "danger"
      ? "bg-rose-700 text-white hover:bg-rose-800"
      : "bg-emerald-800 text-white hover:bg-emerald-900";
  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ value }) {
  const tone = {
    COMPLETED: "bg-emerald-100 text-emerald-800",
    APPROVED: "bg-blue-100 text-blue-800",
    PENDING: "bg-amber-100 text-amber-800",
    ACTIVE: "bg-emerald-100 text-emerald-800",
    REJECTED: "bg-rose-100 text-rose-800",
    INACTIVE: "bg-slate-100 text-slate-600",
    PARTIALLY_RETURNED: "bg-blue-100 text-blue-800",
    RETURNED: "bg-slate-100 text-slate-700",
  }[value] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {String(value).replaceAll("_", " ")}
    </span>
  );
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
