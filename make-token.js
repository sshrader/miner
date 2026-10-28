// Creates a throwaway DEVNET token with the reward wallet as its owner and puts the supply in the reward wallet.
//   node make-token.js [--supply 1000000] [--decimals 6]
//   node make-token.js --to <address> --amount 5000 [--mint <mint>]     (give test tokens to another wallet)
// The reward wallet needs a little devnet SOL first (faucet.solana.com): about 0.02 SOL covers it.
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  if (/mainnet/i.test(RPC_URL) || process.env.NETWORK === 'mainnet') { console.error('Refusing to run: this tool only makes throwaway DEVNET tokens. Your real coin already exists.'); process.exit(1); }
  const walletFile = path.join(__dirname, 'reward-wallet.json');
  if (!fs.existsSync(walletFile)) { console.error('No reward-wallet.json yet. Run "npm start" once to create it, then stop the server and run this.'); process.exit(1); }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletFile, 'utf8'))));
  const conn = new Connection(RPC_URL, 'confirmed');
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) { console.error('RPC is not devnet. Stopping.'); process.exit(1); }
  const sol = await conn.getBalance(payer.publicKey, 'confirmed');
  console.log('Reward wallet ' + payer.publicKey.toBase58() + ' has ' + (sol / LAMPORTS_PER_SOL).toFixed(4) + ' devnet SOL');
  if (sol < 0.02 * LAMPORTS_PER_SOL) { console.error('It needs at least 0.02 devnet SOL for fees and token accounts. Fund it at https://faucet.solana.com and run again.'); process.exit(1); }

  let mint, decimals;
  if (arg('mint')) {
    mint = new PublicKey(arg('mint'));
  } else {
    decimals = Number(arg('decimals') || 6);
    mint = await spl.createMint(conn, payer, payer.publicKey, null, decimals);   // classic Token program
    const supply = Number(arg('supply') || 1000000);
    const ata = await spl.getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
    await spl.mintTo(conn, payer, mint, ata.address, payer, BigInt(Math.round(supply * Math.pow(10, decimals))));
    console.log('Created token ' + mint.toBase58() + ' with ' + supply.toLocaleString('en-US') + ' tokens in the reward wallet.');
  }
  const info = await conn.getAccountInfo(mint, 'confirmed');
  const programId = info.owner;
  if (decimals === undefined) decimals = (await spl.getMint(conn, mint, 'confirmed', programId)).decimals;

  const to = arg('to');
  if (to) {
    const amount = Number(arg('amount') || 0);
    if (!(amount > 0)) { console.error('Add --amount <tokens>.'); process.exit(1); }
    const dest = await spl.getOrCreateAssociatedTokenAccount(conn, payer, mint, new PublicKey(to), false, 'confirmed', undefined, programId);
    await spl.mintTo(conn, payer, mint, dest.address, payer, BigInt(Math.round(amount * Math.pow(10, decimals))), [], undefined, programId);
    console.log('Gave ' + amount.toLocaleString('en-US') + ' test tokens to ' + to);
  }
  console.log('\nStart the game with:');
  console.log('  PowerShell:  $env:TOKEN_MINT="' + mint.toBase58() + '"; $env:TOKEN_SYMBOL="TEST"; $env:MIN_HOLD="1000"; npm start');
  console.log('  (MIN_HOLD is the number of tokens a wallet must hold to mine; leave it out for no minimum.)');
})().catch((e) => { console.error('Failed: ' + (e && e.message || e)); process.exit(1); });
