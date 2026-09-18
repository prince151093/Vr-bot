/* Vehicle Life - Discord connection diagnostics enabled */
const giveawayCommand = require("./src/commands/giveaway");
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
  ButtonStyle,
  EmbedBuilder
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
  setInstagram,
  removeInstagram,
  close: closeDb,
  init: initDb
} = require("./db");

const {
  profileEmbed,
  profileFiles,
  garagePage,
  topGaragesEmbed
} = require("./cards");

/* =========================
   CONFIG CHECK
========================= */

if (!config.token) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}
if (!config.clientId) {
  console.error("Missing CLIENT_ID environment variable.");
  process.exit(1);
}

/* =========================
   HEALTH SERVER
========================= */

function startHealthServer() {
  const port = Number(process.env.PORT);

  if (!port) return;

  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });

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

/* =========================
   DISCORD CLIENT
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel
  ]
});

/* =========================
   DISCORD DIAGNOSTICS
========================= */

client.on("error", error => {
  console.error("DISCORD CLIENT ERROR:", error);
});

client.on("warn", warning => {
  console.warn("DISCORD CLIENT WARNING:", warning);
});

client.on("debug", message => {
  // discord.js debug output can contain the bot token during login.
  // Never log authentication tokens or token-bearing debug messages.
  const msg = String(message);
  if (/token|authorization|authenticate/i.test(msg)) return;
  console.log("DISCORD DEBUG:", msg);
});

// Gateway lifecycle diagnostics
client.on("shardReady", (id, unavailableGuilds) => {
  console.log(
    `DISCORD SHARD READY: shard=${id} unavailableGuilds=${unavailableGuilds ? unavailableGuilds.size : 0}`
  );
});

client.on("shardReconnecting", id => {
  console.log(`DISCORD SHARD RECONNECTING: shard=${id}`);
});

client.on("shardDisconnect", (closeEvent, id) => {
  console.error(
    `DISCORD SHARD DISCONNECT: shard=${id} code=${closeEvent?.code ?? "unknown"} reason=${closeEvent?.reason || "unknown"}`
  );
});

client.on("shardResume", (id, replayedEvents) => {
  console.log(
    `DISCORD SHARD RESUMED: shard=${id} replayedEvents=${replayedEvents}`
  );
});

client.on("invalidated", () => {
  console.error("DISCORD SESSION INVALIDATED: Discord invalidated the gateway session.");
});

/* =========================
   SLASH COMMANDS
========================= */

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
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

  giveawayCommand.data

].map(command => command.toJSON());

/* =========================
   DEPLOY COMMANDS
========================= */

async function deployCommands() {
  const rest = new REST({
    version: "10"
  }).setToken(config.token);

  if (config.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(
        config.clientId,
        config.guildId
      ),
      {
        body: commands
      }
    );

    console.log("Guild slash commands registered.");
  } else {
    await rest.put(
      Routes.applicationCommands(config.clientId),
      {
        body: commands
      }
    );

    console.log("Global slash commands registered.");
  }
}

/* =========================
   VEHICLE UNLOCK SYSTEM
========================= */

async function checkUnlocks(guild, userId) {
  const user = getUser(
    userId,
    guild.id
  );

  let unlocked = [];
  let index = user.vehicle_index;

  while (index < vehicles.length) {
    const next = vehicles[index];

    const hours =
      user.vc_seconds / 3600;

    if (
      hours >= next.vcHours &&
      user.messages >= next.messages
    ) {
      index++;
      unlocked.push(next);
    } else {
      break;
    }
  }

  if (!unlocked.length) {
    return;
  }

  setVehicleIndex(
    userId,
    guild.id,
    index
  );

  const member =
    await guild.members
      .fetch(userId)
      .catch(() => null);

  if (!member) {
    return;
  }

  const last =
    unlocked[unlocked.length - 1];

  const channel =
    guild.systemChannel;

  if (channel) {
    await channel.send(
      `🎉 **NEW VEHICLE UNLOCKED!**\n` +
      `${member} has unlocked **${last.emoji} ${last.name}**!\n` +
      `🏁 Collection: **${index}/${vehicles.length}**`
    ).catch(() => {});
  }
}

/* =========================
   RESTORE VC SESSIONS
========================= */

