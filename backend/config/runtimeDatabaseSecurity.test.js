import test from "node:test";
import assert from "node:assert/strict";
import {
  APPLICATION_ROUTINES,
  APPLICATION_TABLES,
  APPLICATION_UPDATE_TABLES,
  validateRuntimeDatabaseSecurity,
} from "./appRoleRuntimeValidation.js";

const runtimeIdentity = {
  database_name: "kristallball_test",
  database_oid: "16384",
  login_role: "runtime_login",
  database_comment:
    "kristallball.identity=3f6587e8-492e-4678-8baa-239fb6d3ee27",
};

function createTableRows(overrides = {}) {
  const updateTables = new Set(APPLICATION_UPDATE_TABLES);
  const rows = [
    ...APPLICATION_TABLES.map((table_name) => ({
      table_name,
      relation_kind: "r",
      can_select: true,
      can_insert: true,
      can_update: updateTables.has(table_name),
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
      can_select_column: true,
      can_insert_column: true,
      can_update_column: updateTables.has(table_name),
      can_reference_column: false,
    })),
    {
      table_name: "typeorm_migrations",
      relation_kind: "r",
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
      can_select_column: false,
      can_insert_column: false,
      can_update_column: false,
      can_reference_column: false,
    },
  ];

  if (overrides.table_name) {
    const row = rows.find(
      (candidate) => candidate.table_name === overrides.table_name,
    );
    Object.assign(row, overrides);
  }
  return rows;
}

function createRuntimeDataSource({
  inheritsApplicationRole = true,
  canCreateTemporaryObjects = false,
  tableOverrides = {},
  unsafeRuntimeRole = false,
  unexpectedInheritedRole = false,
  ownsProtectedObjects = false,
  canCreateDatabaseSchema = false,
} = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes("can_create_temporary_objects")) {
        return [{
          ...runtimeIdentity,
          current_role: runtimeIdentity.login_role,
          can_create_temporary_objects: canCreateTemporaryObjects,
        }];
      }
      if (sql.includes("session_user::text AS login_role")) {
        return [runtimeIdentity];
      }
      if (sql.includes("FROM pg_class object")) {
        return ownsProtectedObjects ? [{ "?column?": 1 }] : [];
      }
      if (sql.includes("can_create_database_schema")) {
        return [{ can_create_database_schema: canCreateDatabaseSchema }];
      }
      if (sql.includes("WITH RECURSIVE runtime_role_tree AS")) {
        return [
          { rolname: runtimeIdentity.login_role },
          { rolname: "application_group" },
          ...(unexpectedInheritedRole ? [{ rolname: "extra_role" }] : []),
        ];
      }
      if (sql.includes("SELECT rolname, rolsuper")) {
        return [
          {
            rolname: runtimeIdentity.login_role,
            rolsuper: unsafeRuntimeRole,
            rolbypassrls: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            rolcanlogin: true,
          },
          {
            rolname: "application_group",
            rolsuper: false,
            rolbypassrls: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            rolcanlogin: false,
          },
        ];
      }
      if (sql.includes("pg_has_role($1, $2, 'USAGE')")) {
        return [{ inherits_application_role: inheritsApplicationRole }];
      }
      if (sql.includes("can_use_schema")) {
        return [{
          schema_name: "public",
          can_use_schema: true,
          can_create_schema: false,
          owns_schema: false,
          owns_database: false,
        }];
      }
      if (sql.includes("AS has_forbidden_privilege")) {
        return [{ has_forbidden_privilege: false }];
      }
      if (sql.includes("AS table_name")) {
        return createTableRows(tableOverrides);
      }
      if (sql.includes("AS sequence_name")) {
        return [];
      }
      if (sql.includes("has_function_privilege")) {
        return APPLICATION_ROUTINES.map((routine_identity) => ({
          schema_name: "public",
          routine_identity,
          is_security_definer: false,
          can_execute: true,
          extension_name: null,
        }));
      }
      throw new Error("Unexpected runtime security query.");
    },
  };
}

