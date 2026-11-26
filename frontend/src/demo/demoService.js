import {
  DEMO_BASE_IDS,
  DEMO_TYPE_IDS,
  calculatePosition,
  createInitialDemoData,
  getInventoryRows,
} from "./demoData.js";

const VALID_ROLES = ["ADMIN", "BASE_COMMANDER", "LOGISTICS_OFFICER"];
let data = createInitialDemoData();
let activePrincipal = null;
let nextGeneratedId = 1000;

export class DemoServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DemoServiceError";
    this.status = status;
  }
}

function copy(value) {
  return structuredClone(value);
}

function generatedId() {
  const suffix = String(nextGeneratedId++);
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

function now() {
  return new Date().toISOString();
}

function dispatchToast(message) {
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("kristallball:demo-toast", { detail: { message } }),
    );
  }
}

function fail(message, status) {
  throw new DemoServiceError(message, status);
}

function currentUser() {
  if (!activePrincipal) fail("Sign in to access the local demo data.", 401);
  const user = data.users.find((candidate) => candidate.id === activePrincipal.id);
  if (!user || !user.isActive) {
    activePrincipal = null;
    fail("This demo account is inactive. Sign in with an active demo account.", 401);
  }
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) {
    fail("Your role is not permitted to perform this demo action.", 403);
  }
}

function assertBaseAccess(user, baseId) {
  if (user.role !== "ADMIN" && user.baseId !== baseId) {
    fail("This record is outside your assigned base scope.", 403);
  }
}

function addAudit(action, entityType, entityId, baseId = null) {
  const user = currentUser();
  const entry = {
    id: generatedId(),
    action,
    entityType,
    entityId,
    actorId: user.id,
    baseId,
    correlationId: `demo-correlation-${generatedId().slice(-6)}`,
    createdAt: now(),
    metadata: { synthetic: true, source: "local-demo" },
  };
  data.auditLogs.unshift(entry);
  return entry;
}

export function setDemoPrincipal(user) {
  activePrincipal = user ? { id: user.id } : null;
}

export function clearDemoPrincipal() {
  activePrincipal = null;
}

export function getDemoUserByEmail(email) {
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";
  const user = data.users.find(
    (candidate) =>
      candidate.email.toLowerCase() === normalizedEmail &&
      candidate.isDemoAccount !== false,
  );
  return user
    ? {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        baseId: user.baseId,
        isActive: user.isActive,
      }
    : null;
}

export function resetDemoData() {
  data = createInitialDemoData();
  nextGeneratedId = 1000;
  if (activePrincipal) {
    const user = data.users.find((candidate) => candidate.id === activePrincipal.id);
    activePrincipal = user ? { id: user.id } : null;
  }
}

export function getDemoDataSnapshot() {
  return copy(data);
}

function listMeta(total, limit, offset) {
  return { total, limit, offset, hasMore: offset + limit < total };
}

function paginate(items, params) {
  const parsedLimit = Number(params.limit);
  const parsedOffset = Number(params.offset);
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 500)
      : 50;
  const offset =
    Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  return {
    items: items.slice(offset, offset + limit),
    meta: listMeta(items.length, limit, offset),
  };
}

function response(payload, meta) {
  return {
    status: 200,
    data: {
      success: true,
      data: payload,
      ...(meta ? { meta } : {}),
    },
  };
}

function matchesSearch(values, search) {
  if (!search) return true;
  const needle = String(search).trim().toLowerCase();
  return values.some((value) =>
    String(value ?? "").toLowerCase().includes(needle),
  );
}

function withinDates(date, params) {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return false;
  if (params.from && timestamp < Date.parse(params.from)) return false;
  if (params.to && timestamp > Date.parse(params.to)) return false;
  return true;
}

function filterBaseRows(rows, user, baseId, transfer = false) {
  if (user.role === "ADMIN") {
    if (!baseId) return rows;
    return rows.filter((row) =>
      transfer
        ? row.sourceBaseId === baseId || row.destinationBaseId === baseId
        : row.baseId === baseId,
    );
  }
  if (!user.baseId) return [];
  return rows.filter((row) =>
    transfer
      ? row.sourceBaseId === user.baseId || row.destinationBaseId === user.baseId
      : row.baseId === user.baseId,
  );
}

function applyCommonFilters(rows, params, dateKey) {
  return rows.filter((row) => {
    if (params.equipmentTypeId && row.equipmentTypeId !== params.equipmentTypeId) {
      return false;
    }
    if (params.from || params.to) {
      if (!withinDates(row[dateKey], params)) return false;
    }
    return true;
  });
}

function withBaseAndType(item) {
  return {
    ...item,
    base: data.bases.find((base) => base.id === item.baseId) ?? null,
    equipmentType:
      data.equipmentTypes.find((type) => type.id === item.equipmentTypeId) ?? null,
  };
}

function scopedInventory(user, params = {}) {
  const baseId = user.role === "ADMIN" ? params.baseId : user.baseId;
  return getInventoryRows(data, baseId)
    .filter((row) => !params.equipmentTypeId || row.equipmentTypeId === params.equipmentTypeId)
    .filter((row) => params.isActive === undefined || row.isActive === (params.isActive === "true" || params.isActive === true));
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item[field] ?? 0), 0);
}

