/**
 * Build a JSON-RPC 2.0 error Response.
 */
export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  httpStatus: number
): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status: httpStatus }
  );
}

/**
 * Extract the `id` field from a JSON-RPC request body string.
 * Returns null if the body is missing, unparseable, or has no id.
 */
export function extractRequestId(body: string | undefined): string | number | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const id = parsed?.id;
    if (typeof id === 'string' || typeof id === 'number') return id;
    return null;
  } catch {
    return null;
  }
}
