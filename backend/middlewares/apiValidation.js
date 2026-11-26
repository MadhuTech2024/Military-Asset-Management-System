import { isUuid } from "../config/jwt.js";
import { AUTHORIZATION_ROLES } from "../config/authorizationPolicies.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const MAX_LIMIT = 100;
const MAX_OFFSET = 1000000;
const MAX_PASSWORD_BYTES = 72;
const POSTGRES_INTEGER_MAX = 2147483647;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AUDIT_FILTER_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/iu;
const UTC_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MAX_AUDIT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const INVENTORY_MOVEMENT_TYPES = Object.freeze([
  "PURCHASE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "ASSIGNMENT",
  "RETURN",
  "EXPENDITURE",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidRequest(response) {
  return response.status(400).json({
    success: false,
    error: {
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
    },
  });
}

function parseBoundedInteger(value, defaultValue, maximum) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function parsePagination(query) {
  const limit = parseBoundedInteger(query.limit, 50, MAX_LIMIT);
  const offset = parseBoundedInteger(query.offset, 0, MAX_OFFSET);
  if (limit === null || limit < 1 || offset === null) {
    return null;
  }
  return { limit, offset };
}

function parseOptionalBoolean(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function parseName(value, maximum = 128) {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  return name.length > 0 && name.length <= maximum ? name : null;
}

function parseCode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

function parseEmail(value) {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  return (
    Buffer.byteLength(email, "utf8") <= 254 && EMAIL_PATTERN.test(email)
  )
    ? email
    : null;
}

function parsePassword(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES
  ) {
    return null;
  }
  return value;
}

function parseBaseId(value) {
  if (value === null || isUuid(value)) {
    return value;
  }
  return undefined;
}

function parseUserFields(body, { partial }) {
  const keys = ["email", "name", "password", "role", "baseId"];
  if (!hasOnlyKeys(body, keys) || (partial && Object.keys(body).length === 0)) {
    return null;
  }

  const result = {};
  if (!partial || Object.hasOwn(body, "email")) {
    result.email = parseEmail(body.email);
    if (result.email === null) {
      return null;
    }
  }
  if (!partial || Object.hasOwn(body, "name")) {
    result.name = parseName(body.name);
    if (result.name === null) {
      return null;
    }
  }
  if (!partial || Object.hasOwn(body, "password")) {
    result.password = parsePassword(body.password);
    if (result.password === null) {
      return null;
    }
  }
  if (!partial || Object.hasOwn(body, "role")) {
    if (!AUTHORIZATION_ROLES.includes(body.role)) {
      return null;
    }
    result.role = body.role;
  }
  if (Object.hasOwn(body, "baseId")) {
    result.baseId = parseBaseId(body.baseId);
    if (result.baseId === undefined) {
      return null;
    }
  } else if (!partial) {
    result.baseId = null;
  }

  return result;
}

function parseStatusBody(body) {
  if (!hasOnlyKeys(body, ["isActive"]) || typeof body.isActive !== "boolean") {
    return null;
  }
  return { isActive: body.isActive };
}

function parseBaseFields(body, { partial }) {
  const keys = ["code", "name", "locationName"];
  if (!hasOnlyKeys(body, keys) || (partial && Object.keys(body).length === 0)) {
    return null;
  }

  const result = {};
  if (!partial || Object.hasOwn(body, "code")) {
    result.code = parseCode(body.code);
    if (result.code === null) {
      return null;
    }
  }
  if (!partial || Object.hasOwn(body, "name")) {
    result.name = parseName(body.name);
    if (result.name === null) {
      return null;
    }
  }
  if (!partial || Object.hasOwn(body, "locationName")) {
    const locationName = body.locationName ?? null;
    if (locationName !== null && typeof locationName !== "string") {
      return null;
    }
    result.locationName =
      locationName === null ? null : locationName.trim();
    if (result.locationName?.length > 128) {
      return null;
    }
  }
  return result;
}

function parseEquipmentTypeFields(body, { partial }) {
  const keys = ["code", "name", "category", "description"];
  if (!hasOnlyKeys(body, keys) || (partial && Object.keys(body).length === 0)) {
    return null;
  }

  const result = {};
  for (const [field, parser] of [
    ["code", parseCode],
    ["name", parseName],
    ["category", (value) => parseName(value, 64)],
  ]) {
    if (!partial || Object.hasOwn(body, field)) {
      result[field] = parser(body[field]);
      if (result[field] === null) {
        return null;
      }
    }
  }

  if (!partial || Object.hasOwn(body, "description")) {
    const description = body.description ?? null;
    if (description !== null && typeof description !== "string") {
      return null;
    }
    result.description =
      description === null ? null : description.trim();
    if (result.description?.length > 4000) {
      return null;
    }
  }
  return result;
}

function parseBaseListQuery(query) {
  if (!hasOnlyKeys(query, ["limit", "offset", "isActive", "search"])) {
    return null;
  }
  const pagination = parsePagination(query);
  const isActive = parseOptionalBoolean(query.isActive);
  const search = parseOptionalSearch(query.search);
  if (!pagination || isActive === null || search === undefined) {
    return null;
  }
  return { ...pagination, isActive, search };
}

function parseTransferDestinationListQuery(query) {
  if (!hasOnlyKeys(query, ["limit", "offset"])) {
    return null;
  }
  return parsePagination(query);
}

function parseUserListQuery(query) {
  if (!hasOnlyKeys(query, ["limit", "offset", "search", "role", "isActive"])) {
    return null;
  }
  const pagination = parsePagination(query);
  const search = parseOptionalSearch(query.search);
  const isActive = parseOptionalBoolean(query.isActive);
  if (
    !pagination ||
    search === undefined ||
    isActive === null ||
    (query.role !== undefined && !AUTHORIZATION_ROLES.includes(query.role))
  ) {
    return null;
  }
  return {
    ...pagination,
    search,
    role: query.role ?? null,
    isActive,
  };
}

function parseEquipmentTypeListQuery(query) {
  return parseBaseListQuery(query);
}

function parseInventoryListQuery(query) {
  if (!hasOnlyKeys(query, ["limit", "offset", "baseId", "equipmentTypeId"])) {
    return null;
  }
  const pagination = parsePagination(query);
  if (
    !pagination ||
    (query.baseId !== undefined && !isUuid(query.baseId))
  ) {
    return null;
  }
  if (
    query.equipmentTypeId !== undefined &&
    !isUuid(query.equipmentTypeId)
  ) {
    return null;
  }
  return {
    ...pagination,
    baseId: query.baseId ?? null,
    equipmentTypeId: query.equipmentTypeId ?? null,
  };
}

function parseUtcIsoDate(value, fieldName) {
  if (typeof value !== "string" || !UTC_ISO_PATTERN.test(value)) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const normalized = new Date(timestamp).toISOString();
  const canonicalWithoutMilliseconds =
    normalized.replace(".000Z", "Z");
  if (value !== normalized && value !== canonicalWithoutMilliseconds) {
    return null;
  }
  return { fieldName, value: normalized };
}

function parseAuditListQuery(query) {
  if (
    !hasOnlyKeys(query, [
      "action",
      "entityType",
      "actorId",
      "baseId",
      "from",
      "to",
      "limit",
      "offset",
    ])
  ) {
    return null;
  }
  const pagination = parsePagination(query);
  if (!pagination) {
    return null;
  }

  if (
    query.action !== undefined &&
    (typeof query.action !== "string" ||
      !AUDIT_FILTER_PATTERN.test(query.action))
  ) {
    return null;
  }
  if (
    query.entityType !== undefined &&
    (typeof query.entityType !== "string" ||
      !AUDIT_FILTER_PATTERN.test(query.entityType))
  ) {
    return null;
  }
  if (
    query.actorId !== undefined &&
    !isUuid(query.actorId)
  ) {
    return null;
  }
  if (
    query.baseId !== undefined &&
    !isUuid(query.baseId)
  ) {
    return null;
  }

  const from = query.from === undefined
    ? null
    : parseUtcIsoDate(query.from, "from");
  const to = query.to === undefined
    ? null
    : parseUtcIsoDate(query.to, "to");
  if (
    (query.from !== undefined && from === null) ||
    (query.to !== undefined && to === null)
  ) {
    return null;
  }
  const now = Date.now();
  const fromTime = from ? Date.parse(from.value) : null;
  const toTime = to ? Date.parse(to.value) : null;
  if (
    (fromTime !== null && fromTime > now) ||
    (toTime !== null && toTime > now)
  ) {
    return null;
  }
  if (from && to) {
    if (fromTime > toTime || toTime - fromTime > MAX_AUDIT_WINDOW_MS) {
      return null;
    }
  } else if (fromTime !== null) {
    if (now - fromTime > MAX_AUDIT_WINDOW_MS) {
      return null;
    }
  } else if (toTime !== null) {
    if (now - toTime > MAX_AUDIT_WINDOW_MS) {
      return null;
    }
  }

  return {
    ...pagination,
    action: query.action ?? null,
    entityType: query.entityType ?? null,
    actorId: query.actorId ?? null,
    baseId: query.baseId ?? null,
    from: from?.value ?? null,
    to: to?.value ?? null,
  };
}

function parseReportListQuery(query, { includeMovementType = false } = {}) {
  const allowedKeys = [
    "baseId",
    "equipmentTypeId",
    "from",
    "to",
    "limit",
    "offset",
  ];
  if (includeMovementType) {
    allowedKeys.push("movementType");
  }
  if (
    !hasOnlyKeys(query, allowedKeys)
  ) {
    return null;
  }
  const pagination = parsePagination(query);
  if (
    !pagination ||
    (query.baseId !== undefined && !isUuid(query.baseId)) ||
    (query.equipmentTypeId !== undefined &&
      !isUuid(query.equipmentTypeId)) ||
    (query.movementType !== undefined &&
      (!includeMovementType ||
        !INVENTORY_MOVEMENT_TYPES.includes(query.movementType)))
  ) {
    return null;
  }

  const from = query.from === undefined
    ? null
    : parseUtcIsoDate(query.from, "from");
  const to = query.to === undefined
    ? null
    : parseUtcIsoDate(query.to, "to");
  if (
    (query.from !== undefined && from === null) ||
    (query.to !== undefined && to === null)
  ) {
    return null;
  }

  const now = Date.now();
  const fromTime = from ? Date.parse(from.value) : null;
  const toTime = to ? Date.parse(to.value) : null;
  if (
    (fromTime !== null && fromTime > now) ||
    (toTime !== null && toTime > now)
  ) {
    return null;
  }
  if (from && to) {
    if (fromTime > toTime || toTime - fromTime > MAX_AUDIT_WINDOW_MS) {
      return null;
    }
  } else if (fromTime !== null && now - fromTime > MAX_AUDIT_WINDOW_MS) {
    return null;
  } else if (toTime !== null && now - toTime > MAX_AUDIT_WINDOW_MS) {
    return null;
  }

  return {
    ...pagination,
    baseId: query.baseId ?? null,
    equipmentTypeId: query.equipmentTypeId ?? null,
    from: from?.value ?? null,
    to: to?.value ?? null,
    ...(includeMovementType
      ? { movementType: query.movementType ?? null }
      : {}),
  };
}

function parseQuantity(value) {
  return Number.isInteger(value) &&
    value > 0 &&
    value <= POSTGRES_INTEGER_MAX
    ? value
    : null;
}

function parseOptionalSearch(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length > 128) {
    return undefined;
  }
  return value.trim() || null;
}

function parseOpeningStockBody(body) {
  if (
    !hasOnlyKeys(body, ["baseId", "equipmentTypeId", "openingBalance"]) ||
    !isUuid(body.baseId) ||
    !isUuid(body.equipmentTypeId) ||
    parseQuantity(body.openingBalance) === null
  ) {
    return null;
  }
  return {
    baseId: body.baseId,
    equipmentTypeId: body.equipmentTypeId,
    openingBalance: body.openingBalance,
  };
}

function parseShortText(value, maximum) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = value.trim();
  return parsed.length > 0 && parsed.length <= maximum ? parsed : null;
}

