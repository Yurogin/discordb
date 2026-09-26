# discordb

Use a Discord server as a tiny NoSQL database. **Channels are tables, messages are JSON documents.**

```js
import { DiscorDB } from "discordb";

const db = new DiscorDB({ token: process.env.DISCORD_TOKEN, guild: "123456789012345678" });
const users = db.table("users");

await users.insert({ username: "zoe", score: 10 });
await users.update({ username: "zoe" }, (u) => ({ score: u.score + 5 }));

const top = await users.find({ score: { $gte: 10 } }, { sort: "-score", limit: 3 });
```

In Discord it looks like this:

```
📁 discordb
   # users        ← table
      ```json
      { "username": "zoe", "score": 15 }   ← document, _id = message id
      ```
```

Zero dependencies, TypeScript types included, Node 18+ (or Bun/Deno). It is a toy: perfect for a side project, a bot's leaderboard or a hackathon, not for data you'd be sad to lose.

## Install

```bash
npm i discordb
```

You need a bot in your server with these permissions: *View Channels, Send Messages, Read Message History, Manage Messages, Manage Channels* (`permissions=76816` in the invite URL). No privileged intent is required.

## Setup

```js
const db = new DiscorDB({
  token: "...",           // or: client (a logged-in discord.js Client)
  guild: "...",           // server id
  category: "discordb",   // category holding the tables: id or name (created if missing). Default "discordb"
});
```

Already have a discord.js bot? Reuse it:

```js
const db = new DiscorDB({ client, guild: interaction.guildId });
```

## Tables

```js
const pets = db.table("pets");      // lazy: the channel is created on the first insert
await db.tables();                  // ["pets", "users"]
await pets.drop();                  // deletes the channel
```

TypeScript:

```ts
interface Pet { name: string; age: number; tags?: string[] }
const pets = db.table<Pet>("pets");
```

## Documents

Every document gets two read-only fields: `_id` (the message id) and `_createdAt` (a `Date`).

```js
const rex = await pets.insert({ name: "Rex", age: 3 });
await pets.insertMany([{ name: "Mia", age: 7 }, { name: "Kiwi", age: 1 }]);

await pets.get(rex._id);
await pets.findOne({ name: "Rex" });
await pets.count({ age: { $lt: 5 } });

await pets.update(rex, { age: 4 });                      // a document, an _id or a filter
await pets.update({ age: { $gt: 5 } }, { senior: true }); // every match
await pets.update(rex, (p) => ({ age: p.age + 1 }));      // computed
await pets.update(rex, { tags: undefined });              // removes the key
await pets.upsert({ name: "Nemo" }, { age: 1 });          // update or insert

await pets.delete({ age: { $gt: 10 } });                  // returns the count
await pets.deleteOne(rex);
await pets.clear();
```

## Queries

```js
pets.find({ species: "cat" })                        // equality
pets.find({ age: { $gte: 2, $lt: 10 } })             // $eq $ne $gt $gte $lt $lte
pets.find({ species: { $in: ["cat", "dog"] } })      // $in $nin
pets.find({ owner: { $exists: true } })              // $exists
pets.find({ name: /^k/i })                           // regex (or { $regex })
pets.find({ "owner.name": "Zoe" })                   // nested paths
pets.find({ tags: "lazy" })                          // matches inside arrays
pets.find({ $or: [{ age: 1 }, { species: "fish" }] }) // $or / $and
pets.find((p) => p.name.length > 3)                  // or any function

pets.find({}, { sort: "-age", skip: 10, limit: 10 }) // sort: "age", "-age" or { age: -1, name: 1 }
```

## How it works (and its limits)

- A table is loaded once (100 messages per request), then served from memory. Writes update the cache. If something else writes to the channel (another process, a human), call `await table.refresh()`.
- Only the bot's own messages are documents: it can read them without the Message Content intent, and Discord doesn't let a bot edit anyone else's messages anyway.
- A document must fit in a message: **2000 characters** of JSON.
- Discord rate limits apply (roughly 5 writes per 5 seconds per channel). Requests are queued and retried automatically, so bulk inserts are slow but safe.
- Deleting is instant for documents younger than 14 days, one by one beyond that.
- This is a creative use of Discord. Keep it to fun projects, and don't store personal or sensitive data.

## License

MIT
