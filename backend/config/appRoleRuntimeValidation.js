import {
  parseDatabaseIdentityRows,
  readDatabaseIdentity,
} from "./databaseIdentity.js";

function requireRows(result, description) {
  if (!Array.isArray(result)) {
    throw new Error(`Could not verify ${description}.`);
  }

  return result;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

const PRIVILEGED_ROLE_NAMES = Object.freeze([
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "pg_monitor",
  "pg_signal_backend",
  "pg_checkpoint",
  "pg_read_all_settings",
  "pg_read_all_stats",
  "pg_stat_scan_tables",
  "pg_maintain",
  "pg_use_reserved_connections",
  "pg_create_subscription",
  "pg_database_owner",
]);

export const APPLICATION_TABLES = Object.freeze([
  "base",
  "equipment_type",
  "app_user",
  "asset",
  "purchase",
  "transfer",
  "assignment",
  "expenditure",
  "return_operation",
  "inventory_movement",
  "audit_log",
  "business_idempotency",
]);

export const APPLICATION_UPDATE_TABLES = Object.freeze([
  "base",
  "equipment_type",
  "app_user",
  "asset",
  "purchase",
  "transfer",
  "assignment",
  "expenditure",
  "return_operation",
]);

export const APPLICATION_SCHEMAS = Object.freeze(["public"]);

export const APPROVED_INFRASTRUCTURE_SCHEMAS = Object.freeze([]);

export const APPLICATION_ROUTINES = Object.freeze([
  "prevent_append_only_mutation()",
  "validate_inventory_movement()",
  "validate_inventory_balance()",
  "validate_return_operation()",
  "process_return_operation()",
  "sanitize_audit_json(jsonb)",
  "sanitize_audit_log_insert()",
]);

const APPROVED_SCHEMA_NAMES = Object.freeze([
  ...APPLICATION_SCHEMAS,
  ...APPROVED_INFRASTRUCTURE_SCHEMAS,
]);

const NON_SYSTEM_SCHEMA_FILTER = `namespace.nspname NOT IN (
  'pg_catalog', 'information_schema', 'pg_toast'
)
AND namespace.nspname !~ '^pg_temp_[0-9]+$'
AND namespace.nspname !~ '^pg_toast(_temp)?_[0-9]+$'`;

const ROUTINE_IDENTITY_SQL =
  "routine.proname || '(' || oidvectortypes(routine.proargtypes) || ')'";

export async function validateRuntimeTemporaryPrivilege(
  runtimeDataSource,
  expectedIdentity,
) {
  if (!runtimeDataSource || typeof runtimeDataSource.query !== "function") {
    throw new Error(
      "A connected DATABASE_URL runtime connection is required to validate TEMPORARY privilege.",
    );
  }
  if (
    !expectedIdentity ||
    typeof expectedIdentity.databaseName !== "string" ||
    typeof expectedIdentity.databaseOid !== "string" ||
    typeof expectedIdentity.databaseMarker !== "string" ||
    typeof expectedIdentity.loginRole !== "string"
  ) {
    throw new Error(
      "The verified runtime database identity is required to validate TEMPORARY privilege.",
    );
  }

  const rows = requireRows(
    await runtimeDataSource.query(
      `SELECT database.datname AS database_name,
              database.oid::text AS database_oid,
              session_user::text AS login_role,
              current_user::text AS current_role,
              shobj_description(database.oid, 'pg_database') AS database_comment,
              has_database_privilege(
                session_user, database.oid, 'TEMPORARY'
              ) AS can_create_temporary_objects
       FROM pg_database database
       WHERE database.datname = current_database()`,
    ),
    "runtime database identity and TEMPORARY privilege",
  );
  const identity = parseDatabaseIdentityRows(rows);
  const row = rows[0];

  if (
    identity.databaseName !== expectedIdentity.databaseName ||
    identity.databaseOid !== expectedIdentity.databaseOid ||
    identity.databaseMarker !== expectedIdentity.databaseMarker ||
    identity.loginRole !== expectedIdentity.loginRole ||
    row.current_role !== identity.loginRole
  ) {
    throw new Error(
      "The active DATABASE_URL runtime connection identity could not be verified.",
    );
  }

  if (row.can_create_temporary_objects !== false) {
    throw new Error(
      "The DATABASE_URL runtime login has effective TEMPORARY privilege on the current database, or that privilege could not be verified.",
    );
  }

  return identity;
}

export async function validateApplicationSchemaInventory(dataSource, roleName) {
  const rows = requireRows(
    await dataSource.query(
      `SELECT namespace.nspname AS schema_name,
              has_schema_privilege($1, namespace.oid, 'USAGE') AS can_use_schema,
              has_schema_privilege($1, namespace.oid, 'CREATE') AS can_create_schema,
              pg_has_role($1, namespace.nspowner, 'USAGE') AS owns_schema,
              EXISTS (
                SELECT 1
                FROM pg_database database
                WHERE database.datname = current_database()
                  AND pg_has_role($1, database.datdba, 'USAGE')
              ) AS owns_database
       FROM pg_namespace namespace
       WHERE ${NON_SYSTEM_SCHEMA_FILTER}
       ORDER BY namespace.nspname`,
      [roleName],
    ),
    "non-system schema inventory",
  );
  const expectedSchemas = new Set(APPROVED_SCHEMA_NAMES);
  const seenSchemas = new Set();

  for (const row of rows) {
    if (!expectedSchemas.has(row.schema_name) || seenSchemas.has(row.schema_name)) {
      throw new Error("The database contains an unexpected non-system schema.");
    }
    if (row.owns_schema !== false) {
      throw new Error("The configured role owns a protected schema.");
    }
    seenSchemas.add(row.schema_name);
  }

  if (
    APPLICATION_SCHEMAS.some((schemaName) => !seenSchemas.has(schemaName))
  ) {
    throw new Error("A required application schema is missing.");
  }

  return rows;
}

export async function validateApplicationSchemaPrivileges(
  dataSource,
  roleName,
) {
  const rows = await validateApplicationSchemaInventory(dataSource, roleName);
  const schemaRows = new Map(rows.map((row) => [row.schema_name, row]));

  for (const schemaName of APPLICATION_SCHEMAS) {
    const schema = schemaRows.get(schemaName);
    if (
      schema?.can_use_schema !== true ||
      schema.can_create_schema !== false ||
      schema.owns_schema !== false ||
      schema.owns_database !== false
    ) {
      throw new Error(
        `The runtime role has unsafe effective schema privileges on ${schemaName}.`,
      );
    }
  }

  for (const schemaName of APPROVED_INFRASTRUCTURE_SCHEMAS) {
    const schema = schemaRows.get(schemaName);
    if (
      schema?.can_use_schema !== false ||
      schema.can_create_schema !== false
    ) {
      throw new Error(
        `The runtime role has unexpected schema access to ${schemaName}.`,
      );
    }
  }
}

export async function validateRole(
  dataSource,
  name,
  { loginExpected, migrationOwnerName },
) {
  if (!migrationOwnerName || name === migrationOwnerName) {
    throw new Error("A configured role must be separate from the migration owner.");
  }

  const roleRows = requireRows(
    await dataSource.query(
      `SELECT oid, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
              rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
      [name],
    ),
    "configured database role",
  );
  const role = roleRows[0];
  if (!role) {
    throw new Error("A configured database role does not exist.");
  }

  if (
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolcanlogin !== loginExpected
  ) {
    throw new Error("A configured database role has unsafe role attributes.");
  }

  const inheritedPrivileges = requireRows(
    await dataSource.query(
      `WITH RECURSIVE role_tree AS (
         SELECT oid, rolname, rolsuper, rolbypassrls, rolcreaterole,
                rolcreatedb, rolreplication
         FROM pg_roles
         WHERE rolname = $1
         UNION
         SELECT parent.oid, parent.rolname, parent.rolsuper,
                parent.rolbypassrls, parent.rolcreaterole,
                parent.rolcreatedb, parent.rolreplication
         FROM pg_auth_members membership
         JOIN role_tree child ON membership.member = child.oid
         JOIN pg_roles parent ON parent.oid = membership.roleid
       ),
       migration_owner_tree AS (
         SELECT oid
         FROM pg_roles
         WHERE rolname = $2
         UNION
         SELECT parent.oid
         FROM pg_auth_members membership
         JOIN migration_owner_tree child ON membership.member = child.oid
         JOIN pg_roles parent ON parent.oid = membership.roleid
       )
       SELECT 1
       FROM role_tree candidate
       LEFT JOIN migration_owner_tree migration_role
         ON migration_role.oid = candidate.oid
       WHERE candidate.rolname <> $1
         AND (
           migration_role.oid IS NOT NULL
           OR candidate.rolsuper
           OR candidate.rolbypassrls
           OR candidate.rolcreaterole
           OR candidate.rolcreatedb
           OR candidate.rolreplication
           OR candidate.rolname = ANY($3::text[])
         )
       LIMIT 1`,
      [name, migrationOwnerName, [...PRIVILEGED_ROLE_NAMES]],
    ),
    "privileged database role memberships",
  );
  if (inheritedPrivileges.length > 0) {
    throw new Error("A configured database role inherits unexpected privileges.");
  }

  const ownedProtectedObjects = requireRows(
    await dataSource.query(
      `WITH RECURSIVE role_tree AS (
         SELECT oid FROM pg_roles WHERE rolname = $1
         UNION
         SELECT membership.roleid
         FROM pg_auth_members membership
         JOIN role_tree child ON membership.member = child.oid
       )
       SELECT 1
       FROM pg_class object
       JOIN pg_namespace schema ON schema.oid = object.relnamespace
       JOIN role_tree owner_role ON owner_role.oid = object.relowner
       WHERE schema.nspname = ANY($2::text[])
         AND object.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       UNION ALL
       SELECT 1
       FROM pg_proc routine
       JOIN pg_namespace schema ON schema.oid = routine.pronamespace
       JOIN role_tree owner_role ON owner_role.oid = routine.proowner
       WHERE schema.nspname = ANY($2::text[])
       UNION ALL
       SELECT 1
       FROM pg_namespace schema
       JOIN role_tree owner_role ON owner_role.oid = schema.nspowner
       WHERE schema.nspname = ANY($2::text[])
       UNION ALL
       SELECT 1
       FROM pg_database database
       JOIN role_tree owner_role ON owner_role.oid = database.datdba
       WHERE database.datname = current_database()
       LIMIT 1`,
      [name, [...APPROVED_SCHEMA_NAMES]],
    ),
    "protected table and schema ownership",
  );
  if (ownedProtectedObjects.length > 0) {
    throw new Error("A configured database role owns an application database object.");
  }

  const databaseCreateRows = requireRows(
    await dataSource.query(
      `SELECT has_database_privilege($1, current_database(), 'CREATE')
         AS can_create_schema`,
      [name],
    ),
    "database CREATE privilege",
  );
  if (databaseCreateRows[0]?.can_create_schema !== false) {
    throw new Error(
      "A configured database role retains or could not be verified to lack database CREATE privilege.",
    );
  }
}

export async function validateMigrationOwnerRole(dataSource, name) {
  const rows = requireRows(
    await dataSource.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
              rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
      [name],
    ),
    "migration-owner role",
  );
  const role = rows[0];
  if (!role) {
    throw new Error("The configured migration-owner role does not exist.");
  }

  if (
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolcanlogin !== true
  ) {
    throw new Error("The configured migration-owner role has unsafe attributes.");
  }

  const inheritedUnsafeRoles = requireRows(
    await dataSource.query(
      `WITH RECURSIVE role_tree AS (
         SELECT oid, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
                rolreplication, rolname
         FROM pg_roles
         WHERE rolname = $1
         UNION
         SELECT parent.oid, parent.rolsuper, parent.rolbypassrls,
                parent.rolcreaterole, parent.rolcreatedb,
                parent.rolreplication, parent.rolname
         FROM pg_auth_members membership
         JOIN role_tree child ON membership.member = child.oid
         JOIN pg_roles parent ON parent.oid = membership.roleid
       )
       SELECT 1
       FROM role_tree candidate
       WHERE candidate.oid <> (SELECT oid FROM pg_roles WHERE rolname = $1)
         AND (
           candidate.rolsuper
           OR candidate.rolbypassrls
           OR candidate.rolcreaterole
           OR candidate.rolcreatedb
           OR candidate.rolreplication
           OR candidate.rolname = ANY($2::text[])
         )
       LIMIT 1`,
      [name, [...PRIVILEGED_ROLE_NAMES]],
    ),
    "migration-owner role memberships",
  );
  if (inheritedUnsafeRoles.length > 0) {
    throw new Error(
      "The configured migration-owner role inherits unsafe privileges.",
    );
  }
}

export async function validateMigrationOwnerObjectPrivileges(dataSource, name) {
  const schemaRows = await validateApplicationSchemaInventory(dataSource, name);
  const applicationSchema = schemaRows.find(
    (row) => row.schema_name === APPLICATION_SCHEMAS[0],
  );
  if (
    !applicationSchema ||
    applicationSchema.can_use_schema !== true ||
    applicationSchema.can_create_schema !== true ||
    applicationSchema.owns_schema !== false ||
    applicationSchema.owns_database !== false
  ) {
    throw new Error(
      "The migration-owner role must have effective USAGE and CREATE on the public schema without owning the schema or database.",
    );
  }

  const relationRows = requireRows(
    await dataSource.query(
      `SELECT relation.relname AS relation_name,
              relation.relkind AS relation_kind,
              pg_has_role($1, relation.relowner, 'USAGE') AS can_manage_owner
       FROM pg_class relation
       JOIN pg_namespace schema ON schema.oid = relation.relnamespace
       WHERE schema.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
      [name],
    ),
    "migration-owner relation ownership",
  );
  const expectedTableNames = new Set([
    ...APPLICATION_TABLES,
    "typeorm_migrations",
  ]);
  const seenTableNames = new Set();

  for (const row of relationRows) {
    if (row.relation_kind === "S") {
      if (row.can_manage_owner !== true) {
        throw new Error(
          "The migration-owner role must effectively own every public sequence.",
        );
      }
      continue;
    }

    if (
      !expectedTableNames.has(row.relation_name) ||
      !["r", "p"].includes(row.relation_kind) ||
      seenTableNames.has(row.relation_name)
    ) {
      throw new Error(
        "The public schema contains an unexpected or unverified migration relation.",
      );
    }
    if (row.can_manage_owner !== true) {
      throw new Error(
        `The migration-owner role must effectively own public relation ${row.relation_name}.`,
      );
    }
    seenTableNames.add(row.relation_name);
  }

  if (seenTableNames.size !== expectedTableNames.size) {
    throw new Error(
      "The migration-owner role could not be verified as owner of every required application relation.",
    );
  }

  await validateMigrationOwnerRoutineOwnership(dataSource, name);
}

async function validateMigrationOwnerRoutineOwnership(dataSource, roleName) {
  const rows = requireRows(
    await dataSource.query(
      `SELECT namespace.nspname AS schema_name,
              ${ROUTINE_IDENTITY_SQL} AS routine_identity,
              routine.prosecdef AS is_security_definer,
              pg_has_role($1, routine.proowner, 'USAGE') AS can_manage_owner,
              extension.extname AS extension_name
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       LEFT JOIN pg_depend extension_dependency
         ON extension_dependency.classid = 'pg_proc'::regclass
        AND extension_dependency.objid = routine.oid
        AND extension_dependency.refclassid = 'pg_extension'::regclass
        AND extension_dependency.deptype = 'e'
       LEFT JOIN pg_extension extension
         ON extension.oid = extension_dependency.refobjid
       WHERE namespace.nspname = ANY($2::text[])
       ORDER BY namespace.nspname, routine_identity`,
      [roleName, [...APPROVED_SCHEMA_NAMES]],
    ),
    "migration-owner routine ownership",
  );
  const expectedRoutines = new Set(APPLICATION_ROUTINES);
  const seenRoutines = new Set();

  for (const row of rows) {
    if (row.extension_name === "pgcrypto") {
      if (row.is_security_definer !== false) {
        throw new Error("An approved pgcrypto routine is SECURITY DEFINER.");
      }
      continue;
    }

    if (
      row.schema_name !== APPLICATION_SCHEMAS[0] ||
      !expectedRoutines.has(row.routine_identity) ||
      seenRoutines.has(row.routine_identity)
    ) {
      throw new Error("The application schema contains an unexpected routine.");
    }
    if (row.is_security_definer !== false) {
      throw new Error(
        `Application routine ${row.routine_identity} must not be SECURITY DEFINER.`,
      );
    }
    if (row.can_manage_owner !== true) {
      throw new Error(
        `The migration-owner role must effectively own routine ${row.routine_identity}.`,
      );
    }
    seenRoutines.add(row.routine_identity);
  }

  if (seenRoutines.size !== expectedRoutines.size) {
    throw new Error(
      "The migration-owner role could not be verified as owner of every application routine.",
    );
  }
}

export async function validateApplicationRoutinePrivileges(
  dataSource,
  roleName,
) {
  const rows = requireRows(
    await dataSource.query(
      `SELECT namespace.nspname AS schema_name,
              ${ROUTINE_IDENTITY_SQL} AS routine_identity,
              routine.prosecdef AS is_security_definer,
              has_function_privilege($1, routine.oid, 'EXECUTE') AS can_execute,
              extension.extname AS extension_name
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       LEFT JOIN pg_depend extension_dependency
         ON extension_dependency.classid = 'pg_proc'::regclass
        AND extension_dependency.objid = routine.oid
        AND extension_dependency.refclassid = 'pg_extension'::regclass
        AND extension_dependency.deptype = 'e'
       LEFT JOIN pg_extension extension
         ON extension.oid = extension_dependency.refobjid
       WHERE namespace.nspname = ANY($2::text[])
       ORDER BY namespace.nspname, routine_identity`,
      [roleName, [...APPROVED_SCHEMA_NAMES]],
    ),
    "effective application routine privileges",
  );
  const expectedRoutines = new Set(APPLICATION_ROUTINES);
  const seenRoutines = new Set();

  for (const row of rows) {
    if (row.is_security_definer !== false) {
      throw new Error(
        `Routine ${row.routine_identity} is SECURITY DEFINER and is not permitted.`,
      );
    }

    if (row.extension_name === "pgcrypto") {
      if (
        row.schema_name !== APPLICATION_SCHEMAS[0] ||
        row.can_execute !== (row.routine_identity === "gen_random_uuid()")
      ) {
        throw new Error(
          "The runtime role has unexpected effective EXECUTE on a pgcrypto routine.",
        );
      }
      continue;
    }

    if (
      row.schema_name !== APPLICATION_SCHEMAS[0] ||
      !expectedRoutines.has(row.routine_identity) ||
      seenRoutines.has(row.routine_identity)
    ) {
      throw new Error("The application schema contains an unexpected routine.");
    }
    if (row.can_execute !== true) {
      throw new Error(
        `The runtime role cannot execute required routine ${row.routine_identity}.`,
      );
    }
    seenRoutines.add(row.routine_identity);
  }

  if (seenRoutines.size !== expectedRoutines.size) {
    throw new Error("A required application routine is missing.");
  }
}

export async function validateApplicationTablePrivileges(dataSource, roleName) {
  const expectedTableNames = [...APPLICATION_TABLES, "typeorm_migrations"];
  const updateTables = new Set(APPLICATION_UPDATE_TABLES);
  const rows = requireRows(
    await dataSource.query(
      `SELECT relation.relname AS table_name,
              relation.relkind AS relation_kind,
              has_table_privilege($1, relation.oid, 'SELECT') AS can_select,
              has_table_privilege($1, relation.oid, 'INSERT') AS can_insert,
              has_table_privilege($1, relation.oid, 'UPDATE') AS can_update,
              has_table_privilege($1, relation.oid, 'DELETE') AS can_delete,
              has_table_privilege($1, relation.oid, 'TRUNCATE') AS can_truncate,
              has_table_privilege($1, relation.oid, 'REFERENCES') AS can_reference,
              has_table_privilege($1, relation.oid, 'TRIGGER') AS can_trigger,
              has_any_column_privilege($1, relation.oid, 'SELECT')
                AS can_select_column,
              has_any_column_privilege($1, relation.oid, 'INSERT')
                AS can_insert_column,
              has_any_column_privilege($1, relation.oid, 'UPDATE')
                AS can_update_column,
              has_any_column_privilege($1, relation.oid, 'REFERENCES')
                AS can_reference_column
       FROM pg_class relation
       JOIN pg_namespace schema ON schema.oid = relation.relnamespace
       WHERE schema.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')`,
      [roleName],
    ),
    "effective application table privileges",
  );
  const expectedNames = new Set(expectedTableNames);
  const seenNames = new Set();

  for (const row of rows) {
    if (!expectedNames.has(row.table_name) || seenNames.has(row.table_name)) {
      throw new Error("Could not verify effective application table privileges.");
    }
    if (!["r", "p"].includes(row.relation_kind)) {
      throw new Error("An expected application relation is not a table.");
    }
    seenNames.add(row.table_name);

    const isApplicationTable = row.table_name !== "typeorm_migrations";
    const expectedPrivileges = {
      can_select: isApplicationTable,
      can_insert: isApplicationTable,
      can_update: isApplicationTable && updateTables.has(row.table_name),
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
      can_select_column: isApplicationTable,
      can_insert_column: isApplicationTable,
      can_update_column: isApplicationTable && updateTables.has(row.table_name),
      can_reference_column: false,
    };

    for (const [privilege, expected] of Object.entries(expectedPrivileges)) {
      if (row[privilege] !== expected) {
        throw new Error(
          "A runtime or application role has unexpected effective table privileges.",
        );
      }
    }
  }

  if (seenNames.size !== expectedTableNames.length) {
    throw new Error(
      "Could not verify effective application table privileges for every configured table.",
    );
  }
}

export async function validateApplicationSequencePrivileges(
  dataSource,
  roleName,
) {
  const rows = requireRows(
    await dataSource.query(
      `SELECT seq.relname AS sequence_name,
              has_sequence_privilege($1, seq.oid, 'USAGE') AS can_use,
              has_sequence_privilege($1, seq.oid, 'SELECT') AS can_select,
              has_sequence_privilege($1, seq.oid, 'UPDATE') AS can_update
       FROM pg_class seq
       JOIN pg_namespace nsp ON nsp.oid = seq.relnamespace
       WHERE nsp.nspname = 'public'
         AND seq.relkind = 'S'`,
      [roleName],
    ),
    "effective application sequence privileges",
  );

  for (const row of rows) {
    if (
      row.can_use !== false ||
      row.can_select !== false ||
      row.can_update !== false
    ) {
      throw new Error(
        "A runtime or application role has unexpected effective sequence privileges.",
      );
    }
  }
}

export async function validateRuntimeRoleMembership(
  dataSource,
  runtimeLoginName,
  applicationRoleName,
) {
  const membershipRows = requireRows(
    await dataSource.query(
      `SELECT pg_has_role($1, $2, 'USAGE') AS inherits_application_role`,
      [runtimeLoginName, applicationRoleName],
    ),
    "runtime role membership",
  );

  if (membershipRows[0]?.inherits_application_role !== true) {
    throw new Error(
      "The DATABASE_URL runtime login must inherit APP_DATABASE_ROLE.",
    );
  }
}

export async function validateRuntimeAppendOnlyPrivileges(
  dataSource,
  runtimeLoginName,
) {
  const privilegeRows = requireRows(
    await dataSource.query(
      `SELECT
         has_table_privilege($1, 'public.inventory_movement', 'UPDATE')
           OR has_any_column_privilege($1, 'public.inventory_movement', 'UPDATE')
           OR has_table_privilege($1, 'public.inventory_movement', 'DELETE')
           OR has_table_privilege($1, 'public.inventory_movement', 'TRUNCATE')
           OR has_table_privilege($1, 'public.audit_log', 'UPDATE')
           OR has_any_column_privilege($1, 'public.audit_log', 'UPDATE')
           OR has_table_privilege($1, 'public.audit_log', 'DELETE')
           OR has_table_privilege($1, 'public.audit_log', 'TRUNCATE')
           OR has_table_privilege($1, 'public.business_idempotency', 'UPDATE')
           OR has_any_column_privilege($1, 'public.business_idempotency', 'UPDATE')
           OR has_table_privilege($1, 'public.business_idempotency', 'DELETE')
           OR has_table_privilege($1, 'public.business_idempotency', 'TRUNCATE')
         AS has_forbidden_privilege`,
      [runtimeLoginName],
    ),
    "runtime append-only table privileges",
  );

  if (privilegeRows[0]?.has_forbidden_privilege !== false) {
    throw new Error(
      "The DATABASE_URL runtime login has UPDATE, DELETE, or TRUNCATE privileges on a protected table, or those privileges could not be verified.",
    );
  }
}

export async function revokeAndValidatePublicSchemaCreate(
  dataSource,
  applicationRoleName,
  runtimeLoginName,
) {
  await dataSource.query(
    `REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(applicationRoleName)}`,
  );

  for (const [roleName, description] of [
    [applicationRoleName, "application role"],
    [runtimeLoginName, "runtime login"],
  ]) {
    const schemaPrivilegeRows = requireRows(
      await dataSource.query(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS has_create_privilege`,
        [roleName],
      ),
      `public schema CREATE privilege for ${description}`,
    );

    if (schemaPrivilegeRows[0]?.has_create_privilege !== false) {
      throw new Error(
        `The ${description} retains or could not be verified to lack CREATE on the public schema.`,
      );
    }
  }
}

async function validateRuntimeRoleConfiguration(
  runtimeDataSource,
  runtimeLoginName,
  applicationRoleName,
) {
  const roleRows = requireRows(
    await runtimeDataSource.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
              rolreplication, rolcanlogin
       FROM pg_roles
       WHERE rolname = ANY($1::text[])`,
      [[runtimeLoginName, applicationRoleName]],
    ),
    "runtime role attributes",
  );
  const roles = new Map(roleRows.map((row) => [row.rolname, row]));
  const runtimeRole = roles.get(runtimeLoginName);
  const applicationRole = roles.get(applicationRoleName);

  if (
    roleRows.length !== 2 ||
    !runtimeRole ||
    !applicationRole ||
    runtimeRole.rolcanlogin !== true ||
    applicationRole.rolcanlogin !== false ||
    [runtimeRole, applicationRole].some(
      (role) =>
        role.rolsuper ||
        role.rolbypassrls ||
        role.rolcreaterole ||
        role.rolcreatedb ||
        role.rolreplication,
    )
  ) {
    throw new Error("Runtime and application database roles have unsafe attributes.");
  }

  const roleTree = requireRows(
    await runtimeDataSource.query(
      `WITH RECURSIVE runtime_role_tree AS (
         SELECT oid, rolname
         FROM pg_roles
         WHERE rolname = $1
         UNION
         SELECT parent.oid, parent.rolname
         FROM pg_auth_members membership
         JOIN runtime_role_tree child ON membership.member = child.oid
         JOIN pg_roles parent ON membership.roleid = parent.oid
       )
       SELECT rolname FROM runtime_role_tree`,
      [runtimeLoginName],
    ),
    "runtime role memberships",
  );
  const inheritedRoles = new Set(roleTree.map((row) => row.rolname));
  if (
    roleTree.length !== 2 ||
    !inheritedRoles.has(runtimeLoginName) ||
    !inheritedRoles.has(applicationRoleName)
  ) {
    throw new Error(
      "The runtime login must inherit only the configured application role.",
    );
  }
}

async function validateRuntimeObjectPrivileges(
  runtimeDataSource,
  runtimeLoginName,
) {
  const ownedObjects = requireRows(
    await runtimeDataSource.query(
      `WITH RECURSIVE runtime_role_tree AS (
         SELECT oid FROM pg_roles WHERE rolname = $1
         UNION
         SELECT membership.roleid
         FROM pg_auth_members membership
         JOIN runtime_role_tree child ON membership.member = child.oid
       )
       SELECT 1
       FROM pg_class object
       JOIN pg_namespace schema ON schema.oid = object.relnamespace
       JOIN runtime_role_tree owner_role ON owner_role.oid = object.relowner
       WHERE schema.nspname = ANY($2::text[])
         AND object.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       UNION ALL
       SELECT 1
       FROM pg_proc routine
       JOIN pg_namespace schema ON schema.oid = routine.pronamespace
       JOIN runtime_role_tree owner_role ON owner_role.oid = routine.proowner
       WHERE schema.nspname = ANY($2::text[])
       UNION ALL
       SELECT 1
       FROM pg_namespace schema
       JOIN runtime_role_tree owner_role ON owner_role.oid = schema.nspowner
       WHERE schema.nspname = ANY($2::text[])
       UNION ALL
       SELECT 1
       FROM pg_database database
       JOIN runtime_role_tree owner_role ON owner_role.oid = database.datdba
       WHERE database.datname = current_database()
       LIMIT 1`,
      [runtimeLoginName, [...APPLICATION_SCHEMAS]],
    ),
    "runtime ownership of protected database objects",
  );
  if (ownedObjects.length > 0) {
    throw new Error(
      "The runtime login or application role owns a protected database object.",
    );
  }

  const databaseCreateRows = requireRows(
    await runtimeDataSource.query(
      `SELECT has_database_privilege(
         $1, current_database(), 'CREATE'
       ) AS can_create_database_schema`,
      [runtimeLoginName],
    ),
    "runtime database CREATE privilege",
  );
  if (databaseCreateRows[0]?.can_create_database_schema !== false) {
    throw new Error(
      "The runtime login retains or could not be verified to lack database CREATE privilege.",
    );
  }
}

export async function validateRuntimeDatabaseSecurity(
  runtimeDataSource,
  applicationRoleName,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(applicationRoleName ?? "")) {
    throw new Error("APP_DATABASE_ROLE must be a valid PostgreSQL role name.");
  }
  if (!runtimeDataSource || typeof runtimeDataSource.query !== "function") {
    throw new Error("A connected DATABASE_URL runtime connection is required.");
  }

  const runtimeIdentity = await readDatabaseIdentity(runtimeDataSource);
  if (runtimeIdentity.loginRole === applicationRoleName) {
    throw new Error(
      "DATABASE_URL must use a separate login from APP_DATABASE_ROLE.",
    );
  }

  await validateRuntimeRoleConfiguration(
    runtimeDataSource,
    runtimeIdentity.loginRole,
    applicationRoleName,
  );
  await validateRuntimeObjectPrivileges(
    runtimeDataSource,
    runtimeIdentity.loginRole,
  );
  await validateRuntimeTemporaryPrivilege(runtimeDataSource, runtimeIdentity);
  await validateRuntimeRoleMembership(
    runtimeDataSource,
    runtimeIdentity.loginRole,
    applicationRoleName,
  );
  await validateApplicationSchemaPrivileges(
    runtimeDataSource,
    runtimeIdentity.loginRole,
  );
  await validateRuntimeAppendOnlyPrivileges(
    runtimeDataSource,
    runtimeIdentity.loginRole,
  );
  await validateApplicationTablePrivileges(
    runtimeDataSource,
    runtimeIdentity.loginRole,
  );
  await validateApplicationSequencePrivileges(
    runtimeDataSource,
    runtimeIdentity.loginRole,
  );
  await validateApplicationRoutinePrivileges(
    runtimeDataSource,
    runtimeIdentity.loginRole,
  );

  return runtimeIdentity;
}