function createMovements(user, params) {
  let movements = [];
  const scoped = (baseId) =>
    user.role === "ADMIN"
      ? !params.baseId || params.baseId === baseId
      : user.baseId === baseId;
  const append = (row) => {
    if (!scoped(row.baseId)) return;
    if (params.equipmentTypeId && params.equipmentTypeId !== row.equipmentTypeId) return;
    if (params.movementType && params.movementType !== row.movementType) return;
    if ((params.from || params.to) && !withinDates(row.occurredAt, params)) return;
    movements.push(row);
  };
  data.purchases
    .filter((purchase) => purchase.status === "COMPLETED")
    .forEach((purchase) =>
      append({
        id: `movement-${purchase.id}`,
        baseId: purchase.baseId,
        equipmentTypeId: purchase.equipmentTypeId,
        movementType: "PURCHASE",
        direction: "IN",
        quantity: purchase.quantity,
        occurredAt: purchase.completedAt ?? purchase.purchasedAt,
        sourceId: purchase.id,
      }),
    );
  data.transfers
    .filter((transfer) => transfer.status === "COMPLETED")
    .forEach((transfer) => {
      append({
        id: `movement-${transfer.id}-out`,
        baseId: transfer.sourceBaseId,
        equipmentTypeId: transfer.equipmentTypeId,
        movementType: "TRANSFER_OUT",
        direction: "OUT",
        quantity: transfer.quantity,
        occurredAt: transfer.completedAt ?? transfer.createdAt,
        sourceId: transfer.id,
      });
      append({
        id: `movement-${transfer.id}-in`,
        baseId: transfer.destinationBaseId,
        equipmentTypeId: transfer.equipmentTypeId,
        movementType: "TRANSFER_IN",
        direction: "IN",
        quantity: transfer.quantity,
        occurredAt: transfer.completedAt ?? transfer.createdAt,
        sourceId: transfer.id,
      });
    });
  data.assignments.forEach((assignment) =>
    append({
      id: `movement-${assignment.id}-assignment`,
      baseId: assignment.baseId,
      equipmentTypeId: assignment.equipmentTypeId,
      movementType: "ASSIGNMENT",
      direction: "OUT",
      quantity: assignment.grossAssigned,
      occurredAt: assignment.assignedAt,
      sourceId: assignment.id,
    }),
  );
  data.returns.forEach((entry) =>
    append({
      id: `movement-${entry.id}-return`,
      baseId: entry.baseId,
      equipmentTypeId: entry.equipmentTypeId,
      movementType: "RETURN",
      direction: "IN",
      quantity: entry.quantity,
      occurredAt: entry.returnedAt,
      sourceId: entry.id,
    }),
  );
  data.expenditures.forEach((entry) =>
    append({
      id: `movement-${entry.id}-expenditure`,
      baseId: entry.baseId,
      equipmentTypeId: entry.equipmentTypeId,
      movementType: "EXPENDITURE",
      direction: "OUT",
      quantity: entry.quantity,
      occurredAt: entry.expendedAt,
      sourceId: entry.id,
    }),
  );
  return movements.sort(
    (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
  );
}

function reportFor(kind, user, params) {
  const baseId = user.role === "ADMIN" ? params.baseId : user.baseId;
  if (kind === "inventory-movements") {
    const movements = createMovements(user, params);
    const page = paginate(movements, params);
    const inventory = scopedInventory(user, { baseId });
    return response(
      {
        movements: page.items,
        summary: {
          openingBalance: sum(inventory, "openingBalance"),
          openingBalanceIntroduced: sum(inventory, "openingBalance"),
          closingBalance: sum(inventory, "closingBalance"),
          netAssigned: sum(inventory, "assigned"),
        },
      },
      page.meta,
    );
  }

  const definitions = {
    purchases: { key: "purchases", dateKey: "purchasedAt", transfer: false },
    transfers: { key: "transfers", dateKey: "createdAt", transfer: true },
    assignments: { key: "assignments", dateKey: "assignedAt", transfer: false },
    returns: { key: "returns", dateKey: "returnedAt", transfer: false },
    expenditures: { key: "expenditures", dateKey: "expendedAt", transfer: false },
  };
  const definition = definitions[kind];
  if (!definition) fail("The requested demo report does not exist.", 404);
  let rows = filterBaseRows(
    data[definition.key],
    user,
    baseId,
    definition.transfer,
  );
  rows = applyCommonFilters(rows, params, definition.dateKey);
  if (kind === "purchases") {
    const page = paginate(rows, params);
    return response(
      {
        purchases: page.items,
        pending: {
          count: rows.filter((row) => row.status === "PENDING").length,
          quantity: sum(rows.filter((row) => row.status === "PENDING"), "quantity"),
        },
      },
      page.meta,
    );
  }
  if (kind === "transfers") {
    const page = paginate(rows, params);
    const byStatus = {};
    for (const transfer of rows) {
      const key = transfer.status.toLowerCase();
      byStatus[key] ??= { count: 0, quantity: 0 };
      byStatus[key].count += 1;
      byStatus[key].quantity += transfer.quantity;
    }
    return response({ transfers: page.items, byStatus }, page.meta);
  }
  if (kind === "assignments") {
    const page = paginate(rows, params);
    return response(
      {
        assignments: page.items,
        summary: {
          assignmentCount: rows.length,
          grossAssigned: sum(rows, "grossAssigned"),
          cumulativeReturned: sum(rows, "cumulativeReturned"),
          netAssigned: sum(rows, "netAssigned"),
        },
      },
      page.meta,
    );
  }
  if (kind === "returns") {
    const page = paginate(rows, params);
    return response(
      {
        returns: page.items,
        summary: { count: rows.length, quantity: sum(rows, "quantity") },
      },
      page.meta,
    );
  }
  const page = paginate(rows, params);
  return response(
    {
      expenditures: page.items,
      summary: { count: rows.length, quantity: sum(rows, "quantity") },
    },
    page.meta,
  );
}

function dashboardData(user, baseId) {
  const effectiveBaseId = user.role === "ADMIN" ? baseId : user.baseId;
  const inventory = scopedInventory(user, { baseId: effectiveBaseId });
  const visibleBaseIds = new Set(inventory.map((row) => row.baseId));
  const visibleBases = data.bases.filter(
    (base) => visibleBaseIds.has(base.id) && base.isActive,
  );
  const purchases = filterBaseRows(data.purchases, user, effectiveBaseId);
  const transfers = filterBaseRows(data.transfers, user, effectiveBaseId, true);
  const assignments = filterBaseRows(data.assignments, user, effectiveBaseId);
  const expenditures = filterBaseRows(data.expenditures, user, effectiveBaseId);
  const audits = filterBaseRows(data.auditLogs, user, effectiveBaseId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const pendingPurchases = purchases.filter((purchase) => purchase.status === "PENDING");
  const pendingTransfers = transfers.filter((transfer) => transfer.status === "PENDING");
  const approvedTransfers = transfers.filter((transfer) => transfer.status === "APPROVED");
  const availableQuantity = sum(inventory, "closingBalance");
  const netAssignedQuantity = sum(inventory, "assigned");
  const expenditureQuantity = sum(expenditures, "quantity");
  const baseTotals = visibleBases.map((base) => {
    const rows = inventory.filter((row) => row.baseId === base.id);
    return {
      ...base,
      available: sum(rows, "closingBalance"),
      assigned: sum(rows, "assigned"),
      opening: sum(rows, "openingBalance"),
      expenditure: sum(rows, "expended"),
    };
  });
  const categoryTotals = data.equipmentTypes.map((type) => {
    const rows = inventory.filter((row) => row.equipmentTypeId === type.id);
    return {
      name: type.name,
      category: type.category,
      available: sum(rows, "closingBalance"),
      assigned: sum(rows, "assigned"),
    };
  });
  const lowStock = inventory
    .filter((row) => row.closingBalance < Math.max(75, row.openingBalance * 0.62))
    .map((row) => ({
      ...row,
      threshold: Math.max(75, Math.floor(row.openingBalance * 0.62)),
    }))
    .sort((left, right) => left.closingBalance - right.closingBalance)
    .slice(0, 8);

  const monthLabel = (date) =>
    new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(date));
  const monthKeys = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - (5 - index));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
  const monthlyActivity = monthKeys.map((key) => {
    const matchingPurchases = purchases.filter(
      (purchase) =>
        purchase.status === "COMPLETED" &&
        (purchase.completedAt ?? purchase.purchasedAt).slice(0, 7) === key,
    );
    const matchingExpenditures = expenditures.filter(
      (entry) => entry.expendedAt.slice(0, 7) === key,
    );
    return {
      month: monthLabel(`${key}-01T00:00:00Z`),
      purchases: sum(matchingPurchases, "quantity"),
      expenditures: sum(matchingExpenditures, "quantity"),
    };
  });
  const transferFlows = transfers
    .filter((transfer) => transfer.status === "COMPLETED")
    .map((transfer) => ({
      route: `${data.bases.find((base) => base.id === transfer.sourceBaseId)?.code ?? "?"} → ${data.bases.find((base) => base.id === transfer.destinationBaseId)?.code ?? "?"}`,
      quantity: transfer.quantity,
      equipmentTypeId: transfer.equipmentTypeId,
      status: transfer.status,
    }));

  return {
    role: user.role,
    baseId: effectiveBaseId ?? null,
    baseName: effectiveBaseId
      ? data.bases.find((base) => base.id === effectiveBaseId)?.name ?? "Assigned base"
      : null,
    inventory: {
      availableQuantity,
      netAssignedQuantity,
      openingQuantity: sum(inventory, "openingBalance"),
    },
    pendingPurchases: {
      count: pendingPurchases.length,
      quantity: sum(pendingPurchases, "quantity"),
    },
    transfers: {
      pending: {
        count: pendingTransfers.length,
        quantity: sum(pendingTransfers, "quantity"),
      },
      approved: {
        count: approvedTransfers.length,
        quantity: sum(approvedTransfers, "quantity"),
      },
      completed: {
        count: transfers.filter((transfer) => transfer.status === "COMPLETED").length,
        quantity: sum(transfers.filter((transfer) => transfer.status === "COMPLETED"), "quantity"),
      },
    },
    assignments: {
      count: assignments.length,
      gross: sum(assignments, "grossAssigned"),
      returned: sum(assignments, "cumulativeReturned"),
      net: sum(assignments, "netAssigned"),
    },
    expenditureQuantity,
    personnelCount: data.personnel.filter(
      (person) => !effectiveBaseId || person.baseId === effectiveBaseId,
    ).length,
    baseTotals,
    categoryTotals,
    monthlyActivity,
    transferFlows,
    lowStock,
    recentActivities: audits.slice(0, 8),
    inventoryRows: inventory,
    incomingTransfers: transfers.filter(
      (transfer) => transfer.destinationBaseId === effectiveBaseId,
    ),
    outgoingTransfers: transfers.filter(
      (transfer) => transfer.sourceBaseId === effectiveBaseId,
    ),
    recentPurchases: purchases.slice().sort(
      (left, right) => Date.parse(right.purchasedAt) - Date.parse(left.purchasedAt),
    ).slice(0, 5),
  };
}

