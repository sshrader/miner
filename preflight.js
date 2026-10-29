// Run before going live:  npm run preflight   (use the same environment variables as the server)
// Reads settings and the chain; sends nothing and spends nothing.
const fs = require('fs');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const NETWORK = String(process.env.NETWORK || 'devnet').toLowerCase();
const MAINNET = NETWORK === 'mainnet';
const GENESIS = MAINNET ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC_URL = process.env.RPC_URL || (MAINNET ? '' : 'https://api.devnet.solana.com');
let bad = 0, warn = 0;
const ok = (m) => console.log('  ok    ' + m);
const no = (m) => { bad++; console.log('  FAIL  ' + m); };
const wn = (m) => { warn++; console.log('  warn  ' + m); };
(async () => {
  console.log('Rock Bottom Rewards preflight, network: ' + NETWORK + '\n');
  MAINNET ? (process.env.CONFIRM_MAINNET === 'yes-i-am-using-real-funds' ? ok('CONFIRM_MAINNET is set') : no('CONFIRM_MAINNET=yes-i-am-using-real-funds is missing')) : wn('NETWORK is devnet: nothing here is real money');
  const key = process.env.ADMIN_KEY || '';
  key.length >= 24 ? ok('ADMIN_KEY is ' + key.length + ' characters') : no('ADMIN_KEY must be at least 24 characters (never reuse one that was pasted anywhere)');
  const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  origins.length && origins.every((o) => /^https:\/\//.test(o) || !MAINNET) ? ok('ALLOWED_ORIGINS: ' + origins.join(', ')) : (MAINNET ? no('ALLOWED_ORIGINS must list your https site address') : wn('ALLOWED_ORIGINS is not set'));
  process.env.TRUST_PROXY === '1' ? ok('TRUST_PROXY is set (needed behind Railway so per-IP limits see real addresses)') : wn('TRUST_PROXY is not 1; behind a proxy every visitor would look like one IP');
  Number(process.env.MAX_PER_IP) > 0 ? ok('MAX_PER_IP=' + process.env.MAX_PER_IP) : wn('MAX_PER_IP is not set (no per-connection limit)');
  Number(process.env.MAX_PAYOUT_PER_HOUR) > 0 ? ok('MAX_PAYOUT_PER_HOUR=' + process.env.MAX_PAYOUT_PER_HOUR) : (MAINNET ? no('MAX_PAYOUT_PER_HOUR is required on mainnet') : wn('MAX_PAYOUT_PER_HOUR is not set'));
  Number(process.env.MAX_WALLET_PAYOUT) > 0 ? ok('MAX_WALLET_PAYOUT=' + process.env.MAX_WALLET_PAYOUT) : wn('MAX_WALLET_PAYOUT is not set (one wallet could win a big share)');
  process.env.STATE_FILE ? ok('STATE_FILE=' + process.env.STATE_FILE + ' (is it on a persistent volume?)') : wn('STATE_FILE is not set: a restart forgets the mine and the per-wallet limits');
  process.env.TOKEN_MINT ? (Number(process.env.MIN_HOLD) > 0 ? ok('Token mode, MIN_HOLD=' + process.env.MIN_HOLD) : wn('Token mode without MIN_HOLD: anyone can mine')) : ok('SOL mode');
  if (process.env.REQUIRE_SIGNATURE !== '1') wn('REQUIRE_SIGNATURE is off: pasted addresses can be entered by anyone (fine for a free game, weak against takeovers)');
  let wallet = null;
  try {
    const raw = process.env.REWARD_WALLET_JSON || (fs.existsSync('reward-wallet.json') ? fs.readFileSync('reward-wallet.json', 'utf8') : '');
    if (!raw) no('No reward wallet: set REWARD_WALLET_JSON');
    else { wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))); ok('Reward wallet ' + wallet.publicKey.toBase58()); }
  } catch (e) { no('Reward wallet could not be read: ' + e.message); }
  if (!RPC_URL) { no('RPC_URL is not set'); }
  else if (!MAINNET && /mainnet/i.test(RPC_URL)) no('RPC_URL looks like mainnet but NETWORK is devnet');
  else if (MAINNET && /devnet|testnet/i.test(RPC_URL)) no('RPC_URL looks like devnet/testnet but NETWORK is mainnet');
  else {
    const c = new Connection(RPC_URL, 'confirmed');
    try {
      const g = await c.getGenesisHash();
      g === GENESIS ? ok('RPC is on the right chain') : no('RPC reports the wrong chain (' + g + ')');
      if (wallet) {
        const sol = await c.getBalance(wallet.publicKey);
        sol / LAMPORTS_PER_SOL >= 0.01 ? ok('Wallet holds ' + (sol / LAMPORTS_PER_SOL).toFixed(4) + ' SOL') : no('Wallet holds ' + (sol / LAMPORTS_PER_SOL).toFixed(4) + ' SOL, needs fees and a rent reserve');
        if (MAINNET && sol / LAMPORTS_PER_SOL > 20) wn('The reward wallet holds a lot of SOL. Keep it to what you are willing to lose.');
      }
      if (process.env.TOKEN_MINT && wallet) {
        const mint = new PublicKey(process.env.TOKEN_MINT);
        const info = await c.getAccountInfo(mint);
        info ? ok('Token mint exists') : no('Token mint not found on this network');
        const list = await c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint });
        const amt = list.value.reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
        amt > 0 ? ok('Wallet holds ' + amt.toLocaleString('en-US') + ' of the token') : no('Wallet holds none of the token');
      }
    } catch (e) { no('Could not reach the RPC: ' + e.message); }
  }
  console.log('\n' + (bad ? bad + ' problem(s) to fix before going live.' : 'No blocking problems.') + (warn ? ' ' + warn + ' warning(s) worth reading.' : ''));
  process.exit(bad ? 1 : 0);
})();
