import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_ENV_PATH } from "./loadEnvironment.js";
import { createSyntheticJwtSecret } from "./testJwtSecret.js";

const backendDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("backend .env path is anchored to the backend directory", () => {
  assert.equal(BACKEND_ENV_PATH, join(backendDirectory, ".env"));
});

test("environment loading uses the selected file independently of cwd and runs once", async () => {
  const testDirectory = await mkdtemp(join(tmpdir(), "kristallball-env-load-"));
  const workingDirectory = join(testDirectory, "outside-backend");
  const firstEnvironmentPath = join(testDirectory, "first", ".env");
  const secondEnvironmentPath = join(testDirectory, "second", ".env");
  const firstSecret = createSyntheticJwtSecret(48, 3);
  const secondSecret = createSyntheticJwtSecret(48, 7);

  try {
    await mkdir(workingDirectory);
    await mkdir(dirname(firstEnvironmentPath));
    await mkdir(dirname(secondEnvironmentPath));
    await writeFile(firstEnvironmentPath, `JWT_SECRET=${firstSecret}\n`);
    await writeFile(secondEnvironmentPath, `JWT_SECRET=${secondSecret}\n`);

    const loaderUrl = new URL("./loadEnvironment.js", import.meta.url).href;
    const probe = `
      import { loadEnvironment } from ${JSON.stringify(loaderUrl)};
      process.chdir(${JSON.stringify(workingDirectory)});
      loadEnvironment(${JSON.stringify(firstEnvironmentPath)});
      const loaded = process.env.JWT_SECRET === ${JSON.stringify(firstSecret)};
      loadEnvironment(${JSON.stringify(secondEnvironmentPath)});
      const loadedOnlyOnce = process.env.JWT_SECRET === ${JSON.stringify(firstSecret)};
      console.log(JSON.stringify({
        loaded,
        loadedOnlyOnce,
        cwdIndependent: process.cwd() === ${JSON.stringify(workingDirectory)}
      }));
    `;
    const environment = { ...process.env };
    delete environment.JWT_SECRET;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: testDirectory,
      env: environment,
      encoding: "utf8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      loaded: true,
      loadedOnlyOnce: true,
      cwdIndependent: true,
    });
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});

test("environment loading preserves externally supplied variables", async () => {
  const testDirectory = await mkdtemp(join(tmpdir(), "kristallball-env-precedence-"));
  const environmentPath = join(testDirectory, ".env");
  const fileSecret = createSyntheticJwtSecret(48, 11);
  const externalSecret = createSyntheticJwtSecret(48, 19);

  try {
    await writeFile(environmentPath, `JWT_SECRET=${fileSecret}\n`);
    const loaderUrl = new URL("./loadEnvironment.js", import.meta.url).href;
    const probe = `
      import { loadEnvironment } from ${JSON.stringify(loaderUrl)};
      loadEnvironment(${JSON.stringify(environmentPath)});
      console.log(JSON.stringify({
        externalValuePreserved:
          process.env.JWT_SECRET === ${JSON.stringify(externalSecret)}
      }));
    `;
    const environment = { ...process.env, JWT_SECRET: externalSecret };
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: testDirectory,
      env: environment,
      encoding: "utf8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      externalValuePreserved: true,
    });
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});