export function getDemoDashboardData(user, baseId) {
  const current = currentUser();
  if (!user || current.id !== user.id) {
    fail("The dashboard user does not match the active demo session.", 403);
  }
  return copy(dashboardData(current, baseId));
}

function cleanPath(pathname) {
  const path = pathname.split("?")[0].replace(/^\/api(?=\/|$)/, "");
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
}

function getParams(config) {
  const url = new URL(config.url ?? "/", "http://local.demo");
  const query = Object.fromEntries(url.searchParams.entries());
  const configParams =
    config.params instanceof URLSearchParams
      ? Object.fromEntries(config.params.entries())
      : config.params ?? {};
  return { ...query, ...configParams };
}

function getBody(config) {
  if (config.data == null || config.data === "") return {};
  if (typeof config.data === "object") return config.data;
  try {
    return JSON.parse(config.data);
  } catch {
    fail("The demo request body must be valid JSON.", 400);
  }
}

function getEntity(path, collection, label) {
  const entity = collection.find((entry) => entry.id === path);
  if (!entity) fail(`${label} was not found in the synthetic demo data.`, 404);
  return entity;
}

function validateQuantity(value) {
  if (!Number.isInteger(value) || value <= 0) {
    fail("Quantity must be a whole number greater than zero.", 400);
  }
}

