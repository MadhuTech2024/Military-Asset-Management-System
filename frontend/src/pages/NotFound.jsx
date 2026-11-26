import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-bold uppercase tracking-[0.18em] text-emerald-800">
          Kristallball
        </p>
        <h1 className="mt-4 text-3xl font-bold text-slate-950">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          This route does not exist or is not available in this workspace.
        </p>
        <Link
          to="/dashboard"
          className="mt-6 inline-flex min-h-10 items-center rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900"
        >
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}