function restoreActiveVoiceSessions() {
  let restored = 0;

  for (
    const guild of client.guilds.cache.values()
  ) {
    for (
      const state of guild.voiceStates.cache.values()
    ) {
      if (!state.channelId) {
        continue;
      }

      const member = state.member;

      if (member?.user?.bot) {
        continue;
      }

      const user = getUser(
        state.id,
        guild.id
      );

      if (
        user.last_vc_join === null ||
        user.last_vc_join === undefined
      ) {
        setVcJoin(
          state.id,
          guild.id,
          Date.now()
        );

        restored++;
      }
    }
  }

  console.log(
    `Restored ${restored} active VC session(s).`
  );
}

/* =========================
   BOT READY
========================= */

client.once("clientReady", async () => {
  console.log(
    `DISCORD READY: Logged in as ${client.user.tag}`
  );
  console.log(
    `DISCORD READY DETAILS: userId=${client.user.id} guilds=${client.guilds.cache.size}`
  );

  try {
    await deployCommands();

    console.log(
      "Vehicle Life is online."
    );

    restoreActiveVoiceSessions();

  } catch (err) {
    console.error(
      "Slash-command registration failed:",
      err
    );
  }
});

/* =========================
   MESSAGE COMMANDS
========================= */

client.on(
  "messageCreate",
  async message => {

    if (
      !message.guild ||
      message.author.bot
    ) {
      return;
    }

    /* =========================
       MESSAGE TRACKING
    ========================= */

    addMessage(
      message.author.id,
      message.guild.id,
      1
    );

    await checkUnlocks(
      message.guild,
      message.author.id
    );

    /* =========================
       PURGE COMMAND
       ?purge 10
    ========================= */

    if (
      message.content
        .toLowerCase()
        .startsWith("?purge")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ManageMessages
        )
      ) {
        return message.reply(
          "❌ You don't have permission to delete messages."
        );
      }

      const args =
        message.content.trim().split(/\s+/);

      const amount =
        parseInt(args[1], 10);

      if (
        Number.isNaN(amount) ||
        amount < 1 ||
        amount > 100
      ) {
        return message.reply(
          "❌ Usage: `?purge <1-100>`"
        );
      }

      try {

        const deleted =
          await message.channel.bulkDelete(
            amount,
            true
          );

        await message.delete()
          .catch(() => {});

        const confirmation =
          await message.channel.send(
            `🧹 Successfully deleted **${deleted.size}** messages.`
          );

        setTimeout(() => {
          confirmation
            .delete()
            .catch(() => {});
        }, 3000);

      } catch (err) {

        console.error(
          "Purge error:",
          err
        );

        return message.channel.send(
          "❌ I couldn't delete those messages. Make sure I have **Manage Messages** permission and the messages are eligible for bulk deletion."
        );
      }

      return;
    }

    /* =========================
       WARN
    ========================= */

    if (
      message.content.startsWith("?warn")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ModerateMembers
        )
      ) {
        return message.reply(
          "❌ You don't have permission to warn members."
        );
      }

      const target =
        message.mentions.users.first();

      if (!target) {
        return message.reply(
          "❌ Please mention a user."
        );
      }

      const reason =
        message.content
          .split(" ")
          .slice(2)
          .join(" ") ||
        "No reason provided";

      return message.channel.send(
        `⚠️ ${target} has been warned.\nReason: ${reason}`
      );
    }

    /* =========================
       UNWARN
    ========================= */

    if (
      message.content.startsWith("?unwarn")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ModerateMembers
        )
      ) {
        return message.reply(
          "❌ You don't have permission to unwarn members."
        );
      }

      const target =
        message.mentions.users.first();

      if (!target) {
        return message.reply(
          "❌ Please mention a user."
        );
      }

      return message.channel.send(
        `✅ ${target} has been unwarned.`
      );
    }

    /* =========================
       SET NICKNAME
    ========================= */

    if (
      message.content.startsWith("?setnick")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ManageNicknames
        )
      ) {
        return message.reply(
          "❌ You don't have permission to change nicknames."
        );
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message.reply(
          "❌ Please mention the user."
        );
      }

      const nickname =
        message.content
          .split(" ")
          .slice(2)
          .join(" ");

      if (!nickname) {
        return message.reply(
          "❌ Please provide a nickname."
        );
      }

      try {

        await target.setNickname(
          nickname
        );

        return message.channel.send(
          `✅ Changed ${target}'s nickname to **${nickname}**`
        );

      } catch (err) {

        return message.reply(
          "❌ I can't change that user's nickname. Check my role position and permissions."
        );
      }
    }

    /* =========================
       ROLE COMMANDS
    ========================= */

    if (message.content.startsWith("?giverole")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("❌ You don't have permission to manage roles.");
      }

      const target = message.mentions.members.first();
      const role = message.mentions.roles.first();

      if (!target) {
        return message.reply("❌ Please mention the user.");
      }

      if (!role) {
        return message.reply("❌ Please mention the role.");
      }

      if (role.managed) {
        return message.reply("❌ I can't manage this role.");
      }

      if (role.position >= message.guild.members.me.roles.highest.position) {
        return message.reply("❌ I can't manage this role because it is above or equal to my highest role.");
      }

      try {
        await target.roles.add(role);

        return message.channel.send(
          `✅ Added ${role} to ${target}.`
        );
      } catch (err) {
        console.error("Give role error:", err);

        return message.reply(
          "❌ I couldn't give that role. Check my permissions and role position."
        );
      }
    }

    if (message.content.startsWith("?removerole")) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("❌ You don't have permission to manage roles.");
      }

      const target = message.mentions.members.first();
      const role = message.mentions.roles.first();

      if (!target) {
        return message.reply("❌ Please mention the user.");
      }

      if (!role) {
        return message.reply("❌ Please mention the role.");
      }

      if (role.managed) {
        return message.reply("❌ I can't manage this role.");
      }

      if (role.position >= message.guild.members.me.roles.highest.position) {
        return message.reply("❌ I can't manage this role because it is above or equal to my highest role.");
      }

      try {
        await target.roles.remove(role);

        return message.channel.send(
          `✅ Removed ${role} from ${target}.`
        );
      } catch (err) {
        console.error("Remove role error:", err);

        return message.reply(
          "❌ I couldn't remove that role. Check my permissions and role position."
        );
      }
    }

    /* =========================
       MUTE
    ========================= */

    if (
      message.content.startsWith("?mute")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ModerateMembers
        )
      ) {
        return message.reply(
          "❌ You don't have permission to mute members."
        );
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message.reply(
          "❌ Please mention a user."
        );
      }

      const duration =
        message.content
          .split(" ")[2];

      if (!duration) {
        return message.reply(
          "❌ Please provide a duration (60s, 5m, 4h, 2d)."
        );
      }

      let ms = 0;

      if (duration.endsWith("s")) {
        ms =
          parseInt(duration) *
          1000;

      } else if (duration.endsWith("m")) {
        ms =
          parseInt(duration) *
          60 *
          1000;

      } else if (duration.endsWith("h")) {
        ms =
          parseInt(duration) *
          60 *
          60 *
          1000;

      } else if (duration.endsWith("d")) {
        ms =
          parseInt(duration) *
          24 *
          60 *
          60 *
          1000;

      } else {

        return message.reply(
          "❌ Invalid duration. Use s, m, h, or d."
        );
      }

      if (!Number.isFinite(ms) || ms <= 0) {
        return message.reply(
          "❌ Invalid duration."
        );
      }

      try {

        await target.timeout(ms);

        return message.channel.send(
          `🔇 ${target} has been muted for ${duration}.`
        );

      } catch (err) {

        return message.reply(
          "❌ I can't mute that user. Check my permissions and role position."
        );
      }
    }

    /* =========================
       UNMUTE
    ========================= */

    if (
      message.content.startsWith("?unmute")
    ) {

      if (
        !message.member.permissions.has(
          PermissionFlagsBits.ModerateMembers
        )
      ) {
        return message.reply(
          "❌ You don't have permission to unmute members."
        );
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message.reply(
          "❌ Please mention a user."
        );
      }

      if (
        !target.isCommunicationDisabled()
      ) {
        return message.reply(
          "❌ That user is not muted."
        );
      }

      try {

        await target.timeout(null);

        return message.channel.send(
          `🔊 ${target} has been unmuted.`
        );

      } catch (err) {

        return message.reply(
          "❌ I can't unmute that user."
        );
      }
    }

    /* =========================
       ADD INSTAGRAM
    ========================= */

    if (
      message.content.startsWith("?addinsta")
    ) {

      const username =
        message.content
          .split(" ")[1];

      if (!username) {
        return message.reply(
          "❌ Please provide an Instagram username."
        );
      }

      setInstagram(
        message.author.id,
        message.guild.id,
        username
      );

      const role =
        message.guild.roles.cache.find(
          r =>
            r.name === "Instagram user"
        );

      if (role) {
        await message.member.roles
          .add(role)
          .catch(err =>
            console.error(
              "Instagram role add error:",
              err
            )
          );
      }

      return message.reply(
        `✅ Instagram username set to ${username}`
      );
    }

    /* =========================
       REMOVE INSTAGRAM
    ========================= */

    if (
      message.content.startsWith("?removeinsta")
    ) {

      removeInstagram(
        message.author.id,
        message.guild.id
      );

      const role =
        message.guild.roles.cache.find(
          r =>
            r.name === "Instagram user"
        );

      if (!role) {
        return message.reply(
          "❌ Role 'Instagram user' not found."
        );
      }

      try {

        await message.member.roles
          .remove(role);

      } catch (err) {

        console.error(err);

        return message.reply(
          `❌ Role error: ${err.message}`
        );
      }

      return message.reply(
        "✅ Instagram username removed."
      );
    }

    /* =========================
       VIEW INSTAGRAM
    ========================= */

    if (
      message.content.startsWith("?insta")
    ) {

      const target =
        message.mentions.users.first() ||
        message.author;

      const user =
        getUser(
          target.id,
          message.guild.id
        );

      if (!user.instagram) {
        return message.reply(
          "❌ No Instagram username set."
        );
      }

      return message.channel.send(
        `📸 ${target.username}'s Instagram:\nhttps://instagram.com/${user.instagram}`
      );
    }
  }
);

