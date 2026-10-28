// Sends what is left in the reward wallet to an address you choose. DEVNET ONLY.
//   node sweep.js --to <address> [--keep <SOL>] [--yes]          sends the leftover SOL
//   node sweep.js --to <address> --token [--yes]                 sends the leftover tokens (needs TOKEN_MINT) and closes the token account to get its SOL deposit back
// Stop the game server first: it reserves rewards the moment they are found and pays them a moment later.
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
let spl = null;
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');

const NETWORK = String(process.env.NETWORK || 'devnet').toLowerCase();
const MAINNET = NETWORK === 'mainnet';
const GENESIS = MAINNET ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CLUSTER_Q = MAINNET ? '' : '?cluster=devnet';
const RPC_URL = process.env.RPC_URL || (MAINNET ? '' : 'https://api.devnet.solana.com');
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
  if (!RPC_URL) { console.error('Set RPC_URL to your RPC provider.'); process.exit(1); }
  if (!MAINNET && /mainnet/i.test(RPC_URL)) { console.error('RPC_URL looks like mainnet but NETWORK is devnet. Set NETWORK=mainnet to sweep real funds.'); process.exit(1); }
  if (MAINNET && process.env.CONFIRM_MAINNET !== 'yes-i-am-using-real-funds') { console.error('NETWORK=mainnet also needs CONFIRM_MAINNET=yes-i-am-using-real-funds.'); process.exit(1); }
  const toStr = arg('to');
  if (!toStr) { console.error('Usage: node sweep.js --to <address> [--keep <SOL>] [--yes]'); process.exit(1); }
  let to;
  try { to = new PublicKey(toStr); } catch (e) { console.error('That is not a valid Solana address.'); process.exit(1); }
  const walletFile = path.join(__dirname, 'reward-wallet.json');
  if (!fs.existsSync(walletFile)) { console.error('No reward-wallet.json here.'); process.exit(1); }
  if (await serverRunning()) { console.error('The game server is still running on port ' + PORT + '. Stop it first (Ctrl+C), then run this again.'); process.exit(1); }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletFile, 'utf8'))));
  const conn = new Connection(RPC_URL, 'confirmed');
  if ((await conn.getGenesisHash()) !== GENESIS) { console.error('RPC is not ' + NETWORK + '. Stopping.'); process.exit(1); }
  if (args.includes('--token')) {
    const mintStr = process.env.TOKEN_MINT;
    if (!mintStr) { console.error('Set TOKEN_MINT to the token you want to sweep.'); process.exit(1); }
    spl = require('@solana/spl-token');
    const mint = new PublicKey(mintStr), info = await conn.getAccountInfo(mint, 'confirmed');
    if (!info) { console.error('That mint does not exist on ' + NETWORK + '.'); process.exit(1); }
    const programId = info.owner, m = await spl.getMint(conn, mint, 'confirmed', programId);
    const src = spl.getAssociatedTokenAddressSync(mint, payer.publicKey, true, programId);
    let amountT = 0n;
    try { amountT = BigInt((await conn.getTokenAccountBalance(src, 'confirmed')).value.amount); } catch (e) { console.log('The reward wallet has no token account for this mint. Nothing to send.'); return; }
    console.log('Reward wallet holds ' + (Number(amountT) / Math.pow(10, m.decimals)).toLocaleString('en-US') + ' tokens of ' + mintStr);
    if (!args.includes('--yes') && (await ask('Send them all to ' + to.toBase58() + ' and close the token account? Type "yes": ')) !== 'yes') { console.log('Cancelled.'); return; }
    const dst = spl.getAssociatedTokenAddressSync(mint, to, true, programId);
    const tx = new Transaction().add(spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dst, to, mint, programId));
    if (amountT > 0n) tx.add(spl.createTransferCheckedInstruction(src, mint, dst, payer.publicKey, amountT, m.decimals, [], programId));
    tx.add(spl.createCloseAccountInstruction(src, payer.publicKey, payer.publicKey, [], programId));   // rent deposit goes back to the reward wallet as SOL
    const sigT = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
    console.log('Sent. https://explorer.solana.com/tx/' + sigT + CLUSTER_Q + '\nRun the SOL sweep afterwards to move the rest of the SOL.');
    return;
  }
  const bal = await conn.getBalance(payer.publicKey, 'confirmed');
  const keep = Math.round(Number(arg('keep') || 0) * LAMPORTS_PER_SOL);
  const amount = bal - FEE - keep;
  console.log('Reward wallet ' + payer.publicKey.toBase58() + ' holds ' + (bal / LAMPORTS_PER_SOL).toFixed(6) + ' SOL');
  if (amount <= 0) { console.log('Nothing to send after the network fee' + (keep ? ' and the amount you asked to keep' : '') + '.'); return; }
  console.log('Will send ' + (amount / LAMPORTS_PER_SOL).toFixed(6) + ' SOL to ' + to.toBase58() + (keep ? ' and keep ' + (keep / LAMPORTS_PER_SOL) + ' SOL' : ''));
  if (!args.includes('--yes') && (await ask('Type "yes" to send: ')) !== 'yes') { console.log('Cancelled.'); return; }
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: amount }));
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  console.log('Sent. https://explorer.solana.com/tx/' + sig + CLUSTER_Q);
})().catch((e) => { console.error('Sweep failed: ' + (e && e.message || e)); process.exit(1); });