function parseNullableReferenceCode(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return parseShortText(value, 64);
}

function parsePurchaseCreateBody(body) {
  if (
    !hasOnlyKeys(body, [
      "baseId",
      "equipmentTypeId",
      "quantity",
      "referenceCode",
    ])
  ) {
    return null;
  }
  const referenceCode = parseNullableReferenceCode(body.referenceCode);
  if (
    !isUuid(body.baseId) ||
    !isUuid(body.equipmentTypeId) ||
    parseQuantity(body.quantity) === null ||
    (body.referenceCode !== undefined &&
      body.referenceCode !== null &&
      referenceCode === null)
  ) {
    return null;
  }
  return {
    baseId: body.baseId,
    equipmentTypeId: body.equipmentTypeId,
    quantity: body.quantity,
    referenceCode,
  };
}

function parseTransferCreateBody(body) {
  if (
    !hasOnlyKeys(body, [
      "sourceBaseId",
      "destinationBaseId",
      "equipmentTypeId",
      "quantity",
    ]) ||
    !isUuid(body.sourceBaseId) ||
    !isUuid(body.destinationBaseId) ||
    body.sourceBaseId === body.destinationBaseId ||
    !isUuid(body.equipmentTypeId) ||
    parseQuantity(body.quantity) === null
  ) {
    return null;
  }
  return {
    sourceBaseId: body.sourceBaseId,
    destinationBaseId: body.destinationBaseId,
    equipmentTypeId: body.equipmentTypeId,
    quantity: body.quantity,
  };
}

