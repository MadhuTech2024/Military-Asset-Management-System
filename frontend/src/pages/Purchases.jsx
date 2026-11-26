import { useState } from "react";
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

const PURCHASE_PAGE_SIZE = 50;

export default function Purchases() {
  const { user, isDemoSession } = useAuth();
  const canCreate = user.role === "ADMIN" || user.role === "LOGISTICS_OFFICER";
  const [offset, setOffset] = useState(0);
  const [values, setValues] = useState({
    baseId: user.baseId ?? "",
    equipmentTypeId: "",
    quantity: "",
    referenceCode: "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState(null);
  const [pendingStatusId, setPendingStatusId] = useState("");
  const report = useApiQuery("/reports/purchases", {
    limit: PURCHASE_PAGE_SIZE,
    offset,
  });
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const equipmentQuery = useApiQuery("/equipment-types", {
    limit: 100,
    isActive: true,
  });
  const bases = basesQuery.data?.bases ?? [];
  const equipmentTypes = equipmentQuery.data?.equipmentTypes ?? [];
  const baseById = new Map(bases.map((base) => [base.id, base]));
  const typeById = new Map(
    equipmentTypes.map((equipmentType) => [equipmentType.id, equipmentType]),
  );
  const canManageDemoStatus =
    isDemoSession && (user.role === "ADMIN" || user.role === "LOGISTICS_OFFICER");

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    try {
      await api.post(
        "/purchases",
        {
          baseId: user.role === "ADMIN" ? values.baseId : user.baseId,
          equipmentTypeId: values.equipmentTypeId,
          quantity: Number(values.quantity),
          referenceCode: values.referenceCode.trim() || null,
        },
        { headers: { "Idempotency-Key": makeIdempotencyKey("purchase") } },
      );
      setSuccess("Purchase request created as PENDING. It has not increased inventory.");
      setValues((current) => ({ ...current, quantity: "", referenceCode: "" }));
      report.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  async function changeDemoStatus(purchase, status) {
    setPendingStatusId(purchase.id);
    setError("");
    setSuccess("");
    try {
      await api.post(`/demo/purchases/${purchase.id}/status`, { status });
      setSuccess(`Synthetic purchase ${status.toLowerCase()}.`);
      setSelected(null);
      report.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPendingStatusId("");
    }
  }

  const purchases = report.data?.purchases ?? [];
  return (
    <>
      <PageHeader
        title="Purchases"
        description={
          isDemoSession
            ? "Review synthetic purchase requests. Demo-only status changes update the local inventory ledger."
            : "Review purchase requests and submit new pending requests. Completion is not available in this API."
        }
      />
      <Notice>{error || report.error || basesQuery.error || equipmentQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      {selected && (
        <Panel
          title="Purchase details"
          className="mb-5"
          actions={
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Close
            </Button>
          }
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Reference", selected.referenceCode ?? "—"],
              ["Supplier", selected.supplier ?? "—"],
              ["Estimated cost", selected.estimatedCost ? `$${Number(selected.estimatedCost).toLocaleString()}` : "—"],
              ["Expected date", formatDate(selected.expectedAt)],
              ["Status", selected.status],
              ["Quantity", selected.quantity],
              ["Requested", formatDate(selected.purchasedAt)],
              ["Completed", formatDate(selected.completedAt)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-1 break-words font-medium text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
          {selected.notes && <p className="mt-4 text-sm text-slate-600">{selected.notes}</p>}
        </Panel>
      )}
      {canCreate && (
        <Panel title="Create purchase request" className="mb-5">
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {user.role === "ADMIN" && (
              <Field label="Base">
                <select
                  className={inputClass}
                  value={values.baseId}
                  onChange={(event) => setValues({ ...values, baseId: event.target.value })}
                  required
                >
                  <option value="">Select base</option>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.code} · {base.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
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
            <Field label="Reference code (optional)">
              <input
                className={inputClass}
                maxLength={64}
                value={values.referenceCode}
                onChange={(event) =>
                  setValues({ ...values, referenceCode: event.target.value })
                }
              />
            </Field>
            <div className="sm:col-span-2 xl:col-span-4">
              <Button type="submit" disabled={pending || basesQuery.loading || equipmentQuery.loading}>
                {pending ? "Submitting…" : "Submit pending request"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-950">Pending requests</p>
          <p className="mt-1 text-2xl font-bold text-amber-950">
            {(report.data?.pending?.quantity ?? 0).toLocaleString()} units
          </p>
          <p className="text-xs text-amber-800">
            {report.data?.pending?.count ?? 0} requests · not counted as inventory
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold text-slate-800">Inventory rule</p>
          <p className="mt-1 text-sm text-slate-600">
            Only completed purchase movements contribute to available inventory.
          </p>
        </div>
      </div>
      <Panel
        title="Purchase history"
        description={`${report.meta?.total ?? 0} records`}
      >
        {report.loading ? (
          <LoadingState label="Loading purchases" />
        ) : (
          <>
            <DataTable
              columns={[
                {
                  key: "baseId",
                  label: "Base",
                  render: (purchase) =>
                    baseById.get(purchase.baseId)?.name ?? purchase.baseId,
                },
                {
                  key: "equipmentTypeId",
                  label: "Equipment",
                  render: (purchase) =>
                    typeById.get(purchase.equipmentTypeId)?.name ??
                    purchase.equipmentTypeId,
                },
                { key: "quantity", label: "Quantity" },
                ...(isDemoSession
                  ? [
                      { key: "referenceCode", label: "Reference" },
                      { key: "supplier", label: "Supplier" },
                      {
                        key: "estimatedCost",
                        label: "Estimate",
                        render: (purchase) => `$${Number(purchase.estimatedCost ?? 0).toLocaleString()}`,
                      },
                    ]
                  : []),
                {
                  key: "status",
                  label: "Status",
                  render: (purchase) => <StatusBadge value={purchase.status} />,
                },
                {
                  key: "purchasedAt",
                  label: "Purchase date",
                  render: (purchase) => formatDate(purchase.purchasedAt),
                },
                {
                  key: "completedAt",
                  label: "Completed at",
                  render: (purchase) => formatDate(purchase.completedAt),
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (purchase) => (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => setSelected(purchase)}>
                        Details
                      </Button>
                      {canManageDemoStatus &&
                        ["PENDING", "APPROVED"].includes(purchase.status) && (
                          <>
                            <Button
                              disabled={pendingStatusId === purchase.id}
                              onClick={() => changeDemoStatus(purchase, "COMPLETED")}
                            >
                              Complete
                            </Button>
                            <Button
                              variant="danger"
                              disabled={pendingStatusId === purchase.id}
                              onClick={() => changeDemoStatus(purchase, "REJECTED")}
                            >
                              Reject
                            </Button>
                          </>
                        )}
                    </div>
                  ),
                },
              ]}
              rows={purchases}
              emptyMessage="No purchase requests are visible in this scope."
            />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {purchases.length ? offset + 1 : 0}–
                {offset + purchases.length} of {report.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || report.loading}
                  onClick={() =>
                    setOffset((value) =>
                      Math.max(0, value - PURCHASE_PAGE_SIZE),
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    offset + PURCHASE_PAGE_SIZE >= (report.meta?.total ?? 0) ||
                    report.loading
                  }
                  onClick={() =>
                    setOffset((value) => value + PURCHASE_PAGE_SIZE)
                  }
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
