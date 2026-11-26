import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import useApiQuery from "../hooks/useApiQuery.js";
import api, { apiErrorMessage, makeIdempotencyKey } from "../services/api.js";
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

const TRANSFER_PAGE_SIZE = 50;

export default function Transfers() {
  const { user } = useAuth();
  const canInitiate = user.role === "ADMIN" || user.role === "LOGISTICS_OFFICER";
  const isAdmin = user.role === "ADMIN";
  const [values, setValues] = useState({
    sourceBaseId: user.baseId ?? "",
    destinationBaseId: "",
    equipmentTypeId: "",
    quantity: "",
  });
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState(null);
  const [offset, setOffset] = useState(0);
  const [destinationOffset, setDestinationOffset] = useState(0);
  const [loadedDestinations, setLoadedDestinations] = useState([]);
  const report = useApiQuery("/reports/transfers", {
    limit: TRANSFER_PAGE_SIZE,
    offset,
  });
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const destinationsQuery = useApiQuery("/bases/transfer-destinations", {
    limit: 100,
    offset: destinationOffset,
  });
  const equipmentQuery = useApiQuery("/equipment-types", {
    limit: 100,
    isActive: true,
  });
  const bases = basesQuery.data?.bases ?? [];
  const destinations = loadedDestinations;
  const equipmentTypes = equipmentQuery.data?.equipmentTypes ?? [];
  const allBases = [...bases, ...destinations];
  const baseName = (id) => allBases.find((base) => base.id === id)?.name ?? id;
  const typeName = (id) =>
    equipmentTypes.find((type) => type.id === id)?.name ?? id;

  useEffect(() => {
    const page = destinationsQuery.data?.bases;
    if (!page) return;
    setLoadedDestinations((current) => {
      const merged = destinationOffset === 0 ? [] : current;
      const existingIds = new Set(merged.map((base) => base.id));
      return [...merged, ...page.filter((base) => !existingIds.has(base.id))];
    });
  }, [destinationOffset, destinationsQuery.data]);

  async function submit(event) {
    event.preventDefault();
    setPendingId("new");
    setError("");
    setSuccess("");
    try {
      await api.post(
        "/transfers",
        {
          sourceBaseId: isAdmin ? values.sourceBaseId : user.baseId,
          destinationBaseId: values.destinationBaseId,
          equipmentTypeId: values.equipmentTypeId,
          quantity: Number(values.quantity),
        },
        { headers: { "Idempotency-Key": makeIdempotencyKey("transfer") } },
      );
      setSuccess("Transfer initiated as PENDING. Inventory moves only when completed.");
      setValues((current) => ({ ...current, destinationBaseId: "", quantity: "" }));
      report.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPendingId("");
    }
  }

  async function act(transfer, action) {
    setPendingId(transfer.id);
    setError("");
    setSuccess("");
    try {
      await api.post(
        `/transfers/${transfer.id}/${action}`,
        {},
        { headers: { "Idempotency-Key": makeIdempotencyKey(`transfer-${action}`) } },
      );
      setSuccess(`Transfer ${action} request completed.`);
      report.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPendingId("");
    }
  }

  const transfers = report.data?.transfers ?? [];
  const columns = [
    { key: "id", label: "Transfer", render: (transfer) => transfer.id.slice(0, 8).toUpperCase() },
    { key: "sourceBaseId", label: "Source", render: (transfer) => baseName(transfer.sourceBaseId) },
    {
      key: "destinationBaseId",
      label: "Destination",
      render: (transfer) => baseName(transfer.destinationBaseId),
    },
    {
      key: "equipmentTypeId",
      label: "Equipment",
      render: (transfer) => typeName(transfer.equipmentTypeId),
    },
    { key: "quantity", label: "Quantity" },
    {
      key: "status",
      label: "Status",
      render: (transfer) => <StatusBadge value={transfer.status} />,
    },
    { key: "createdAt", label: "Requested", render: (transfer) => formatDate(transfer.createdAt) },
    {
      key: "actions",
      label: "Available action",
      render: (transfer) => {
        const isDestination = transfer.destinationBaseId === user.baseId;
        const controls = [];
        if (user.role === "BASE_COMMANDER" && isDestination && transfer.status === "PENDING") {
          controls.push(
            <Button key="approve" disabled={pendingId === transfer.id} onClick={() => act(transfer, "approve")}>
              Approve
            </Button>,
            <Button key="reject" variant="danger" disabled={pendingId === transfer.id} onClick={() => act(transfer, "reject")}>
              Reject
            </Button>,
          );
        }
        if (user.role === "LOGISTICS_OFFICER" && isDestination && transfer.status === "APPROVED") {
          controls.push(
            <Button key="complete" disabled={pendingId === transfer.id} onClick={() => act(transfer, "complete")}>
              Complete
            </Button>,
          );
        }
        return (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setSelected(transfer)}>
              Details
            </Button>
            {controls}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Track transfer lifecycle and perform only the actions permitted for your role and base."
      />
      <Notice>{error || report.error || basesQuery.error || destinationsQuery.error || equipmentQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      {selected && (
        <Panel
          title="Transfer details"
          className="mb-5"
          actions={
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Close
            </Button>
          }
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Transfer ID", selected.id],
              ["Source base", baseName(selected.sourceBaseId)],
              ["Destination base", baseName(selected.destinationBaseId)],
              ["Equipment", typeName(selected.equipmentTypeId)],
              ["Quantity", selected.quantity],
              ["Status", selected.status],
              ["Requested", formatDate(selected.createdAt)],
              ["Approved", formatDate(selected.approvedAt)],
              ["Completed", formatDate(selected.completedAt)],
              ["Rejected", formatDate(selected.rejectedAt)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-1 break-all font-medium text-slate-900">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {selected.notes && <p className="mt-4 text-sm text-slate-600">{selected.notes}</p>}
        </Panel>
      )}
      {canInitiate && (
        <Panel title="Initiate transfer" className="mb-5">
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {isAdmin ? (
              <Field label="Source base">
                <select
                  className={inputClass}
                  value={values.sourceBaseId}
                  onChange={(event) =>
                    setValues({
                      ...values,
                      sourceBaseId: event.target.value,
                      destinationBaseId:
                        values.destinationBaseId === event.target.value
                          ? ""
                          : values.destinationBaseId,
                    })
                  }
                  required
                >
                  <option value="">Select source</option>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.code} · {base.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Source base">
                <input className={inputClass} value={baseName(user.baseId)} disabled />
              </Field>
            )}
            <Field label="Destination base">
              <select
                className={inputClass}
                value={values.destinationBaseId}
                onChange={(event) =>
                  setValues({ ...values, destinationBaseId: event.target.value })
                }
                required
              >
                <option value="">Select destination</option>
                {destinations
                  .filter((base) => !isAdmin || base.id !== values.sourceBaseId)
                  .map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.code} · {base.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Equipment type">
              <select
                className={inputClass}
                value={values.equipmentTypeId}
                onChange={(event) =>
                  setValues({ ...values, equipmentTypeId: event.target.value })
                }
                required
              >
                <option value="">Select equipment</option>
                {equipmentTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.code} · {type.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantity">
              <input
                className={inputClass}
                type="number"
                min="1"
                max="2147483647"
                step="1"
                required
                value={values.quantity}
                onChange={(event) => setValues({ ...values, quantity: event.target.value })}
              />
            </Field>
            <div className="sm:col-span-2 xl:col-span-4">
              <Button
                type="submit"
                disabled={
                  pendingId === "new" ||
                  basesQuery.loading ||
                  destinationsQuery.loading ||
                  equipmentQuery.loading
                }
              >
                {pendingId === "new" ? "Submitting…" : "Create pending transfer"}
              </Button>
            </div>
          </form>
          {destinationsQuery.meta?.total > destinations.length && (
            <Button
              className="mt-3"
              variant="secondary"
              type="button"
              disabled={destinationsQuery.loading}
              onClick={() => setDestinationOffset((value) => value + 100)}
            >
              {destinationsQuery.loading ? "Loading…" : "Load more destinations"}
            </Button>
          )}
        </Panel>
      )}
      <Panel
        title="Transfer register"
        description={`${report.meta?.total ?? 0} records`}
      >
        {report.loading ? (
          <LoadingState label="Loading transfers" />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={transfers}
              emptyMessage="No transfers are visible in this scope."
            />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {transfers.length ? offset + 1 : 0}–
                {offset + transfers.length} of {report.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || report.loading}
                  onClick={() =>
                    setOffset((value) =>
                      Math.max(0, value - TRANSFER_PAGE_SIZE),
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    offset + TRANSFER_PAGE_SIZE >= (report.meta?.total ?? 0) ||
                    report.loading
                  }
                  onClick={() => setOffset((value) => value + TRANSFER_PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
