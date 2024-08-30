require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { Keypair } = require('@solana/web3.js');
const crypto = require('crypto');
const readline = require('readline');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let globalKeypair = null;
let encryptedPrivateKey = null;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function encryptPrivateKey(privateKey, password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(privateKey);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return salt.toString('hex') + ':' + iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPrivateKey(encryptedPrivateKey, password) {
  const parts = encryptedPrivateKey.split(':');
  const salt = Buffer.from(parts.shift(), 'hex');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

async function promptForPassword(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function initializeKeypair() {
  if (process.env.SOLANA_PRIVATE_KEY) {
    try {
      const privateKey = Buffer.from(process.env.SOLANA_PRIVATE_KEY, 'hex');
      globalKeypair = Keypair.fromSecretKey(privateKey);
      console.log(`Loaded wallet from .env file. Public Key: ${globalKeypair.publicKey.toString()}`);
    } catch (error) {
      console.error('Invalid private key format in .env file.');
      process.exit(1);
    }
  } else {
    console.log('No private key found in .env file. Generating a new keypair...');
    globalKeypair = Keypair.generate();
    const privateKey = Buffer.from(globalKeypair.secretKey).toString('hex');
    
    const password = await promptForPassword('Enter a password to encrypt the new private key: ');
    encryptedPrivateKey = encryptPrivateKey(privateKey, password);
    
    console.log(`New wallet generated. Public Key: ${globalKeypair.publicKey.toString()}`);
    console.log('Please add the following line to your .env file:');
    console.log(`SOLANA_PRIVATE_KEY=${privateKey}`);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  const commands = [
    new SlashCommandBuilder().setName('showpubkey').setDescription('Show the current wallet\'s public key'),
    new SlashCommandBuilder().setName('exportprivatekey').setDescription('Export the current wallet\'s private key')
      .addStringOption(option => option.setName('password').setDescription('Password to decrypt the private key').setRequired(encryptedPrivateKey !== null)),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'showpubkey') {
    await interaction.reply(`Current wallet's Public Key: ${globalKeypair.publicKey.toString()}`);
  } else if (commandName === 'exportprivatekey') {
    if (encryptedPrivateKey) {
      const password = interaction.options.getString('password');
      try {
        const privateKey = decryptPrivateKey(encryptedPrivateKey, password);
        await interaction.reply({ content: `Your private key is: ${privateKey}\nKeep this safe and don't share it with anyone!`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: 'Invalid password or decryption failed.', ephemeral: true });
      }
    } else {
      const privateKey = Buffer.from(globalKeypair.secretKey).toString('hex');
      await interaction.reply({ content: `Your private key is: ${privateKey}\nKeep this safe and don't share it with anyone!`, ephemeral: true });
    }
  }
});

async function main() {
  await initializeKeypair();
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(console.error);