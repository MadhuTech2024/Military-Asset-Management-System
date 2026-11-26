import { lazy, Suspense, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowLeftRight,
  ClipboardList,
  PackageCheck,
  Users,
  Wallet,
} from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import useApiQuery from "../hooks/useApiQuery.js";
import api, { apiErrorMessage } from "../services/api.js";
import { getDemoDashboardData } from "../demo/demoService.js";
import StatCard from "../components/StatCard.jsx";
import {
  Button,
  DataTable,
  Field,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  inputClass,
  formatDate,
} from "../components/ui.jsx";

const DemoDashboardCharts = lazy(() => import("./DemoDashboardCharts.jsx"));
const number = (value) => Number(value ?? 0).toLocaleString();

function RecentActivity({ entries, bases }) {
  const baseNames = new Map(bases.map((base) => [base.id, base.name]));
  return (
    <div className="divide-y divide-slate-100">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              {entry.action.replaceAll("_", " ")}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {baseNames.get(entry.baseId) ?? "Global"} · {entry.entityType.replaceAll("_", " ")}
            </p>
          </div>
          <time className="shrink-0 text-xs text-slate-500">{formatDate(entry.createdAt)}</time>
        </div>
      ))}
      {!entries.length && <p className="text-sm text-slate-500">No recent synthetic activity.</p>}
    </div>
  );
}

