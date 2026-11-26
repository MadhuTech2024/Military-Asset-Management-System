import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(configDirectory, "..");
const isolatedUrl = process.env.KRISTALLBALL_ISOLATED_TEST_DATABASE_URL;
const integrationTestFiles = [
  "administrativeAudit.integration.test.js",
  "appRoleRuntimeValidation.integration.test.js",
  "appRoleTemporaryPrivilege.integration.test.js",
  "reportingApi.integration.test.js",
];
const integrationTestNames = new Map([
  [
    "administrativeAudit.integration.test.js",
    "isolated PostgreSQL keeps administrative mutations atomic with audit writes",
  ],
  [
    "appRoleRuntimeValidation.integration.test.js",
    "isolated PostgreSQL validates role CTEs, effective privileges, and transactional rollback",
  ],
  [
    "appRoleTemporaryPrivilege.integration.test.js",
    "isolated PostgreSQL rejects runtime TEMPORARY privilege and protects production triggers",
  ],
  [
    "reportingApi.integration.test.js",
    "isolated PostgreSQL executes reporting and dashboard queries against synthetic fixtures",
  ],
]);

function isSafeIsolatedTestUrl(value) {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname === "127.0.0.1" &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      port !== 5432 &&
      url.pathname === "/postgres" &&
      url.username === "postgres" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

if (!isolatedUrl) {
  console.error(
    "Set KRISTALLBALL_ISOLATED_TEST_DATABASE_URL to the dedicated disposable local PostgreSQL cluster before running this verification gate.",
  );
  process.exitCode = 1;
} else if (!isSafeIsolatedTestUrl(isolatedUrl)) {
  console.error(
    "The isolated test URL must be password-free, use 127.0.0.1 on a non-default port, and target the postgres maintenance database.",
  );
  process.exitCode = 1;
} else {
  const runAll = process.argv[2] === "--all";
  const availableTestFiles = new Set(
    readdirSync(configDirectory).filter((file) => file.endsWith(".test.js")),
  );
  const missingIntegrationFiles = integrationTestFiles.filter(
    (file) => !availableTestFiles.has(file),
  );

  if (missingIntegrationFiles.length > 0) {
    console.error(
      `Required PostgreSQL integration test files are missing: ${missingIntegrationFiles.join(", ")}.`,
    );
    process.exitCode = 1;
  } else if (!runAll && process.argv[2] !== "--postgres-only") {
    console.error("Choose --postgres-only or --all.");
    process.exitCode = 1;
  } else {
    const selectedFiles = runAll
      ? [...availableTestFiles].sort()
      : integrationTestFiles;
    for (const file of selectedFiles) {
      const result = spawnSync(
        process.execPath,
        [
          "--test",
          "--test-concurrency=1",
          "--test-reporter=tap",
          resolve(configDirectory, file),
        ],
        {
          cwd: backendDirectory,
          env: process.env,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["inherit", "pipe", "pipe"],
        },
      );

      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      if (result.error) {
        console.error(`Could not start test file ${file}.`);
        process.exitCode = 1;
        break;
      }
      if (integrationTestNames.has(file)) {
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        const testCountMatches = [
          ...output.matchAll(/(?:^|\r?\n)# tests (\d+)(?:\r?\n|$)/gu),
        ];
        const skippedCountMatches = [
          ...output.matchAll(/(?:^|\r?\n)# skipped (\d+)(?:\r?\n|$)/gu),
        ];
        const testCount = testCountMatches.at(-1);
        const skippedCount = skippedCountMatches.at(-1);
        const requiredTestName = integrationTestNames.get(file);
        const requiredTestPassed = output.split(/\r?\n/u).some((line) => {
          const trimmed = line.trim();
          return (
            /^ok \d+ - /u.test(trimmed) &&
            trimmed.includes(requiredTestName) &&
            !trimmed.includes("# SKIP")
          );
        });
        if (
          !testCount ||
          Number(testCount[1]) === 0 ||
          !skippedCount ||
          Number(skippedCount[1]) !== 0 ||
          !requiredTestPassed
        ) {
          console.error(
            `Required PostgreSQL integration suite ${file} did not run its required test or reported skipped tests.`,
          );
          process.exitCode = 1;
          break;
        }
      }
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        break;
      }
    }
  }
}
