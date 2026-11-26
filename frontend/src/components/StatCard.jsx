export default function StatCard({ label, value, detail, icon: Icon }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            {value}
          </p>
          <p className="mt-2 text-xs text-slate-500">{detail}</p>
        </div>
        {Icon && (
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-50 text-emerald-800">
            <Icon aria-hidden="true" className="h-5 w-5" />
          </span>
        )}
      </div>
    </article>
  );
}
