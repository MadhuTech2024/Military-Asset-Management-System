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
  formatDate,
  inputClass,
} from "../components/ui.jsx";

const EXPENDITURE_PAGE_SIZE = 50;

export default function Expenditures() {
  const { user } = useAuth();
  const canRecord = user.role === "ADMIN" || user.role === "BASE_COMMANDER";
  const [values, setValues] = useState({
    assetId: "",
    quantity: "",
    reasonCode: "",
    notes: "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [offset, setOffset] = useState(0);
  const report = useApiQuery("/reports/expenditures", {
    limit: EXPENDITURE_PAGE_SIZE,
    offset,
  });
  const inventoryQuery = useApiQuery("/inventory", { limit: 100, offset: 0 });
  const inventory = inventoryQuery.data?.inventory ?? [];
  const assetsById = new Map(inventory.map((asset) => [asset.id, asset]));

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    try {
      await api.post(
        "/expenditures",
        {
          assetId: values.assetId,
          quantity: Number(values.quantity),
          reasonCode: values.reasonCode.trim(),
          notes: values.notes.trim() || null,
        },
        { headers: { "Idempotency-Key": makeIdempotencyKey("expenditure") } },
      );
      setSuccess("Expenditure recorded. The quantity is reflected in the inventory ledger.");
      setValues({ assetId: "", quantity: "", reasonCode: "", notes: "" });
      report.refresh();
      inventoryQuery.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Expenditures"
        description="Record quantity-based expenditure and review the ledger events. Monetary totals are not available."
      />
      <Notice>{error || report.error || inventoryQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      {canRecord && (
        <Panel title="Record expenditure" className="mb-5">
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Inventory position">
            <select
              className={inputClass}
              value={values.assetId}
              onChange={(event) => setValues({ ...values, assetId: event.target.value })}
              required
            >
              <option value="">Select equipment position</option>
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
              max={values.assetId ? assetsById.get(values.assetId)?.closingBalance : 2147483647}
              step="1"
              required
              value={values.quantity}
              onChange={(event) => setValues({ ...values, quantity: event.target.value })}
            />
          </Field>
          <Field label="Reason code">
            <input
              className={inputClass}
              value={values.reasonCode}
              onChange={(event) => setValues({ ...values, reasonCode: event.target.value })}
              maxLength={64}
              required
            />
          </Field>
          <Field label="Notes (optional)">
            <textarea
              className={inputClass}
              rows={2}
              maxLength={4000}
              value={values.notes}
              onChange={(event) => setValues({ ...values, notes: event.target.value })}
            />
          </Field>
          <div className="sm:col-span-2 xl:col-span-4">
            <Button type="submit" disabled={pending || inventoryQuery.loading}>
              {pending ? "Recording…" : "Record expenditure"}
            </Button>
          </div>
          </form>
        </Panel>
      )}
      <Panel
        title="Expenditure history"
        description={`${report.data?.summary?.quantity ?? 0} units recorded`}
      >
        {report.loading ? (
          <LoadingState label="Loading expenditures" />
        ) : (
          <>
            <DataTable
              columns={[
                {
                  key: "baseId",
                  label: "Base",
                  render: (entry) => assetsById.get(entry.assetId)?.base.name ?? entry.baseId,
                },
                {
                  key: "equipmentTypeId",
                  label: "Equipment",
                  render: (entry) =>
                    assetsById.get(entry.assetId)?.equipmentType.name ?? entry.equipmentTypeId,
                },
                { key: "quantity", label: "Quantity" },
                { key: "expendedAt", label: "Recorded", render: (entry) => formatDate(entry.expendedAt) },
                { key: "expenditureId", label: "Record", render: (entry) => entry.expenditureId.slice(0, 8).toUpperCase() },
              ]}
              rows={report.data?.expenditures ?? []}
              emptyMessage="No expenditures are visible in this scope."
            />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {report.data?.expenditures?.length ? offset + 1 : 0}–
                {offset + (report.data?.expenditures?.length ?? 0)} of{" "}
                {report.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || report.loading}
                  onClick={() =>
                    setOffset((value) =>
                      Math.max(0, value - EXPENDITURE_PAGE_SIZE),
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    offset + EXPENDITURE_PAGE_SIZE >=
                      (report.meta?.total ?? 0) || report.loading
                  }
                  onClick={() =>
                    setOffset((value) => value + EXPENDITURE_PAGE_SIZE)
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
