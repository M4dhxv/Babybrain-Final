/**
 * Tolerant SUPABASE_DB_URL parsing.
 *
 * .env.example asks for a url-encoded password, but a Supabase-generated
 * password containing `/`, `*` or `#` pasted in raw parses as a malformed URL
 * and `postgres(url)` throws `ERR_INVALID_URL` before it ever connects. That
 * turns every db script into an unrelated-looking crash, and makes applying a
 * migration by hand in the dashboard the path of least resistance — which is
 * how 00068 came to be half-applied (see
 * supabase/migrations/00075_repair_redeem_package_credit.sql).
 *
 * Splitting on the *last* `@` and the *first* `:` of the credentials is what
 * makes an unencoded password work: neither character is ambiguous at those
 * positions.
 */
export function parseDbUrl(url) {
  if (!url) throw new Error('SUPABASE_DB_URL is not set — add it to .env.local');

  const raw = url.replace(/^postgres(ql)?:\/\//, '');
  const at = raw.lastIndexOf('@');
  if (at === -1) throw new Error('SUPABASE_DB_URL has no credentials (expected user:password@host)');

  const creds = raw.slice(0, at);
  const colon = creds.indexOf(':');
  if (colon === -1) throw new Error('SUPABASE_DB_URL has no password (expected user:password@host)');

  const [hostPort, database = 'postgres'] = raw.slice(at + 1).split('/');
  const [host, port = '5432'] = hostPort.split(':');

  return {
    host,
    port: Number(port),
    // Already-encoded passwords stay correct: decodeURIComponent is a no-op on
    // a password with nothing to decode, and undoes the encoding on one that
    // followed .env.example.
    username: decodeURIComponent(creds.slice(0, colon)),
    password: safeDecode(creds.slice(colon + 1)),
    database: database.split('?')[0] || 'postgres',
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    // A raw password containing a stray `%` is not valid percent-encoding —
    // take it literally rather than failing the connection.
    return value;
  }
}
