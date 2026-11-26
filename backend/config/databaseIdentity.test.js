import test from "node:test";
import assert from "node:assert/strict";
import {
  readDatabaseIdentity,
  runAfterDatabaseIdentityVerification,
  verifyDatabaseIdentity,
} from "./databaseIdentity.js";

const databaseMarker = "kristallball.identity=3f6587e8-492e-4678-8baa-239fb6d3ee27";

function dataSourceWithIdentity(
  {
    databaseName = "kristallball",
    databaseOid = "16384",
    loginRole = "runtime_login",
    databaseComment = databaseMarker,
  } = {},
  error,
) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (error) {
        throw error;
      }
      return [{
        database_name: databaseName,
        database_oid: databaseOid,
        login_role: loginRole,
        database_comment: databaseComment,
      }];
    },
  };
}

test("database identity accepts the same database through different roles", async () => {
  const runtime = dataSourceWithIdentity({ loginRole: "runtime_login" });
  const maintenance = dataSourceWithIdentity({
    loginRole: "migration_owner",
  });

  const identity = await verifyDatabaseIdentity(runtime, maintenance);

  assert.equal(identity.runtimeIdentity.databaseName, "kristallball");
  assert.equal(identity.runtimeIdentity.databaseOid, "16384");
  assert.equal(
    identity.runtimeIdentity.databaseMarker,
    "3f6587e8-492e-4678-8baa-239fb6d3ee27",
  );
  assert.equal(identity.maintenanceIdentity.loginRole, "migration_owner");
  assert.equal(runtime.calls.length, 1);
  assert.equal(maintenance.calls.length, 1);
  assert.match(runtime.calls[0], /FROM pg_database database/);
  assert.match(runtime.calls[0], /shobj_description/);
  assert.match(runtime.calls[0], /session_user/);
});

test("database identity rejects different databases despite matching names or markers", async () => {
  const runtime = dataSourceWithIdentity({
    databaseName: "kristallball",
    databaseOid: "16384",
  });
  const differentMarker = dataSourceWithIdentity({
    databaseName: "kristallball",
    databaseOid: "16384",
    loginRole: "migration_owner",
    databaseComment:
      "kristallball.identity=fd5dcb6e-cb54-4c69-90d9-18dd28967831",
  });
  await assert.rejects(
    verifyDatabaseIdentity(runtime, differentMarker),
    /do not target the same PostgreSQL database/,
  );

  const differentOid = dataSourceWithIdentity({
    databaseName: "kristallball",
    databaseOid: "16385",
    loginRole: "migration_owner",
  });
  await assert.rejects(
    verifyDatabaseIdentity(runtime, differentOid),
    /do not target the same PostgreSQL database/,
  );
});

test("database identity rejects the same login for both connections", async () => {
  await assert.rejects(
    verifyDatabaseIdentity(
      dataSourceWithIdentity({ loginRole: "same_role" }),
      dataSourceWithIdentity({ loginRole: "same_role" }),
    ),
    /separate login roles/,
  );
});

test("database identity fails closed when the marker or query result is invalid", async () => {
  await assert.rejects(
    readDatabaseIdentity(
      dataSourceWithIdentity({ databaseComment: "ordinary database comment" }),
    ),
    /missing or has an invalid format/,
  );
  await assert.rejects(
    readDatabaseIdentity({
      async query() {
        return [];
      },
    }),
    /Could not verify PostgreSQL database identity/,
  );
  await assert.rejects(
    readDatabaseIdentity(dataSourceWithIdentity({}, new Error("query failed"))),
    /query failed/,
  );
});

test("identity mismatch prevents the gated operation from running", async () => {
  let operationCalled = false;
  await assert.rejects(
    runAfterDatabaseIdentityVerification(
      dataSourceWithIdentity(),
      dataSourceWithIdentity({
        loginRole: "migration_owner",
        databaseOid: "16385",
      }),
      async () => {
        operationCalled = true;
      },
    ),
    /do not target the same PostgreSQL database/,
  );
  assert.equal(operationCalled, false);
});

test("identity verification rejects a missing operation callback", async () => {
  await assert.rejects(
    runAfterDatabaseIdentityVerification(
      dataSourceWithIdentity(),
      dataSourceWithIdentity({ loginRole: "migration_owner" }),
      null,
    ),
    /operation is required/,
  );
});
