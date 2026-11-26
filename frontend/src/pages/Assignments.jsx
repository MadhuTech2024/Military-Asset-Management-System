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

const ASSIGNMENT_PAGE_SIZE = 50;

export default function Assignments() {
  const { user } = useAuth();
  const canCreate = user.role === "ADMIN" || user.role === "BASE_COMMANDER";
  const [values, setValues] = useState({
    assetId: "",
    quantity: "",
    personnelReference: "",
  });
  const [returnQuantities, setReturnQuantities] = useState({});
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [offset, setOffset] = useState(0);
  const report = useApiQuery("/reports/assignments", {
    limit: ASSIGNMENT_PAGE_SIZE,
    offset,
  });
  const inventoryQuery = useApiQuery("/inventory", { limit: 100, offset: 0 });
  const assignments = report.data?.assignments ?? [];
  const inventory = inventoryQuery.data?.inventory ?? [];
  const inventoryById = new Map(inventory.map((asset) => [asset.id, asset]));

  async function submit(event) {
    event.preventDefault();
    setPendingId("new");
    setError("");
    setSuccess("");
    try {
      await api.post(
        "/assignments",
        {
          assetId: values.assetId,
          quantity: Number(values.quantity),
          personnelReference: values.personnelReference.trim(),
        },
        { headers: { "Idempotency-Key": makeIdempotencyKey("assignment") } },
      );
      setSuccess("Assignment recorded.");
      setValues({ assetId: "", quantity: "", personnelReference: "" });
      report.refresh();
      inventoryQuery.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPendingId("");
    }
  }

  async function recordReturn(assignment) {
    const quantity = Number(returnQuantities[assignment.id]);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > assignment.netAssigned) {
      setError("Enter a return quantity within the outstanding assigned amount.");
      return;
    }
    setPendingId(assignment.id);
    setError("");
    setSuccess("");
    try {
      await api.post(
        `/assignments/${assignment.id}/returns`,
        { quantity },
        { headers: { "Idempotency-Key": makeIdempotencyKey("assignment-return") } },
      );
      setSuccess("Return recorded and reflected in the backend inventory ledger.");
      setReturnQuantities((current) => ({ ...current, [assignment.id]: "" }));
      report.refresh();
      inventoryQuery.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPendingId("");
    }
  }

  return (
    <>
      <PageHeader
        title="Assignments & returns"
        description="Gross assignments, cumulative returns, and net assigned quantities are reported separately."
      />
      <Notice>{error || report.error || inventoryQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      {canCreate && (
        <Panel title="Create assignment" className="mb-5">
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Inventory position">
              <select
                className={inputClass}
                value={values.assetId}
                onChange={(event) => setValues({ ...values, assetId: event.target.value })}
                required
              >
                <option value="">Select available equipment</option>
                {inventory
                  .filter((asset) => asset.closingBalance > 0 && asset.isActive)
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.base.code} · {asset.equipmentType.name} · {asset.closingBalance} available
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Quantity">
              <input
                className={inputClass}
                type="number"
                min="1"
                max={values.assetId ? inventoryById.get(values.assetId)?.closingBalance : 2147483647}
                step="1"
                required
                value={values.quantity}
                onChange={(event) => setValues({ ...values, quantity: event.target.value })}
              />
            </Field>
            <Field
              label="Synthetic personnel reference"
              hint="Use demonstration data only; do not enter real operational personal information."
            >
              <input
                className={inputClass}
                value={values.personnelReference}
                onChange={(event) =>
                  setValues({ ...values, personnelReference: event.target.value })
                }
                maxLength={64}
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={pendingId === "new" || inventoryQuery.loading}>
                {pendingId === "new" ? "Saving…" : "Record assignment"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Assignments</p>
          <p className="mt-1 text-2xl font-bold text-slate-950">
            {report.data?.summary?.assignmentCount ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Gross assigned</p>
          <p className="mt-1 text-2xl font-bold text-slate-950">
            {(report.data?.summary?.grossAssigned ?? 0).toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">Net assigned</p>
          <p className="mt-1 text-2xl font-bold text-slate-950">
            {(report.data?.summary?.netAssigned ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            After {(report.data?.summary?.cumulativeReturned ?? 0).toLocaleString()} returns
          </p>
        </div>
      </div>
      <Panel title="Assignment register">
        {report.loading ? (
          <LoadingState label="Loading assignments" />
        ) : (
          <>
            <DataTable
              columns={[
                { key: "id", label: "Assignment", render: (assignment) => assignment.id.slice(0, 8).toUpperCase() },
                {
                  key: "assetId",
                  label: "Position",
                  render: (assignment) => {
                    const asset = inventoryById.get(assignment.assetId);
                    return asset
                      ? `${asset.base.code} · ${asset.equipmentType.name}`
                      : assignment.assetId;
                  },
                },
                { key: "grossAssigned", label: "Gross assigned" },
                { key: "cumulativeReturned", label: "Returned to date" },
                { key: "netAssigned", label: "Net assigned" },
                { key: "status", label: "Status", render: (assignment) => <StatusBadge value={assignment.status} /> },
                { key: "assignedAt", label: "Assigned at", render: (assignment) => formatDate(assignment.assignedAt) },
                {
                  key: "return",
                  label: "Record return",
                  render: (assignment) =>
                    canCreate && assignment.netAssigned > 0 ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          recordReturn(assignment);
                        }}
                      >
                        <input
                          className={`${inputClass} w-24`}
                          type="number"
                          min="1"
                          max={assignment.netAssigned}
                          step="1"
                          aria-label={`Return quantity for assignment ${assignment.id}`}
                          value={returnQuantities[assignment.id] ?? ""}
                          onChange={(event) =>
                            setReturnQuantities((current) => ({
                              ...current,
                              [assignment.id]: event.target.value,
                            }))
                          }
                          required
                        />
                        <Button type="submit" disabled={pendingId === assignment.id}>
                          Return
                        </Button>
                      </form>
                    ) : "—",
                },
              ]}
              rows={assignments}
              emptyMessage="No assignments are visible in this scope."
            />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {assignments.length ? offset + 1 : 0}–
                {offset + assignments.length} of {report.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || report.loading}
                  onClick={() =>
                    setOffset((value) =>
                      Math.max(0, value - ASSIGNMENT_PAGE_SIZE),
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    offset + ASSIGNMENT_PAGE_SIZE >=
                      (report.meta?.total ?? 0) || report.loading
                  }
                  onClick={() =>
                    setOffset((value) => value + ASSIGNMENT_PAGE_SIZE)
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
