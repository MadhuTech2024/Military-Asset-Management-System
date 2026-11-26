const DATABASE_IDENTITY_PREFIX = "kristallball.identity=";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDatabaseIdentityRows(result) {
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error("Could not verify PostgreSQL database identity.");
  }

  const row = result[0];
  const marker =
    typeof row.database_comment === "string" &&
    row.database_comment.startsWith(DATABASE_IDENTITY_PREFIX)
    ? row.database_comment.slice(DATABASE_IDENTITY_PREFIX.length)
    : "";
  if (
    typeof row.database_name !== "string" ||
    row.database_name.length === 0 ||
    typeof row.database_oid !== "string" ||
    !/^[0-9]+$/.test(row.database_oid) ||
    typeof row.login_role !== "string" ||
    row.login_role.length === 0 ||
    !UUID_PATTERN.test(marker)
  ) {
    throw new Error(
      "PostgreSQL database identity is missing or has an invalid format.",
    );
  }

  return {
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    databaseMarker: marker.toLowerCase(),
    loginRole: row.login_role,
  };
}

export async function readDatabaseIdentity(dataSource) {
  return parseDatabaseIdentityRows(
    await dataSource.query(
      `SELECT database.datname AS database_name,
              database.oid::text AS database_oid,
              session_user::text AS login_role,
              shobj_description(database.oid, 'pg_database') AS database_comment
       FROM pg_database database
       WHERE database.datname = current_database()`,
    ),
  );
}

export async function verifyDatabaseIdentity(
  runtimeDataSource,
  maintenanceDataSource,
) {
  const [runtimeIdentity, maintenanceIdentity] = await Promise.all([
    readDatabaseIdentity(runtimeDataSource),
    readDatabaseIdentity(maintenanceDataSource),
  ]);

  if (runtimeIdentity.loginRole === maintenanceIdentity.loginRole) {
    throw new Error(
      "Runtime and maintenance database connections must use separate login roles.",
    );
  }

  if (
    runtimeIdentity.databaseName !== maintenanceIdentity.databaseName ||
    runtimeIdentity.databaseOid !== maintenanceIdentity.databaseOid ||
    runtimeIdentity.databaseMarker !== maintenanceIdentity.databaseMarker
  ) {
    throw new Error(
      "Runtime and maintenance connections do not target the same PostgreSQL database.",
    );
  }

  return { runtimeIdentity, maintenanceIdentity };
}

export async function runAfterDatabaseIdentityVerification(
  runtimeDataSource,
  maintenanceDataSource,
  operation,
) {
  if (typeof operation !== "function") {
    throw new Error("A database identity verification operation is required.");
  }

  const identity = await verifyDatabaseIdentity(
    runtimeDataSource,
    maintenanceDataSource,
  );
  return operation(identity);
}
