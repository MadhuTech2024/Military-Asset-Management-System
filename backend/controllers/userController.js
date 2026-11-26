import bcrypt from "bcrypt";
import { writeBusinessAudit } from "../utils/businessAudit.js";
import {
  sendConflict,
  sendDatabaseError,
  sendNotFound,
} from "../utils/apiResponses.js";
import { rowsOfCommandResult } from "../utils/databaseResults.js";

const USER_COLUMNS = `
  id, email, full_name, role, base_id, is_active, created_at, updated_at
`;

function toUserDto(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.full_name,
    role: user.role,
    baseId: user.base_id ?? null,
    isActive: user.is_active,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function toUserAuditSnapshot(user) {
  return {
    role: user.role,
    baseId: user.base_id ?? null,
    isActive: user.is_active,
  };
}

function validRoleBaseAssignment(role, baseId) {
  return role === "ADMIN" ? baseId === null : baseId !== null;
}

async function activeBaseExists(manager, baseId) {
  if (baseId === null) {
    return true;
  }
  const bases = await manager.query(
    `SELECT id
     FROM public.base
     WHERE id = $1 AND is_active = TRUE
     FOR SHARE`,
    [baseId],
  );
  return Array.isArray(bases) && bases.length === 1;
}

export function createUserController({
  dataSource,
  passwordHasher = bcrypt,
}) {
  return {
    async list(request, response) {
      try {
        const { limit, offset, search, role, isActive } = request.validatedQuery;
        const [countRows, users] = await Promise.all([
          dataSource.query(
            `SELECT COUNT(*) AS total
             FROM public.app_user
             WHERE ($1::text IS NULL OR
                    pg_catalog.strpos(pg_catalog.lower(full_name), pg_catalog.lower($1)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(email), pg_catalog.lower($1)) > 0)
               AND ($2::text IS NULL OR role::text = $2)
               AND ($3::boolean IS NULL OR is_active = $3)`,
            [search, role, isActive ?? null],
          ),
          dataSource.query(
            `SELECT ${USER_COLUMNS}
             FROM public.app_user
             WHERE ($1::text IS NULL OR
                    pg_catalog.strpos(pg_catalog.lower(full_name), pg_catalog.lower($1)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(email), pg_catalog.lower($1)) > 0)
               AND ($2::text IS NULL OR role::text = $2)
               AND ($3::boolean IS NULL OR is_active = $3)
             ORDER BY created_at DESC, id
             LIMIT $4 OFFSET $5`,
            [search, role, isActive ?? null, limit, offset],
          ),
        ]);
        if (
          !Array.isArray(countRows) ||
          countRows.length !== 1 ||
          !Array.isArray(users)
        ) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }

        return response.status(200).json({
          success: true,
          data: { users: users.map(toUserDto) },
          meta: { limit, offset, total: Number(countRows[0].total) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async getById(request, response) {
      try {
        const users = await dataSource.query(
          `SELECT ${USER_COLUMNS}
           FROM public.app_user
           WHERE id = $1`,
          [request.params.id],
        );
        if (!Array.isArray(users)) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        if (users.length === 0) {
          return sendNotFound(response, "User");
        }

        return response.status(200).json({
          success: true,
          data: { user: toUserDto(users[0]) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async create(request, response) {
      const { email, name, password, role, baseId } = request.validatedBody;
      try {
        if (!validRoleBaseAssignment(role, baseId)) {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_ROLE_BASE_ASSIGNMENT",
              message: "The role and base assignment are inconsistent.",
            },
          });
        }

        const passwordHash = await passwordHasher.hash(password, 12);
        const result = await dataSource.transaction(async (manager) => {
          if (!(await activeBaseExists(manager, baseId))) {
            return { kind: "invalid-base" };
          }

          const existingUsers = await manager.query(
            `SELECT id
             FROM public.app_user
             WHERE pg_catalog.lower(email) = $1
             LIMIT 1`,
            [email],
          );
          if (!Array.isArray(existingUsers)) {
            return { kind: "database-error" };
          }
          if (existingUsers.length > 0) {
            return { kind: "duplicate-email" };
          }

          const users = await manager.query(
            `INSERT INTO public.app_user
               (email, password_hash, full_name, role, base_id, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             RETURNING ${USER_COLUMNS}`,
            [email, passwordHash, name, role, baseId],
          );
          if (!Array.isArray(users) || users.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "USER_CREATED",
            entityType: "user",
            entityId: users[0].id,
            baseId: users[0].base_id,
            afterData: toUserAuditSnapshot(users[0]),
          });
          return { kind: "created", user: users[0] };
        });

        if (result.kind === "invalid-base") {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_BASE",
              message: "The selected base is unavailable.",
            },
          });
        }
        if (result.kind === "duplicate-email") {
          return sendConflict(
            response,
            "DUPLICATE_EMAIL",
            "A user with that email already exists.",
          );
        }
        if (result.kind !== "created") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }

        return response.status(201).json({
          success: true,
          data: { user: toUserDto(result.user) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async update(request, response) {
      const { id } = request.params;
      const body = request.validatedBody;
      try {
        const passwordHash =
          body.password === undefined
            ? null
            : await passwordHasher.hash(body.password, 12);

        const result = await dataSource.transaction(async (manager) => {
          const existingUsers = await manager.query(
            `SELECT id, email, role, base_id, is_active
             FROM public.app_user
             WHERE id = $1
             FOR UPDATE`,
            [id],
          );
          if (!Array.isArray(existingUsers)) {
            return { kind: "database-error" };
          }
          if (existingUsers.length === 0) {
            return { kind: "not-found" };
          }
          if (existingUsers.length !== 1) {
            return { kind: "database-error" };
          }

          const existing = existingUsers[0];
          const nextRole = body.role ?? existing.role;
          const nextBaseId = Object.hasOwn(body, "baseId")
            ? body.baseId
            : existing.base_id;
          if (
            request.currentUser.id === id &&
            body.role === "ADMIN"
          ) {
            return { kind: "self-admin" };
          }
          if (!validRoleBaseAssignment(nextRole, nextBaseId)) {
            return { kind: "invalid-assignment" };
          }
          if (!(await activeBaseExists(manager, nextBaseId))) {
            return { kind: "invalid-base" };
          }

          if (
            body.email !== undefined &&
            body.email !== existing.email
          ) {
            const duplicates = await manager.query(
              `SELECT id
               FROM public.app_user
               WHERE pg_catalog.lower(email) = $1
                 AND id <> $2
               LIMIT 1`,
              [body.email, id],
            );
            if (!Array.isArray(duplicates)) {
              return { kind: "database-error" };
            }
            if (duplicates.length > 0) {
              return { kind: "duplicate-email" };
            }
          }

          const users = rowsOfCommandResult(
            await manager.query(
              `UPDATE public.app_user
               SET email = CASE WHEN $2 THEN $3 ELSE email END,
                   full_name = CASE WHEN $4 THEN $5 ELSE full_name END,
                   role = CASE WHEN $6 THEN $7 ELSE role END,
                   base_id = CASE WHEN $8 THEN $9 ELSE base_id END,
                   password_hash = CASE WHEN $10 THEN $11 ELSE password_hash END,
                   updated_at = now()
               WHERE id = $1
               RETURNING ${USER_COLUMNS}`,
              [
                id,
                body.email !== undefined,
                body.email ?? null,
                body.name !== undefined,
                body.name ?? null,
                body.role !== undefined,
                body.role ?? null,
                Object.hasOwn(body, "baseId"),
                nextBaseId,
                passwordHash !== null,
                passwordHash,
              ],
            ),
          );
          if (!Array.isArray(users)) {
            return { kind: "database-error" };
          }
          if (users.length === 0) {
            return { kind: "not-found" };
          }
          if (users.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "USER_UPDATED",
            entityType: "user",
            entityId: users[0].id,
            baseId: users[0].base_id,
            beforeData: toUserAuditSnapshot(existing),
            afterData: {
              ...toUserAuditSnapshot(users[0]),
              changedFields: Object.keys(body).filter(
                (field) => field !== "password",
              ),
            },
          });
          return { kind: "updated", user: users[0] };
        });

        if (result.kind === "not-found") {
          return sendNotFound(response, "User");
        }
        if (result.kind === "self-admin") {
          return response.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You cannot assign yourself administrator privileges.",
            },
          });
        }
        if (result.kind === "invalid-assignment") {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_ROLE_BASE_ASSIGNMENT",
              message: "The role and base assignment are inconsistent.",
            },
          });
        }
        if (result.kind === "invalid-base") {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_BASE",
              message: "The selected base is unavailable.",
            },
          });
        }
        if (result.kind === "duplicate-email") {
          return sendConflict(
            response,
            "DUPLICATE_EMAIL",
            "A user with that email already exists.",
          );
        }
        if (result.kind !== "updated") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }

        return response.status(200).json({
          success: true,
          data: { user: toUserDto(result.user) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async setActive(request, response) {
      try {
        const result = await dataSource.transaction(async (manager) => {
          const currentUsers = await manager.query(
            `SELECT ${USER_COLUMNS}
             FROM public.app_user
             WHERE id = $1
             FOR UPDATE`,
            [request.params.id],
          );
          if (!Array.isArray(currentUsers) || currentUsers.length > 1) {
            return { kind: "database-error" };
          }
          if (currentUsers.length === 0) {
            return { kind: "not-found" };
          }

          const current = currentUsers[0];
          if (current.is_active === request.validatedBody.isActive) {
            return { kind: "unchanged", user: current };
          }

          const users = rowsOfCommandResult(
            await manager.query(
              `UPDATE public.app_user
               SET is_active = $2, updated_at = now()
               WHERE id = $1
               RETURNING ${USER_COLUMNS}`,
              [request.params.id, request.validatedBody.isActive],
            ),
          );
          if (!Array.isArray(users) || users.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: users[0].is_active ? "USER_ACTIVATED" : "USER_DEACTIVATED",
            entityType: "user",
            entityId: users[0].id,
            baseId: users[0].base_id,
            beforeData: { isActive: current.is_active },
            afterData: { isActive: users[0].is_active },
          });
          return { kind: "updated", user: users[0] };
        });

        if (result.kind === "not-found") {
          return sendNotFound(response, "User");
        }
        if (result.kind !== "updated" && result.kind !== "unchanged") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }

        return response.status(200).json({
          success: true,
          data: { user: toUserDto(result.user) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