export default function DemoDashboard() {
  const { user } = useAuth();
  const isAdmin = user.role === "ADMIN";
  const [baseId, setBaseId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [resetPending, setResetPending] = useState(false);
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const dashboard = getDemoDashboardData(user, baseId || undefined);
  const bases = basesQuery.data?.bases ?? [];
  const isCommander = user.role === "BASE_COMMANDER";
  const isLogistics = user.role === "LOGISTICS_OFFICER";
  const title = isAdmin
    ? "Command overview"
    : isCommander
      ? "Base command dashboard"
      : "Logistics operations dashboard";

  async function resetData() {
    setResetPending(true);
    setError("");
    setSuccess("");
    try {
      await api.post("/demo/reset");
      setBaseId("");
      setSuccess("Synthetic demo records have been restored to the original dataset.");
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setResetPending(false);
    }
  }

  const inventoryColumns = [
    { key: "name", label: "Base" },
    { key: "available", label: "Available" },
    { key: "assigned", label: "Net assigned" },
    { key: "expenditure", label: "Expended" },
  ];
  const lowStockColumns = [
    { key: "base", label: "Base", render: (row) => row.base.name },
    { key: "type", label: "Equipment", render: (row) => row.equipmentType.name },
    { key: "closingBalance", label: "Available" },
    { key: "threshold", label: "Alert threshold" },
  ];

  return (
    <>
      <PageHeader
        title={title}
        description={
          dashboard.baseName
            ? `Synthetic operational picture for ${dashboard.baseName}.`
            : "Synthetic operational picture across all five demonstration bases."
        }
        actions={
          <div className="flex flex-wrap items-end gap-3">
            {isAdmin && (
              <Field label="Dashboard scope">
                <select
                  className={`${inputClass} min-w-48`}
                  value={baseId}
                  onChange={(event) => setBaseId(event.target.value)}
                >
                  <option value="">All bases</option>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.code} · {base.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {isAdmin && (
              <Button variant="secondary" disabled={resetPending} onClick={resetData}>
                {resetPending ? "Resetting…" : "Reset demo data"}
              </Button>
            )}
          </div>
        }
      />
      <Notice>{error || basesQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <strong></strong> fictional records only; changes stay in this browser session and are not sent to a backend.
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Available inventory"
          value={number(dashboard.inventory.availableQuantity)}
          detail="Units ready for issue or transfer"
          icon={Archive}
        />
        <StatCard
          label="Net assigned"
          value={number(dashboard.inventory.netAssignedQuantity)}
          detail={`${number(dashboard.assignments.returned)} returned to date`}
          icon={ArrowDownToLine}
        />
        <StatCard
          label={isLogistics ? "Pending purchases" : "Pending workflows"}
          value={number(dashboard.pendingPurchases.quantity + dashboard.transfers.pending.quantity)}
          detail={`${dashboard.pendingPurchases.count} purchase · ${dashboard.transfers.pending.count} transfer requests`}
          icon={PackageCheck}
        />
        <StatCard
          label="Personnel in scope"
          value={number(dashboard.personnelCount)}
          detail={`${number(dashboard.expenditureQuantity)} units expended`}
          icon={Users}
        />
      </div>

      <Suspense fallback={<div className="mt-5 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading synthetic charts…</div>}>
        <DemoDashboardCharts dashboard={dashboard} />
      </Suspense>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Panel
          title={isAdmin ? "Base inventory summary" : "Assigned base inventory"}
          description="Opening stock + completed purchases + completed transfers − net assignments − expenditures"
          className="xl:col-span-2"
        >
          <DataTable columns={inventoryColumns} rows={dashboard.baseTotals} emptyMessage="No base totals in this scope." />
          {isAdmin && (
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
              <span><Activity className="mr-1 inline h-3.5 w-3.5" /> Ledger values are synthetic and reconcile from movements.</span>
              <span><ArrowLeftRight className="mr-1 inline h-3.5 w-3.5" /> Pending and approved transfers are excluded from stock.</span>
            </div>
          )}
        </Panel>
        <Panel title="Workflow status" description="Requests remain separate from available stock">
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-amber-50 p-3">
              <span className="text-sm font-medium text-amber-950">Pending purchases</span>
              <strong className="text-amber-950">{dashboard.pendingPurchases.count}</strong>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-sky-50 p-3">
              <span className="text-sm font-medium text-sky-950">Pending transfers</span>
              <strong className="text-sky-950">{dashboard.transfers.pending.count}</strong>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-emerald-50 p-3">
              <span className="text-sm font-medium text-emerald-950">Approved transfers</span>
              <strong className="text-emerald-950">{dashboard.transfers.approved.count}</strong>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
              <span className="text-sm font-medium text-slate-800">Assignments</span>
              <strong className="text-slate-900">{dashboard.assignments.count}</strong>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel
          title="Low-stock watchlist"
          description="Positions below the synthetic demonstration threshold"
        >
          <DataTable columns={lowStockColumns} rows={dashboard.lowStock} emptyMessage="No positions are below the demo threshold." />
        </Panel>
        <Panel
          title={isCommander ? "Incoming transfer requests" : isLogistics ? "Incoming logistics" : "Recent activity"}
          description={isAdmin ? "Latest synthetic audit events across the selected scope" : "Base-scoped synthetic workflow events"}
        >
          {isAdmin ? (
            <RecentActivity entries={dashboard.recentActivities} bases={bases} />
          ) : (
            <div className="space-y-3">
              {(dashboard.incomingTransfers.length
                ? dashboard.incomingTransfers.slice(0, 5)
                : dashboard.recentActivities.slice(0, 5)
              ).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {"quantity" in entry
                        ? `${number(entry.quantity)} units · ${entry.status.toLowerCase()}`
                        : entry.action.replaceAll("_", " ")}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {"sourceBaseId" in entry
                        ? `From ${bases.find((base) => base.id === entry.sourceBaseId)?.name ?? "another base"}`
                        : formatDate(entry.createdAt)}
                    </p>
                  </div>
                  {"status" in entry && <StatusBadge value={entry.status} />}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel title="Recent purchase requests" description="Supplier and estimate data are fictional demo fields">
          <DataTable
            columns={[
              { key: "referenceCode", label: "Reference" },
              { key: "supplier", label: "Supplier" },
              { key: "quantity", label: "Units" },
              { key: "estimatedCost", label: "Estimate", render: (row) => `$${number(row.estimatedCost)}` },
              { key: "status", label: "Status", render: (row) => <StatusBadge value={row.status} /> },
            ]}
            rows={dashboard.recentPurchases}
            emptyMessage="No purchase requests in this scope."
          />
        </Panel>
        <Panel title="Activity trail" description="Synthetic audit events; no real records are included">
          <RecentActivity entries={dashboard.recentActivities} bases={bases} />
        </Panel>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Completed transfers" value={number(dashboard.transfers.completed.count)} detail={`${number(dashboard.transfers.completed.quantity)} units moved`} icon={ArrowLeftRight} />
        <StatCard label="Personnel assignments" value={number(dashboard.assignments.count)} detail={`${number(dashboard.assignments.gross)} gross units`} icon={ClipboardList} />
        <StatCard label="Returns recorded" value={number(dashboard.assignments.returned)} detail={`${number(dashboard.assignments.net)} units still assigned`} icon={ArrowDownToLine} />
        <StatCard label="Expenditure quantity" value={number(dashboard.expenditureQuantity)} detail="Units recorded as expended" icon={Wallet} />
      </div>
    </>
  );
}
