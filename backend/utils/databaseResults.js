export function rowsOfCommandResult(result) {
  const rows =
    Array.isArray(result) &&
    Array.isArray(result[0]) &&
    Number.isInteger(result[1])
      ? result[0]
      : result;
  if (!Array.isArray(rows)) {
    throw new Error("The database returned an invalid result.");
  }
  return rows;
}
