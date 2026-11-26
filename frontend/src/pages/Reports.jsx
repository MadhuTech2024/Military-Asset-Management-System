import { useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import useApiQuery from "../hooks/useApiQuery.js";
import {
  Button,
  DataTable,
  Field,
  LoadingState,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  formatDate,
  inputClass,
} from "../components/ui.jsx";

const reportOptions = [
  ["inventory-movements", "Inventory movements"],
  ["purchases", "Purchases"],
  ["transfers", "Transfers"],
  ["assignments", "Assignments"],
  ["returns", "Returns"],
  ["expenditures", "Expenditures"],
];
const REPORT_PAGE_SIZE = 50;

function dateBound(day, endOfDay = false) {
  if (!day) return undefined;
  return `${day}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
}

function SummaryTiles({ entries }) {
  if (!entries?.length) return null;
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-2 text-xl font-bold text-slate-950">{value}</p>
        </div>
      ))}
    </div>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const [kind, setKind] = useState("inventory-movements");
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({
    from: "",
    to: "",
    baseId: "",
    equipmentTypeId: "",
    movementType: "",
  });
  const [applied, setApplied] = useState({});
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const typesQuery = useApiQuery("/equipment-types", {
    limit: 100,
    isActive: true,
  });
  const queryParams = useMemo(() => {
    const { movementType, ...commonFilters } = applied;
    return {
      ...commonFilters,
      ...(kind === "inventory-movements" && movementType
        ? { movementType }
        : {}),
      limit: REPORT_PAGE_SIZE,
      offset,
    };
  }, [applied, kind, offset]);
  const report = useApiQuery(`/reports/${kind}`, queryParams);
  const reportData = report.isCurrent ? report.data : null;
  const reportError = report.isCurrent ? report.error : "";
  const reportLoading = !report.isCurrent || report.loading;
  const reportMeta = report.isCurrent ? report.meta : null;
  const isAdmin = user.role === "ADMIN";
  const bases = basesQuery.data?.bases ?? [];
  const types = typesQuery.data?.equipmentTypes ?? [];
  const baseName = (id) => bases.find((base) => base.id === id)?.name ?? id ?? "—";
  const typeName = (id) => types.find((type) => type.id === id)?.name ?? id ?? "—";
  const rowsKey = {
    "inventory-movements": "movements",
    purchases: "purchases",
    transfers: "transfers",
    assignments: "assignments",
    returns: "returns",
    expenditures: "expenditures",
  }[kind];
  const rows = reportData?.[rowsKey] ?? [];
  const pageOffset = reportMeta?.offset ?? offset;
  const pageLimit = reportMeta?.limit ?? REPORT_PAGE_SIZE;
  const totalRows = reportMeta?.total ?? 0;
  const firstRow = rows.length > 0 ? pageOffset + 1 : 0;
  const lastRow = pageOffset + rows.length;

  function applyFilters(event) {
    event.preventDefault();
    setOffset(0);
    setApplied({
      ...(isAdmin && filters.baseId ? { baseId: filters.baseId } : {}),
      ...(filters.equipmentTypeId
        ? { equipmentTypeId: filters.equipmentTypeId }
        : {}),
      ...(filters.from ? { from: dateBound(filters.from) } : {}),
      ...(filters.to ? { to: dateBound(filters.to, true) } : {}),
      ...(kind === "inventory-movements" && filters.movementType
        ? { movementType: filters.movementType }
        : {}),
    });
  }

  const summaries = (() => {
    if (!reportData) return [];
    if (kind === "inventory-movements") {
      const summary = reportData.summary;
      return [
        ["Opening balance", summary.openingBalance],
        ["Stock introduced", summary.openingBalanceIntroduced],
        ["Closing balance", summary.closingBalance],
        ["Net assigned", summary.netAssigned],
      ];
    }
    if (kind === "purchases") {
      return [
        ["Pending requests", reportData.pending.count],
        ["Pending quantity", reportData.pending.quantity],
      ];
    }
    if (kind === "transfers") {
      return Object.entries(reportData.byStatus).map(([status, value]) => [
        `${status.toLowerCase()} transfers`,
        `${value.count} · ${value.quantity} units`,
      ]);
    }
    if (kind === "assignments") {
      return [
        ["Assignments", reportData.summary.assignmentCount],
        ["Gross assigned", reportData.summary.grossAssigned],
        ["Returned to date", reportData.summary.cumulativeReturned],
        ["Net assigned", reportData.summary.netAssigned],
      ];
    }
    if (kind === "returns") {
      return [
        ["Return events", reportData.summary.count],
        ["Returned quantity", reportData.summary.quantity],
      ];
    }
    return [
      ["Expenditure events", reportData.summary.count],
      ["Expenditure quantity", reportData.summary.quantity],
    ];
  })();

  const columns = (() => {
    const quantity = { key: "quantity", label: "Quantity" };
    if (kind === "inventory-movements") {
      return [
        { key: "occurredAt", label: "Occurred", render: (row) => formatDate(row.occurredAt) },
        { key: "baseId", label: "Base", render: (row) => baseName(row.baseId) },
        { key: "equipmentTypeId", label: "Equipment", render: (row) => typeName(row.equipmentTypeId) },
        { key: "movementType", label: "Movement", render: (row) => <StatusBadge value={row.movementType} /> },
        { key: "direction", label: "Direction" },
        quantity,
      ];
    }
    if (kind === "purchases") {
      return [
        { key: "purchasedAt", label: "Purchase date", render: (row) => formatDate(row.purchasedAt) },
        { key: "baseId", label: "Base", render: (row) => baseName(row.baseId) },
        { key: "equipmentTypeId", label: "Equipment", render: (row) => typeName(row.equipmentTypeId) },
        quantity,
        { key: "status", label: "Status", render: (row) => <StatusBadge value={row.status} /> },
        { key: "completedAt", label: "Completed", render: (row) => formatDate(row.completedAt) },
      ];
    }
    if (kind === "transfers") {
      return [
        { key: "createdAt", label: "Requested", render: (row) => formatDate(row.createdAt) },
        { key: "sourceBaseId", label: "Source", render: (row) => baseName(row.sourceBaseId) },
        { key: "destinationBaseId", label: "Destination", render: (row) => baseName(row.destinationBaseId) },
        { key: "equipmentTypeId", label: "Equipment", render: (row) => typeName(row.equipmentTypeId) },
        quantity,
        { key: "status", label: "Status", render: (row) => <StatusBadge value={row.status} /> },
      ];
    }
    if (kind === "assignments") {
      return [
        { key: "assignedAt", label: "Assigned", render: (row) => formatDate(row.assignedAt) },
        { key: "baseId", label: "Base", render: (row) => baseName(row.baseId) },
        { key: "grossAssigned", label: "Gross assigned" },
        { key: "cumulativeReturned", label: "Returned to date" },
        { key: "netAssigned", label: "Net assigned" },
        { key: "status", label: "Status", render: (row) => <StatusBadge value={row.status} /> },
      ];
    }
    return [
      {
        key: kind === "returns" ? "returnedAt" : "expendedAt",
        label: kind === "returns" ? "Returned" : "Expended",
        render: (row) =>
          formatDate(kind === "returns" ? row.returnedAt : row.expendedAt),
      },
      { key: "baseId", label: "Base", render: (row) => baseName(row.baseId) },
      { key: "equipmentTypeId", label: "Equipment", render: (row) => typeName(row.equipmentTypeId) },
      quantity,
      {
        key: kind === "returns" ? "assignmentId" : "expenditureId",
        label: "Related record",
        render: (row) =>
          (kind === "returns" ? row.assignmentId : row.expenditureId)
            ?.slice(0, 8)
            .toUpperCase() ?? "—",
      },
    ];
  })();

  return (
    <>
      <PageHeader
        title="Reports"
        description="Filter backend reports by their authoritative event timestamps and ledger values."
      />
      <Notice>{reportError || basesQuery.error || typesQuery.error}</Notice>
      <Panel title="Report criteria" className="mb-5">
        <form onSubmit={applyFilters} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <Field label="Report">
            <select
              className={inputClass}
              value={kind}
              onChange={(event) => {
                const nextKind = event.target.value;
                setKind(nextKind);
                setOffset(0);
                if (nextKind !== "inventory-movements") {
                  setFilters((current) => ({ ...current, movementType: "" }));
                  setApplied((current) => {
                    const next = { ...current };
                    delete next.movementType;
                    return next;
                  });
                }
              }}
            >
              {reportOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          {isAdmin && (
            <Field label="Base scope">
              <select
                className={inputClass}
                value={filters.baseId}
                onChange={(event) => setFilters({ ...filters, baseId: event.target.value })}
              >
                <option value="">All bases</option>
                {bases.map((base) => (
                  <option key={base.id} value={base.id}>{base.code} · {base.name}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Equipment type">
            <select
              className={inputClass}
              value={filters.equipmentTypeId}
              onChange={(event) =>
                setFilters({ ...filters, equipmentTypeId: event.target.value })
              }
            >
              <option value="">All equipment</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>{type.code} · {type.name}</option>
              ))}
            </select>
          </Field>
          <Field label="From (UTC date)">
            <input
              className={inputClass}
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </Field>
          <Field label="To (UTC date)">
            <input
              className={inputClass}
              type="date"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </Field>
          {kind === "inventory-movements" && (
            <Field label="Movement type">
              <select
                className={inputClass}
                value={filters.movementType}
                onChange={(event) =>
                  setFilters({ ...filters, movementType: event.target.value })
                }
              >
                <option value="">All types</option>
                {["PURCHASE", "TRANSFER_IN", "TRANSFER_OUT", "ASSIGNMENT", "RETURN", "EXPENDITURE"].map((type) => (
                  <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
                ))}
              </select>
            </Field>
          )}
          <div className="sm:col-span-2 xl:col-span-6">
            <button
              type="submit"
              className="min-h-10 rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Run report
            </button>
          </div>
        </form>
      </Panel>
      <SummaryTiles entries={summaries} />
      <Panel
        title={reportOptions.find(([value]) => value === kind)?.[1]}
        description={`${totalRows} rows`}
      >
        {reportLoading ? (
          <LoadingState label="Running report" />
        ) : (
          <>
            <DataTable columns={columns} rows={rows} emptyMessage="No records match this report." />
            {!reportError && (
              <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-slate-600">
                  Showing {firstRow}–{lastRow} of {totalRows}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={pageOffset === 0 || report.loading}
                    onClick={() =>
                      setOffset((value) => Math.max(0, value - pageLimit))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={
                      pageOffset + rows.length >= totalRows || report.loading
                    }
                    onClick={() => setOffset((value) => value + pageLimit)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