function inventoryPosition(assetId) {
  return getEntity(assetId, data.inventoryPositions, "Inventory position");
}

function operationAllowedForBase(user, baseId) {
  assertBaseAccess(user, baseId);
  const base = getEntity(baseId, data.bases, "Base");
  if (!base.isActive) fail("The selected base is inactive.", 409);
  return base;
}

function createUser(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const role = body.role;
  if (!name || !email || !VALID_ROLES.includes(role)) {
    fail("Name, email, and a valid role are required.", 400);
  }
  if (data.users.some((candidate) => candidate.email.toLowerCase() === email)) {
    fail("A user with this email already exists.", 409);
  }
  const baseId = role === "ADMIN" ? null : body.baseId;
  if (role !== "ADMIN") operationAllowedForBase(user, baseId);
  const created = {
    id: generatedId(),
    name,
    email,
    role,
    baseId,
    isActive: true,
    isDemoAccount: false,
    createdAt: now(),
    updatedAt: now(),
  };
  data.users.unshift(created);
  addAudit("USER_CREATED", "user", created.id, created.baseId);
  dispatchToast("Synthetic directory user created.");
  return response({ user: copy(created) });
}

function updateUserStatus(path, body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  const target = getEntity(path, data.users, "User");
  target.isActive = Boolean(body.isActive);
  target.updatedAt = now();
  addAudit(target.isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED", "user", target.id, target.baseId);
  dispatchToast(target.isActive ? "Synthetic user activated." : "Synthetic user deactivated.");
  return response({ user: copy(target) });
}

function updateUser(path, body) {
  const actor = currentUser();
  requireRole(actor, ["ADMIN"]);
  const target = getEntity(path, data.users, "User");
  if (body.name !== undefined) target.name = String(body.name).trim();
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (data.users.some((candidate) => candidate.id !== target.id && candidate.email.toLowerCase() === email)) {
      fail("A user with this email already exists.", 409);
    }
    target.email = email;
  }
  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(body.role)) fail("Select a valid role.", 400);
    target.role = body.role;
    if (body.role === "ADMIN") {
      target.baseId = null;
    } else if (body.baseId !== undefined) {
      operationAllowedForBase(actor, body.baseId);
      target.baseId = body.baseId;
    } else if (!target.baseId) {
      fail("Base-scoped roles require an assigned base.", 400);
    }
  } else if (body.baseId !== undefined) {
    if (target.role === "ADMIN") {
      fail("Administrators do not have a base assignment.", 400);
    }
    operationAllowedForBase(actor, body.baseId);
    target.baseId = body.baseId;
  }
  target.updatedAt = now();
  addAudit("USER_UPDATED", "user", target.id, target.baseId);
  dispatchToast("Synthetic user details updated.");
  return response({ user: copy(target) });
}

function createBase(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  if (!code || !name) fail("Base code and name are required.", 400);
  if (data.bases.some((base) => base.code.toLowerCase() === code.toLowerCase())) {
    fail("A base with this code already exists.", 409);
  }
  const base = {
    id: generatedId(),
    code,
    name,
    region: String(body.locationName ?? body.region ?? body.location ?? "Synthetic District").trim(),
    location: String(body.locationName ?? body.location ?? body.region ?? "Synthetic District").trim(),
    locationName: String(body.locationName ?? body.location ?? body.region ?? "Synthetic District").trim(),
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
  };
  data.bases.push(base);
  addAudit("BASE_CREATED", "base", base.id, base.id);
  dispatchToast("Synthetic base created.");
  return response({ base: copy(base) });
}

function updateBase(path, body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  const base = getEntity(path, data.bases, "Base");
  for (const field of ["code", "name", "region", "location", "locationName"]) {
    if (body[field] !== undefined) base[field] = String(body[field]).trim();
  }
  if (body.locationName !== undefined) {
    base.location = base.locationName;
    base.region = base.locationName;
  }
  base.updatedAt = now();
  addAudit("BASE_UPDATED", "base", base.id, base.id);
  dispatchToast("Synthetic base details updated.");
  return response({ base: copy(base) });
}

