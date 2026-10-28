// Sends what is left in the reward wallet to an address you choose. DEVNET ONLY.
//   node sweep.js --to <address> [--keep <SOL>] [--yes]
// Stop the game server first: it reserves rewards the moment they are found and pays them a moment later.
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const PORT = Number(process.env.PORT) || 3000;
const FEE = 5000;
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };

function serverRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim().toLowerCase()); }));
}
(async () => {
  if (/mainnet/i.test(RPC_URL)) { console.error('Refusing to run: this tool is devnet only.'); process.exit(1); }
  const toStr = arg('to');
  if (!toStr) { console.error('Usage: node sweep.js --to <address> [--keep <SOL>] [--yes]'); process.exit(1); }
  let to;
  try { to = new PublicKey(toStr); } catch (e) { console.error('That is not a valid Solana address.'); process.exit(1); }
  const walletFile = path.join(__dirname, 'reward-wallet.json');
  if (!fs.existsSync(walletFile)) { console.error('No reward-wallet.json here.'); process.exit(1); }
  if (await serverRunning()) { console.error('The game server is still running on port ' + PORT + '. Stop it first (Ctrl+C), then run this again.'); process.exit(1); }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletFile, 'utf8'))));
  const conn = new Connection(RPC_URL, 'confirmed');
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) { console.error('RPC is not devnet. Stopping.'); process.exit(1); }
  const bal = await conn.getBalance(payer.publicKey, 'confirmed');
  const keep = Math.round(Number(arg('keep') || 0) * LAMPORTS_PER_SOL);
  const amount = bal - FEE - keep;
  console.log('Reward wallet ' + payer.publicKey.toBase58() + ' holds ' + (bal / LAMPORTS_PER_SOL).toFixed(6) + ' SOL');
  if (amount <= 0) { console.log('Nothing to send after the network fee' + (keep ? ' and the amount you asked to keep' : '') + '.'); return; }
  console.log('Will send ' + (amount / LAMPORTS_PER_SOL).toFixed(6) + ' SOL to ' + to.toBase58() + (keep ? ' and keep ' + (keep / LAMPORTS_PER_SOL) + ' SOL' : ''));
  if (!args.includes('--yes') && (await ask('Type "yes" to send: ')) !== 'yes') { console.log('Cancelled.'); return; }
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: amount }));
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  console.log('Sent. https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
})().catch((e) => { console.error('Sweep failed: ' + (e && e.message || e)); process.exit(1); });
