const http = require("http");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const config = require("./config");
const { vehicles } = require("./vehicles");
const {
  getUser,
  addMessage,
  addVcSeconds,
  settleVcSession,
  setVcJoin,
  clearVcJoin,
  setVehicleIndex,
  topUsers,
  close: closeDb,
  init: initDb
} = require("./db");
const { profileEmbed, profileFiles, garagePage, topGaragesEmbed } = require("./cards");

if (!config.token) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}
if (!config.clientId) {
  console.error("Missing CLIENT_ID environment variable.");
  process.exit(1);
}

function startHealthServer() {
  const port = Number(process.env.PORT);
  if (!port) return;

  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Vehicle Life is running\n");
      return;
    }
    res.writeHead(404);
    res.end("Not found\n");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });
}

startHealthServer();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

const commands = [
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View your Vehicle Life profile"),
  new SlashCommandBuilder()
    .setName("garage")
    .setDescription("View your complete vehicle collection"),
  new SlashCommandBuilder()
    .setName("viewgarage")
    .setDescription("View another member's vehicle collection")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("The member whose garage you want to view")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("topgarages")
    .setDescription("Refresh the Top Garages leaderboard"),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set the current channel as the Top Garages channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    console.log("Guild slash commands registered.");
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log("Global slash commands registered.");
  }
}

async function checkUnlocks(guild, userId) {
  const user = getUser(userId, guild.id);
  let unlocked = [];
  let index = user.vehicle_index;

  while (index < vehicles.length) {
    const next = vehicles[index];
    const hours = user.vc_seconds / 3600;
    if (hours >= next.vcHours && user.messages >= next.messages) {
      index++;
      unlocked.push(next);
    } else break;
  }

  if (!unlocked.length) return;

  setVehicleIndex(userId, guild.id, index);

  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    const last = unlocked[unlocked.length - 1];
    const channel = guild.systemChannel;
    if (channel) {
      await channel.send(
        `🎉 **NEW VEHICLE UNLOCKED!**\n` +
        `${member} has unlocked **${last.emoji} ${last.name}**!\n` +
        `🏁 Collection: **${index}/${vehicles.length}**`
      ).catch(() => {});
    }
  }
}

async function refreshTopGarages(guild, channel) {
  const rows = topUsers(guild.id, 10);
  await channel.send({ embeds: [topGaragesEmbed(rows, guild)] });
}

/*
 * Discord does not send a fresh voiceStateUpdate for members who were already
 * in voice when the bot restarted. Start a new timing session for them.
 */
function restoreActiveVoiceSessions() {
  let restored = 0;

  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId) continue;

      const member = state.member;
      if (member?.user?.bot) continue;

      const user = getUser(state.id, guild.id);

      if (user.last_vc_join === null || user.last_vc_join === undefined) {
        setVcJoin(state.id, guild.id, Date.now());
        restored++;
      }
    }
  }

  console.log(`Restored ${restored} active VC session(s).`);
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await deployCommands();
    console.log("Vehicle Life is online.");
    restoreActiveVoiceSessions();
  } catch (err) {
    console.error("Slash-command registration failed:", err);
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  addMessage(message.author.id, message.guild.id, 1);
  await checkUnlocks(message.guild, message.author.id);

  if (message.content.startsWith("?warn")) {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return message.reply("❌ You don't have permission to warn members.");
    }

    const target = message.mentions.users.first();

    if (!target) {
      return message.reply("❌ Please mention a user.");
    }

    const reason =
      message.content.split(" ").slice(2).join(" ") || "No reason provided";

    return message.channel.send(
      `⚠️ ${target} has been warned.\nReason: ${reason}`
    );
  }
  if (message.content.startsWith("?unwarn")) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply("❌ You don't have permission to unwarn members.");
  }

  const target = message.mentions.users.first();

  if (!target) {
    return message.reply("❌ Please mention a user.");
  }

  return message.channel.send(
    `✅ ${target} has been unwarned.`
  );
  }
});
// Track the latest profile message for each user so it can refresh automatically.
const activeProfileMessages = new Map();

async function refreshProfileMessage(guildId, userId, channelId, messageId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return false;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;

    const user = getUser(userId, guildId);

    await message.edit({
      embeds: [profileEmbed(member, user)],
      files: profileFiles(user)
    });

    return true;
  } catch (err) {
    console.error("Profile refresh error:", err.message);
    return false;
  }
}

function rememberProfileMessage(guildId, userId, message) {
  activeProfileMessages.set(`${guildId}:${userId}`, {
    guildId,
    userId,
    channelId: message.channelId,
    messageId: message.id
  });
}

async function refreshAllProfiles() {
  for (const [key, info] of activeProfileMessages) {
    const ok = await refreshProfileMessage(
      info.guildId,
      info.userId,
      info.channelId,
      info.messageId
    );

    if (!ok) activeProfileMessages.delete(key);
  }
}