function updateBaseStatus(path, body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  const base = getEntity(path, data.bases, "Base");
  base.isActive = Boolean(body.isActive);
  base.updatedAt = now();
  addAudit(base.isActive ? "BASE_ACTIVATED" : "BASE_DEACTIVATED", "base", base.id, base.id);
  dispatchToast(base.isActive ? "Synthetic base activated." : "Synthetic base deactivated.");
  return response({ base: copy(base) });
}

function createEquipmentType(body) {
  const user = currentUser();
  requireRole(user, VALID_ROLES);
  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  if (!code || !name) fail("Equipment code and name are required.", 400);
  if (data.equipmentTypes.some((type) => type.code.toLowerCase() === code.toLowerCase())) {
    fail("An equipment type with this code already exists.", 409);
  }
  const equipmentType = {
    id: generatedId(),
    code,
    name,
    category: String(body.category ?? "General").trim(),
    description: String(body.description ?? ""),
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
  };
  data.equipmentTypes.push(equipmentType);
  addAudit("EQUIPMENT_TYPE_CREATED", "equipment_type", equipmentType.id);
  dispatchToast("Synthetic equipment type created.");
  return response({ equipmentType: copy(equipmentType) });
}

function updateEquipmentType(path, body) {
  const user = currentUser();
  requireRole(user, VALID_ROLES);
  const equipmentType = getEntity(path, data.equipmentTypes, "Equipment type");
  for (const field of ["code", "name", "category", "description"]) {
    if (body[field] !== undefined) equipmentType[field] = String(body[field]).trim();
  }
  equipmentType.updatedAt = now();
  addAudit("EQUIPMENT_TYPE_UPDATED", "equipment_type", equipmentType.id);
  dispatchToast("Synthetic equipment details updated.");
  return response({ equipmentType: copy(equipmentType) });
}

function updateEquipmentTypeStatus(path, body) {
  const user = currentUser();
  requireRole(user, VALID_ROLES);
  const equipmentType = getEntity(path, data.equipmentTypes, "Equipment type");
  equipmentType.isActive = Boolean(body.isActive);
  equipmentType.updatedAt = now();
  addAudit(
    equipmentType.isActive ? "EQUIPMENT_TYPE_ACTIVATED" : "EQUIPMENT_TYPE_DEACTIVATED",
    "equipment_type",
    equipmentType.id,
  );
  dispatchToast(equipmentType.isActive ? "Equipment type activated." : "Equipment type deactivated.");
  return response({ equipmentType: copy(equipmentType) });
}

function createOpeningStock(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  validateQuantity(body.openingBalance);
  operationAllowedForBase(user, body.baseId);
  getEntity(body.equipmentTypeId, data.equipmentTypes, "Equipment type");
  if (data.inventoryPositions.some((position) => position.baseId === body.baseId && position.equipmentTypeId === body.equipmentTypeId)) {
    fail("An inventory position already exists for this base and equipment type.", 409);
  }
  const position = {
    id: generatedId(),
    baseId: body.baseId,
    equipmentTypeId: body.equipmentTypeId,
    openingBalance: body.openingBalance,
    openingAt: now(),
    isActive: true,
  };
  data.inventoryPositions.push(position);
  addAudit("OPENING_STOCK_CREATED", "inventory_position", position.id, position.baseId);
  dispatchToast("Synthetic opening stock initialized.");
  return response({ inventory: copy(position) });
}

function createPurchase(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN", "LOGISTICS_OFFICER"]);
  validateQuantity(body.quantity);
  operationAllowedForBase(user, body.baseId);
  const type = getEntity(body.equipmentTypeId, data.equipmentTypes, "Equipment type");
  if (!type.isActive) fail("The selected equipment type is inactive.", 409);
  const purchase = {
    id: generatedId(),
    baseId: body.baseId,
    equipmentTypeId: body.equipmentTypeId,
    quantity: body.quantity,
    referenceCode: body.referenceCode ?? null,
    status: "PENDING",
    supplier: "Local demo supplier",
    estimatedCost: body.quantity * 250,
    purchasedAt: now(),
    completedAt: null,
    expectedAt: null,
    createdBy: user.id,
    notes: "Created during local synthetic demonstration.",
  };
  data.purchases.unshift(purchase);
  addAudit("PURCHASE_CREATED", "purchase", purchase.id, purchase.baseId);
  dispatchToast("Synthetic purchase request created as pending.");
  return response({ purchase: copy(purchase) });
}

function createPersonnel(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN"]);
  const fullName = String(body.fullName ?? "").trim();
  const serviceNumber = String(body.serviceNumber ?? "").trim().toUpperCase();
  const baseId = body.baseId;
  if (!fullName || !serviceNumber || !baseId) {
    fail("Name, synthetic service number, and base are required.", 400);
  }
  operationAllowedForBase(user, baseId);
  if (data.personnel.some((person) => person.serviceNumber === serviceNumber)) {
    fail("A personnel record with this synthetic service number already exists.", 409);
  }
  const person = {
    id: generatedId(),
    fullName,
    serviceNumber,
    rank: String(body.rank ?? "Specialist").trim(),
    unit: String(body.unit ?? "Operations").trim(),
    baseId,
    email: String(body.email ?? "synthetic.personnel@demo.example.com").trim(),
    phone: "555-0100",
    status: "ACTIVE",
    assignedAt: now(),
  };
  data.personnel.unshift(person);
  addAudit("PERSONNEL_CREATED", "personnel", person.id, person.baseId);
  dispatchToast("Synthetic personnel record created.");
  return response({ personnel: copy(person) });
}

