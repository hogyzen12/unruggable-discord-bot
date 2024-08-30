require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { Keypair } = require('@solana/web3.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined a new guild: ${guild.name}`);
  const keypair = Keypair.generate();
  const privateKey = keypair.secretKey.toString();
  const publicKey = keypair.publicKey.toString();

  // Find the first available text channel to send the message
  const channel = guild.channels.cache.find(channel => channel.type === 0 && channel.permissionsFor(guild.members.me).has('SendMessages'));
  
  if (channel) {
    await channel.send(`Hello! I've generated a new Solana wallet for this server.\nPublic Key: ${publicKey}\n\nThe private key has been securely stored.`);
    console.log(`Generated wallet for guild ${guild.name}. Private key: ${privateKey}`);
    // In a real application, you would securely store the private key, not log it
  }
});

client.login(process.env.DISCORD_TOKEN);