/* =========================
   PROFILE MESSAGE TRACKING
========================= */

const activeProfileMessages =
  new Map();

async function refreshProfileMessage(
  guildId,
  userId,
  channelId,
  messageId
) {

  try {

    const guild =
      client.guilds.cache.get(
        guildId
      );

    if (!guild) {
      return false;
    }

    const channel =
      await guild.channels
        .fetch(channelId)
        .catch(() => null);

    if (
      !channel ||
      !channel.isTextBased()
    ) {
      return false;
    }

    const message =
      await channel.messages
        .fetch(messageId)
        .catch(() => null);

    if (!message) {
      return false;
    }

    const member =
      await guild.members
        .fetch(userId)
        .catch(() => null);

    if (!member) {
      return false;
    }

    const user =
      getUser(
        userId,
        guildId
      );

    await message.edit({
      embeds: [
        profileEmbed(
          member,
          user
        )
      ],
      files:
        profileFiles(user)
    });

    return true;

  } catch (err) {

    console.error(
      "Profile refresh error:",
      err.message
    );

    return false;
  }
}

function rememberProfileMessage(
  guildId,
  userId,
  message
) {

  activeProfileMessages.set(
    `${guildId}:${userId}`,
    {
      guildId,
      userId,
      channelId:
        message.channelId,
      messageId:
        message.id
    }
  );
}

