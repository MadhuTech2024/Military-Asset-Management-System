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

const emptyUser = {
  email: "",
  name: "",
  role: "LOGISTICS_OFFICER",
  baseId: "",
  password: "",
};

export default function Users() {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState(emptyUser);
  const [formOpen, setFormOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [viewing, setViewing] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState("");
  const query = useApiQuery("/users", {
    limit: 50,
    offset,
    search,
    role: roleFilter || undefined,
    isActive:
      statusFilter === "" ? undefined : statusFilter === "active",
  });
  const basesQuery = useApiQuery("/bases", { limit: 100, isActive: true });
  const users = query.data?.users ?? [];
  const bases = basesQuery.data?.bases ?? [];

  function openForm(user = null) {
    setEditing(user);
    setValues(
      user
        ? {
            email: user.email,
            name: user.name,
            role: user.role,
            baseId: user.baseId ?? "",
            password: "",
          }
        : emptyUser,
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
      email: values.email.trim().toLowerCase(),
      name: values.name.trim(),
      role: values.role,
      baseId: values.role === "ADMIN" ? null : values.baseId || null,
    };
    if (values.password) body.password = values.password;
    try {
      if (editing) {
        await api.patch(`/users/${editing.id}`, body);
        setSuccess("User details updated.");
      } else {
        await api.post("/users", { ...body, password: values.password });
        setSuccess("User account created.");
      }
      setFormOpen(false);
      setValues(emptyUser);
      query.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  async function toggleActive(user) {
    setError("");
    setSuccess("");
    try {
      await api.patch(`/users/${user.id}/status`, { isActive: !user.isActive });
      setSuccess(user.isActive ? "User deactivated." : "User activated.");
      query.refresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    }
  }

  async function viewUser(user) {
    setViewing(null);
    setViewError("");
    setViewLoading(true);
    try {
      const { data } = await api.get(`/users/${user.id}`);
      setViewing(data.data.user);
    } catch (requestError) {
      setViewError(apiErrorMessage(requestError));
    } finally {
      setViewLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="User management"
        description="Manage account identity, role, base assignment, and active access."
        actions={<Button onClick={() => openForm()}>Add user</Button>}
      />
      <Notice>{error || query.error || basesQuery.error}</Notice>
      <Notice tone="success">{success}</Notice>
      <Notice>{viewError}</Notice>
      {viewLoading && <LoadingState label="Loading user details" />}
      {viewing && (
        <Panel
          title="User details"
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
            <div><dt className="text-slate-500">Name</dt><dd className="font-medium">{viewing.name}</dd></div>
            <div><dt className="text-slate-500">Email</dt><dd className="font-medium">{viewing.email}</dd></div>
            <div><dt className="text-slate-500">Role</dt><dd className="font-medium">{viewing.role.replaceAll("_", " ")}</dd></div>
            <div><dt className="text-slate-500">Base ID</dt><dd className="font-medium">{viewing.baseId ?? "Global"}</dd></div>
            <div><dt className="text-slate-500">Status</dt><dd><StatusBadge value={viewing.isActive ? "ACTIVE" : "INACTIVE"} /></dd></div>
            <div><dt className="text-slate-500">Created</dt><dd className="font-medium">{formatDate(viewing.createdAt)}</dd></div>
            <div><dt className="text-slate-500">Last updated</dt><dd className="font-medium">{formatDate(viewing.updatedAt)}</dd></div>
          </dl>
        </Panel>
      )}
      {formOpen && (
        <Panel
          title={editing ? "Update user" : "Create user"}
          className="mb-5"
          actions={
            <Button variant="secondary" type="button" onClick={() => setFormOpen(false)}>
              Close
            </Button>
          }
        >
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
            <Field label="Full name">
              <input
                className={inputClass}
                value={values.name}
                onChange={(event) => setValues({ ...values, name: event.target.value })}
                maxLength={128}
                required
              />
            </Field>
            <Field label="Email">
              <input
                className={inputClass}
                type="email"
                value={values.email}
                onChange={(event) => setValues({ ...values, email: event.target.value })}
                maxLength={254}
                required
              />
            </Field>
            <Field label="Role">
              <select
                className={inputClass}
                value={values.role}
                onChange={(event) =>
                  setValues({
                    ...values,
                    role: event.target.value,
                    baseId: event.target.value === "ADMIN" ? "" : values.baseId,
                  })
                }
              >
                <option value="ADMIN">Administrator</option>
                <option value="BASE_COMMANDER">Base commander</option>
                <option value="LOGISTICS_OFFICER">Logistics officer</option>
              </select>
            </Field>
            {values.role !== "ADMIN" && (
              <Field label="Assigned base">
                <select
                  className={inputClass}
                  value={values.baseId}
                  onChange={(event) => setValues({ ...values, baseId: event.target.value })}
                  required
                >
                  <option value="">Select a base</option>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.code} · {base.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field
              label={editing ? "New password (optional)" : "Temporary password"}
              hint="At least 12 characters. Passwords are never displayed after creation."
            >
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                value={values.password}
                onChange={(event) => setValues({ ...values, password: event.target.value })}
                minLength={editing && !values.password ? undefined : 12}
                maxLength={72}
                required={!editing}
              />
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" disabled={pending || basesQuery.loading}>
                {pending ? "Saving…" : editing ? "Save changes" : "Create user"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <Panel title="Accounts" description={`${query.meta?.total ?? 0} users`}>
        {query.loading ? (
          <LoadingState label="Loading users" />
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Field label="Search users">
                <input
                  className={inputClass}
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                  maxLength={128}
                  placeholder="Name or email"
                />
              </Field>
              <Field label="Role">
                <select
                  className={inputClass}
                  value={roleFilter}
                  onChange={(event) => {
                    setRoleFilter(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All roles</option>
                  <option value="ADMIN">Administrator</option>
                  <option value="BASE_COMMANDER">Base commander</option>
                  <option value="LOGISTICS_OFFICER">Logistics officer</option>
                </select>
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
                {
                  key: "name",
                  label: "User",
                  render: (user) => (
                    <div>
                      <p className="font-semibold text-slate-900">{user.name}</p>
                      <p className="text-xs text-slate-500">{user.email}</p>
                    </div>
                  ),
                },
                {
                  key: "role",
                  label: "Role",
                  render: (user) => user.role.replaceAll("_", " "),
                },
                {
                  key: "baseId",
                  label: "Base",
                  render: (user) =>
                    bases.find((base) => base.id === user.baseId)?.name ?? "Global",
                },
                {
                  key: "isActive",
                  label: "Status",
                  render: (user) => <StatusBadge value={user.isActive ? "ACTIVE" : "INACTIVE"} />,
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (user) => (
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => viewUser(user)}>
                        View
                      </Button>
                      <Button variant="secondary" onClick={() => openForm(user)}>Edit</Button>
                      <Button
                        variant={user.isActive ? "danger" : "secondary"}
                        onClick={() => toggleActive(user)}
                      >
                        {user.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={users}
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
