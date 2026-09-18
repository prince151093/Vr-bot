const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits
} = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("giveaway")
        .setDescription("Create a giveaway")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageGuild
        )
        .addSubcommand(sub =>
            sub
                .setName("create")
                .setDescription("Create a giveaway")
                .addStringOption(option =>
                    option
                        .setName("prize")
                        .setDescription("Giveaway prize")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("duration")
                        .setDescription("Example: 1h, 24h, 7d")
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option
                        .setName("winners")
                        .setDescription("Number of winners")
                        .setMinValue(1)
                        .setMaxValue(20)
                        .setRequired(true)
                )
        ),

    async execute(interaction) {

        const prize =
            interaction.options.getString("prize");

        const duration =
            interaction.options.getString("duration");

        const winners =
            interaction.options.getInteger("winners");

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`🎁 ${prize}`)
            .setDescription(
                "## 🎉 Giveaway is Live!\n\n" +
                "Click the button below to enter!\n\n" +
                `🎁 **Prize:** ${prize}\n` +
                `🏆 **Winners:** ${winners}\n` +
                `⏱️ **Duration:** ${duration}\n\n` +
                "👥 **Entries:** 0"
            )
            .setFooter({
                text: "Vehicle Life • Good luck! 🍀"
            })
            .setTimestamp();

        const button =
            new ButtonBuilder()
                .setCustomId("giveaway_join")
                .setLabel("🎉 Join Giveaway")
                .setStyle(ButtonStyle.Success);

        const row =
            new ActionRowBuilder()
                .addComponents(button);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
};
