import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createAuthController } from "../controllers/authController.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";

export function createAuthRouter({
  dataSource,
  jwtConfiguration,
  loginRateLimitOptions = {},
}) {
  const router = Router();
  const controller = createAuthController({ dataSource, jwtConfiguration });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...loginRateLimitOptions,
    handler(_request, response) {
      response.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many login attempts. Try again later.",
        },
      });
    },
  });

  router.post("/login", loginRateLimiter, controller.login);
  router.get("/me", authenticate, controller.me);

  return router;
}