async function refreshAllProfiles() {

  for (
    const [
      key,
      info
    ] of activeProfileMessages
  ) {

    const ok =
      await refreshProfileMessage(
        info.guildId,
        info.userId,
        info.channelId,
        info.messageId
      );

    if (!ok) {
      activeProfileMessages.delete(
        key
      );
    }
  }
}

/* =========================
   PROFILE REFRESH TIMER
========================= */

const profileRefreshTimer =
  setInterval(
    refreshAllProfiles,
    60_000
  );

profileRefreshTimer.unref?.();

/* =========================
   VOICE TRACKING
========================= */

client.on(
  "voiceStateUpdate",
  async (
    oldState,
    newState
  ) => {

    try {

      if (!newState.guild) {
        return;
      }

      const userId =
        newState.id;

      const guildId =
        newState.guild.id;

      const member =
        newState.member ||
        oldState.member;

      if (member?.user?.bot) {
        return;
      }

      const joined =
        !oldState.channelId &&
        !!newState.channelId;

      const left =
        !!oldState.channelId &&
        !newState.channelId;

      if (joined) {

        const user =
          getUser(
            userId,
            guildId
          );

        if (
          user.last_vc_join === null ||
          user.last_vc_join === undefined
        ) {

          setVcJoin(
            userId,
            guildId,
            Date.now()
          );

          console.log(
            `VC started: ${userId}`
          );
        }

        return;
      }

      if (left) {

        settleVcSession(
          userId,
          guildId
        );

        console.log(
          `VC ended: ${userId}`
        );

        await checkUnlocks(
          newState.guild,
          userId
        );
      }

    } catch (err) {

      console.error(
        "voiceStateUpdate error:",
        err
      );
    }
  }
);

