import { useState } from "react";
import { Activity, Archive, ArrowDownToLine, PackageCheck, Wallet } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import DemoDashboard from "./DemoDashboard.jsx";
import useApiQuery from "../hooks/useApiQuery.js";
import StatCard from "../components/StatCard.jsx";
import {
  Button,
  Field,
  LoadingState,
  PageHeader,
  Panel,
  inputClass,
  StatusBadge,
} from "../components/ui.jsx";

export default function Dashboard() {
  const { user, isDemoSession } = useAuth();
  if (isDemoSession) return <DemoDashboard />;
  return <OperationalDashboard user={user} />;
}

function OperationalDashboard({ user }) {
  const [baseId, setBaseId] = useState("");
  const isAdmin = user.role === "ADMIN";
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const dashboardUrl = isAdmin
    ? baseId
      ? `/bases/${baseId}/dashboard`
      : "/dashboard"
    : `/bases/${user.baseId}/dashboard`;
  const dashboardQuery = useApiQuery(dashboardUrl);
  const dashboard = dashboardQuery.data?.dashboard;

  const selectedBase = basesQuery.data?.bases?.find((base) => base.id === baseId);
  function retryFailedQueries() {
    if (dashboardQuery.error) dashboardQuery.refresh();
    if (isAdmin && basesQuery.error) basesQuery.refresh();
  }

  return (
    <>
      <PageHeader
        title="Operational dashboard"
        description={
          selectedBase
            ? `Current inventory and workflow indicators for ${selectedBase.name}.`
            : "Current inventory and workflow indicators from the authoritative ledger."
        }
        actions={
          isAdmin ? (
            <Field label="Dashboard scope">
              <select
                className={`${inputClass} min-w-56`}
                value={baseId}
                onChange={(event) => setBaseId(event.target.value)}
              >
                <option value="">All bases</option>
                {(basesQuery.data?.bases ?? []).map((base) => (
                  <option key={base.id} value={base.id}>
                    {base.code} · {base.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null
        }
      />
      {(dashboardQuery.error || (isAdmin && basesQuery.error)) && (
        <Panel title="Dashboard unavailable">
          <p role="alert" className="text-sm text-rose-800">
            {dashboardQuery.error || basesQuery.error}
          </p>
          <Button className="mt-4" variant="secondary" onClick={retryFailedQueries}>
            Retry
          </Button>
        </Panel>
      )}
      {dashboardQuery.loading && <LoadingState label="Loading dashboard" />}
      {dashboard && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Available inventory"
              value={dashboard.inventory.availableQuantity.toLocaleString()}
              detail="Units available now"
              icon={Archive}
            />
            <StatCard
              label="Net assigned"
              value={dashboard.inventory.netAssignedQuantity.toLocaleString()}
              detail="After cumulative returns"
              icon={ArrowDownToLine}
            />
            <StatCard
              label="Pending purchases"
              value={dashboard.pendingPurchases.quantity.toLocaleString()}
              detail={`${dashboard.pendingPurchases.count} pending requests · excluded from stock`}
              icon={PackageCheck}
            />
            <StatCard
              label="Expenditure quantity"
              value={dashboard.expenditureQuantity.toLocaleString()}
              detail="Units recorded as expended"
              icon={Wallet}
            />
          </div>
          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <Panel
              title="Transfer workflow"
              description="Operational status is shown separately from inventory movements."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {["pending", "approved"].map((status) => (
                  <div key={status} className="rounded-lg bg-slate-50 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold capitalize text-slate-800">{status}</p>
                      <StatusBadge value={status.toUpperCase()} />
                    </div>
                    <p className="mt-3 text-2xl font-bold text-slate-950">
                      {dashboard.transfers[status].quantity.toLocaleString()} units
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {dashboard.transfers[status].count} transfer
                      {dashboard.transfers[status].count === 1 ? "" : "s"}
                    </p>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel
              title="Inventory basis"
              description="These totals are supplied by the backend and reconcile against its inventory ledger."
            >
              <div className="flex gap-3 rounded-lg border border-emerald-100 bg-emerald-50 p-4">
                <Activity aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-800" />
                <p className="text-sm leading-6 text-emerald-950">
                  Pending purchases and future-dated stock are not available
                  inventory. Returns reduce net assigned quantity and restore
                  availability only through backend ledger calculations.
                </p>
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
