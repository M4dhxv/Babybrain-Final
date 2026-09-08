export const GENERIC_RPC_ERROR = "Something went wrong — please try again or contact support.";

/**
 * Internal database errors that must never be read by a parent. Matching on
 * shape is only the backstop for when `code` is missing (a non-Postgres
 * failure, or an older client shape); the SQLSTATE check below is the real
 * gate.
 */
export const INTERNAL_DB_ERROR = new RegExp(
  [
    'has no field',
    'does not exist',
    'invalid input syntax',
    'violates [a-z-]+ constraint',
    'null value in column',
    'permission denied',
    'out of range',
    '^(record|column|relation|operator|function) ',
  ].join('|'),
  'i',
);

/**
 * Turn an RPC failure into something a parent can act on.
 *
 * Our own `raise exception` messages in PL/pgSQL are written for parents and
 * come back as SQLSTATE P0001, so those are shown as-is. Anything else is the
 * database talking to itself — a dropped column, a failed cast, a constraint
 * — and gets the generic line instead. Checking the code rather than the text
 * is what matters here: a half-applied migration surfaced
 * `record "v_pkg" has no field "activity_id"` on the checkout screen, and it
 * slipped through the old text-only version because that message happens to
 * contain no colon (see 00075_repair_redeem_package_credit.sql).
 *
 * The label-stripping below is kept for the wrapped `label: text` form. It
 * only strips a prefix that looks like a genuine short label, and never
 * surfaces a quoted or oversized remainder — a raw Postgres error can quote
 * the offending value verbatim (seen for real: a Wix slot id sent where a
 * session uuid was expected put "wix:<encoded slot>" on screen, because the
 * naive strip-to-first-colon this used to do stopped at *that* inner colon).
 */
export function cleanRpcErrorMessage(error: { message: string; code?: string | null } | string): string {
  const message = typeof error === "string" ? error : error.message;
  const code = typeof error === "string" ? undefined : error.code ?? undefined;
  if (!message) return GENERIC_RPC_ERROR;

  // P0001 is a plain `raise exception` — i.e. a message we wrote on purpose.
  // Any other SQLSTATE is internal. No code at all (network/transport) falls
  // through to the shape check.
  if (code && code !== "P0001") return GENERIC_RPC_ERROR;
  if (INTERNAL_DB_ERROR.test(message)) return GENERIC_RPC_ERROR;

  const m = message.match(/^([A-Za-z0-9 _.'()-]{1,60}):\s*(.*)$/s);
  if (!m) return message;
  const rest = m[2];
  if (rest.startsWith('"') || rest.length > 200) return GENERIC_RPC_ERROR;
  return rest;
}
