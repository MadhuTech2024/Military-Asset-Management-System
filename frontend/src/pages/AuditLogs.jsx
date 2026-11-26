import { useState } from "react";
import { Eye } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import useApiQuery from "../hooks/useApiQuery.js";
import api, { apiErrorMessage } from "../services/api.js";
import {
  Button,
  DataTable,
  Field,
  LoadingState,
  Notice,
  PageHeader,
  Panel,
  formatDate,
  inputClass,
} from "../components/ui.jsx";

const ACTION_LABELS = {
  USER_CREATED: "User created",
  USER_UPDATED: "User details updated",
  USER_ACTIVATED: "User activated",
  USER_DEACTIVATED: "User deactivated",
  BASE_CREATED: "Base created",
  BASE_UPDATED: "Base details updated",
  BASE_ACTIVATED: "Base activated",
  BASE_DEACTIVATED: "Base deactivated",
  EQUIPMENT_TYPE_CREATED: "Equipment type created",
  EQUIPMENT_TYPE_UPDATED: "Equipment type updated",
  EQUIPMENT_TYPE_ACTIVATED: "Equipment type activated",
  EQUIPMENT_TYPE_DEACTIVATED: "Equipment type deactivated",
  OPENING_STOCK_CREATED: "Opening stock created",
  PURCHASE_CREATED: "Purchase requested",
  TRANSFER_INITIATED: "Transfer initiated",
  TRANSFER_APPROVED: "Transfer approved",
  TRANSFER_REJECTED: "Transfer rejected",
  TRANSFER_COMPLETED: "Transfer completed",
  ASSIGNMENT_CREATED: "Assignment created",
  ASSIGNMENT_RETURN_RECORDED: "Assignment return recorded",
  EXPENDITURE_RECORDED: "Expenditure recorded",
};

const ENTITY_LABELS = {
  equipment_type: "Equipment type",
  return_operation: "Return",
};

function dateBound(day, endOfDay = false) {
  if (!day) return undefined;
  return `${day}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
}

function actionLabel(action) {
  return ACTION_LABELS[action] ?? action
    ?.toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function entityLabel(entityType) {
  return ENTITY_LABELS[entityType] ?? entityType;
}

export default function AuditLogs() {
  const { user } = useAuth();
  const isAdmin = user.role === "ADMIN";
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({
    action: "",
    entityType: "",
    baseId: "",
    from: "",
    to: "",
  });
  const [applied, setApplied] = useState({});
  const [selected, setSelected] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState("");
  const basesQuery = useApiQuery("/bases", { limit: 100 });
  const query = useApiQuery("/audit", {
    ...applied,
    limit: 50,
    offset,
  });
  const logs = query.data?.audits ?? [];

  function applyFilters(event) {
    event.preventDefault();
    setOffset(0);
    setApplied({
      ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
      ...(filters.entityType.trim()
        ? { entityType: filters.entityType.trim() }
        : {}),
      ...(isAdmin && filters.baseId ? { baseId: filters.baseId } : {}),
      ...(filters.from ? { from: dateBound(filters.from) } : {}),
      ...(filters.to ? { to: dateBound(filters.to, true) } : {}),
    });
  }

  async function showDetails(log) {
    setSelected(null);
    setError("");
    setDetailsLoading(true);
    try {
      const { data } = await api.get(`/audit/${log.id}`);
      setSelected(data.data.audit);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setDetailsLoading(false);
    }
  }

  function baseLabel(baseId) {
    if (!baseId) return "Global";
    const base = (basesQuery.data?.bases ?? []).find(
      (candidate) => candidate.id === baseId,
    );
    return base ? `${base.code} · ${base.name}` : baseId;
  }

  return (
    <>
      <PageHeader
        title="Audit logs"
        description="Review scoped audit event metadata. Sensitive snapshots and restricted user details are not exposed."
      />
      <Notice>{error || query.error || basesQuery.error}</Notice>
      <Panel title="Filter audit events" className="mb-5">
        <form onSubmit={applyFilters} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="Action">
            <input
              className={inputClass}
              value={filters.action}
              onChange={(event) => setFilters({ ...filters, action: event.target.value })}
              maxLength={64}
              placeholder="e.g. USER_UPDATED"
            />
          </Field>
          <Field label="Entity type">
            <input
              className={inputClass}
              value={filters.entityType}
              onChange={(event) => setFilters({ ...filters, entityType: event.target.value })}
              maxLength={64}
              placeholder="e.g. equipment_type"
            />
          </Field>
          {isAdmin && (
            <Field label="Base">
              <select
                className={inputClass}
                value={filters.baseId}
                onChange={(event) => setFilters({ ...filters, baseId: event.target.value })}
              >
                <option value="">All bases</option>
                {(basesQuery.data?.bases ?? []).map((base) => (
                  <option key={base.id} value={base.id}>{base.code} · {base.name}</option>
                ))}
              </select>
            </Field>
          )}
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
          <div className="sm:col-span-2 xl:col-span-5">
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
      </Panel>
      {detailsLoading && (
        <Panel title="Audit event details" className="mb-5">
          <LoadingState label="Loading audit event details" />
        </Panel>
      )}
      {selected && (
        <Panel
          title="Audit event details"
          className="mb-5"
          actions={
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Close
            </Button>
          }
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            {[
              ["Event ID", selected.id],
              ["Action", actionLabel(selected.action)],
              ["Entity", `${entityLabel(selected.entityType)} · ${selected.entityId}`],
              ["Actor ID", selected.actorId ?? "System"],
              ["Base", baseLabel(selected.baseId)],
              ["Correlation ID", selected.correlationId ?? "—"],
              ["Created", formatDate(selected.createdAt)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-1 break-all font-medium text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}
      <Panel title="Event register" description={`${query.meta?.total ?? 0} events`}>
        {query.loading ? (
          <LoadingState label="Loading audit events" />
        ) : (
          <>
            <DataTable
              columns={[
                { key: "createdAt", label: "Timestamp", render: (log) => formatDate(log.createdAt) },
                { key: "action", label: "Action", render: (log) => actionLabel(log.action) },
                { key: "entityType", label: "Entity", render: (log) => entityLabel(log.entityType) },
                { key: "entityId", label: "Entity ID", render: (log) => log.entityId?.slice(0, 8).toUpperCase() ?? "—" },
                { key: "actorId", label: "Actor", render: (log) => log.actorId?.slice(0, 8).toUpperCase() ?? "System" },
                { key: "baseId", label: "Base", render: (log) => baseLabel(log.baseId) },
                {
                  key: "details",
                  label: "Details",
                  render: (log) => (
                    <Button
                      variant="secondary"
                      aria-label={`View metadata for ${log.action}`}
                      onClick={() => showDetails(log)}
                    >
                      <Eye aria-hidden="true" className="h-4 w-4" />
                      View
                    </Button>
                  ),
                },
              ]}
              rows={logs}
              emptyMessage="No audit events match the current filters."
            />
            <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <Button
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 50))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={offset + 50 >= (query.meta?.total ?? 0)}
                onClick={() => setOffset((value) => value + 50)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