test("runtime startup security check verifies effective permissions read-only", async () => {
  const dataSource = createRuntimeDataSource();
  const identity = await validateRuntimeDatabaseSecurity(
    dataSource,
    "application_group",
  );

  assert.deepEqual(identity, {
    databaseName: "kristallball_test",
    databaseOid: "16384",
    databaseMarker: "3f6587e8-492e-4678-8baa-239fb6d3ee27",
    loginRole: "runtime_login",
  });
  assert.ok(
    dataSource.queries.some(({ sql }) => sql.includes("can_select")),
    "startup check must verify application table privileges",
  );
  assert.ok(
    dataSource.queries.some(({ sql }) =>
      sql.includes("has_forbidden_privilege"),
    ),
    "startup check must verify append-only privileges",
  );
  assert.ok(
    dataSource.queries.every(
      ({ sql }) =>
        !/^\s*(GRANT|REVOKE|ALTER|CREATE|DROP)\b/i.test(sql),
    ),
    "startup validation must not change database privileges or schema",
  );
});

test("business idempotency table is insert-only for the runtime role", () => {
  const rows = createTableRows();
  const idempotency = rows.find(
    ({ table_name }) => table_name === "business_idempotency",
  );
  assert.ok(APPLICATION_TABLES.includes("business_idempotency"));
  assert.equal(APPLICATION_UPDATE_TABLES.includes("business_idempotency"), false);
  assert.equal(idempotency.can_select, true);
  assert.equal(idempotency.can_insert, true);
  assert.equal(idempotency.can_update, false);
  assert.equal(idempotency.can_delete, false);
  assert.equal(idempotency.can_truncate, false);
});

test("runtime startup validation requires a valid separate application role", async () => {
  const dataSource = createRuntimeDataSource();

  await assert.rejects(
    validateRuntimeDatabaseSecurity(dataSource, undefined),
    /APP_DATABASE_ROLE/,
  );
  assert.equal(dataSource.queries.length, 0);

  await assert.rejects(
    validateRuntimeDatabaseSecurity(dataSource, "runtime_login"),
    /separate login/,
  );
});

test("runtime startup fails if the login does not inherit the application role", async () => {
  const dataSource = createRuntimeDataSource({
    inheritsApplicationRole: false,
  });

  await assert.rejects(
    validateRuntimeDatabaseSecurity(dataSource, "application_group"),
    /must inherit APP_DATABASE_ROLE/,
  );
});

test("runtime startup rejects unsafe role attributes and unexpected memberships", async () => {
  const unsafeRoleDataSource = createRuntimeDataSource({
    unsafeRuntimeRole: true,
  });
  await assert.rejects(
    validateRuntimeDatabaseSecurity(
      unsafeRoleDataSource,
      "application_group",
    ),
    /unsafe attributes/,
  );

  const unexpectedMembershipDataSource = createRuntimeDataSource({
    unexpectedInheritedRole: true,
  });
  await assert.rejects(
    validateRuntimeDatabaseSecurity(
      unexpectedMembershipDataSource,
      "application_group",
    ),
    /inherit only the configured application role/,
  );
});

test("runtime startup rejects protected object ownership and database CREATE", async () => {
  const ownedObjectDataSource = createRuntimeDataSource({
    ownsProtectedObjects: true,
  });
  await assert.rejects(
    validateRuntimeDatabaseSecurity(
      ownedObjectDataSource,
      "application_group",
    ),
    /owns a protected database object/,
  );

  const databaseCreateDataSource = createRuntimeDataSource({
    canCreateDatabaseSchema: true,
  });
  await assert.rejects(
    validateRuntimeDatabaseSecurity(
      databaseCreateDataSource,
      "application_group",
    ),
    /database CREATE privilege/,
  );
});

test("runtime startup fails on temporary or excess table privileges", async () => {
  const temporaryPrivilegeDataSource = createRuntimeDataSource({
    canCreateTemporaryObjects: true,
  });
  await assert.rejects(
    validateRuntimeDatabaseSecurity(
      temporaryPrivilegeDataSource,
      "application_group",
    ),
    /TEMPORARY privilege/,
  );

  const excessTablePrivilegeDataSource = createRuntimeDataSource({
    tableOverrides: {
      table_name: "inventory_movement",
      can_update: true,
      can_update_column: true,
    },
  });
  await assert.rejects(
    validateRuntimeDatabaseSecurity(
      excessTablePrivilegeDataSource,
      "application_group",
    ),
    /unexpected effective table privileges/,
  );
});