/* =========================
   INSTAGRAM ROLE SYNC
========================= */

client.on(
  "guildMemberUpdate",
  async (
    oldMember,
    newMember
  ) => {

    const role =
      newMember.guild.roles.cache.find(
        r =>
          r.name === "Instagram user"
      );

    if (!role) {
      return;
    }

    const hadRole =
      oldMember.roles.cache.has(
        role.id
      );

    const hasRole =
      newMember.roles.cache.has(
        role.id
      );

    if (
      hadRole &&
      !hasRole
    ) {

      removeInstagram(
        newMember.id,
        newMember.guild.id
      );

      console.log(
        `Instagram removed for ${newMember.user.tag} because role was removed`
      );
    }
  }
);

/* =========================
   INTERACTION HANDLER
========================= */

client.on(
  "interactionCreate",
  async interaction => {
    const interactionAgeMs = Date.now() - interaction.createdTimestamp;

    console.log(
      `INTERACTION RECEIVED: type=${interaction.type} command=${interaction.commandName || ""} customId=${interaction.customId || ""} id=${interaction.id} ageMs=${interactionAgeMs}`
    );

    try {

      if (!interaction.guild) {
        return;
      }

      /*
       * A Discord interaction must be acknowledged within ~3 seconds.
       * Acknowledge normal slash commands immediately, before any command
       * work can consume that window. The giveaway command is excluded
       * because its handler sends its own initial reply().
       */
      if (
        interaction.isChatInputCommand() &&
        interaction.commandName !== "giveaway" &&
        !interaction.deferred &&
        !interaction.replied
      ) {
        try {
          await interaction.deferReply();
        } catch (err) {
          console.error(
            `Interaction acknowledgement failed: command=${interaction.commandName} id=${interaction.id} ageMs=${Date.now() - interaction.createdTimestamp}`,
            err
          );
          return;
        }
      }

      /* =========================
         GARAGE VIEW BUTTONS
      ========================= */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "garageview:"
        )
      ) {

        const [
          ,
          direction,
          viewerId,
          targetId,
          pageText
        ] =
          interaction.customId.split(":");

        if (
          interaction.user.id !==
          viewerId
        ) {

          return interaction.reply({
            content:
              "❌ Only the person who opened this garage can use these buttons.",
            ephemeral: true
          });
        }

        const currentPage =
          Number(pageText) || 0;

        const nextPage =
          direction === "next"
            ? currentPage + 1
            : currentPage - 1;

        const targetMember =
          await interaction.guild.members
            .fetch(targetId)
            .catch(() => null);

        if (!targetMember) {

          return interaction.reply({
            content:
              "❌ That member is no longer in this server.",
            ephemeral: true
          });
        }

        const targetUser =
          getUser(
            targetId,
            interaction.guild.id
          );

        const page =
          garagePage(
            targetMember,
            targetUser,
            nextPage
          );

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garageview:prev:${viewerId}:${targetId}:${page.page}`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garageview:next:${viewerId}:${targetId}:${page.page}`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.update({
          embeds: page.embeds,
          files: page.files,
          components: [row]
        });
      }

      /* =========================
         GIVEAWAY JOIN BUTTON
      ========================= */

      if (
        interaction.isButton() &&
        interaction.customId ===
          "giveaway_join"
      ) {

        const entries =
          giveawayCommand.giveawayEntries?.get(
            interaction.message.id
          );

        if (!entries) {

          return interaction.reply({
            content:
              "❌ This giveaway is no longer active.",
            ephemeral: true
          });
        }

        if (
          entries.has(
            interaction.user.id
          )
        ) {

          return interaction.reply({
            content:
              "⚠️ You are already entered in this giveaway!",
            ephemeral: true
          });
        }

        entries.add(
          interaction.user.id
        );

        const oldEmbed =
          interaction.message.embeds[0];

        if (oldEmbed) {

          const oldDescription =
            oldEmbed.description || "";

          const newDescription =
            oldDescription.replace(
              /👥 \*\*Entries:\*\* \d+/,
              `👥 **Entries:** ${entries.size}`
            );

          const updatedEmbed =
            EmbedBuilder
              .from(oldEmbed)
              .setDescription(
                newDescription
              );

          await interaction.message.edit({
            embeds: [
              updatedEmbed
            ]
          });
        }

        return interaction.reply({
          content:
            "🎉 You have successfully entered the giveaway! Good luck! 🍀",
          ephemeral: true
        });
      }

      /* =========================
         PERSONAL GARAGE BUTTONS
      ========================= */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "garage:"
        )
      ) {

        const [
          ,
          direction,
          ownerId,
          pageText
        ] =
          interaction.customId.split(":");

        if (
          interaction.user.id !==
          ownerId
        ) {

          return interaction.reply({
            content:
              "❌ Only the person who opened this garage can use these buttons.",
            ephemeral: true
          });
        }

        const currentPage =
          Number(pageText) || 0;

        const nextPage =
          direction === "next"
            ? currentPage + 1
            : currentPage - 1;

        const freshUser =
          getUser(
            interaction.user.id,
            interaction.guild.id
          );

        const page =
          garagePage(
            interaction.member,
            freshUser,
            nextPage
          );

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garage:prev:${ownerId}:${page.page}`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garage:next:${ownerId}:${page.page}`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.update({
          embeds: page.embeds,
          files: page.files,
          components: [row]
        });
      }

      /* =========================
         SLASH COMMAND CHECK
      ========================= */

      if (
        !interaction.isChatInputCommand()
      ) {
        return;
      }

      /* =========================
         GIVEAWAY SLASH COMMAND
         MUST HAPPEN BEFORE DEFER
      ========================= */

      if (
        interaction.commandName ===
        "giveaway"
      ) {

        try {

          return await giveawayCommand.execute(
            interaction
          );

        } catch (err) {

          console.error(
            "Giveaway command error:",
            err
          );

          if (
            interaction.replied ||
            interaction.deferred
          ) {

            return interaction
              .editReply({
                content:
                  "❌ An error occurred while creating the giveaway."
              })
              .catch(() => {});
          }

          return interaction
            .reply({
              content:
                "❌ An error occurred while creating the giveaway.",
              ephemeral: true
            })
            .catch(() => {});
        }
      }

      /* =========================
         NORMAL SLASH COMMANDS
      ========================= */

      console.log(
        `INTERACTION ACKNOWLEDGED: command=${interaction.commandName || "unknown"} id=${interaction.id} ageMs=${Date.now() - interaction.createdTimestamp}`
      );

      const user =
        getUser(
          interaction.user.id,
          interaction.guild.id
        );

      /* =========================
         PROFILE
      ========================= */

      if (
        interaction.commandName ===
        "profile"
      ) {

        await interaction.editReply({
          embeds: [
            profileEmbed(
              interaction.member,
              user
            )
          ],
          files:
            profileFiles(user)
        });

        const profileMessage =
          await interaction
            .fetchReply()
            .catch(() => null);

        if (profileMessage) {

          rememberProfileMessage(
            interaction.guild.id,
            interaction.user.id,
            profileMessage
          );
        }

        return;
      }

      /* =========================
         GARAGE
      ========================= */

      if (
        interaction.commandName ===
        "garage"
      ) {

        const page =
          garagePage(
            interaction.member,
            user,
            0
          );

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garage:prev:${interaction.user.id}:0`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garage:next:${interaction.user.id}:0`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.editReply({
          embeds: page.embeds,
          files: page.files,
          components: [row]
        });
      }

      /* =========================
         VIEW GARAGE
      ========================= */

      if (
        interaction.commandName ===
        "viewgarage"
      ) {

        const targetUser =
          interaction.options.getUser(
            "user",
            true
          );

        const targetMember =
          await interaction.guild.members
            .fetch(targetUser.id)
            .catch(() => null);

        if (!targetMember) {

          return interaction.editReply({
            content:
              "❌ That user is not a member of this server.",
            ephemeral: true
          });
        }

        const targetData =
          getUser(
            targetUser.id,
            interaction.guild.id
          );

        const page =
          garagePage(
            targetMember,
            targetData,
            0
          );

        const viewerId =
          interaction.user.id;

        const targetId =
          targetUser.id;

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `garageview:prev:${viewerId}:${targetId}:0`
                )
                .setLabel("Previous")
                .setEmoji("⬅️")
                .setStyle(
                  ButtonStyle.Secondary
                )
                .setDisabled(
                  page.page <= 0
                ),

              new ButtonBuilder()
                .setCustomId(
                  `garageview:next:${viewerId}:${targetId}:0`
                )
                .setLabel("Next")
                .setEmoji("➡️")
                .setStyle(
                  ButtonStyle.Primary
                )
                .setDisabled(
                  page.page >=
                  page.pageCount - 1
                )
            );

        return interaction.editReply({
          embeds: page.embeds,
          files: page.files,
          components: [row]
        });
      }

      /* =========================
         TOP GARAGES
      ========================= */

      if (
        interaction.commandName ===
        "topgarages"
      ) {

        return interaction.editReply({
          embeds: [
            topGaragesEmbed(
              topUsers(
                interaction.guild.id,
                10
              ),
              interaction.guild
            )
          ]
        });
      }

      /* =========================
         SETUP
      ========================= */

      if (
        interaction.commandName ===
        "setup"
      ) {

        if (
          !interaction.memberPermissions.has(
            PermissionFlagsBits.ManageGuild
          )
        ) {

          return interaction.editReply({
            content:
              "❌ You need Manage Server permission.",
            ephemeral: true
          });
        }

        if (
          interaction.channel.type !==
          ChannelType.GuildText
        ) {

          return interaction.editReply({
            content:
              "❌ Run this command inside a text channel.",
            ephemeral: true
          });
        }

        return interaction.editReply({
          content:
            `✅ **Top Garages channel configured!**\n` +
            `Use \`/topgarages\` here to publish the leaderboard.\n\n` +
            `For automatic updates, put this channel ID in \`TOP_GARAGES_CHANNEL_ID\` in your .env.`
        });
      }

    } catch (err) {

      console.error(
        "Interaction error:",
        err
      );

      if (
        interaction.isRepliable()
      ) {

        if (
          interaction.replied ||
          interaction.deferred
        ) {

          await interaction
            .editReply({
              content:
                "❌ Something went wrong while processing this command."
            })
            .catch(() => {});

        } else {

          await interaction
            .reply({
              content:
                "❌ Something went wrong while processing this command.",
              ephemeral: true
            })
            .catch(() => {});
        }
      }
    }
  }
);

