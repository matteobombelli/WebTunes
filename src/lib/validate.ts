// Route params arrive as raw strings; comparing a non-UUID against a uuid
// column makes Postgres throw (22P02), which surfaces as a 500. Routes guard
// with this and return their normal 404 instead.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
