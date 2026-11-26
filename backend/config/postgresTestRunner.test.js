import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(
  new URL("./run-postgres-integration-tests.js", import.meta.url),
);

test("PostgreSQL verification refuses to fall back to application database URLs", () => {
  const env = { ...process.env };
  delete env.KRISTALLBALL_ISOLATED_TEST_DATABASE_URL;
  env.DATABASE_URL = "postgresql://application-url-must-not-be-used";
  env.MIGRATION_DATABASE_URL = "postgresql://migration-url-must-not-be-used";

  const result = spawnSync(process.execPath, [runnerPath, "--postgres-only"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.match(output, /KRISTALLBALL_ISOLATED_TEST_DATABASE_URL/u);
  assert.doesNotMatch(output, /application-url-must-not-be-used|migration-url-must-not-be-used/u);
});
