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
  formatDate,
  inputClass,
} from "../components/ui.jsx";

const blankBase = { code: "", name: "", locationName: "" };

export default function Bases() {
  const { user } = useAuth();
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState(blankBase);
  const [formOpen, setFormOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [viewing, setViewing] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState("");
  const query = useApiQuery("/bases", {
    limit: 50,
    offset,
    search,
    isActive:
      statusFilter === "" ? undefined : statusFilter === "active",
  });
  const isAdmin = user.role === "ADMIN";
  const bases = query.data?.bases ?? [];

  function startCreate() {
    setEditing(null);
    setValues(blankBase);
    setError("");
    setSuccess("");
    setFormOpen(true);
  }

  function startEdit(base) {
    setEditing(base);
    setValues({
      code: base.code,
      name: base.name,
      locationName: base.locationName ?? "",
    });
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
      locationName: values.locationName.trim() || null,
    };
    try {
      if (editing) {
        await api.patch(`/bases/${editing.id}`, body);
      } else {
        await api.post("/bases", body);
      }
      setSuccess(editing ? "Base details updated." : "Base created.");
      setFormOpen(false);
      setEditing(null);
      setValues(blankBase);
      query.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  async function toggleActive(base) {
    setError("");
    setSuccess("");
    try {
      await api.patch(`/bases/${base.id}/status`, {
        isActive: !base.isActive,
      });
      setSuccess(base.isActive ? "Base deactivated." : "Base activated.");
      query.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    }
  }

  async function viewBase(base) {
    setViewing(null);
    setViewError("");
    setViewLoading(true);
    try {
      const { data } = await api.get(`/bases/${base.id}`);
      setViewing(data.data.base);
    } catch (requestError) {
      setViewError(apiErrorMessage(requestError));
    } finally {
      setViewLoading(false);
    }
  }

  const columns = [
    { key: "code", label: "Code" },
    { key: "name", label: "Base" },
    {
      key: "locationName",
      label: "Location",
      render: (base) => base.locationName || "—",
    },
    {
      key: "isActive",
      label: "Status",
      render: (base) => <StatusBadge value={base.isActive ? "ACTIVE" : "INACTIVE"} />,
    },
    {
      key: "actions",
      label: "Actions",
      render: (base) => (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => viewBase(base)}>
            View
          </Button>
          {isAdmin && (
            <>
              <Button variant="secondary" onClick={() => startEdit(base)}>
                Edit
              </Button>
              <Button
                variant={base.isActive ? "danger" : "secondary"}
                onClick={() => toggleActive(base)}
              >
                {base.isActive ? "Deactivate" : "Activate"}
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Base management"
        description={
          isAdmin
            ? "Maintain the base directory and active status."
            : "View the base assigned to your account."
        }
        actions={
          isAdmin && (
            <Button onClick={startCreate}>Add base</Button>
          )
        }
      />
      <Notice>{error || query.error}</Notice>
      <Notice tone="success">{success}</Notice>
      <Notice>{viewError}</Notice>
      {viewLoading && <LoadingState label="Loading base details" />}
      {viewing && (
        <Panel
          title="Base details"
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
            <div><dt className="text-slate-500">Location</dt><dd className="font-medium">{viewing.locationName || "—"}</dd></div>
            <div><dt className="text-slate-500">Status</dt><dd><StatusBadge value={viewing.isActive ? "ACTIVE" : "INACTIVE"} /></dd></div>
            <div><dt className="text-slate-500">Created</dt><dd className="font-medium">{formatDate(viewing.createdAt)}</dd></div>
            <div><dt className="text-slate-500">Last updated</dt><dd className="font-medium">{formatDate(viewing.updatedAt)}</dd></div>
          </dl>
        </Panel>
      )}
      {formOpen && isAdmin && (
        <Panel
          title={editing ? "Update base" : "Create base"}
          className="mb-5"
          actions={
            <Button
              variant="secondary"
              onClick={() => setFormOpen(false)}
              type="button"
            >
              Close
            </Button>
          }
        >
          <form className="grid gap-4 md:grid-cols-3" onSubmit={submit}>
            <Field label="Base code">
              <input
                className={inputClass}
                value={values.code}
                onChange={(event) =>
                  setValues((current) => ({ ...current, code: event.target.value }))
                }
                maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}"
                required
              />
            </Field>
            <Field label="Base name">
              <input
                className={inputClass}
                value={values.name}
                onChange={(event) =>
                  setValues((current) => ({ ...current, name: event.target.value }))
                }
                maxLength={128}
                required
              />
            </Field>
            <Field label="Location (optional)">
              <input
                className={inputClass}
                value={values.locationName}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    locationName: event.target.value,
                  }))
                }
                maxLength={128}
              />
            </Field>
            <div className="md:col-span-3">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : editing ? "Save changes" : "Create base"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <Panel title="Bases" description={`${query.meta?.total ?? 0} records`}>
        {query.loading ? (
          <LoadingState label="Loading bases" />
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Search bases">
                <input
                  className={inputClass}
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                  maxLength={128}
                  placeholder="Code, name, or location"
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
            <DataTable columns={columns} rows={bases} />
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
              <span className="text-slate-500">
                Showing {bases.length ? offset + 1 : 0}–{offset + bases.length} of{" "}
                {query.meta?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={offset === 0 || query.loading}
                  onClick={() => setOffset((value) => Math.max(0, value - 50))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={offset + 50 >= (query.meta?.total ?? 0) || query.loading}
                  onClick={() => setOffset((value) => value + 50)}
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
