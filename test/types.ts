import { DiscorDB } from "../src/index.js";

interface User { username: string; score: number; role?: "admin" | "member" }

const db = new DiscorDB({ token: "x", guild: "1" });
const users = db.table<User>("users");

async function check() {
  const u = await users.insert({ username: "Zoe", score: 1 });
  const id: string = u._id;
  const d: Date = u._createdAt;
  const s: number = u.score;
  await users.find({ score: { $gte: 10 }, role: "admin" }, { sort: "-score", limit: 10 });
  await users.update(u, (x) => ({ score: x.score + 1 }));
  await users.upsert({ username: "Zoe" }, { score: 5 });
  // @ts-expect-error wrong type
  await users.insert({ username: "Zoe", score: "beaucoup" });
  // @ts-expect-error unknown role
  await users.find({ role: "king" });
  return [id, d, s];
}
check;