function parseAssignmentCreateBody(body) {
  if (
    !hasOnlyKeys(body, ["assetId", "quantity", "personnelReference"]) ||
    !isUuid(body.assetId) ||
    parseQuantity(body.quantity) === null
  ) {
    return null;
  }
  const personnelReference = parseShortText(body.personnelReference, 64);
  if (personnelReference === null) {
    return null;
  }
  return { assetId: body.assetId, quantity: body.quantity, personnelReference };
}

function parseReturnBody(body) {
  if (
    !hasOnlyKeys(body, ["quantity"]) ||
    parseQuantity(body.quantity) === null
  ) {
    return null;
  }
  return { quantity: body.quantity };
}

function parseExpenditureCreateBody(body) {
  if (
    !hasOnlyKeys(body, ["assetId", "quantity", "reasonCode", "notes"]) ||
    !isUuid(body.assetId) ||
    parseQuantity(body.quantity) === null
  ) {
    return null;
  }
  const reasonCode = parseShortText(body.reasonCode, 64);
  if (reasonCode === null) {
    return null;
  }
  let notes = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== "string" || body.notes.trim().length > 4000) {
      return null;
    }
    notes = body.notes.trim() || null;
  }
  return { assetId: body.assetId, quantity: body.quantity, reasonCode, notes };
}

