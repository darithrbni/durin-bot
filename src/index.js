import sodium from 'libsodium-wrappers';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import { voiceManager } from './voiceManager.js';

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

await sodium.ready;

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Invite Durin into your current voice channel.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect Durin from the voice channel and clear session memory.')
    .toJSON(),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Discord] Logged in as ${readyClient.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  try {
    await rest.put(Routes.applicationCommands(config.clientId), {
      body: commands,
    });
    console.log('[Discord] Slash commands (/join, /leave) registered.');
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.user.id !== config.ownerUserId) {
    await interaction.reply({
      content: 'Sorry, I only respond to my creator.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === 'join') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'Please join a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await voiceManager.joinChannel(voiceChannel);
      await interaction.editReply(`Joined **${voiceChannel.name}**. I'm listening whenever you're ready.`);
    } catch (err) {
      console.error('[Discord] /join failed:', err);
      await interaction.editReply(`Failed to join voice channel: ${err.message}`);
    }
    return;
  }

  if (interaction.commandName === 'leave') {
    if (!voiceManager.isConnected()) {
      await interaction.reply({
        content: "I'm not currently in a voice channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await voiceManager.leaveChannel();
    await interaction.editReply('Left the voice channel and cleared session memory.');
  }
});

await client.login(config.discordToken);
