import { useState } from "react";
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
} from "../components/ui.jsx";

const PAGE_SIZE = 50;

export default function Personnel() {
  const { user } = useAuth();
  const isAdmin = user.role === "ADMIN";
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [baseId, setBaseId] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    serviceNumber: "",
    rank: "",
    unit: "",
    baseId: "",
    email: "",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const personnelQuery = useApiQuery("/personnel", {
    limit: PAGE_SIZE,
    offset,
    search: search.trim() || undefined,
    ...(isAdmin && baseId ? { baseId } : {}),
  });
  const personnel = personnelQuery.data?.personnel ?? [];
  const baseById = new Map(
    (basesQuery.data?.bases ?? []).map((base) => [base.id, base]),
  );

  async function createPerson(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    try {
      await api.post("/personnel", form);
      setSuccess("Synthetic personnel record added.");
      setForm({
        fullName: "",
        serviceNumber: "",
        rank: "",
        unit: "",
        baseId: "",
        email: "",
      });
      setFormOpen(false);
      personnelQuery.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Personnel"
        description="Synthetic roster records for local demonstration only. No real personal information is used."
        actions={
          isAdmin ? (
            <Button onClick={() => setFormOpen((open) => !open)}>
              {formOpen ? "Close form" : "Add synthetic personnel"}
            </Button>
          ) : null
        }
      />
      <Notice>{error || personnelQuery.error || basesQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      {formOpen && isAdmin && (
        <Panel title="Add synthetic personnel" className="mb-5">
          <form
            onSubmit={createPerson}
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            <Field label="Name">
              <input
                className={inputClass}
                value={form.fullName}
                onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                maxLength={120}
                required
              />
            </Field>
            <Field label="Synthetic service number">
              <input
                className={inputClass}
                value={form.serviceNumber}
                onChange={(event) => setForm({ ...form, serviceNumber: event.target.value })}
                maxLength={32}
                required
              />
            </Field>
            <Field label="Rank">
              <input
                className={inputClass}
                value={form.rank}
                onChange={(event) => setForm({ ...form, rank: event.target.value })}
                maxLength={64}
                required
              />
            </Field>
            <Field label="Unit">
              <input
                className={inputClass}
                value={form.unit}
                onChange={(event) => setForm({ ...form, unit: event.target.value })}
                maxLength={80}
                required
              />
            </Field>
            <Field label="Base">
              <select
                className={inputClass}
                value={form.baseId}
                onChange={(event) => setForm({ ...form, baseId: event.target.value })}
                required
              >
                <option value="">Select base</option>
                {(basesQuery.data?.bases ?? []).map((base) => (
                  <option key={base.id} value={base.id}>
                    {base.code} · {base.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Demo email (optional)">
              <input
                className={inputClass}
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                maxLength={120}
              />
            </Field>
            <div className="sm:col-span-2 xl:col-span-3">
              <Button type="submit" disabled={pending || basesQuery.loading}>
                {pending ? "Adding…" : "Add synthetic record"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <Panel title="Synthetic roster" description={`${personnelQuery.meta?.total ?? 0} personnel records`}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Search roster">
            <input
              className={inputClass}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
              placeholder="Name, service number, rank, or unit"
            />
          </Field>
          {isAdmin && (
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
                {(basesQuery.data?.bases ?? []).map((base) => (
                  <option key={base.id} value={base.id}>
                    {base.code} · {base.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {personnelQuery.loading ? (
          <LoadingState label="Loading synthetic personnel" />
        ) : (
          <>
            <DataTable
              columns={[
                { key: "fullName", label: "Name" },
                { key: "serviceNumber", label: "Service number" },
                { key: "rank", label: "Rank" },
                { key: "unit", label: "Unit" },
                {
                  key: "baseId",
                  label: "Base",
                  render: (person) => baseById.get(person.baseId)?.name ?? "—",
                },
                { key: "status", label: "Status", render: (person) => <StatusBadge value={person.status} /> },
              ]}
              rows={personnel}
              emptyMessage="No synthetic personnel match this scope."
            />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {personnel.length ? offset + 1 : 0}–{offset + personnel.length} of{" "}
                {personnelQuery.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || personnelQuery.loading}
                  onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    offset + PAGE_SIZE >= (personnelQuery.meta?.total ?? 0) ||
                    personnelQuery.loading
                  }
                  onClick={() => setOffset((value) => value + PAGE_SIZE)}
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
