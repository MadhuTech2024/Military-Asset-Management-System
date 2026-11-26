import { useState } from "react";
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
  formatDate,
  inputClass,
} from "../components/ui.jsx";

const emptyType = { code: "", name: "", category: "", description: "" };

export default function EquipmentTypes() {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState(emptyType);
  const [formOpen, setFormOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [viewing, setViewing] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState("");
  const query = useApiQuery("/equipment-types", {
    limit: 50,
    offset,
    search,
    isActive:
      statusFilter === "" ? undefined : statusFilter === "active",
  });
  const types = query.data?.equipmentTypes ?? [];

  function openForm(type = null) {
    setEditing(type);
    setValues(
      type
        ? {
            code: type.code,
            name: type.name,
            category: type.category,
            description: type.description ?? "",
          }
        : emptyType,
    );
    setError("");
    setSuccess("");
    setFormOpen(true);
  }

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    const body = {
      code: values.code.trim().toUpperCase(),
      name: values.name.trim(),
      category: values.category.trim(),
      description: values.description.trim() || null,
    };
    try {
      if (editing) await api.patch(`/equipment-types/${editing.id}`, body);
      else await api.post("/equipment-types", body);
      setSuccess(editing ? "Equipment type updated." : "Equipment type created.");
      setFormOpen(false);
      query.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  async function toggleActive(type) {
    setError("");
    setSuccess("");
    try {
      await api.patch(`/equipment-types/${type.id}/status`, {
        isActive: !type.isActive,
      });
      setSuccess(type.isActive ? "Equipment type deactivated." : "Equipment type activated.");
      query.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    }
  }

  async function viewType(type) {
    setViewing(null);
    setViewError("");
    setViewLoading(true);
    try {
      const { data } = await api.get(`/equipment-types/${type.id}`);
      setViewing(data.data.equipmentType);
    } catch (requestError) {
      setViewError(apiErrorMessage(requestError));
    } finally {
      setViewLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Equipment types"
        description="Maintain the shared equipment catalog used by inventory and operations."
        actions={<Button onClick={() => openForm()}>Add equipment type</Button>}
      />
      <Notice>{error || query.error}</Notice>
      <Notice tone="success">{success}</Notice>
      <Notice>{viewError}</Notice>
      {viewLoading && <LoadingState label="Loading equipment type details" />}
      {viewing && (
        <Panel
          title="Equipment type details"
          className="mb-5"
          actions={
            <Button
              variant="secondary"
              onClick={() => setViewing(null)}
              type="button"
            >
              Close
            </Button>
          }
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-500">Code</dt><dd className="font-medium">{viewing.code}</dd></div>
            <div><dt className="text-slate-500">Name</dt><dd className="font-medium">{viewing.name}</dd></div>
            <div><dt className="text-slate-500">Category</dt><dd className="font-medium">{viewing.category}</dd></div>
            <div><dt className="text-slate-500">Status</dt><dd><StatusBadge value={viewing.isActive ? "ACTIVE" : "INACTIVE"} /></dd></div>
            <div className="sm:col-span-2"><dt className="text-slate-500">Description</dt><dd className="font-medium">{viewing.description || "—"}</dd></div>
            <div><dt className="text-slate-500">Created</dt><dd className="font-medium">{formatDate(viewing.createdAt)}</dd></div>
            <div><dt className="text-slate-500">Last updated</dt><dd className="font-medium">{formatDate(viewing.updatedAt)}</dd></div>
          </dl>
        </Panel>
      )}
      {formOpen && (
        <Panel
          title={editing ? "Edit equipment type" : "Create equipment type"}
          className="mb-5"
          actions={
            <Button variant="secondary" type="button" onClick={() => setFormOpen(false)}>
              Close
            </Button>
          }
        >
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
            <Field label="Code">
              <input
                className={inputClass}
                value={values.code}
                onChange={(event) => setValues({ ...values, code: event.target.value })}
                maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}"
                required
              />
            </Field>
            <Field label="Name">
              <input
                className={inputClass}
                value={values.name}
                onChange={(event) => setValues({ ...values, name: event.target.value })}
                maxLength={128}
                required
              />
            </Field>
            <Field label="Category">
              <input
                className={inputClass}
                value={values.category}
                onChange={(event) => setValues({ ...values, category: event.target.value })}
                maxLength={64}
                required
              />
            </Field>
            <Field label="Description (optional)">
              <textarea
                className={inputClass}
                value={values.description}
                onChange={(event) =>
                  setValues({ ...values, description: event.target.value })
                }
                rows={3}
                maxLength={4000}
              />
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : editing ? "Save changes" : "Create equipment type"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <Panel title="Catalog" description={`${query.meta?.total ?? 0} equipment types`}>
        {query.loading ? (
          <LoadingState label="Loading equipment types" />
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Search equipment types">
                <input
                  className={inputClass}
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                  maxLength={128}
                  placeholder="Code, name, category, or description"
                />
              </Field>
              <Field label="Status">
                <select
                  className={inputClass}
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
            </div>
            <DataTable
              columns={[
                { key: "code", label: "Code" },
                { key: "name", label: "Equipment type" },
                { key: "category", label: "Category" },
                {
                  key: "isActive",
                  label: "Status",
                  render: (type) => <StatusBadge value={type.isActive ? "ACTIVE" : "INACTIVE"} />,
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (type) => (
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => viewType(type)}>
                        View
                      </Button>
                      <Button variant="secondary" onClick={() => openForm(type)}>Edit</Button>
                      <Button
                        variant={type.isActive ? "danger" : "secondary"}
                        onClick={() => toggleActive(type)}
                      >
                        {type.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={types}
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
