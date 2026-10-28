'use strict';
// Tries to airdrop devnet SOL to the reward wallet. The public RPC rate-limits often; if this fails use https://faucet.solana.com
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const file = path.join(__dirname, 'reward-wallet.json');
if (!fs.existsSync(file)) { console.error('No reward-wallet.json yet. Run "npm start" once to create it.'); process.exit(1); }
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
const sol = parseFloat(process.argv[2] || '1');
const c = new Connection(process.env.RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
(async () => {
  try {
    console.log('Requesting ' + sol + ' devnet SOL for ' + kp.publicKey.toBase58() + ' ...');
    const sig = await c.requestAirdrop(kp.publicKey, Math.round(sol * LAMPORTS_PER_SOL));
    await c.confirmTransaction(sig, 'confirmed');
    console.log('Done. Balance: ' + (await c.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL + ' SOL');
  } catch (e) {
    console.error('Airdrop failed (' + ((e && e.message) || e) + ').');
    console.error('Use the web faucet instead: https://faucet.solana.com (choose devnet, paste ' + kp.publicKey.toBase58() + ').');
    process.exit(1);
  }
})();