export function validateUuidParam(parameterName) {
  return function validateIdentifier(request, response, next) {
    if (!isUuid(request.params[parameterName])) {
      return invalidRequest(response);
    }
    return next();
  };
}

export function validateIdempotencyKey(request, response, next) {
  const key = request.get("Idempotency-Key");
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalidRequest(response);
  }
  request.idempotencyKey = key;
  return next();
}

export function validateEmptyRequestBody(request, response, next) {
  const body = request.body;
  if (
    body !== undefined &&
    (!isPlainObject(body) || Object.keys(body).length !== 0)
  ) {
    return invalidRequest(response);
  }
  request.validatedBody = {};
  return next();
}

export function validateRequestBody(parser) {
  return function validateBody(request, response, next) {
    if (!isPlainObject(request.body)) {
      return invalidRequest(response);
    }
    const parsedBody = parser(request.body);
    if (!parsedBody) {
      return invalidRequest(response);
    }
    request.validatedBody = parsedBody;
    return next();
  };
}

export function validateRequestQuery(parser) {
  return function validateQuery(request, response, next) {
    if (!isPlainObject(request.query)) {
      return invalidRequest(response);
    }

    const parsedQuery = parser(request.query);
    if (!parsedQuery) {
      return invalidRequest(response);
    }
    request.validatedQuery = parsedQuery;
    return next();
  };
}

export function validateEmptyQuery(request, response, next) {
  if (
    !isPlainObject(request.query) ||
    Object.keys(request.query).length !== 0
  ) {
    return invalidRequest(response);
  }
  return next();
}

export const validateUserCreateBody = validateRequestBody((body) =>
  parseUserFields(body, { partial: false }),
);
export const validateUserUpdateBody = validateRequestBody((body) =>
  parseUserFields(body, { partial: true }),
);
export const validateStatusBody = validateRequestBody(parseStatusBody);
export const validateBaseCreateBody = validateRequestBody((body) =>
  parseBaseFields(body, { partial: false }),
);
export const validateBaseUpdateBody = validateRequestBody((body) =>
  parseBaseFields(body, { partial: true }),
);
export const validateEquipmentTypeCreateBody = validateRequestBody((body) =>
  parseEquipmentTypeFields(body, { partial: false }),
);
export const validateEquipmentTypeUpdateBody = validateRequestBody((body) =>
  parseEquipmentTypeFields(body, { partial: true }),
);
export const validateBaseListQuery =
  validateRequestQuery(parseBaseListQuery);
export const validateTransferDestinationListQuery =
  validateRequestQuery(parseTransferDestinationListQuery);
export const validateEquipmentTypeListQuery =
  validateRequestQuery(parseEquipmentTypeListQuery);
export const validateUserListQuery =
  validateRequestQuery(parseUserListQuery);
export const validateInventoryListQuery =
  validateRequestQuery(parseInventoryListQuery);
export const validateAuditListQuery =
  validateRequestQuery(parseAuditListQuery);
export const validateReportListQuery =
  validateRequestQuery(parseReportListQuery);
export const validateInventoryMovementListQuery =
  validateRequestQuery((query) =>
    parseReportListQuery(query, { includeMovementType: true }),
  );
export const validatePurchaseCreateBody =
  validateRequestBody(parsePurchaseCreateBody);
export const validateTransferCreateBody =
  validateRequestBody(parseTransferCreateBody);
export const validateAssignmentCreateBody =
  validateRequestBody(parseAssignmentCreateBody);
export const validateReturnBody = validateRequestBody(parseReturnBody);
export const validateExpenditureCreateBody =
  validateRequestBody(parseExpenditureCreateBody);
export const validateOpeningStockBody =
  validateRequestBody(parseOpeningStockBody);
