import { Menu, ShieldCheck, X } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";

export default function Navbar({ mobileOpen, menuButtonRef, onMenuClick }) {
  const { user, logout } = useAuth();
  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-7">
      <div className="flex items-center gap-3">
        <button
          ref={menuButtonRef}
          type="button"
          className="grid h-10 w-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700 lg:hidden"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          aria-controls="primary-navigation"
          onClick={onMenuClick}
        >
          {mobileOpen ? (
            <X aria-hidden="true" className="h-5 w-5" />
          ) : (
            <Menu aria-hidden="true" className="h-5 w-5" />
          )}
        </button>
        <div className="hidden items-center gap-2 text-sm text-slate-500 sm:flex">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-700" />
          Secure operations workspace
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden text-right sm:block">
          <p className="text-sm font-semibold text-slate-900">{user?.name}</p>
          <p className="text-xs text-slate-500">{user?.role?.replaceAll("_", " ")}</p>
        </div>
        <button
          type="button"
          onClick={logout}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
