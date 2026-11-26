function databaseErrorCode(error) {
  const code = error?.code ?? error?.driverError?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code)
    ? code
    : null;
}

export function sendNotFound(response, resourceName) {
  return response.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `${resourceName} was not found.`,
    },
  });
}

export function sendConflict(response, code, message) {
  return response.status(409).json({
    success: false,
    error: { code, message },
  });
}

export function sendDatabaseError(response, error) {
  const code = databaseErrorCode(error);
  if (code === "23505") {
    return sendConflict(
      response,
      "DUPLICATE_RECORD",
      "A record with the supplied unique value already exists.",
    );
  }
  if (code === "23503") {
    return sendConflict(
      response,
      "RELATED_RECORD_CONFLICT",
      "Related records prevent this change.",
    );
  }
  if (code === "23514" || code === "23502" || code === "22P02") {
    return response.status(400).json({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "The request is invalid.",
      },
    });
  }

  return response.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "The request could not be completed.",
    },
  });
}
