const {
    SlashCommandBuilder,
    PermissionFlagsBits
} = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete multiple messages from this channel")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageMessages
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription("Number of messages to delete")
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true)
        ),

    async execute(interaction) {
        const amount = interaction.options.getInteger("amount");

        const deleted = await interaction.channel.bulkDelete(
            amount,
            true
        );

        return interaction.reply({
            content: `🧹 Successfully deleted **${deleted.size}** messages.`,
            ephemeral: true
        });
    }
};
