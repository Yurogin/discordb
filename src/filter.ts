export type Operators<V> = {
  $eq?: V;
  $ne?: V;
  $gt?: V;
  $gte?: V;
  $lt?: V;
  $lte?: V;
  $in?: V[];
  $nin?: V[];
  $exists?: boolean;
  $regex?: RegExp | string;
};

type Condition<V> = V | RegExp | Operators<V>;

/**
 * Mongo-like query: `{ role: "admin", score: { $gte: 100 }, "stats.level": 3 }`,
 * `{ $or: [...] }`, or a plain predicate function.
 */
export type Filter<T> =
  | ((doc: T) => boolean)
  | ({ [K in keyof T]?: Condition<T[K]> } & {
      [path: string]: unknown;
      $or?: Filter<T>[];
      $and?: Filter<T>[];
    });

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "object" && typeof b === "object" && a && b) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function compare(a: unknown, b: unknown): number | null {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function isOperators(v: unknown): v is Operators<unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).some((k) => k.startsWith("$"));
}

function matchCondition(value: unknown, cond: unknown): boolean {
  if (cond instanceof RegExp) return typeof value === "string" && cond.test(value);
  if (!isOperators(cond)) return Array.isArray(value) && !Array.isArray(cond) ? value.some((v) => equals(v, cond)) : equals(value, cond);

  for (const [op, arg] of Object.entries(cond)) {
    const c = compare(value, arg);
    switch (op) {
      case "$eq": if (!equals(value, arg)) return false; break;
      case "$ne": if (equals(value, arg)) return false; break;
      case "$gt": if (c === null || c <= 0) return false; break;
      case "$gte": if (c === null || c < 0) return false; break;
      case "$lt": if (c === null || c >= 0) return false; break;
      case "$lte": if (c === null || c > 0) return false; break;
      case "$in": if (!(arg as unknown[]).some((a) => equals(value, a))) return false; break;
      case "$nin": if ((arg as unknown[]).some((a) => equals(value, a))) return false; break;
      case "$exists": if ((value !== undefined) !== arg) return false; break;
      case "$regex": {
        const re = arg instanceof RegExp ? arg : new RegExp(String(arg));
        if (typeof value !== "string" || !re.test(value)) return false;
        break;
      }
      default:
        throw new Error(`Unknown operator ${op}`);
    }
  }
  return true;
}

export function matches<T>(doc: T, filter?: Filter<T>): boolean {
  if (!filter) return true;
  if (typeof filter === "function") return filter(doc);
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(cond as Filter<T>[]).some((f) => matches(doc, f))) return false;
    } else if (key === "$and") {
      if (!(cond as Filter<T>[]).every((f) => matches(doc, f))) return false;
    } else if (!matchCondition(getPath(doc, key), cond)) {
      return false;
    }
  }
  return true;
}

export type Sort<T> = keyof T | `-${string & keyof T}` | string | { [path: string]: 1 | -1 };

/** `"score"`, `"-score"` or `{ score: -1, username: 1 }`. */
export function sorter<T>(sort: Sort<T>): (a: T, b: T) => number {
  const entries: [string, number][] =
    typeof sort === "object"
      ? Object.entries(sort as Record<string, number>)
      : [String(sort).startsWith("-") ? [String(sort).slice(1), -1] : [String(sort), 1]];
  return (a, b) => {
    for (const [path, dir] of entries) {
      const va = getPath(a, path);
      const vb = getPath(b, path);
      if (va === vb) continue;
      if (va === undefined || va === null) return 1;
      if (vb === undefined || vb === null) return -1;
      const c = compare(va, vb) ?? String(va).localeCompare(String(vb));
      if (c !== 0) return c * dir;
    }
    return 0;
  };
}
