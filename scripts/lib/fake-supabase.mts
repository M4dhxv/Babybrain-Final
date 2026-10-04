/**
 * A small in-memory stand-in for the Supabase client, just rich enough to run the Wix Events code paths
 * for real in a test (scripts/validate-wix-events-flow.mts): tables are arrays of rows; the query builder
 * supports the filters those paths use (eq / neq / is / in / not / gt / gte / lt / lte / or), order, limit,
 * select / insert / update / delete, maybeSingle / single and awaiting. It does NOT understand embedded
 * selects or SQL — only what this integration needs. Updates and inserts return the affected rows when
 * `.select()` follows, which is how the order-claim lock reads.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

const cmp = (a: unknown, b: unknown): number => {
  if (a == null || b == null) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

/** `a.is.null,b.lt.2026-01-01` -> predicate (OR of the parts). */
function parseOr(expr: string): Pred {
  const parts = expr.split(/,(?=[a-z_]+\.(?:is|eq|neq|lt|lte|gt|gte|not)\.)/);
  const preds = parts.map((part): Pred => {
    const m = part.match(/^([a-z_]+)\.(not\.)?(is|eq|neq|lt|lte|gt|gte)\.(.*)$/);
    if (!m) throw new Error(`fake-supabase: cannot parse or() part "${part}"`);
    const [, col, neg, op, raw] = m;
    const test: Pred = (r) => {
      const v = r[col];
      switch (op) {
        case 'is': return raw === 'null' ? v == null : String(v) === raw;
        case 'eq': return String(v) === raw;
        case 'neq': return String(v) !== raw;
        case 'lt': return v != null && cmp(v, raw) < 0;
        case 'lte': return v != null && cmp(v, raw) <= 0;
        case 'gt': return v != null && cmp(v, raw) > 0;
        case 'gte': return v != null && cmp(v, raw) >= 0;
        default: return false;
      }
    };
    return neg ? (r) => !test(r) : test;
  });
  return (r) => preds.some((p) => p(r));
}

class Query implements PromiseLike<{ data: unknown; error: null | { message: string }; count?: number | null }> {
  private preds: Pred[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private returning = false;
  private headCount = false;
  private wantCount = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      if (opts?.count) this.wantCount = true;
      if (opts?.head) this.headCount = true;
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this; }

  eq(c: string, v: unknown) { this.preds.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.preds.push((r) => r[c] !== v); return this; }
  is(c: string, v: unknown) { this.preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c: string, vs: unknown[]) { this.preds.push((r) => vs.includes(r[c])); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === 'is') this.preds.push((r) => (v === null ? r[c] != null : r[c] !== v));
    else if (op === 'in') this.preds.push((r) => !String(v).includes(String(r[c])));
    else throw new Error(`fake-supabase: not(${op}) unsupported`);
    return this;
  }
  gt(c: string, v: unknown) { this.preds.push((r) => r[c] != null && cmp(r[c], v) > 0); return this; }
  gte(c: string, v: unknown) { this.preds.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
  lt(c: string, v: unknown) { this.preds.push((r) => r[c] != null && cmp(r[c], v) < 0); return this; }
  lte(c: string, v: unknown) { this.preds.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this; }
  or(expr: string) { this.preds.push(parseOr(expr)); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orderBy.push({ col: c, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }

  private rows() { return this.db.tables.get(this.table) ?? this.db.tables.set(this.table, []).get(this.table)!; }

  private run(): { data: unknown; error: null | { message: string }; count?: number | null } {
    const t = this.rows();
    this.db.log.push(`${this.op} ${this.table}`);
    if (this.op === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const created = incoming.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...(this.db.defaults[this.table] ?? {}), ...r }));
      t.push(...created);
      return { data: this.returning ? created.map((r) => ({ ...r })) : null, error: null };
    }
    const matched = t.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') {
      for (const r of matched) Object.assign(r, this.payload);
      return { data: this.returning ? matched.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === 'delete') {
      this.db.tables.set(this.table, t.filter((r) => !matched.includes(r)));
      return { data: null, error: null };
    }
    let out = matched.map((r) => ({ ...r }));
    for (const o of [...this.orderBy].reverse()) out.sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
    if (this.limitN != null) out = out.slice(0, this.limitN);
    if (this.headCount) return { data: null, error: null, count: matched.length };
    return { data: out, error: null, count: this.wantCount ? matched.length : null };
  }

  maybeSingle() { const r = this.run(); const d = r.data as Row[] | null; return Promise.resolve({ data: Array.isArray(d) ? d[0] ?? null : d, error: null }); }
  single() { return this.maybeSingle(); }
  then<A, B>(ok?: ((v: { data: unknown; error: null | { message: string }; count?: number | null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    try { return Promise.resolve(this.run()).then(ok, bad); } catch (e) { return Promise.reject(e).then(ok, bad); }
  }
}

export class FakeDb {
  tables = new Map<string, Row[]>();
  defaults: Record<string, Row> = {};
  log: string[] = [];
  rpcCalls: { fn: string; args: unknown }[] = [];
  users = new Map<string, { email: string; name: string }>();

  seed(table: string, rows: Row[]) {
    const t = this.tables.get(table) ?? [];
    for (const r of rows) t.push({ id: randomUUID(), ...(this.defaults[table] ?? {}), ...r });
    this.tables.set(table, t);
  }
  all(table: string): Row[] { return this.tables.get(table) ?? []; }
  where(table: string, pred: (r: Row) => boolean): Row[] { return this.all(table).filter(pred); }

  from = (table: string) => new Query(this, table);
  rpc = async (fn: string, args: unknown) => { this.rpcCalls.push({ fn, args }); return { data: null, error: null }; };
  auth = {
    admin: {
      getUserById: async (id: string) => {
        const u = this.users.get(id);
        return { data: { user: u ? { email: u.email, user_metadata: { full_name: u.name } } : null } };
      },
    },
  };
}