function changePurchaseStatus(path, body) {
  const user = currentUser();
  requireRole(user, ["ADMIN", "LOGISTICS_OFFICER"]);
  const purchase = getEntity(path, data.purchases, "Purchase");
  assertBaseAccess(user, purchase.baseId);
  if (!["COMPLETED", "REJECTED"].includes(body.status)) {
    fail("Demo purchases can be completed or rejected.", 400);
  }
  if (purchase.status !== "PENDING" && purchase.status !== "APPROVED") {
    fail("Only pending or approved purchases can change status.", 409);
  }
  purchase.status = body.status;
  purchase.completedAt = body.status === "COMPLETED" ? now() : null;
  addAudit(
    body.status === "COMPLETED" ? "PURCHASE_COMPLETED" : "PURCHASE_REJECTED",
    "purchase",
    purchase.id,
    purchase.baseId,
  );
  dispatchToast(`Synthetic purchase ${body.status.toLowerCase()}.`);
  return response({ purchase: copy(purchase) });
}

function createTransfer(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN", "LOGISTICS_OFFICER"]);
  validateQuantity(body.quantity);
  operationAllowedForBase(user, body.sourceBaseId);
  if (body.sourceBaseId === body.destinationBaseId) {
    fail("Source and destination bases must be different.", 400);
  }
  const destination = getEntity(body.destinationBaseId, data.bases, "Base");
  if (!destination.isActive) fail("The destination base is inactive.", 409);
  getEntity(body.equipmentTypeId, data.equipmentTypes, "Equipment type");
  const position = data.inventoryPositions.find(
    (entry) => entry.baseId === body.sourceBaseId && entry.equipmentTypeId === body.equipmentTypeId,
  );
  if (!position || calculatePosition(data, position).closingBalance < body.quantity) {
    fail("The source base does not have enough available inventory.", 409);
  }
  const transfer = {
    id: generatedId(),
    sourceBaseId: body.sourceBaseId,
    destinationBaseId: body.destinationBaseId,
    equipmentTypeId: body.equipmentTypeId,
    quantity: body.quantity,
    status: "PENDING",
    createdAt: now(),
    approvedAt: null,
    completedAt: null,
    rejectedAt: null,
    initiatedBy: user.id,
    notes: "Created during local synthetic demonstration.",
  };
  data.transfers.unshift(transfer);
  addAudit("TRANSFER_INITIATED", "transfer", transfer.id, transfer.sourceBaseId);
  dispatchToast("Synthetic transfer created as pending.");
  return response({ transfer: copy(transfer) });
}

function transferAction(path, action) {
  const user = currentUser();
  const transfer = getEntity(path, data.transfers, "Transfer");
  if (action === "approve" || action === "reject") {
    requireRole(user, ["BASE_COMMANDER"]);
    assertBaseAccess(user, transfer.destinationBaseId);
    if (transfer.status !== "PENDING") fail("Only pending transfers can be reviewed.", 409);
    transfer.status = action === "approve" ? "APPROVED" : "REJECTED";
    if (action === "approve") transfer.approvedAt = now();
    else transfer.rejectedAt = now();
  } else if (action === "complete") {
    requireRole(user, ["LOGISTICS_OFFICER"]);
    assertBaseAccess(user, transfer.destinationBaseId);
    if (transfer.status !== "APPROVED") fail("Only approved transfers can be completed.", 409);
    const source = data.inventoryPositions.find(
      (position) => position.baseId === transfer.sourceBaseId && position.equipmentTypeId === transfer.equipmentTypeId,
    );
    if (!source || calculatePosition(data, source).closingBalance < transfer.quantity) {
      fail("The source base no longer has enough inventory for this transfer.", 409);
    }
    transfer.status = "COMPLETED";
    transfer.completedAt = now();
  } else {
    fail("Unknown transfer action.", 404);
  }
  const actionName = {
    approve: "TRANSFER_APPROVED",
    reject: "TRANSFER_REJECTED",
    complete: "TRANSFER_COMPLETED",
  }[action];
  addAudit(actionName, "transfer", transfer.id, transfer.destinationBaseId);
  dispatchToast(`Synthetic transfer ${action}d.`);
  return response({ transfer: copy(transfer) });
}

function createAssignment(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN", "BASE_COMMANDER"]);
  validateQuantity(body.quantity);
  const position = inventoryPosition(body.assetId);
  operationAllowedForBase(user, position.baseId);
  const calculated = calculatePosition(data, position);
  if (calculated.closingBalance < body.quantity) {
    fail("The inventory position does not have enough available quantity.", 409);
  }
  const personnelReference = String(body.personnelReference ?? "").trim();
  if (!personnelReference || personnelReference.length > 64) {
    fail("A synthetic personnel reference is required.", 400);
  }
  const personnel = data.personnel.find(
    (person) =>
      person.baseId === position.baseId &&
      (person.serviceNumber.toLowerCase() === personnelReference.toLowerCase() ||
        person.fullName.toLowerCase() === personnelReference.toLowerCase()),
  );
  const assignment = {
    id: generatedId(),
    assetId: position.id,
    baseId: position.baseId,
    equipmentTypeId: position.equipmentTypeId,
    grossAssigned: body.quantity,
    cumulativeReturned: 0,
    netAssigned: body.quantity,
    status: "ACTIVE",
    assignedAt: now(),
    personnelReference,
    personnelId: personnel?.id ?? null,
    createdBy: user.id,
    notes: "Created during local synthetic demonstration.",
  };
  data.assignments.unshift(assignment);
  addAudit("ASSIGNMENT_CREATED", "assignment", assignment.id, assignment.baseId);
  dispatchToast("Synthetic assignment recorded.");
  return response({ assignment: copy(assignment) });
}

