import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_ENV_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env",
);

let environmentLoaded = false;

export function loadEnvironment(envPath = BACKEND_ENV_PATH) {
  if (environmentLoaded) {
    return;
  }

  dotenv.config({ path: resolve(envPath) });
  environmentLoaded = true;
}
