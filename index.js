import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { Decimal } from 'decimal.js';
import axios from 'axios';
import bs58 from 'bs58';
import * as splToken from '@solana/spl-token';

dotenv.config();

const ASSETS = {
    "USDC": { "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "decimals": 6, "allocation": new Decimal('0.3') },
    "JTO": { "mint": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", "decimals": 9, "allocation": new Decimal('0.2') },
    "WIF": { "mint": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "decimals": 6, "allocation": new Decimal('0') },
    "SOL": { "mint": "So11111111111111111111111111111111111111112", "decimals": 9, "allocation": new Decimal('0.3') },
    "JUP": { "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "decimals": 6, "allocation": new Decimal('0.2') },
};

const TOKEN_IDS = {
    "SOL": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    "JUP": "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
    "JTO": "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
    "WIF": "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
};

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=5adcfebf-b520-4bcd-92ee-b4861e5e7b5b";
const REBALANCE_THRESHOLD = new Decimal('0.0042');
const CHECK_INTERVAL = 60000; // 60 seconds
const STASH_THRESHOLD = new Decimal('1');
const STASH_AMOUNT = new Decimal('0.1');
const STASH_ADDRESS = new PublicKey("StAshdD7TkoNrWqsrbPTwRjCdqaCfMgfVCwKpvaGhuC");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const connection = new Connection(RPC_ENDPOINT);
let globalKeypair = null;
let lastEventValue = null;
let discordChannel = null;

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
    if (discordChannel) {
        discordChannel.send(message);
    }
}

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

async function getWalletBalances(walletAddress) {
    log("Fetching wallet balances...");
    try {
        const response = await axios.post(RPC_ENDPOINT, {
            jsonrpc: "2.0",
            id: "my-id",
            method: "getAssetsByOwner",
            params: {
                ownerAddress: walletAddress,
                page: 1,
                limit: 1000,
                displayOptions: {
                    showFungible: true,
                    showNativeBalance: true
                }
            }
        });

        const data = response.data;

        if ('error' in data) {
            throw new Error(`API Error: ${data.error.message}`);
        }

        if (!('result' in data)) {
            throw new Error("Unexpected API response format");
        }

        const balances = Object.fromEntries(
            Object.keys(ASSETS).map(asset => [asset, new Decimal('0')])
        );

        for (const item of data.result.items) {
            for (const [asset, details] of Object.entries(ASSETS)) {
                if (item.id === details.mint) {
                    const balance = new Decimal(item.token_info.balance).div(new Decimal(10).pow(details.decimals));
                    balances[asset] = balance;
                    break;
                }
            }
        }

        if ('nativeBalance' in data.result) {
            const solLamports = new Decimal(data.result.nativeBalance.lamports);
            balances['SOL'] = solLamports.div(new Decimal(10).pow(ASSETS['SOL'].decimals));
        }

        log("Wallet balances fetched successfully");
        return balances;
    } catch (error) {
        log(`Error fetching wallet balances: ${error.message}`);
        throw error;
    }
}

async function getPrices() {
    log("Fetching asset prices...");
    try {
        const url = "https://hermes.pyth.network/v2/updates/price/latest";
        const params = new URLSearchParams(
            Object.values(TOKEN_IDS).map(id => ['ids[]', id])
        );
        params.append('parsed', 'true');

        const response = await axios.get(url, { params });
        const data = response.data;

        const prices = {};
        for (const item of data.parsed) {
            const token = Object.keys(TOKEN_IDS).find(key => TOKEN_IDS[key] === item.id);
            const price = new Decimal(item.price.price).mul(new Decimal(10).pow(item.price.expo));
            prices[token] = price;
        }

        prices["USDC"] = new Decimal('1.0');

        log("Asset prices fetched successfully");
        return prices;
    } catch (error) {
        log(`Error fetching asset prices: ${error.message}`);
        throw error;
    }
}

function calculatePortfolioValue(balances, prices) {
    return Object.keys(ASSETS).reduce((total, asset) => {
        return total.add(balances[asset].mul(prices[asset]));
    }, new Decimal(0));
}

function calculateRebalanceAmounts(balances, prices, totalValue) {
    const rebalanceAmounts = {};

    for (const asset of Object.keys(ASSETS)) {
        const currentValue = balances[asset].mul(prices[asset]);
        const targetValue = totalValue.mul(ASSETS[asset].allocation);
        const targetAmount = targetValue.div(prices[asset]);
        const rebalanceAmount = targetAmount.minus(balances[asset]);
        rebalanceAmounts[asset] = rebalanceAmount.toDecimalPlaces(6, Decimal.ROUND_DOWN);
    }

    return rebalanceAmounts;
}

function printSwaps(swaps) {
    let message = "\nExecuting the following swaps:\n";
    message += "-".repeat(40) + "\n";
    message += "From   To     Amount      Value ($)\n";
    message += "-".repeat(40) + "\n";
    for (const swap of swaps) {
        message += `${swap.from.padEnd(6)} ${swap.to.padEnd(6)} ${swap.amount.toFixed(6).padStart(12)} ${swap.value.toFixed(2).padStart(12)}\n`;
    }
    message += "-".repeat(40);
    log(message);
}

function printPortfolio(balances, prices, totalValue) {
    let message = "\nCurrent Portfolio:\n";
    message += "------------------\n";
    message += "Asset  Balance      Value ($)   Allocation  Target\n";
    message += "-".repeat(57) + "\n";
    for (const asset of Object.keys(ASSETS)) {
        const balance = balances[asset];
        const value = balance.mul(prices[asset]);
        const allocation = value.div(totalValue).mul(100);
        const targetAllocation = ASSETS[asset].allocation.mul(100);
        message += `${asset.padEnd(6)} ${balance.toFixed(3).padStart(12)} ${value.toFixed(2).padStart(12)} ${allocation.toFixed(2).padStart(11)}% ${targetAllocation.toFixed(2).padStart(8)}%\n`;
    }
    message += "-".repeat(57) + "\n";
    message += `${"Total".padEnd(6)} ${" ".repeat(12)} ${totalValue.toFixed(2).padStart(12)} ${"100.00%".padStart(11)} ${"100.00%".padStart(8)}`;
    log(message);
}

async function getJupiterSwapInstructions(fromAccountPublicKey, inputMint, outputMint, amountLamports, slippageBps = 100) {
    log(`Getting Jupiter swap instructions for ${inputMint} to ${outputMint}...`);
    try {
        const quoteURL = `https://quote-api.jup.ag/v6/quote?onlyDirectRoutes=true&inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
        const quoteResponse = await axios.get(quoteURL);

        const swapInstructionsURL = 'https://quote-api.jup.ag/v6/swap-instructions';
        const body = {
            userPublicKey: fromAccountPublicKey.toString(),
            quoteResponse: quoteResponse.data,
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 0,
            dynamicComputeUnitLimit: true,
        };

        const response = await axios.post(swapInstructionsURL, body);

        if (response.status !== 200) {
            throw new Error(`Failed to get swap instructions: ${response.statusText}`);
        }

        log("Jupiter swap instructions fetched successfully");
        return response.data;
    } catch (error) {
        log(`Error getting Jupiter swap instructions: ${error.message}`);
        throw error;
    }
}

function createTransactionInstruction(instructionData) {
    const { programId, accounts, data } = instructionData;
    return new Transaction().add({
        keys: accounts.map(acc => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner,
            isWritable: acc.isWritable
        })),
        programId: new PublicKey(programId),
        data: Buffer.from(data, 'base64'),
    });
}

async function createSwapTransaction(fromAccount, inputAsset, outputAsset, amount) {
    log(`Creating swap transaction for ${inputAsset} to ${outputAsset}...`);
    try {
        const inputMint = ASSETS[inputAsset].mint;
        const outputMint = ASSETS[outputAsset].mint;
        const amountLamports = amount.mul(new Decimal(10).pow(ASSETS[inputAsset].decimals)).toFixed(0);

        const swapInstructionsResponse = await getJupiterSwapInstructions(fromAccount.publicKey, inputMint, outputMint, amountLamports);

        const blockhash = await connection.getLatestBlockhash();
        const transaction = new Transaction();
        transaction.recentBlockhash = blockhash.blockhash;
        transaction.feePayer = fromAccount.publicKey;

        swapInstructionsResponse.computeBudgetInstructions.forEach(instructionData => {
            transaction.add(createTransactionInstruction(instructionData));
        });

        swapInstructionsResponse.setupInstructions.forEach(instructionData => {
            transaction.add(createTransactionInstruction(instructionData));
        });

        transaction.add(createTransactionInstruction(swapInstructionsResponse.swapInstruction));

        if (swapInstructionsResponse.cleanupInstruction) {
            transaction.add(createTransactionInstruction(swapInstructionsResponse.cleanupInstruction));
        }

        transaction.sign(fromAccount);
        log("Swap transaction created successfully");
        return transaction;
    } catch (error) {
        log(`Error creating swap transaction: ${error.message}`);
        throw error;
    }
}

async function createTipTransaction(fromAccount, stashAmount = null) {
    log("Creating tip and stash transaction...");
    try {
        const tipAndStashTransaction = new Transaction();
        const blockhash = await connection.getLatestBlockhash();

        tipAndStashTransaction.recentBlockhash = blockhash.blockhash;
        tipAndStashTransaction.feePayer = fromAccount.publicKey;

        // Add tip transfers
        tipAndStashTransaction.add(
            SystemProgram.transfer({
                fromPubkey: fromAccount.publicKey,
                toPubkey: new PublicKey("juLesoSmdTcRtzjCzYzRoHrnF8GhVu6KCV7uxq7nJGp"),
                lamports: 100_000,
            }),
            SystemProgram.transfer({
                fromPubkey: fromAccount.publicKey,
                toPubkey: new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
                lamports: 100_000,
            })
        );

        // Add stash transfer if stashAmount is provided
        if (stashAmount) {
            // Find the from token account (USDC account of the sender)
            const fromTokenAccount = await splToken.getAssociatedTokenAddress(
                USDC_MINT,
                fromAccount.publicKey
            );

            // Find or create the to token account (USDC account of the receiver)
            const toTokenAccount = await splToken.getAssociatedTokenAddress(
                USDC_MINT,
                STASH_ADDRESS
            );

            // Check if the receiver's token account exists
            const receiverAccountInfo = await connection.getAccountInfo(toTokenAccount);
            if (receiverAccountInfo === null) {
                // If the account doesn't exist, add instruction to create it
                tipAndStashTransaction.add(
                  splToken.createAssociatedTokenAccountInstruction(
                      fromAccount.publicKey,
                      toTokenAccount,
                      STASH_ADDRESS,
                      USDC_MINT
                  )
              );
          }

          // Convert stashAmount to USDC token amount (considering 6 decimals for USDC)
          const stashTokenAmount = stashAmount.mul(new Decimal(10).pow(ASSETS['USDC'].decimals)).toFixed(0);

          // Add the token transfer instruction
          tipAndStashTransaction.add(
              splToken.createTransferInstruction(
                  fromTokenAccount,
                  toTokenAccount,
                  fromAccount.publicKey,
                  BigInt(stashTokenAmount)
              )
          );
      }

      tipAndStashTransaction.sign(fromAccount);
      log("Tip and stash transaction created successfully");
      return tipAndStashTransaction;
  } catch (error) {
      log(`Error creating tip and stash transaction: ${error.message}`);
      throw error;
  }
}

async function sendBundle(transactions) {
  log("Sending transaction bundle...");
  try {
      const encodedTransactions = transactions.map(tx => bs58.encode(tx.serialize()));
      const bundleData = {
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [encodedTransactions]
      };

      const response = await axios.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', bundleData, {
          headers: { 'Content-Type': 'application/json' }
      });
      log("Transaction bundle sent successfully");
      return response.data.result;
  } catch (error) {
      log(`Error sending bundle: ${error.message}`);
      throw new Error("Failed to send bundle.");
  }
}

async function executeSwaps(rebalanceAmounts, prices, fromAccount, totalValue) {
  log("Executing swaps...");
  const swaps = [];
  const swapTransactions = [];

  for (const [asset, amount] of Object.entries(rebalanceAmounts)) {
      if (asset !== "USDC" && amount.abs().gt(new Decimal('0.042'))) {
          if (amount.gt(0)) {
              const usdcAmount = amount.mul(prices[asset]).toDecimalPlaces(6, Decimal.ROUND_DOWN);
              swaps.push({
                  from: "USDC",
                  to: asset,
                  amount: usdcAmount,
                  value: usdcAmount
              });
              swapTransactions.push(await createSwapTransaction(fromAccount, "USDC", asset, usdcAmount));
          } else if (amount.lt(0)) {
              const usdcValue = amount.abs().mul(prices[asset]).toDecimalPlaces(6, Decimal.ROUND_DOWN);
              swaps.push({
                  from: asset,
                  to: "USDC",
                  amount: amount.abs(),
                  value: usdcValue
              });
              swapTransactions.push(await createSwapTransaction(fromAccount, asset, "USDC", amount.abs()));
          }
      }
  }

  if (swaps.length > 0) {
      printSwaps(swaps);

      log("\nPreparing to execute swaps...");

      // Determine if stashing is needed
      const delta = lastEventValue ? totalValue.minus(lastEventValue) : new Decimal(0);
      const stashAmount = lastEventValue && delta.abs().gte(STASH_THRESHOLD) ? STASH_AMOUNT : null;

      log(`Current portfolio value: $${totalValue.toFixed(2)}`);
      log(`Last event value: $${lastEventValue ? lastEventValue.toFixed(2) : 'N/A'}`);
      log(`Delta: $${delta.toFixed(2)}`);
      log(`Stash threshold: $${STASH_THRESHOLD.toFixed(2)}`);
      log(`Stash amount: $${stashAmount ? stashAmount.toFixed(2) : '0.00'}`);

      // Create tip and stash transaction
      const tipAndStashTransaction = await createTipTransaction(fromAccount, stashAmount);

      // Combine all transactions
      const allTransactions = [...swapTransactions, tipAndStashTransaction];

      // Ensure we don't exceed the maximum number of transactions in a bundle
      const maxSwaps = 4; // Maximum number of swap transactions (5 total - 1 for tips and stash)
      if (allTransactions.length > 5) {
          log(`Warning: Only the first ${maxSwaps} swaps will be processed due to bundle size limitations.`);
          allTransactions.splice(maxSwaps, allTransactions.length - maxSwaps - 1);
      }

      // Send the bundle
      try {
          const bundleId = await sendBundle(allTransactions);
          log(`Bundle submitted with ID: ${bundleId}`);
          log(`Processed ${swaps.length} swap(s) and 1 tip/stash transaction.`);

          // Update lastEventValue after successful execution
          lastEventValue = totalValue;

          if (stashAmount) {
              log(`Stashed $${stashAmount} to ${STASH_ADDRESS}`);
          }
      } catch (error) {
          log(`Failed to execute swaps: ${error.message}`);
          throw error;
      }
  } else {
      log("No swaps needed.");

      // Check if stashing is needed even when no swaps are performed
      const delta = lastEventValue ? totalValue.minus(lastEventValue) : new Decimal(0);
      if (lastEventValue && delta.abs().gte(STASH_THRESHOLD)) {
          log("\nPreparing to execute stash transaction...");
          log(`Current portfolio value: $${totalValue.toFixed(2)}`);
          log(`Last event value: $${lastEventValue.toFixed(2)}`);
          log(`Delta: $${delta.toFixed(2)}`);
          log(`Stash threshold: $${STASH_THRESHOLD.toFixed(2)}`);
          log(`Stash amount: $${STASH_AMOUNT.toFixed(2)}`);

          const tipAndStashTransaction = await createTipTransaction(fromAccount, STASH_AMOUNT);

          try {
              const bundleId = await sendBundle([tipAndStashTransaction]);
              log(`Stash transaction bundle submitted with ID: ${bundleId}`);
              log(`Stashed $${STASH_AMOUNT} to ${STASH_ADDRESS}`);

              // Update lastEventValue after successful stash
              lastEventValue = totalValue;
          } catch (error) {
              log(`Failed to execute stash transaction: ${error.message}`);
              throw error;
          }
      } else {
          log("No stashing needed.");
          log(`Current portfolio value: $${totalValue.toFixed(2)}`);
          log(`Last event value: $${lastEventValue ? lastEventValue.toFixed(2) : 'N/A'}`);
          log(`Delta: $${delta.toFixed(2)}`);
          log(`Stash threshold: $${STASH_THRESHOLD.toFixed(2)}`);
      }
  }
}

async function rebalancePortfolio() {
  log(`Wallet address: ${globalKeypair.publicKey.toString()}`);

  while (true) {
      try {
          log("\n--- Starting rebalance check ---");
          const balances = await getWalletBalances(globalKeypair.publicKey.toString());
          log("Balances fetched successfully");

          const prices = await getPrices();
          log("Prices fetched successfully");

          const totalValue = calculatePortfolioValue(balances, prices);
          log(`Total portfolio value: $${totalValue.toFixed(2)}`);

          printPortfolio(balances, prices, totalValue);

          const rebalanceAmounts = calculateRebalanceAmounts(balances, prices, totalValue);
          log("Rebalance amounts calculated");

          const currentAllocations = Object.fromEntries(
              Object.keys(ASSETS).map(asset => [
                  asset,
                  balances[asset].mul(prices[asset]).div(totalValue)
              ])
          );

          const needRebalance = Object.entries(currentAllocations).some(
              ([asset, alloc]) => alloc.minus(ASSETS[asset].allocation).abs().gt(REBALANCE_THRESHOLD)
          );

          if (needRebalance) {
              log("\nRebalancing needed.");
              await executeSwaps(rebalanceAmounts, prices, globalKeypair, totalValue);
              log("\nWaiting for trades to settle...");
              await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds

              // Fetch updated balances and print new portfolio state
              log("Fetching updated portfolio state...");
              const updatedBalances = await getWalletBalances(globalKeypair.publicKey.toString());
              const updatedPrices = await getPrices();
              const updatedTotalValue = calculatePortfolioValue(updatedBalances, updatedPrices);
              log("\nUpdated portfolio after rebalancing:");
              printPortfolio(updatedBalances, updatedPrices, updatedTotalValue);

              // Update lastEventValue after rebalancing
              lastEventValue = updatedTotalValue;
          } else {
              log("\nPortfolio is balanced. Checking if stashing is needed...");
              // Check if stashing is needed even when no rebalance is performed
              if (lastEventValue && totalValue.minus(lastEventValue).abs().gte(STASH_THRESHOLD)) {
                  await executeSwaps(rebalanceAmounts, prices, globalKeypair, totalValue);
              } else {
                  log("No stashing needed.");
              }
          }

      } catch (error) {
          log(`An error occurred during the rebalance check: ${error.message}`);
          if (error.response) {
              log(`Response data: ${JSON.stringify(error.response.data)}`);
              log(`Response status: ${error.response.status}`);
              log(`Response headers: ${JSON.stringify(error.response.headers)}`);
          }
      }

      log(`\nWaiting ${CHECK_INTERVAL / 1000} seconds before next check...`);
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Find a suitable channel to send messages
  for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels.cache.find(channel => channel.type === 0 && channel.permissionsFor(guild.members.me).has('SendMessages'));
      if (channel) {
          discordChannel = channel;
          channel.send(`Bot is now running! Current wallet's Public Key: ${globalKeypair.publicKey.toString()}`);
          break;
      }
  }

  // Start the rebalancing process
  initializeKeypair();
  rebalancePortfolio().catch(error => {
      log(`Fatal error in rebalancePortfolio: ${error.message}`);
      process.exit(1);
  });
});

client.login(process.env.DISCORD_TOKEN);