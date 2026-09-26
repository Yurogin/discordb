import { type Filter, matches, type Sort, sorter } from "./filter.js";
import { DiscorDBError, Rest } from "./rest.js";

const TEXT_CHANNEL = 0;
const CATEGORY = 4;
const MESSAGE_LIMIT = 2000;
const DISCORD_EPOCH = 1420070400000n;
const BULK_DELETE_MAX_AGE = 14 * 24 * 60 * 60 * 1000 - 60_000;

type Channel = { id: string; name: string; type: number; parent_id: string | null };
type Message = { id: string; content: string; type: number; author: { id: string } };

export type Data = Record<string, unknown>;

export type Doc<T extends object = Data> = T & { readonly _id: string; readonly _createdAt: Date };

export type FindOptions<T> = { sort?: Sort<T>; limit?: number; skip?: number };

export type Changes<T extends object> = Partial<T> | ((doc: Doc<T>) => Partial<T>);

export interface DiscorDBOptions {
  token?: string;
  client?: { token: string | null };
  guild: string;
  category?: string;
}

export function timestampOf(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

export function tableName(name: string): string {
  const normalized = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  if (!normalized) throw new DiscorDBError(`Invalid table name "${name}"`);
  return normalized;
}

function parse(content: string): Data | null {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    const value = JSON.parse(fenced ? fenced[1] : content);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function serialize(doc: Data): string {
  const { _id, _createdAt, ...data } = doc;
  const pretty = "```json\n" + JSON.stringify(data, null, 2) + "\n```";
  if (pretty.length <= MESSAGE_LIMIT) return pretty;
  const compact = JSON.stringify(data);
  if (compact.length <= MESSAGE_LIMIT) return compact;
  throw new DiscorDBError(`Document too large: ${compact.length}/${MESSAGE_LIMIT} characters once serialized`);
}

export class DiscorDB {
  readonly rest: Rest;
  readonly guildId: string;
  private categoryOption: string;
  private tablesCache = new Map<string, Table<any>>();
  private channels?: Promise<{ category: Channel; tables: Map<string, Channel> }>;
  private creating = new Map<string, Promise<Channel>>();
  private me?: Promise<string>;

  constructor(options: DiscorDBOptions) {
    const token = options.token ?? options.client?.token;
    if (!token) throw new DiscorDBError("A bot token (or a logged-in client) is required");
    if (!options.guild) throw new DiscorDBError("A guild id is required");
    this.rest = new Rest(token);
    this.guildId = options.guild;
    this.categoryOption = options.category ?? "discordb";
  }

  table<T extends object = Data>(name: string): Table<T> {
    const key = tableName(name);
    let table = this.tablesCache.get(key);
    if (!table) this.tablesCache.set(key, (table = new Table<T>(this, key)));
    return table as Table<T>;
  }

  async tables(): Promise<string[]> {
    const { tables } = await this.loadChannels(true);
    return [...tables.keys()];
  }

  async drop(name: string): Promise<boolean> {
    const key = tableName(name);
    const channel = (await this.loadChannels()).tables.get(key);
    this.tablesCache.get(key)?.reset();
    if (!channel) return false;
    await this.rest.request("DELETE", `/channels/${channel.id}`);
    (await this.loadChannels()).tables.delete(key);
    return true;
  }

  botId(): Promise<string> {
    this.me ??= this.rest.request<{ id: string }>("GET", "/users/@me").then((u) => u.id);
    return this.me;
  }

  async channel(name: string, create: boolean): Promise<Channel | null> {
    const { category, tables } = await this.loadChannels();
    const existing = tables.get(name);
    if (existing || !create) return existing ?? null;
    let pending = this.creating.get(name);
    if (!pending) {
      pending = this.rest.request<Channel>("POST", `/guilds/${this.guildId}/channels`, {
        name,
        type: TEXT_CHANNEL,
        parent_id: category.id,
      });
      this.creating.set(name, pending);
      pending.then((c) => tables.set(name, c)).finally(() => this.creating.delete(name)).catch(() => {});
    }
    return pending;
  }

  private loadChannels(force = false) {
    if (!this.channels || force) {
      this.channels = (async () => {
        const all = await this.rest.request<Channel[]>("GET", `/guilds/${this.guildId}/channels`);
        const wanted = this.categoryOption;
        let category =
          all.find((c) => c.type === CATEGORY && c.id === wanted) ??
          all.find((c) => c.type === CATEGORY && c.name.toLowerCase() === wanted.toLowerCase());
        if (!category) {
          if (/^\d{17,20}$/.test(wanted)) throw new DiscorDBError(`Category ${wanted} not found in guild ${this.guildId}`);
          category = await this.rest.request<Channel>("POST", `/guilds/${this.guildId}/channels`, { name: wanted, type: CATEGORY });
        }
        const tables = new Map(
          all.filter((c) => c.type === TEXT_CHANNEL && c.parent_id === category.id).map((c) => [c.name, c] as const),
        );
        return { category, tables };
      })();
      this.channels.catch(() => (this.channels = undefined));
    }
    return this.channels;
  }
}

export class Table<T extends object = Data> {
  private rows?: Promise<Map<string, Doc<T>>>;

  constructor(
    private db: DiscorDB,
    readonly name: string,
  ) {}

  async find(filter?: Filter<Doc<T>>, options: FindOptions<Doc<T>> = {}): Promise<Doc<T>[]> {
    let docs = [...(await this.load()).values()].filter((d) => matches(d, filter));
    if (options.sort) docs.sort(sorter(options.sort));
    const start = options.skip ?? 0;
    return docs.slice(start, options.limit === undefined ? undefined : start + options.limit).map((d) => ({ ...d }));
  }

  async findOne(filter?: Filter<Doc<T>>, options: Omit<FindOptions<Doc<T>>, "limit"> = {}): Promise<Doc<T> | null> {
    return (await this.find(filter, { ...options, limit: 1 }))[0] ?? null;
  }

  async get(id: string): Promise<Doc<T> | null> {
    const doc = (await this.load()).get(id);
    return doc ? { ...doc } : null;
  }

  async count(filter?: Filter<Doc<T>>): Promise<number> {
    return filter ? (await this.find(filter)).length : (await this.load()).size;
  }

  async insert(data: T): Promise<Doc<T>> {
    const content = serialize(data as Data);
    const channel = (await this.db.channel(this.name, true))!;
    const rows = await this.load();
    const message = await this.db.rest.request<Message>("POST", `/channels/${channel.id}/messages`, {
      content,
      allowed_mentions: { parse: [] },
    });
    const doc = this.toDoc(message.id, parse(message.content) as T);
    rows.set(doc._id, doc);
    return doc;
  }

  async insertMany(items: T[]): Promise<Doc<T>[]> {
    const out: Doc<T>[] = [];
    for (const item of items) out.push(await this.insert(item));
    return out;
  }

  async update(target: Target<T>, changes: Changes<T>): Promise<Doc<T>[]> {
    const docs = await this.resolve(target);
    const channel = await this.db.channel(this.name, false);
    const out: Doc<T>[] = [];
    for (const doc of docs) {
      const patch = typeof changes === "function" ? changes(doc) : changes;
      const next: Data = { ...doc, ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      const message = await this.db.rest.request<Message>("PATCH", `/channels/${channel!.id}/messages/${doc._id}`, {
        content: serialize(next),
        allowed_mentions: { parse: [] },
      });
      const updated = this.toDoc(message.id, parse(message.content) as T);
      (await this.load()).set(updated._id, updated);
      out.push(updated);
    }
    return out;
  }

  async updateOne(target: Target<T>, changes: Changes<T>): Promise<Doc<T> | null> {
    const [doc] = await this.resolve(target, 1);
    return doc ? (await this.update(doc, changes))[0] : null;
  }

  async upsert(filter: Partial<T>, changes: Partial<T>): Promise<Doc<T>> {
    return (await this.updateOne(filter as Target<T>, changes)) ?? this.insert({ ...filter, ...changes } as T);
  }

  async delete(target: Target<T>): Promise<number> {
    const docs = await this.resolve(target);
    if (docs.length === 0) return 0;
    const channel = (await this.db.channel(this.name, false))!;
    const rows = await this.load();
    const limit = Date.now() - BULK_DELETE_MAX_AGE;
    const recent = docs.filter((d) => d._createdAt.getTime() > limit).map((d) => d._id);
    const old = docs.filter((d) => d._createdAt.getTime() <= limit).map((d) => d._id);

    for (let i = 0; i < recent.length; i += 100) {
      const chunk = recent.slice(i, i + 100);
      if (chunk.length === 1) old.push(chunk[0]);
      else await this.db.rest.request("POST", `/channels/${channel.id}/messages/bulk-delete`, { messages: chunk });
      if (chunk.length > 1) chunk.forEach((id) => rows.delete(id));
    }
    for (const id of old) {
      await this.db.rest.request("DELETE", `/channels/${channel.id}/messages/${id}`);
      rows.delete(id);
    }
    return docs.length;
  }

  async deleteOne(target: Target<T>): Promise<boolean> {
    const [doc] = await this.resolve(target, 1);
    return doc ? (await this.delete(doc)) === 1 : false;
  }

  async clear(): Promise<number> {
    return this.delete(() => true);
  }

  drop(): Promise<boolean> {
    return this.db.drop(this.name);
  }

  async refresh(): Promise<void> {
    this.reset();
    await this.load();
  }

  reset() {
    this.rows = undefined;
  }

  private toDoc(id: string, data: T): Doc<T> {
    return Object.assign({ _id: id, _createdAt: timestampOf(id) }, data) as Doc<T>;
  }

  private async resolve(target: Target<T>, limit?: number): Promise<Doc<T>[]> {
    if (typeof target === "string") {
      const doc = await this.get(target);
      return doc ? [doc] : [];
    }
    if (target && typeof target === "object" && "_id" in target && typeof target._id === "string") {
      const doc = await this.get(target._id);
      return doc ? [doc] : [];
    }
    return this.find(target as Filter<Doc<T>>, { limit });
  }

  private load(): Promise<Map<string, Doc<T>>> {
    this.rows ??= (async () => {
      const rows = new Map<string, Doc<T>>();
      const channel = await this.db.channel(this.name, false);
      if (!channel) return rows;
      const botId = await this.db.botId();
      const messages: Message[] = [];
      let before: string | undefined;
      for (;;) {
        const qs = before ? `?limit=100&before=${before}` : "?limit=100";
        const batch = await this.db.rest.request<Message[]>("GET", `/channels/${channel.id}/messages${qs}`);
        messages.push(...batch);
        if (batch.length < 100) break;
        before = batch[batch.length - 1].id;
      }
      for (const m of messages.reverse()) {
        // Only the bot's own messages: readable without the Message Content intent.
        if (m.author.id !== botId) continue;
        const data = parse(m.content);
        if (data) rows.set(m.id, this.toDoc(m.id, data as T));
      }
      return rows;
    })();
    this.rows.catch(() => this.reset());
    return this.rows;
  }
}

export type Target<T extends object> = string | { _id: string } | Filter<Doc<T>>;