/* =========================
   START BOT
========================= */

async function start() {

  const startupStartedAt = Date.now();

  try {

    console.log("START: Initializing database...");
    await initDb();
    console.log(
      `START: Database initialized in ${Date.now() - startupStartedAt}ms.`
    );

    console.log("START: Attempting Discord login...");
    const loginStartedAt = Date.now();

    await client.login(
      config.token
    );

    console.log(
      `START: Discord login() completed in ${Date.now() - loginStartedAt}ms.`
    );

  } catch (err) {

    console.error(
      "Startup failed:",
      err
    );

    process.exit(1);
  }
}

start();

/* =========================
   ERROR HANDLERS
========================= */

process.on(
  "unhandledRejection",
  err =>
    console.error(
      "Unhandled promise rejection:",
      err
    )
);

process.on(
  "uncaughtException",
  err =>
    console.error(
      "Uncaught exception:",
      err
    )
);

/* =========================
   PROCESS LIFECYCLE DIAGNOSTICS
========================= */

process.on("beforeExit", code => {
  console.log(`PROCESS beforeExit: code=${code}`);
});

process.on("exit", code => {
  console.log(`PROCESS exit: code=${code}`);
});

/* =========================
   SHUTDOWN
========================= */

let shuttingDown = false;

async function shutdown(signal) {

  if (shuttingDown) {
    console.log(`Shutdown already in progress; ignoring ${signal}.`);
    return;
  }

  shuttingDown = true;

  console.log(
    `${signal} received. Saving data and shutting down...`
  );

  try {

    await closeDb();

  } catch (err) {

    console.error(
      "Database shutdown error:",
      err.message
    );
  }

  try {

    client.destroy();

  } catch {}

  process.exit(0);
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