// Refresh profile embeds every minute. This makes the VC timer visibly move
// while a user remains in voice instead of leaving an old 0.2h message on screen.
const profileRefreshTimer = setInterval(refreshAllProfiles, 60_000);
profileRefreshTimer.unref?.();

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    if (!newState.guild) return;

    const userId = newState.id;
    const guildId = newState.guild.id;

    const member = newState.member || oldState.member;
    if (member?.user?.bot) return;

    const joined = !oldState.channelId && !!newState.channelId;
    const left = !!oldState.channelId && !newState.channelId;

    if (joined) {
      const user = getUser(userId, guildId);

      // Never overwrite an already-running session.
      if (user.last_vc_join === null || user.last_vc_join === undefined) {
        setVcJoin(userId, guildId, Date.now());
        console.log(`VC started: ${userId}`);
      }

      return;
    }

    if (left) {
      // settleVcSession calculates the elapsed time from the stored join time
      // and clears it in the same operation. This prevents double-counting.
      settleVcSession(userId, guildId);

      console.log(`VC ended: ${userId}`);

      await checkUnlocks(newState.guild, userId);
    }

    // Moving between VC channels is neither a join nor a leave, so the timer
    // remains untouched.
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.guild) return;

  if (interaction.isButton() && interaction.customId.startsWith("garageview:")) {
    const [, direction, viewerId, targetId, pageText] = interaction.customId.split(":");
    if (interaction.user.id !== viewerId) {
      return interaction.reply({ content: "❌ Only the person who opened this garage can use these buttons.", ephemeral: true });
    }

    const currentPage = Number(pageText) || 0;
    const nextPage = direction === "next" ? currentPage + 1 : currentPage - 1;
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: "❌ That member is no longer in this server.", ephemeral: true });
    }

    const targetUser = getUser(targetId, interaction.guild.id);
    const page = garagePage(targetMember, targetUser, nextPage);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`garageview:prev:${viewerId}:${targetId}:${page.page}`)
        .setLabel("Previous")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page.page <= 0),
      new ButtonBuilder()
        .setCustomId(`garageview:next:${viewerId}:${targetId}:${page.page}`)
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page.page >= page.pageCount - 1)
    );

    return interaction.update({ embeds: page.embeds, files: page.files, components: [row] });
  }

  if (interaction.isButton() && interaction.customId.startsWith("garage:")) {
    const [, direction, ownerId, pageText] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ Only the person who opened this garage can use these buttons.", ephemeral: true });
    }

    const currentPage = Number(pageText) || 0;
    const nextPage = direction === "next" ? currentPage + 1 : currentPage - 1;
    const freshUser = getUser(interaction.user.id, interaction.guild.id);
    const page = garagePage(interaction.member, freshUser, nextPage);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`garage:prev:${ownerId}:${page.page}`)
        .setLabel("Previous")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page.page <= 0),
      new ButtonBuilder()
        .setCustomId(`garage:next:${ownerId}:${page.page}`)
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page.page >= page.pageCount - 1)
    );

    return interaction.update({ embeds: page.embeds, files: page.files, components: [row] });
  }

  if (!interaction.isChatInputCommand()) return;

  // Acknowledge the slash command immediately so Discord does not time out.
  await interaction.deferReply();

  const user = getUser(interaction.user.id, interaction.guild.id);

  if (interaction.commandName === "profile") {
    await interaction.editReply({
      embeds: [profileEmbed(interaction.member, user)],
      files: profileFiles(user)
    });

    const profileMessage = await interaction.fetchReply().catch(() => null);
    if (profileMessage) {
      rememberProfileMessage(
        interaction.guild.id,
        interaction.user.id,
        profileMessage
      );
    }

    return;
  }

  if (interaction.commandName === "garage") {
    const page = garagePage(interaction.member, user, 0);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`garage:prev:${interaction.user.id}:0`)
        .setLabel("Previous")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page.page <= 0),
      new ButtonBuilder()
        .setCustomId(`garage:next:${interaction.user.id}:0`)
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page.page >= page.pageCount - 1)
    );

    return interaction.editReply({
      embeds: page.embeds,
      files: page.files,
      components: [row]
    });
  }

  if (interaction.commandName === "viewgarage") {
    const targetUser = interaction.options.getUser("user", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) {
      return interaction.editReply({ content: "❌ That user is not a member of this server.", ephemeral: true });
    }

    const targetData = getUser(targetUser.id, interaction.guild.id);
    const page = garagePage(targetMember, targetData, 0);
    const viewerId = interaction.user.id;
    const targetId = targetUser.id;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`garageview:prev:${viewerId}:${targetId}:0`)
        .setLabel("Previous")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page.page <= 0),
      new ButtonBuilder()
        .setCustomId(`garageview:next:${viewerId}:${targetId}:0`)
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page.page >= page.pageCount - 1)
    );

    return interaction.editReply({
      embeds: page.embeds,
      files: page.files,
      components: [row]
    });
  }

  if (interaction.commandName === "topgarages") {
    return interaction.editReply({ embeds: [topGaragesEmbed(topUsers(interaction.guild.id, 10), interaction.guild)] });
  }

  if (interaction.commandName === "setup") {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply({ content: "❌ You need Manage Server permission.", ephemeral: true });
    }
    if (interaction.channel.type !== ChannelType.GuildText) {
      return interaction.editReply({ content: "❌ Run this command inside a text channel.", ephemeral: true });
    }
    return interaction.editReply({
      content:
        `✅ **Top Garages channel configured!**\n` +
        `Use \`/topgarages\` here to publish the leaderboard.\n\n` +
        `For automatic updates, put this channel ID in \`TOP_GARAGES_CHANNEL_ID\` in your .env.`
    });
  }
});

async function start() {
  try {
    await initDb();
    await client.login(config.token);
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();

process.on("unhandledRejection", err => console.error("Unhandled promise rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught exception:", err));

async function shutdown(signal) {
  console.log(`${signal} received. Saving data and shutting down...`);
  try { await closeDb(); } catch (err) { console.error("Database shutdown error:", err.message); }
  try { client.destroy(); } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
