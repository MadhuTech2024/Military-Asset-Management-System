import { isUuid, verifyAccessToken } from "../config/jwt.js";

function sendUnauthenticated(response) {
  return response.status(401).json({
    success: false,
    error: {
      code: "UNAUTHENTICATED",
      message: "Authentication is required.",
    },
  });
}

function sendAuthenticationUnavailable(response) {
  return response.status(503).json({
    success: false,
    error: {
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Authentication is temporarily unavailable.",
    },
  });
}

function createSafeCurrentUser(user) {
  return {
    id: user.id,
    name: user.full_name,
    email: user.email,
    role: user.role,
    baseId: user.base_id ?? null,
    isActive: user.is_active,
  };
}

export function createAuthMiddleware({ dataSource, jwtConfiguration }) {
  return async function authenticate(request, response, next) {
    const authorization = request.get("authorization") ?? "";
    const bearerMatch = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearerMatch || bearerMatch[1].length > 8192) {
      return sendUnauthenticated(response);
    }

    let subject;
    try {
      subject = await verifyAccessToken(bearerMatch[1], jwtConfiguration);
    } catch {
      return sendUnauthenticated(response);
    }

    if (!isUuid(subject)) {
      return sendUnauthenticated(response);
    }

    let users;
    try {
      users = await dataSource.query(
        `SELECT id, email, full_name, role, base_id, is_active
         FROM public.app_user
         WHERE id = $1`,
        [subject],
      );
      if (!Array.isArray(users)) {
        return sendAuthenticationUnavailable(response);
      }
    } catch {
      return sendAuthenticationUnavailable(response);
    }

    if (users.length !== 1 || users[0].is_active !== true) {
      return sendUnauthenticated(response);
    }

    request.currentUser = createSafeCurrentUser(users[0]);
    return next();
  };
}
