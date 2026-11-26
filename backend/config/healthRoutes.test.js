import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createHealthRouter } from "../routes/healthRoutes.js";

async function withHealthServer(dataSource, callback) {
  const app = express();
  app.use(
    "/api/health",
    createHealthRouter({ getDataSource: () => dataSource }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}/api/health`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("health endpoint reports success only after a database query succeeds", async () => {
  const queries = [];
  await withHealthServer(
    {
      isInitialized: true,
      async query(sql) {
        queries.push(sql);
        return [{ "?column?": 1 }];
      },
    },
    async (url) => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        success: true,
        data: {
          status: "ok",
          database: "ok",
          service: "Kristallball API",
        },
      });
    },
  );
  assert.deepEqual(queries, ["SELECT 1"]);
});

test("health endpoint reports unavailable when the database is not initialized", async () => {
  let queried = false;
  await withHealthServer(
    {
      isInitialized: false,
      async query() {
        queried = true;
      },
    },
    async (url) => {
      const response = await fetch(url);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        success: false,
        data: {
          status: "unavailable",
          database: "unavailable",
          service: "Kristallball API",
        },
      });
    },
  );
  assert.equal(queried, false);
});

test("health endpoint returns a safe unavailable response on database query failure", async () => {
  await withHealthServer(
    {
      isInitialized: true,
      async query() {
        throw new Error("sensitive connection details");
      },
    },
    async (url) => {
      const response = await fetch(url);
      const body = await response.text();
      assert.equal(response.status, 503);
      assert.match(body, /"database":"unavailable"/u);
      assert.doesNotMatch(body, /sensitive connection details/u);
    },
  );
});
