import { useState } from "react";
import { Archive, ArrowDownToLine } from "lucide-react";
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
  StatusBadge,
  inputClass,
  formatDate,
} from "../components/ui.jsx";

function QuantityCard({ title, value, detail, icon: Icon }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500">{title}</p>
        <Icon aria-hidden="true" className="h-5 w-5 text-emerald-800" />
      </div>
      <p className="mt-2 text-3xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

export default function Inventory() {
  const { user } = useAuth();
  const [offset, setOffset] = useState(0);
  const [baseId, setBaseId] = useState("");
  const [equipmentTypeId, setEquipmentTypeId] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formValues, setFormValues] = useState({
    baseId: "",
    equipmentTypeId: "",
    openingBalance: "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const inventoryQuery = useApiQuery("/inventory", {
    limit: 100,
    offset,
    baseId: baseId || undefined,
    equipmentTypeId: equipmentTypeId || undefined,
  });
  const summaryQuery = useApiQuery("/inventory/summary");
  const basesQuery = useApiQuery("/bases", { limit: 100 });
  const equipmentTypesQuery = useApiQuery("/equipment-types", { limit: 100 });
  const rows = inventoryQuery.data?.inventory ?? [];
  const summary = summaryQuery.data?.summary ?? [];
  const bases = basesQuery.data?.bases ?? [];
  const equipmentTypes = equipmentTypesQuery.data?.equipmentTypes ?? [];
  const activeBases = bases.filter((base) => base.isActive);
  const activeEquipmentTypes = equipmentTypes.filter((type) => type.isActive);
  const available = summary.reduce((total, row) => total + row.closingBalance, 0);
  const assigned = summary.reduce((total, row) => total + row.assigned, 0);
  const isAdmin = user.role === "ADMIN";

  function openOpeningStockForm() {
    setFormValues({
      baseId: "",
      equipmentTypeId: "",
      openingBalance: "",
    });
    setError("");
    setSuccess("");
    setFormOpen(true);
  }

  async function submitOpeningStock(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    try {
      await api.post("/inventory/opening-stock", {
        baseId: formValues.baseId,
        equipmentTypeId: formValues.equipmentTypeId,
        openingBalance: Number(formValues.openingBalance),
      });
      setSuccess("Opening stock initialized. This value cannot be edited or deleted.");
      setFormOpen(false);
      setFormValues({
        baseId: "",
        equipmentTypeId: "",
        openingBalance: "",
      });
      inventoryQuery.refresh();
      summaryQuery.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  const columns = [
    {
      key: "base",
      label: "Base",
      render: (row) => (
        <div>
          <p className="font-semibold text-slate-900">{row.base.name}</p>
          <p className="text-xs text-slate-500">{row.base.code}</p>
        </div>
      ),
    },
    {
      key: "equipmentType",
      label: "Equipment",
      render: (row) => (
        <div>
          <p className="font-medium text-slate-900">{row.equipmentType.name}</p>
          <p className="text-xs text-slate-500">{row.equipmentType.code}</p>
        </div>
      ),
    },
    { key: "openingBalance", label: "Opening balance" },
    {
      key: "openingAt",
      label: "Opening date",
      render: (row) => formatDate(row.openingAt),
    },
    {
      key: "closingBalance",
      label: "Available",
      render: (row) => <span className="font-bold text-slate-950">{row.closingBalance.toLocaleString()}</span>,
    },
    { key: "assigned", label: "Net assigned" },
    { key: "purchases", label: "Completed purchases" },
    { key: "transfersIn", label: "Transfers in" },
    { key: "transfersOut", label: "Transfers out" },
    { key: "returned", label: "Returns" },
    { key: "expended", label: "Expended" },
    {
      key: "isActive",
      label: "Position",
      render: (row) => <StatusBadge value={row.isActive ? "ACTIVE" : "INACTIVE"} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Available and net assigned quantities are authoritative backend ledger values."
        actions={
          isAdmin && (
            <Button onClick={openOpeningStockForm}>
              Initialize opening stock
            </Button>
          )
        }
      />
      <Notice>
        {error ||
          inventoryQuery.error ||
          summaryQuery.error ||
          basesQuery.error ||
          equipmentTypesQuery.error}
      </Notice>
      <Notice tone="success">{success}</Notice>
      {formOpen && isAdmin && (
        <Panel
          title="Initialize opening stock"
          description="Creates the inventory position once. The opening balance cannot be edited or deleted."
          className="mb-5"
          actions={
            <Button
              variant="secondary"
              type="button"
              onClick={() => setFormOpen(false)}
            >
              Close
            </Button>
          }
        >
          <form
            onSubmit={submitOpeningStock}
            className="grid gap-4 md:grid-cols-3"
          >
            <Field label="Base">
              <select
                className={inputClass}
                value={formValues.baseId}
                onChange={(event) =>
                  setFormValues((current) => ({
                    ...current,
                    baseId: event.target.value,
                  }))
                }
                required
              >
                <option value="">Select an active base</option>
                {activeBases.map((base) => (
                  <option key={base.id} value={base.id}>
                    {base.code} · {base.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Equipment type">
              <select
                className={inputClass}
                value={formValues.equipmentTypeId}
                onChange={(event) =>
                  setFormValues((current) => ({
                    ...current,
                    equipmentTypeId: event.target.value,
                  }))
                }
                required
              >
                <option value="">Select an active equipment type</option>
                {activeEquipmentTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.code} · {type.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Opening quantity" hint="Enter a whole number greater than zero.">
              <input
                className={inputClass}
                type="number"
                min="1"
                max="2147483647"
                step="1"
                value={formValues.openingBalance}
                onChange={(event) =>
                  setFormValues((current) => ({
                    ...current,
                    openingBalance: event.target.value,
                  }))
                }
                required
              />
            </Field>
            <div className="md:col-span-3">
              <Button
                type="submit"
                disabled={
                  pending ||
                  basesQuery.loading ||
                  equipmentTypesQuery.loading
                }
              >
                {pending ? "Saving…" : "Set opening stock"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {inventoryQuery.loading || summaryQuery.loading ? (
        <LoadingState label="Loading inventory" />
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <QuantityCard
              title="Available inventory"
              value={available.toLocaleString()}
              detail="Current quantity across your authorized scope"
              icon={Archive}
            />
            <QuantityCard
              title="Net assigned"
              value={assigned.toLocaleString()}
              detail="After recorded returns"
              icon={ArrowDownToLine}
            />
          </div>
          <Panel
            title="Asset positions"
            description={`${inventoryQuery.meta?.total ?? rows.length} positions`}
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Filter by base">
                <select
                  className={inputClass}
                  value={baseId}
                  onChange={(event) => {
                    setBaseId(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All bases</option>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.code} · {base.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Filter by equipment type">
                <select
                  className={inputClass}
                  value={equipmentTypeId}
                  onChange={(event) => {
                    setEquipmentTypeId(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All equipment types</option>
                  {equipmentTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.code} · {type.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <DataTable
              columns={columns}
              rows={rows}
              emptyMessage="No inventory positions are available in this scope."
            />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {rows.length ? offset + 1 : 0}–{offset + rows.length} of{" "}
                {inventoryQuery.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || inventoryQuery.loading}
                  onClick={() => setOffset((value) => Math.max(0, value - 100))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    offset + 100 >= (inventoryQuery.meta?.total ?? 0) ||
                    inventoryQuery.loading
                  }
                  onClick={() => setOffset((value) => value + 100)}
                >
                  Next
                </Button>
              </div>
            </div>
          </Panel>
          <Panel title="Ledger summary" className="mt-5">
            <DataTable
              columns={[
                { key: "base", label: "Base", render: (row) => row.base.name },
                {
                  key: "equipmentType",
                  label: "Equipment",
                  render: (row) => row.equipmentType.name,
                },
                { key: "closingBalance", label: "Available" },
                { key: "assigned", label: "Net assigned" },
                { key: "returned", label: "Returned" },
                { key: "expended", label: "Expended" },
              ]}
              rows={summary}
            />
          </Panel>
        </>
      )}
    </>
  );
}