function recordReturn(path, body) {
  const user = currentUser();
  requireRole(user, ["ADMIN", "BASE_COMMANDER"]);
  const assignment = getEntity(path, data.assignments, "Assignment");
  assertBaseAccess(user, assignment.baseId);
  validateQuantity(body.quantity);
  if (body.quantity > assignment.netAssigned) {
    fail("Return quantity cannot exceed the outstanding assigned amount.", 409);
  }
  assignment.cumulativeReturned += body.quantity;
  assignment.netAssigned -= body.quantity;
  assignment.status = assignment.netAssigned === 0 ? "RETURNED" : "ACTIVE";
  const entry = {
    id: generatedId(),
    assignmentId: assignment.id,
    assetId: assignment.assetId,
    baseId: assignment.baseId,
    equipmentTypeId: assignment.equipmentTypeId,
    quantity: body.quantity,
    returnedAt: now(),
    returnedBy: user.id,
  };
  data.returns.unshift(entry);
  addAudit("ASSIGNMENT_RETURN_RECORDED", "return_operation", entry.id, assignment.baseId);
  dispatchToast("Synthetic return recorded.");
  return response({ return: copy(entry), assignment: copy(assignment) });
}

function createExpenditure(body) {
  const user = currentUser();
  requireRole(user, ["ADMIN", "BASE_COMMANDER"]);
  validateQuantity(body.quantity);
  const position = inventoryPosition(body.assetId);
  operationAllowedForBase(user, position.baseId);
  if (calculatePosition(data, position).closingBalance < body.quantity) {
    fail("The inventory position does not have enough available quantity.", 409);
  }
  const reasonCode = String(body.reasonCode ?? "").trim();
  if (!reasonCode || reasonCode.length > 64) fail("A valid reason code is required.", 400);
  const expenditure = {
    id: generatedId(),
    expenditureId: generatedId(),
    assetId: position.id,
    baseId: position.baseId,
    equipmentTypeId: position.equipmentTypeId,
    quantity: body.quantity,
    reasonCode,
    notes: body.notes ?? null,
    expendedAt: now(),
    createdBy: user.id,
  };
  expenditure.expenditureId = expenditure.id;
  data.expenditures.unshift(expenditure);
  addAudit("EXPENDITURE_RECORDED", "expenditure", expenditure.id, expenditure.baseId);
  dispatchToast("Synthetic expenditure recorded.");
  return response({ expenditure: copy(expenditure) });
}

function detailsForRoute(path, params, user) {
  const baseDetail = path.match(/^\/bases\/(?!transfer-destinations$)([^/]+)$/);
  if (baseDetail) {
    const base = getEntity(baseDetail[1], data.bases, "Base");
    assertBaseAccess(user, base.id);
    return response({ base: copy(base) });
  }
  const typeDetail = path.match(/^\/equipment-types\/([^/]+)$/);
  if (typeDetail) {
    return response({ equipmentType: copy(getEntity(typeDetail[1], data.equipmentTypes, "Equipment type")) });
  }
  const userDetail = path.match(/^\/users\/([^/]+)$/);
  if (userDetail) {
    requireRole(user, ["ADMIN"]);
    return response({ user: copy(getEntity(userDetail[1], data.users, "User")) });
  }
  const auditDetail = path.match(/^\/audit\/([^/]+)$/);
  if (auditDetail) {
    const audit = getEntity(auditDetail[1], data.auditLogs, "Audit event");
    assertBaseAccess(user, audit.baseId ?? user.baseId);
    return response({ audit: copy(audit) });
  }
  return null;
}

