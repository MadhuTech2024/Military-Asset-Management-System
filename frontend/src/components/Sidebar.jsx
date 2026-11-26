import {
  Archive,
  ArrowLeftRight,
  ClipboardList,
  FileBarChart2,
  Gauge,
  Layers3,
  MapPinned,
  PackageCheck,
  Shield,
  Users,
  UserRound,
  WalletCards,
} from "lucide-react";
import { NavLink } from "react-router-dom";

const navigation = [
  { to: "/dashboard", label: "Dashboard", icon: Gauge },
  { to: "/bases", label: "Bases", icon: MapPinned },
  { to: "/users", label: "User management", icon: Users, roles: ["ADMIN"] },
  { to: "/personnel", label: "Personnel", icon: UserRound, demoOnly: true },
  { to: "/equipment-types", label: "Equipment types", icon: Layers3 },
  { to: "/inventory", label: "Inventory", icon: Archive },
  { to: "/purchases", label: "Purchases", icon: PackageCheck },
  { to: "/transfers", label: "Transfers", icon: ArrowLeftRight },
  {
    to: "/assignments",
    label: "Assignments & returns",
    icon: ClipboardList,
  },
  {
    to: "/expenditures",
    label: "Expenditures",
    icon: WalletCards,
  },
  { to: "/audit", label: "Audit logs", icon: Shield },
  { to: "/reports", label: "Reports", icon: FileBarChart2 },
];

export default function Sidebar({
  user,
  demoMode = false,
  mobileOpen = false,
  firstLinkRef,
  onNavigate,
}) {
  const links = navigation.filter(
    (item) =>
      (!item.roles || item.roles.includes(user?.role)) &&
      (!item.demoOnly || demoMode),
  );
  return (
    <aside
      className={`${
        mobileOpen ? "block" : "hidden"
      } fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-800 bg-military-950 text-white lg:relative lg:block lg:min-h-screen lg:shrink-0`}
    >
      <div className="flex h-16 items-center gap-3 border-b border-white/10 px-6">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-700">
          <Shield aria-hidden="true" className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-bold tracking-wide">KRISTALLBALL</p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
            Asset operations
          </p>
        </div>
      </div>
      <nav
        id="primary-navigation"
        aria-label="Primary navigation"
        className="space-y-1 px-3 py-5"
      >
        {links.map(({ to, label, icon: Icon }, index) => (
          <NavLink
            key={to}
            ref={index === 0 ? firstLinkRef : undefined}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition ${
                isActive
                  ? "bg-emerald-800 text-white"
                  : "text-slate-300 hover:bg-white/10 hover:text-white"
              }`
            }
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>
      {demoMode && (
        <div className="absolute inset-x-0 bottom-0 border-t border-white/10 px-5 py-4">
          <p className="text-xs font-semibold text-amber-300"></p>
          <p className="mt-1 text-xs text-slate-400"></p>
        </div>
      )}
    </aside>
  );
}
