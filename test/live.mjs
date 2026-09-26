// Live test against a real server:
//   DISCORD_TOKEN=... GUILD_ID=... [CATEGORY=discordb-test] npm test
import { DiscorDB } from "../dist/index.js";
import assert from "node:assert/strict";

const { DISCORD_TOKEN: token, GUILD_ID: guild, CATEGORY: category = "discordb-test" } = process.env;
if (!token || !guild) throw new Error("Set DISCORD_TOKEN and GUILD_ID");

const db = new DiscorDB({ token, guild, category });
const t0 = Date.now();
const step = (msg) => console.log(`✔ ${msg} (${Date.now() - t0} ms)`);

const pets = db.table("Lib Test Pets");
assert.equal(pets.name, "lib-test-pets");
assert.equal(await pets.count(), 0);
step("missing table reads as empty, no channel created");

const rex = await pets.insert({ name: "Rex", species: "dog", age: 3, tags: ["good", "loud"], owner: { name: "Zoe" } });
assert.match(rex._id, /^\d+$/); assert.ok(rex._createdAt instanceof Date);
await pets.insertMany([
  { name: "Mia", species: "cat", age: 7, tags: ["lazy"] },
  { name: "Kiwi", species: "bird", age: 1 },
  { name: "Tom", species: "cat", age: 12, owner: { name: "Zoe" } },
]);
assert.ok((await db.tables()).includes("lib-test-pets"));
step("insert + insertMany (channel created on the fly)");

assert.equal((await pets.find({ species: "cat" })).length, 2);
assert.deepEqual((await pets.find({ age: { $gte: 3 } }, { sort: "-age" })).map((p) => p.name), ["Tom", "Mia", "Rex"]);
assert.equal((await pets.find({ "owner.name": "Zoe" })).length, 2);
assert.equal((await pets.find({ tags: "lazy" }))[0].name, "Mia");
assert.equal((await pets.find({ $or: [{ species: "bird" }, { age: { $gt: 10 } }] })).length, 2);
assert.equal((await pets.find({ name: /^k/i }))[0].name, "Kiwi");
assert.equal((await pets.find({ owner: { $exists: false } })).length, 2);
assert.deepEqual((await pets.find(undefined, { sort: "name", skip: 1, limit: 2 })).map((p) => p.name), ["Mia", "Rex"]);
assert.equal((await pets.findOne({ species: "dog" }))._id, rex._id);
assert.equal(await pets.count({ species: "cat" }), 2);
step("find: equality, operators, paths, arrays, $or, regex, sort/skip/limit");

const [older] = await pets.update(rex, (p) => ({ age: p.age + 1, tags: undefined }));
assert.equal(older.age, 4); assert.equal("tags" in older, false);
assert.equal((await pets.update({ species: "cat" }, { vaccinated: true })).length, 2);
const kiwi = await pets.upsert({ name: "Kiwi" }, { age: 2 });
const nemo = await pets.upsert({ name: "Nemo" }, { species: "fish", age: 1 });
assert.equal(kiwi.age, 2); assert.equal(nemo.species, "fish"); assert.equal(await pets.count(), 5);
step("update (object, function, key removal), multi-update, upsert");

await pets.refresh();
const fresh = await pets.get(rex._id);
assert.equal(fresh.age, 4); assert.equal(fresh.owner.name, "Zoe");
assert.equal(await pets.count({ vaccinated: true }), 2);
step("refresh: reloaded data matches the cache");

assert.equal(await pets.delete({ species: "cat" }), 2);
assert.equal(await pets.deleteOne(nemo._id), true);
assert.equal(await pets.count(), 2);
assert.equal(await pets.clear(), 2);
step("delete (bulk), deleteOne, clear");

await assert.rejects(pets.insert({ big: "x".repeat(3000) }), /too large/);
step("oversized document rejected");

assert.equal(await pets.drop(), true);
assert.ok(!(await db.tables()).includes("lib-test-pets"));
step("drop");

console.log("\nAll good.");
