import { Router } from "express";

export function createHealthRouter({ getDataSource }) {
  const router = Router();

  router.get("/", async (_request, response) => {
    const dataSource = getDataSource();
    if (!dataSource?.isInitialized) {
      return response.status(503).json({
        success: false,
        data: {
          status: "unavailable",
          database: "unavailable",
          service: "Kristallball API",
        },
      });
    }

    try {
      await dataSource.query("SELECT 1");
    } catch {
      return response.status(503).json({
        success: false,
        data: {
          status: "unavailable",
          database: "unavailable",
          service: "Kristallball API",
        },
      });
    }

    return response.status(200).json({
      success: true,
      data: {
        status: "ok",
        database: "ok",
        service: "Kristallball API",
      },
    });
  });

  return router;
}
