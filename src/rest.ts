const API = "https://discord.com/api/v10";

export class DiscorDBError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: number,
  ) {
    super(message);
    this.name = "DiscorDBError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Rest {
  private queues = new Map<string, Promise<unknown>>();
  private globalUntil = 0;

  constructor(private token: string) {}

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const major = path.match(/^\/(channels|guilds)\/(\d+)/)?.[0] ?? path;
    const key = `${method} ${major}${path.includes("/messages") ? "/messages" : ""}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.send<T>(method, path, body));
    this.queues.set(key, next);
    next.finally(() => this.queues.get(key) === next && this.queues.delete(key)).catch(() => {});
    return next;
  }

  private async send<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const wait = this.globalUntil - Date.now();
    if (wait > 0) await sleep(wait);

    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "User-Agent": "DiscordBot (https://github.com/Yurogin/discorddb, 0.1.0)",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429 && attempt < 5) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
      const ms = (data.retry_after ?? 1) * 1000 + 50;
      if (data.global) this.globalUntil = Date.now() + ms;
      await sleep(ms);
      return this.send(method, path, body, attempt + 1);
    }

    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const resetAfter = Number(res.headers.get("x-ratelimit-reset-after") ?? 0);
      if (resetAfter > 0) await sleep(resetAfter * 1000);
    }

    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = data as { message?: string; code?: number } | null;
      throw new DiscorDBError(
        `Discord API ${method} ${path}: ${err?.message ?? res.statusText} (${res.status})`,
        res.status,
        err?.code,
      );
    }
    return data as T;
  }
}
