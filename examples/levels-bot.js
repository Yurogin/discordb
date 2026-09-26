// A discord.js bot that gives XP for each message and answers /rank.
// npm i discord.js discordb
import { Client, Events, GatewayIntentBits } from "discord.js";
import { DiscorDB } from "discordb";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const db = new DiscorDB({ client, guild: process.env.GUILD_ID });
const xp = db.table("xp");

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const user = await xp.findOne({ userId: message.author.id });
  if (user) await xp.update(user, (u) => ({ xp: u.xp + 10 }));
  else await xp.insert({ userId: message.author.id, xp: 10 });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "rank") return;
  const top = await xp.find({}, { sort: "-xp", limit: 10 });
  const lines = top.map((u, i) => `${i + 1}. <@${u.userId}> — ${u.xp} XP`);
  await interaction.reply({ content: lines.join("\n") || "Nobody yet!", allowedMentions: { parse: [] } });
});

client.login(process.env.DISCORD_TOKEN);
