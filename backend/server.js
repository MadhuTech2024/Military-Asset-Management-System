import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { validateRuntimeDatabaseSecurity } from "./config/appRoleRuntimeValidation.js";
import { createJwtConfiguration } from "./config/jwt.js";
import { loadEnvironment } from "./config/loadEnvironment.js";
import { createAuthRouter } from "./routes/authRoutes.js";
import { createBusinessOperationsRouter } from "./routes/businessOperationsRoutes.js";
import { createBaseRouter } from "./routes/baseRoutes.js";
import { createEquipmentTypeRouter } from "./routes/equipmentTypeRoutes.js";
import { createInventoryRouter } from "./routes/inventoryRoutes.js";
import { createUserRouter } from "./routes/userRoutes.js";
import { createAuditRouter } from "./routes/auditRoutes.js";
import { createDashboardRouter } from "./routes/dashboardRoutes.js";
import { createHealthRouter } from "./routes/healthRoutes.js";
import { createReportRouter } from "./routes/reportRoutes.js";

loadEnvironment();

const app = express();
let AppDataSource;
app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
const portValue = process.env.PORT ?? "5000";
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const configuredOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins =
  process.env.NODE_ENV === "production"
    ? configuredOrigins
    : ["http://localhost:5173", ...configuredOrigins];

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

app.use(
  "/api/health",
  createHealthRouter({ getDataSource: () => AppDataSource }),
);

let httpServer;
let shutdownPromise;

async function startServer() {
  let jwtConfiguration;
  try {
    jwtConfiguration = createJwtConfiguration(process.env.JWT_SECRET);
  } catch {
    console.error(
      "JWT_SECRET must be configured as a valid high-entropy Base64URL value generated from at least 32 random bytes.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const runtimeDatabase = await import("./config/db.js");
    AppDataSource = runtimeDatabase.AppDataSource;
    runtimeDatabase.validateRuntimeDatabaseConfiguration();
  } catch {
    console.error(
      "DATABASE_URL is required for the restricted runtime database connection.",
    );
    process.exitCode = 1;
    return;
  }

  app.use(
    "/api/auth",
    createAuthRouter({
      dataSource: AppDataSource,
      jwtConfiguration,
    }),
  );
  app.use(
    "/api/users",
    createUserRouter({ dataSource: AppDataSource, jwtConfiguration }),
  );
  app.use(
    "/api/bases",
    createBaseRouter({ dataSource: AppDataSource, jwtConfiguration }),
  );
  app.use(
    "/api/equipment-types",
    createEquipmentTypeRouter({
      dataSource: AppDataSource,
      jwtConfiguration,
    }),
  );
  app.use(
    "/api/inventory",
    createInventoryRouter({ dataSource: AppDataSource, jwtConfiguration }),
  );
  app.use(
    "/api/audit",
    createAuditRouter({ dataSource: AppDataSource, jwtConfiguration }),
  );
  app.use(
    "/api/dashboard",
    createDashboardRouter({ dataSource: AppDataSource, jwtConfiguration }),
  );
  app.use(
    "/api/reports",
    createReportRouter({ dataSource: AppDataSource, jwtConfiguration }),
  );
  app.use(
    "/api",
    createBusinessOperationsRouter({
      dataSource: AppDataSource,
      jwtConfiguration,
    }),
  );
  app.use((_request, response) => {
    response.status(404).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
      },
    });
  });
  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const isInvalidJson = error?.type === "entity.parse.failed";
    response.status(isInvalidJson ? 400 : 500).json({
      success: false,
      error: {
        code: isInvalidJson ? "INVALID_JSON" : "INTERNAL_SERVER_ERROR",
        message: isInvalidJson
          ? "Request body must contain valid JSON."
          : "The request could not be completed.",
      },
    });
  });

  try {
    await AppDataSource.initialize();
  } catch {
    console.error(
      "Runtime database initialization failed. Check DATABASE_URL, runtime database permissions, and database availability.",
    );
    if (AppDataSource?.isInitialized) {
      await AppDataSource.destroy().catch(() => {
        console.error("Runtime database connection could not be closed cleanly.");
      });
    }
    process.exitCode = 1;
    return;
  }

  try {
    await validateRuntimeDatabaseSecurity(
      AppDataSource,
      process.env.APP_DATABASE_ROLE,
    );
  } catch {
    console.error(
      "Runtime database security validation failed. Verify APP_DATABASE_ROLE and the restricted runtime database privileges.",
    );
    if (AppDataSource?.isInitialized) {
      await AppDataSource.destroy().catch(() => {
        console.error("Runtime database connection could not be closed cleanly.");
      });
    }
    process.exitCode = 1;
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      httpServer = app.listen(port, resolve);
      httpServer.once("error", reject);
    });
  } catch {
    console.error("Kristallball API could not start its HTTP listener.");
    if (AppDataSource?.isInitialized) {
      await AppDataSource.destroy().catch(() => {
        console.error("Runtime database connection could not be closed cleanly.");
      });
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Kristallball API listening on port ${port}.`);
}

function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`Received ${signal}; shutting down Kristallball API.`);

    if (httpServer?.listening) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch(() => {
        console.error("HTTP server did not close cleanly.");
        process.exitCode = 1;
      });
    }

    if (AppDataSource?.isInitialized) {
      await AppDataSource.destroy().catch(() => {
        console.error("Runtime database connection did not close cleanly.");
        process.exitCode = 1;
      });
    }
  })();

  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await startServer();