function handleGet(path, params, user) {
  if (path === "/bases/transfer-destinations") {
    let rows = data.bases.filter((base) => base.isActive);
    rows = rows.filter((base) => user.role === "ADMIN" || base.id !== user.baseId);
    rows = rows.filter((base) => matchesSearch([base.code, base.name, base.region], params.search ?? params.q));
    const page = paginate(rows, params);
    return response({ bases: copy(page.items) }, page.meta);
  }
  const detail = detailsForRoute(path, params, user);
  if (detail) return detail;

  if (path === "/bases") {
    let rows = user.role === "ADMIN" ? data.bases : data.bases.filter((base) => base.id === user.baseId);
    if (params.isActive !== undefined) rows = rows.filter((base) => base.isActive === (params.isActive === "true" || params.isActive === true));
    rows = rows.filter((base) => matchesSearch([base.code, base.name, base.region], params.search ?? params.q));
    const page = paginate(rows, params);
    return response({ bases: copy(page.items) }, page.meta);
  }
  if (path === "/equipment-types") {
    let rows = data.equipmentTypes;
    if (params.isActive !== undefined) rows = rows.filter((type) => type.isActive === (params.isActive === "true" || params.isActive === true));
    rows = rows.filter((type) => matchesSearch([type.code, type.name, type.category, type.description], params.search ?? params.q));
    const page = paginate(rows, params);
    return response({ equipmentTypes: copy(page.items) }, page.meta);
  }
  if (path === "/users") {
    requireRole(user, ["ADMIN"]);
    let rows = data.users.filter((candidate) => matchesSearch([candidate.name, candidate.email, candidate.role], params.search ?? params.q));
    if (params.role) rows = rows.filter((candidate) => candidate.role === params.role);
    if (params.baseId) rows = rows.filter((candidate) => candidate.baseId === params.baseId);
    if (params.isActive !== undefined) rows = rows.filter((candidate) => candidate.isActive === (params.isActive === "true" || params.isActive === true));
    const page = paginate(rows, params);
    return response({ users: copy(page.items) }, page.meta);
  }
  if (path === "/personnel") {
    let rows = data.personnel.filter((person) => user.role === "ADMIN" || person.baseId === user.baseId);
    if (user.role === "ADMIN" && params.baseId) rows = rows.filter((person) => person.baseId === params.baseId);
    if (params.status) rows = rows.filter((person) => person.status === params.status);
    rows = rows.filter((person) => matchesSearch([person.fullName, person.serviceNumber, person.rank, person.unit, person.email], params.search ?? params.q));
    const page = paginate(rows, params);
    return response({ personnel: copy(page.items) }, page.meta);
  }
  if (path === "/inventory") {
    const rows = scopedInventory(user, params);
    const page = paginate(rows, params);
    return response({ inventory: copy(page.items) }, page.meta);
  }
  if (path === "/inventory/summary") {
    return response({ summary: copy(scopedInventory(user)) });
  }
  if (path === "/audit") {
    let rows = filterBaseRows(data.auditLogs, user, params.baseId);
    if (params.action) rows = rows.filter((entry) => entry.action.toLowerCase().includes(String(params.action).toLowerCase()));
    if (params.entityType) rows = rows.filter((entry) => entry.entityType.toLowerCase().includes(String(params.entityType).toLowerCase()));
    rows = applyCommonFilters(rows, params, "createdAt");
    rows.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const page = paginate(rows, params);
    return response({ audits: copy(page.items) }, page.meta);
  }
  if (path === "/dashboard") {
    if (user.role !== "ADMIN") fail("Base-scoped users must use their assigned dashboard.", 403);
    return response({ dashboard: dashboardData(user, params.baseId) });
  }
  const baseDashboard = path.match(/^\/bases\/([^/]+)\/dashboard$/);
  if (baseDashboard) {
    assertBaseAccess(user, baseDashboard[1]);
    return response({ dashboard: dashboardData(user, baseDashboard[1]) });
  }
  const reportMatch = path.match(/^\/reports\/([a-z-]+)$/);
  if (reportMatch) return reportFor(reportMatch[1], user, params);
  fail("The requested demo API route is not available.", 404);
}

function handlePost(path, body, user) {
  if (path === "/purchases") return createPurchase(body);
  if (path === "/transfers") return createTransfer(body);
  if (path === "/inventory/opening-stock") return createOpeningStock(body);
  if (path === "/assignments") return createAssignment(body);
  if (path === "/expenditures") return createExpenditure(body);
  if (path === "/users") return createUser(body);
  if (path === "/personnel") return createPersonnel(body);
  if (path === "/bases") return createBase(body);
  if (path === "/equipment-types") return createEquipmentType(body);
  if (path === "/demo/reset") {
    requireRole(user, ["ADMIN"]);
    resetDemoData();
    dispatchToast("Synthetic demo data reset to its original state.");
    return response({ reset: true });
  }
  const transferActionMatch = path.match(/^\/transfers\/([^/]+)\/(approve|reject|complete)$/);
  if (transferActionMatch) return transferAction(transferActionMatch[1], transferActionMatch[2]);
  const returnMatch = path.match(/^\/assignments\/([^/]+)\/returns$/);
  if (returnMatch) return recordReturn(returnMatch[1], body);
  const purchaseStatusMatch = path.match(/^\/demo\/purchases\/([^/]+)\/status$/);
  if (purchaseStatusMatch) return changePurchaseStatus(purchaseStatusMatch[1], body);
  fail("The requested demo API route is not available.", 404);
}

function handlePatch(path, body) {
  const baseStatus = path.match(/^\/bases\/([^/]+)\/status$/);
  if (baseStatus) return updateBaseStatus(baseStatus[1], body);
  const base = path.match(/^\/bases\/([^/]+)$/);
  if (base) return updateBase(base[1], body);
  const userStatus = path.match(/^\/users\/([^/]+)\/status$/);
  if (userStatus) return updateUserStatus(userStatus[1], body);
  const user = path.match(/^\/users\/([^/]+)$/);
  if (user) return updateUser(user[1], body);
  const equipmentStatus = path.match(/^\/equipment-types\/([^/]+)\/status$/);
  if (equipmentStatus) return updateEquipmentTypeStatus(equipmentStatus[1], body);
  const equipmentType = path.match(/^\/equipment-types\/([^/]+)$/);
  if (equipmentType) return updateEquipmentType(equipmentType[1], body);
  fail("The requested demo API route is not available.", 404);
}

export async function handleDemoRequest(config) {
  const path = cleanPath(config.url ?? "/");
  const method = String(config.method ?? "get").toLowerCase();
  const params = getParams(config);
  const user = currentUser();
  if (method === "get") return handleGet(path, params, user);
  const body = getBody(config);
  if (method === "post") return handlePost(path, body, user);
  if (method === "patch") return handlePatch(path, body);
  fail(`The ${method.toUpperCase()} method is not supported by the local demo.`, 405);
}

