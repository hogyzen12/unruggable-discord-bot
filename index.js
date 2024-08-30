import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let globalKeypair = null;

function initializeKeypair() {
  if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error('SOLANA_PRIVATE_KEY not found in .env file');
    process.exit(1);
  }

  try {
    const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY;
    globalKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    console.log(`Loaded wallet. Public Key: ${globalKeypair.publicKey.toString()}`);
  } catch (error) {
    console.error('Invalid private key format in .env file', error);
    process.exit(1);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Check if the bot is responsive'),
    new SlashCommandBuilder().setName('showpubkey').setDescription('Show the current wallet\'s public key'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Successfully reloaded application (/) commands.');

    // Send a message to all guilds the bot is in
    client.guilds.cache.forEach(guild => {
      const channel = guild.channels.cache.find(channel => channel.type === 0 && channel.permissionsFor(guild.members.me).has('SendMessages'));
      if (channel) {
        channel.send(`Bot is now running! Current wallet's Public Key: ${globalKeypair.publicKey.toString()}`);
      }
    });
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'ping') {
    await interaction.reply('Pong! The bot is responsive.');
  } else if (commandName === 'showpubkey') {
    await interaction.reply(`Current wallet's Public Key: ${globalKeypair.publicKey.toString()}`);
  }
});

initializeKeypair();
client.login(process.env.DISCORD_TOKEN);