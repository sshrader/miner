'use strict';
// Pay Dirt devnet server. DEVNET ONLY.
// Holds a throwaway keypair (reward-wallet.json), decides rewards, and pays them to the connected wallet.
// Binds to 127.0.0.1 so only this computer can reach it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';               // use 0.0.0.0 on a host like Railway
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // set to 1 only when a trusted proxy (Railway) sits in front
const MAX_PER_IP = Math.max(0, Number(process.env.MAX_PER_IP) || 0);   // miners allowed per connection address; 0 = no limit
const IP_SWITCH_MS = Math.max(0, Number(process.env.IP_SWITCH_MINUTES === undefined ? 10 : process.env.IP_SWITCH_MINUTES)) * 60000;   // with MAX_PER_IP: how long a connection is tied to the last address it mined with
// Waiting queue: when the mine is full, people wait in line and are let in as places free up.
//   QUEUE_AGE_MINUTES  minutes in line that are worth as much as doubling your holding (default 10)
//   SHIFT_MINUTES      longest a miner stays while others wait (0 = no limit)
const QUEUE_AGE_MS = Math.max(0, Number(process.env.QUEUE_AGE_MINUTES === undefined ? 10 : process.env.QUEUE_AGE_MINUTES)) * 60000;
const SHIFT_MS = Math.max(0, Number(process.env.SHIFT_MINUTES) || 0) * 60000;
const MAX_QUEUE = 500;
// Auto scaling: with more miners digging, blocks take more hits, so a big crowd drains the pool no faster than a small one.
//   AUTO_SCALE=0 turns it off; REF_MINERS = crowd size at which blocks start getting harder (default 6); HARD_CAP = highest multiplier (default 30)
const AUTO_SCALE = process.env.AUTO_SCALE !== '0';
const REF_MINERS = Math.max(1, Number(process.env.REF_MINERS) || 6);
const HARD_CAP = Math.max(1, Number(process.env.HARD_CAP) || 30);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
// NETWORK=devnet (default) pays worthless test tokens. NETWORK=mainnet pays REAL funds and needs several explicit safeguards (see the README).
const NETWORK = String(process.env.NETWORK || 'devnet').toLowerCase();
if (NETWORK !== 'devnet' && NETWORK !== 'mainnet') { console.error('NETWORK must be devnet or mainnet.'); process.exit(1); }
const MAINNET = NETWORK === 'mainnet';
const RPC_URL = process.env.RPC_URL || (MAINNET ? '' : 'https://api.devnet.solana.com');
const POOL_SOL = parseFloat(process.env.POOL_SOL || '0.5');
// The Solana library is only needed for real devnet payouts. A dry run (--dry-run) works without installing it.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const LAMPORTS_PER_SOL = 1000000000;
let Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction;
if (!DRY_RUN) ({ Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js'));

// Token mode: rewards are paid in an SPL token (a throwaway DEVNET token while testing) instead of SOL.
//   TOKEN_MINT      the token's mint address (make one with: node make-token.js)
//   TOKEN_SYMBOL    shown in the page, e.g. TEST
//   POOL_TOKENS     most tokens to put in the pool (default: everything the reward wallet holds)
//   MIN_HOLD        tokens a wallet must hold to mine and to be paid (0 = no minimum)
//   MIN_REWARD_TOKENS  smallest single reward (default 1)
//   MAX_WALLET_PAYOUT  most tokens one wallet can win per 24 hours (0 = no cap)
// A dry run can pretend with DRY_TOKEN=1 (fake balances are set by the admin, see README).
const TOKEN_MINT = (process.env.TOKEN_MINT || '').trim();
const DRY_TOKEN = DRY_RUN && process.env.DRY_TOKEN === '1';
const TOKEN_MODE = !!TOKEN_MINT || DRY_TOKEN;
if (TOKEN_MINT && DRY_RUN) { console.error('TOKEN_MINT cannot be used with a dry run. Use DRY_TOKEN=1 to pretend.'); process.exit(1); }
const TOKEN_SYMBOL = (process.env.TOKEN_SYMBOL || (TOKEN_MODE ? 'TOKEN' : 'SOL')).replace(/[^A-Za-z0-9$]/g, '').slice(0, 10) || 'TOKEN';
let spl = null;
if (TOKEN_MINT) spl = require('@solana/spl-token');
let DEC = TOKEN_MODE ? 6 : 9;           // replaced by the mint's real decimals at startup
let tokenProgram = null;                // classic Token program or Token-2022, detected from the mint
let mintKey = null;
const UI = () => Math.pow(10, DEC);
const MIN_HOLD_UI = Math.max(0, Number(process.env.MIN_HOLD) || 0);
const MAX_WALLET_PAYOUT_UI = Math.max(0, Number(process.env.MAX_WALLET_PAYOUT) || 0);
const HOLD_REQUIRED = TOKEN_MODE && MIN_HOLD_UI > 0;
// By default anyone can paste an address and mine (rewards go to that address, so borrowing someone else's gains nothing).
// REQUIRE_SIGNATURE=1 makes every miner prove ownership with a wallet signature instead.
const REQUIRE_SIGNATURE = process.env.REQUIRE_SIGNATURE === '1';
const GENESIS = MAINNET ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// Difficulty presets. Easy is for testing; harder ones are for a live game. Any single setting can be overridden with its own variable.
//   perLevel = hidden rewards in every level; ALL of a level's rewards must be found before the next level unlocks
//   hardMult = multiplies the hits every block and floor takes
const PRESETS = {
  easy: { perLevel: 4, hardMult: 1 },
  normal: { perLevel: 8, hardMult: 1.5 },
  hard: { perLevel: 12, hardMult: 3 },
  brutal: { perLevel: 20, hardMult: 6 }
};
const DIFFICULTY = String(process.env.DIFFICULTY || 'easy').toLowerCase();
if (!PRESETS[DIFFICULTY]) { console.error('DIFFICULTY must be one of: ' + Object.keys(PRESETS).join(', ')); process.exit(1); }
const PRE = PRESETS[DIFFICULTY];
const PER_LEVEL = Math.max(1, Math.min(30, Number(process.env.REWARDS_PER_LEVEL) || PRE.perLevel));
const MAX_REWARDS = PER_LEVEL * 8;
const HARD_MULT = Math.max(1, Math.min(10, Number(process.env.HARD_MULT) || PRE.hardMult));
// Optional season end (e.g. SEASON_END=2026-12-31T23:59:00Z). After it the mine freezes and no more rewards are paid,
// so the leftover balance can be swept safely with: node sweep.js --to <address>
const SEASON_END = process.env.SEASON_END ? Date.parse(process.env.SEASON_END) : 0;
if (process.env.SEASON_END && !SEASON_END) { console.error('SEASON_END must be a date such as 2026-12-31T23:59:00Z'); process.exit(1); }
const seasonOver = () => SEASON_END > 0 && Date.now() >= SEASON_END;
let MIN_REWARD = 1000000;               // SOL mode: 0.001 SOL; also clears the rent minimum for a brand-new recipient account
let RESERVE = 2000000 + MAX_REWARDS * 5000; // SOL mode: keep rent minimum + fees in the reward wallet
let MIN_HOLD = 0, MAX_WALLET_PAYOUT = 0, POOL_CAP = Math.round(POOL_SOL * LAMPORTS_PER_SOL);
const SOL_PER_PAYOUT = 2600000;          // token mode: fee + the account rent a first-time recipient needs, paid by the reward wallet
function configureAsset() {
  if (!TOKEN_MODE) return;
  MIN_REWARD = Math.max(1, Math.round((Number(process.env.MIN_REWARD_TOKENS) || 1) * UI()));
  RESERVE = 0;
  MIN_HOLD = Math.round(MIN_HOLD_UI * UI());
  MAX_WALLET_PAYOUT = Math.round(MAX_WALLET_PAYOUT_UI * UI());
  POOL_CAP = process.env.POOL_TOKENS ? Math.round(Number(process.env.POOL_TOKENS) * UI()) : Infinity;
}
configureAsset();
// Admin actions (New pool, dry-run funding) need this key. Set ADMIN_KEY yourself, or a new random one is made each start.
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(18).toString('hex');
function isAdmin(req) {
  const got = Buffer.from(String(req.headers['x-admin-key'] || '')), want = Buffer.from(ADMIN_KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const WALLET_FILE = path.join(__dirname, 'reward-wallet.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function fatal(msg) { console.error('Refusing to start: ' + msg); process.exit(1); }
if (!MAINNET && /mainnet/i.test(RPC_URL)) fatal('RPC_URL looks like mainnet but NETWORK is devnet. Set NETWORK=mainnet on purpose, or use a devnet URL.');
if (MAINNET) {
  // Real money: every one of these must be a deliberate choice.
  if (DRY_RUN) fatal('a dry run cannot use NETWORK=mainnet.');
  if (process.env.CONFIRM_MAINNET !== 'yes-i-am-using-real-funds') fatal('NETWORK=mainnet also needs CONFIRM_MAINNET=yes-i-am-using-real-funds.');
  if (!RPC_URL) fatal('set RPC_URL to your mainnet RPC provider (the public endpoint is rate limited).');
  if (/devnet|testnet/i.test(RPC_URL)) fatal('RPC_URL looks like devnet or testnet but NETWORK is mainnet.');
  if (!process.env.ADMIN_KEY || process.env.ADMIN_KEY.length < 24) fatal('set ADMIN_KEY to a long random value (at least 24 characters).');
  if (!process.env.REWARD_WALLET_JSON && !fs.existsSync(path.join(__dirname, 'reward-wallet.json'))) fatal('no reward wallet. Set REWARD_WALLET_JSON (a wallet you funded yourself); a new one is never created on mainnet.');
  if (!(Number(process.env.MAX_PAYOUT_PER_HOUR) > 0)) fatal('set MAX_PAYOUT_PER_HOUR (most that can be paid out in any hour, in tokens or SOL) so a bug cannot drain the wallet.');
  if (!process.env.TRUST_PROXY && HOST !== '127.0.0.1') console.warn('WARNING: TRUST_PROXY is not set, so IP limits will see your proxy instead of visitors.');
}

function fakeAddress() {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let o = '';
  for (let i = 0; i < 44; i++) o += A[crypto.randomInt(A.length)];
  return o;
}
function loadWallet() {
  if (process.env.REWARD_WALLET_JSON) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.REWARD_WALLET_JSON)));   // for hosts without a persistent disk
  if (DRY_RUN) { const a = fakeAddress(); return { publicKey: { toBase58: () => a } }; }
  if (fs.existsSync(WALLET_FILE)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'))));
  }
  if (MAINNET) fatal('no reward wallet and a new one is never created on mainnet.');
  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log('Created a new throwaway DEVNET wallet in reward-wallet.json');
  return kp;
}

const payer = loadWallet();
const connection = DRY_RUN ? null : new Connection(RPC_URL, 'confirmed');
const explorer = 'https://explorer.solana.com';
const clusterQ = MAINNET ? '' : '?cluster=devnet';

let dryExtra = 0;   // dry run only: pretend fees arrived, see /api/dry-fund
const dryHolders = new Map();   // dry token mode: made-up holder balances (base units), set by the admin
let solCache = { at: 0, v: null };
let payerAta = null;
let _unused_dryExtra = 0;   // dry run only: pretend fees arrived, see /api/dry-fund
let balanceCache = { at: 0, v: null };
// What the pool is made of: lamports in SOL mode, token base units in token mode.
async function getBalance(force) {
  if (DRY_RUN) return (TOKEN_MODE ? Math.round((Number(process.env.POOL_TOKENS) || 1000) * UI()) : Math.round(POOL_SOL * LAMPORTS_PER_SOL) + RESERVE) + dryExtra;
  if (!force && Date.now() - balanceCache.at < 20000) return balanceCache.v;
  try {
    let v;
    if (TOKEN_MODE) {
      try { v = Number((await connection.getTokenAccountBalance(payerAta, 'confirmed')).value.amount); } catch (e) { v = 0; }   // no token account yet = nothing held
    } else v = await connection.getBalance(payer.publicKey, 'confirmed');
    balanceCache = { at: Date.now(), v };
  } catch (e) {
    balanceCache = { at: Date.now(), v: null };
  }
  return balanceCache.v;
}
// SOL in the reward wallet (token mode needs it for fees and for new recipients' token accounts).
async function getSol(force) {
  if (DRY_RUN) return 1 * LAMPORTS_PER_SOL;
  if (!force && Date.now() - solCache.at < 20000) return solCache.v;
  try { solCache = { at: Date.now(), v: await connection.getBalance(payer.publicKey, 'confirmed') }; } catch (e) { solCache = { at: Date.now(), v: null }; }
  return solCache.v;
}
// How much of the token a wallet holds right now, in base units. null when the network could not be asked.
async function holderBalance(address) {
  if (DRY_RUN) return dryHolders.get(address) || 0;
  try {
    const r = await connection.getParsedTokenAccountsByOwner(new PublicKey(address), { mint: mintKey }, 'confirmed');
    let t = 0;
    for (const a of r.value) t += Number(a.account.data.parsed.info.tokenAmount.amount);
    return t;
  } catch (e) { return null; }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The pool: `total` lamports split into `count` rewards, each hidden inside one specific block or floor of the shared mine.
// Deeper spots hold bigger shares. A miner is paid when it breaks the block that holds a reward.
const { createWorld, SLOTS, NN, N } = require('./world');
const LV = NN / N;
let pool = { total: 0, left: 0, cells: new Map() };
function levelOfKey(k) { return Math.floor((k >= NN ? k - NN : k) / N); }
let inflight = 0;     // rewards reserved for a payout that has not confirmed yet
let excess = 0;       // balance above the configured pool when it was built; ignored by top-ups
let avgReward = 0;
// Splits `total` lamports over the given reward cells; deeper cells get bigger shares and every reward is at least MIN_REWARD.
// Where rewards hide and how big they are must not be guessable, so these use the operating system's secure random source.
const secureRand = () => crypto.randomBytes(6).readUIntBE(0, 6) / 281474976710656;
function splitAmounts(keys, total) {
  const w = keys.map((k) => { const r = secureRand(); return (0.25 + r * r * 3) * (1 + 0.45 * levelOfKey(k)); });
  const sum = w.reduce((a, b) => a + b, 0), spare = total - keys.length * MIN_REWARD;
  const amts = w.map((x) => MIN_REWARD + Math.floor(spare * x / sum));
  amts[amts.indexOf(Math.max(...amts))] += total - amts.reduce((a, b) => a + b, 0);
  return amts;
}
const showAmt = (x) => (x / UI()).toFixed(TOKEN_MODE ? 2 : 4) + ' ' + TOKEN_SYMBOL;
let unlockedLv = 0;   // deepest level miners may reach right now
function levelCounts() { const c = new Array(LV).fill(0); pool.cells.forEach((_, k) => { c[levelOfKey(k)]++; }); return c; }
// A level opens the next one only when every reward hidden in it has been found.
function recomputeUnlock(reset) {
  const c = levelCounts();
  let u = 0;
  while (u < LV - 1 && c[u] === 0) u++;
  if (reset) unlockedLv = u; else if (u > unlockedLv) { unlockedLv = u; world.emit({ e: 'unlock', lv: u + 1 }); console.log('Level ' + (u + 1) + ' unlocked'); }
  world.setUnlocked(unlockedLv);
}
async function buildPool() {
  const bal = await getBalance(true);
  const total = bal == null ? 0 : Math.max(0, Math.min(POOL_CAP, bal - RESERVE));
  const count = Math.min(MAX_REWARDS, Math.floor(total / (2 * MIN_REWARD)));
  const cells = new Map();
  if (count > 0) {
    const per = new Array(LV).fill(0);
    for (let i = 0; i < count; i++) per[i % LV]++;   // spread evenly; the top levels get any remainder
    const keys = world.pickRewardCells(per);
    const amts = splitAmounts(keys, total);
    keys.forEach((k, i) => cells.set(k, amts[i]));
  }
  pool = { total, left: total, cells };
  excess = bal == null ? 0 : Math.max(0, bal - RESERVE - total);
  avgReward = cells.size ? total / cells.size : 0;
  recomputeUnlock(true);
  console.log(`Pool ready: ${showAmt(total)} hidden in ${cells.size} spots (difficulty ${DIFFICULTY}: ${PER_LEVEL} per level, blocks take ${HARD_MULT}x the hits, each level opens only when all its rewards are found)` + (DRY_RUN ? ' (dry run, nothing is sent)' : ''));
}

// Money that reached the reward wallet after the pool was built (creator fees, say) becomes new hidden rewards.
let TOPUP_MIN = Math.round((Number(process.env.TOPUP_MIN_SOL) || 0.01) * LAMPORTS_PER_SOL);
function configureTopup() { if (TOKEN_MODE) TOPUP_MIN = Math.round((Number(process.env.TOPUP_MIN_TOKENS) || 10 * (MIN_REWARD / UI())) * UI()); }
let toppingUp = false;
async function topUp() {
  if (toppingUp || pool.total === 0 || inflight > 0 || seasonOver()) return;
  toppingUp = true;
  try {
    const bal = await getBalance(true);
    if (bal == null || inflight > 0) return;
    const spare = bal - RESERVE - excess - pool.left;
    if (spare < TOPUP_MIN) return;
    const count = Math.max(1, Math.min(MAX_REWARDS, Math.round(spare / Math.max(avgReward, 2 * MIN_REWARD)), Math.floor(spare / (2 * MIN_REWARD))));
    const per = new Array(LV).fill(0), live = [];
    for (let l = unlockedLv; l < LV; l++) live.push(l);
    for (let i = 0; i < count; i++) per[live[i % live.length]]++;   // hidden on levels that are not cleared yet
    const keys = world.pickRewardCells(per);
    if (!keys.length) return;
    const amts = splitAmounts(keys, spare);
    keys.forEach((k, i) => pool.cells.set(k, amts[i]));
    pool.total += spare; pool.left += spare;
    world.emit({ e: 'topup', amt: spare, n: keys.length });
    console.log(`Pool topped up: +${showAmt(spare)} in ${keys.length} new spots`);
  } finally { toppingUp = false; }
}

async function state() {
  let bal = await getBalance(false);
  // Funded after startup? Build the pool automatically so no manual reset is needed.
  if (pool.total === 0 && bal != null && bal - RESERVE >= 2 * MIN_REWARD) { await buildPool(); bal = await getBalance(false); }
  return {
    devnet: true,   // true whenever this server (not the plain simulated page) answered; see `network` for the chain
    network: NETWORK,
    clusterQ,
    paused, pauseReason,
    limits: { perIp: MAX_PER_IP, walletCap: MAX_WALLET_PAYOUT, hourCap: MAX_PER_HOUR_UI > 0 ? MAX_PER_HOUR_UI * UI() : 0, switchMinutes: IP_SWITCH_MS / 60000 },
    hourPaid: MAX_PER_HOUR_UI > 0 ? hourTotal() : undefined, hourCap: MAX_PER_HOUR_UI * UI() || undefined,
    dryRun: DRY_RUN,
    asset: { token: TOKEN_MODE, sym: TOKEN_SYMBOL, dec: DEC },
    mint: TOKEN_MINT || null,
    holdRequired: HOLD_REQUIRED,
    requireSig: REQUIRE_SIGNATURE,
    minHold: MIN_HOLD,
    solBalance: TOKEN_MODE ? await getSol(false) : undefined,
    rewardWallet: payer.publicKey.toBase58(),
    balance: bal,
    poolTotal: pool.total,
    poolLeft: pool.left,
    rewardsLeft: pool.cells.size,
    needsFunding: pool.total === 0,
    miners: world.miners.size,
    maxMiners: SLOTS,
    queueLength: queue.size,
    hardMult: curHard,
    baseHardMult: HARD_MULT,
    autoScale: AUTO_SCALE,
    queueAgeMinutes: QUEUE_AGE_MS / 60000,
    shiftMinutes: SHIFT_MS / 60000,
    difficulty: DIFFICULTY,
    seasonEnd: SEASON_END || null,
    seasonOver: seasonOver(),
    unlocked: unlockedLv + 1,
    levelsLeft: levelCounts(),
    explorer
  };
}

async function pay(address, amount) {
  if (DRY_RUN) { dryExtra -= amount; return 'DRYRUN' + crypto.randomBytes(24).toString('hex'); }
  const owner = new PublicKey(address);
  if (!TOKEN_MODE) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner, lamports: amount }));
    return sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  }
  const sol = await getSol(true);
  if (sol != null && sol < SOL_PER_PAYOUT) throw new Error('The reward wallet is low on SOL for fees (' + (sol / LAMPORTS_PER_SOL).toFixed(4) + ' SOL left)');
  const dst = spl.getAssociatedTokenAddressSync(mintKey, owner, true, tokenProgram);
  const tx = new Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dst, owner, mintKey, tokenProgram),   // the reward wallet pays for a first-time recipient's token account
    spl.createTransferCheckedInstruction(payerAta, mintKey, dst, payer.publicKey, BigInt(amount), DEC, [], tokenProgram)
  );
  return sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
}

const sessions = new Map();
const clients = new Set();
function hashStr(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

// Called by the shared mine for every block or floor a miner breaks. The server alone decides which digs pay.
// Global safety valves: an hourly payout ceiling, an admin pause, and an automatic pause after repeated payout failures.
const MAX_PER_HOUR_UI = Number(process.env.MAX_PAYOUT_PER_HOUR) || 0;   // in tokens or SOL; 0 = no ceiling (devnet only)
const FAIL_PAUSE = Math.max(1, Math.floor(Number(process.env.PAUSE_AFTER_FAILURES) || 5));
let paused = false, pauseReason = '', failStreak = 0;
const recentPays = [];   // { t, amt } of rewards reserved in the last hour
function hourTotal() { const cut = Date.now() - 3600000; while (recentPays.length && recentPays[0].t < cut) recentPays.shift(); return recentPays.reduce((a, r) => a + r.amt, 0); }
function setPaused(on, why) {
  if (paused === on) return;
  paused = on; pauseReason = on ? (why || 'Paused by the admin') : ''; failStreak = 0;
  console.log(on ? 'PAYOUTS PAUSED: ' + pauseReason : 'Payouts resumed');
  try { world.emit({ e: on ? 'paused' : 'resumed', msg: pauseReason }); } catch (e) { /* ignore */ }
}
const STATE_FILE = process.env.STATE_FILE || '';   // e.g. /data/state.json on a Railway volume; empty = nothing is saved
const SAVE_EVERY_MS = 10000;
let saveDirty = false;
function saveState() {
  if (!STATE_FILE) return;
  try {
    const st = {
      v: 1, network: NETWORK, wallet: payer.publicKey.toBase58(), mint: TOKEN_MINT || null, savedAt: Date.now(),
      world: world.exportState(), pool: { total: pool.total, left: pool.left, cells: Array.from(pool.cells.entries()) },
      avgReward, excess, unlockedLv, paused, pauseReason, muted: Array.from(muted), paidBy: Array.from(paidBy.entries()), recentPays: recentPays.slice(),
    };
    fs.mkdirSync(path.dirname(path.resolve(STATE_FILE)), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, STATE_FILE);   // replace in one step, so a crash never leaves half a file
    saveDirty = false;
  } catch (e) { console.error('Could not save state: ' + e.message); }
}
// Returns true when the saved mine and pool were restored. Anything odd (other wallet, other network, pool bigger than the wallet) falls back to a fresh pool.
async function loadState() {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return false;
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (st.v !== 1 || st.network !== NETWORK || (!DRY_RUN && st.wallet !== payer.publicKey.toBase58()) || (st.mint || null) !== (TOKEN_MINT || null)) { console.log('Saved state belongs to a different wallet or network; starting fresh.'); return false; }
    const bal = await getBalance(true);
    if (bal == null) { console.log('Could not read the wallet balance; starting fresh instead of trusting the saved state.'); return false; }
    const left = Number(st.pool.left) || 0;
    if (left > bal - RESERVE) { console.log('The wallet holds less than the saved pool (it was swept or spent); starting fresh.'); return false; }
    if (!world.importState(st.world)) { console.log('Saved cave is unreadable; starting fresh.'); return false; }
    pool = { total: Number(st.pool.total) || 0, left, cells: new Map(st.pool.cells.map(([k, v]) => [Number(k), Number(v)])) };
    avgReward = Number(st.avgReward) || 0;
    excess = Math.max(0, bal - RESERVE - left);   // anything above the saved pool counts as new money for top-ups
    excess = Math.min(excess, Number(st.excess) || 0);
    unlockedLv = Number(st.unlockedLv) || 0; world.setUnlocked(unlockedLv); recomputeUnlock();
    paused = !!st.paused; pauseReason = st.pauseReason || '';
    (st.muted || []).forEach((a) => muted.add(a));
    (st.paidBy || []).forEach(([a, r]) => paidBy.set(a, r));
    (st.recentPays || []).forEach((r) => recentPays.push(r));
    console.log(`Restored saved mine: ${showAmt(pool.left)} left in ${pool.cells.size} hidden spots` + (paused ? ' (payouts are PAUSED)' : ''));
    return true;
  } catch (e) { console.log('Could not read saved state (' + e.message + '); starting fresh.'); return false; }
}
const paidBy = new Map();   // address -> { amt, since } for the per-wallet cap
function sessionOfMiner(id) { for (const [sid, s2] of sessions) if (s2.minerId === id) return [sid, s2]; return [null, null]; }
class HoldError extends Error {}
function onDig(m, info) {
  const key = info.kind === 'floor' ? NN + info.g : info.g;
  const amt = pool.cells.get(key) || 0;
  if (!amt) return 0;
  if (paused) return 0;   // digging goes on, rewards stay hidden until payouts resume
  if (MAX_PER_HOUR_UI > 0 && hourTotal() + amt > MAX_PER_HOUR_UI * UI()) return 0;
  const [sid, sess] = sessionOfMiner(m.id);
  // A wallet below the minimum holding, or over its cap, digs the block but the reward stays hidden for someone else.
  if (HOLD_REQUIRED && (!sess || sess.hold == null || sess.hold < MIN_HOLD)) return 0;
  let rec = paidBy.get(m.addr);
  if (!rec || Date.now() - rec.since > 86400000) { rec = { amt: 0, since: Date.now() }; paidBy.set(m.addr, rec); }
  if (MAX_WALLET_PAYOUT > 0 && rec.amt + amt > MAX_WALLET_PAYOUT) return 0;
  pool.cells.delete(key);
  recomputeUnlock();
  recentPays.push({ t: Date.now(), amt });
  pool.left -= amt;   // reserved right away so two miners can never be paid the same reward
  rec.amt += amt;
  inflight += amt;
  const go = async () => {
    if (HOLD_REQUIRED) {   // look again right before sending, so buying, collecting and selling straight away does not work
      const now = await holderBalance(m.addr);
      if (now == null || now < MIN_HOLD) throw new HoldError('Your ' + TOKEN_SYMBOL + ' balance is below the minimum, so the reward went back into the mine.');
    }
    return pay(m.addr, amt);
  };
  go().then((sig) => {
    failStreak = 0;
    inflight -= amt;
    balanceCache.at = 0;
    world.emit({ e: 'paid', by: m.id, amt, sig });
    console.log(`Paid ${showAmt(amt)} to ${m.addr} ${sig}`);
  }).catch((err) => {
    inflight -= amt;
    rec.amt -= amt;
    { const i = recentPays.findIndex((r) => r.amt === amt); if (i >= 0) recentPays.splice(i, 1); }
    pool.left += amt;
    const per = new Array(LV).fill(0); per[levelOfKey(key)] = 1;
    const again = world.pickRewardCells(per);   // put the unpaid reward back into a fresh hiding spot on the same level
    if (again.length) pool.cells.set(again[0], amt);
    const hold = err instanceof HoldError;
    const msg = hold ? err.message : 'Payout failed, will retry on a later dig: ' + String((err && err.message) || err).slice(0, 140);
    world.emit({ e: 'perr', by: m.id, msg });
    console.error(msg);
    if (!(err instanceof HoldError) && ++failStreak >= FAIL_PAUSE) setPaused(true, 'Payouts paused automatically after ' + failStreak + ' failures in a row.');
    if (hold && sid) kick(sid, 'Removed from the mine: your ' + TOKEN_SYMBOL + ' balance is below the minimum.');
  });
  return amt;
}
const world = createWorld({
  rand: secureRand,
  onDig,
  // The mine was dug out and rebuilt: hide the rewards that are left in the new cave.
  onRegen() {
    const byLevel = Array.from({ length: LV }, () => []);
    pool.cells.forEach((amt, k) => byLevel[levelOfKey(k)].push(amt));
    pool.cells.clear();
    const keys = world.pickRewardCells(byLevel.map((a) => a.length));
    const used = new Array(LV).fill(0);
    keys.forEach((k) => { const l = levelOfKey(k); pool.cells.set(k, byLevel[l][used[l]++]); });
    recomputeUnlock(true);
  }
}, { hardMult: HARD_MULT });
let curHard = HARD_MULT;
function scaleHardness() {
  if (!AUTO_SCALE) return;
  const n = world.miners.size;
  const target = Math.min(Math.max(HARD_MULT, HARD_CAP), HARD_MULT * Math.max(1, n / REF_MINERS));
  const rounded = Math.round(Math.min(target, HARD_CAP) * 4) / 4;   // steps of 0.25 so it does not flicker
  const next = Math.max(HARD_MULT, rounded);
  if (Math.abs(next - curHard) >= 0.25) { curHard = next; world.setHardMult(curHard); console.log(`Block hardness x${curHard} for ${n} miners`); }
}

const kicked = new Map();   // sessionId -> reason, so the page can say why
function kick(sid, reason) { kicked.set(sid, reason); setTimeout(() => kicked.delete(sid), 120000); dropSession(sid); }
const ipLast = new Map();   // ip -> { address, at }: the last address a connection mined with
function dropSession(sid) {
  const sess = sessions.get(sid);
  if (!sess) return;
  if (sess.ip) ipLast.set(sess.ip, { address: sess.address, at: Date.now() });
  sessions.delete(sid);
  world.removeMiner(sess.minerId);
  console.log('Miner ' + sess.minerId + ' left: ' + sess.address);
  setImmediate(() => { promote().catch(() => {}); });   // a place just opened: let the next person in line in
}
function tickMsg(ev) {
  return { t: 'tick', hm: curHard, m: world.minersSnap(), ev, pool: { left: pool.left, rewards: pool.cells.size, unlocked: unlockedLv + 1, lv: levelCounts(), over: seasonOver() } };
}
function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const c of clients) { try { c.write(line); } catch (e) { clients.delete(c); } }
}

// Chat: kept in memory, last 100 messages. Everyone connected to this server sees the same chat.
const chat = [];
let chatSeq = 0;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  let lead = 0; for (const c of str) { if (c === '1') lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}
// Checks an ed25519 signature made by a Solana wallet over a text message.
function verifySig(address, message, sigB64) {
  const pub = b58decode(address);
  if (pub.length !== 32) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sigB64, 'base64'));
}
function checkAddr(a) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) throw new Error('bad'); return a; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4096) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(b);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// The address a request really came from. Behind a trusted proxy that is the first X-Forwarded-For entry.
function ipOf(req) {
  let ip = '';
  if (TRUST_PROXY) ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim();
  if (!ip) ip = req.socket.remoteAddress || '';
  ip = ip.replace(/^::ffff:/, '');
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':');   // one IPv6 customer owns a whole /64
  return ip;
}
const challenges = new Map();   // address -> { message, at }; each is single use and expires after 2 minutes
const queue = new Map();          // ticket -> { address, ip, hold, proven, since, last }
const queueResults = new Map();  // ticket -> { result, at }, so a client that missed the answer can ask again
// Higher holdings and longer waits move you up: every doubling of your holding (above the minimum) is worth QUEUE_AGE_MINUTES in line.
function queueScore(e, now) {
  const base = MIN_HOLD > 0 ? MIN_HOLD : UI();
  const holdPts = TOKEN_MODE && e.hold ? Math.log2(e.hold / base + 1) : 0;
  const waitPts = QUEUE_AGE_MS > 0 ? (now - e.since) / QUEUE_AGE_MS : 0;
  return holdPts + waitPts;
}
function queueOrder() {
  const now = Date.now();
  return Array.from(queue.entries()).sort((a, b) => queueScore(b[1], now) - queueScore(a[1], now) || a[1].since - b[1].since);
}
function admitSession(e) {
  const miner = world.addMiner(e.address, hashStr(e.address) % 360);
  if (!miner) return null;
  const id = crypto.randomBytes(12).toString('hex');
  sessions.set(id, { address: e.address, minerId: miner.id, last: Date.now(), ip: e.ip, hold: e.hold, holdAt: Date.now(), verified: e.proven, joinedAt: Date.now() });
  console.log('Miner ' + miner.id + ' joined: ' + e.address);
  return { sessionId: id, minerId: miner.id, verified: e.proven };
}
let promoting = false;
async function promote() {
  if (promoting) return;
  promoting = true;
  try {
    while (queue.size && world.miners.size < SLOTS) {
      const [ticket, e] = queueOrder()[0];
      queue.delete(ticket);
      if (HOLD_REQUIRED) {
        const bal = await holderBalance(e.address);
        if (bal == null || bal < MIN_HOLD) { queueResults.set(ticket, { at: Date.now(), result: { failed: 'Your ' + TOKEN_SYMBOL + ' balance is now below the minimum, so you were taken out of the line.' } }); continue; }
        e.hold = bal;
      }
      let dup = false;
      for (const s2 of sessions.values()) if (s2.address === e.address) dup = true;
      if (dup) { queueResults.set(ticket, { at: Date.now(), result: { failed: 'That address is already mining.' } }); continue; }
      const r = admitSession(e);
      if (!r) { queue.set(ticket, e); break; }
      queueResults.set(ticket, { at: Date.now(), result: r });
    }
  } finally { promoting = false; }
}
const joinLog = new Map();   // ip -> recent join times, to slow down hammering
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (MAINNET) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
const streamsByIp = new Map();
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP) || 6, MAX_STREAMS = Number(process.env.MAX_STREAMS) || 400;
const muted = new Set();   // wallet addresses that may not chat
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    setSecurityHeaders(res);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, paused, miners: world.miners.size });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}` && !ALLOWED_ORIGINS.includes(origin)) return send(res, 403, { error: 'Bad origin' });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const sip = ipOf(req);
      if (clients.size >= MAX_STREAMS || (streamsByIp.get(sip) || 0) >= MAX_STREAMS_PER_IP) return send(res, 429, { error: 'Too many open views' });
      streamsByIp.set(sip, (streamsByIp.get(sip) || 0) + 1);
      req.on('close', () => { const n = (streamsByIp.get(sip) || 1) - 1; if (n > 0) streamsByIp.set(sip, n); else streamsByIp.delete(sip); });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(world.worldMsg()) + '\n\n');
      res.write('data: ' + JSON.stringify(tickMsg([])) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await state());
    if (url.pathname === '/api/challenge' && req.method === 'POST') {
      const body = await readBody(req);
      let a; try { a = checkAddr(String(body.address)); } catch (e) { return send(res, 400, { error: 'Invalid wallet address' }); }
      const message = 'Pay Dirt ' + NETWORK + ': I want to mine with wallet ' + a + '. Nonce ' + crypto.randomBytes(8).toString('hex') + '. This is a message, not a transaction.';
      if (challenges.size > 5000) challenges.clear();
      challenges.set(a, { message, at: Date.now() });
      return send(res, 200, { message });
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      let addr;
      try { addr = DRY_RUN ? checkAddr(String(body.address)) : new PublicKey(String(body.address)).toBase58(); } catch (e) { return send(res, 400, { error: 'Invalid wallet address' }); }
      const ip = ipOf(req), nowMs = Date.now();
      const recent = (joinLog.get(ip) || []).filter((t) => nowMs - t < 60000);
      if (recent.length >= 10) return send(res, 429, { error: 'Too many join attempts. Wait a minute.' });
      recent.push(nowMs); joinLog.set(ip, recent);
      if (MAX_PER_IP > 0) {
        let n = 0;
        for (const s2 of sessions.values()) if (s2.ip === ip && s2.address !== addr) n++;
        for (const q2 of queue.values()) if (q2.ip === ip && q2.address !== addr) n++;
        if (n >= MAX_PER_IP) return send(res, 429, { error: 'Only ' + MAX_PER_IP + (MAX_PER_IP === 1 ? ' miner is' : ' miners are') + ' allowed per connection. Disconnect your other wallet first.' });
      }
      if (MAX_PER_IP > 0 && IP_SWITCH_MS > 0) {
        const last = ipLast.get(ip), wait = last ? IP_SWITCH_MS - (nowMs - last.at) : 0;
        if (last && last.address !== addr && wait > 0) return send(res, 429, { error: 'This connection recently mined as ' + last.address.slice(0, 4) + '…' + last.address.slice(-4) + '. Use that address, or wait ' + Math.ceil(wait / 60000) + ' minute' + (wait > 60000 ? 's' : '') + ' to switch.' });
      }
      // A signature proves the address belongs to the person asking. It is optional unless REQUIRE_SIGNATURE=1.
      let hold = null, proven = false;
      const ch = challenges.get(addr);
      challenges.delete(addr);
      if (body.signature && !DRY_RUN) {
        let ok = false;
        try { ok = !!ch && Date.now() - ch.at < 120000 && verifySig(addr, ch.message, String(body.signature)); } catch (e) { ok = false; }
        if (!ok) return send(res, 403, { error: 'That signature did not check out. Try again.' });
        proven = true;
      } else if (REQUIRE_SIGNATURE && !DRY_RUN) {
        return send(res, 403, { error: 'Please connect your wallet and sign the message to prove you own this address.' });
      }
      if (HOLD_REQUIRED) {
        hold = await holderBalance(addr);
        if (hold == null) return send(res, 503, { error: 'Could not check your ' + TOKEN_SYMBOL + ' balance right now. Try again in a moment.' });
        if (hold < MIN_HOLD) return send(res, 403, { error: 'You need at least ' + (MIN_HOLD / UI()).toLocaleString('en-US') + ' ' + TOKEN_SYMBOL + ' to mine. This wallet holds ' + (hold / UI()).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '.' });
      }
      // One miner per wallet. The same person coming back (same connection, or proven by signature) replaces their old miner.
      // Someone else pasting an address that is already mining is turned away, so nobody can kick a holder out of the mine.
      for (const [sid, s2] of sessions) {
        if (s2.address !== addr) continue;
        if (!proven && s2.ip !== ip) return send(res, 409, { error: 'That address is already mining. If it is yours on another device, connect your wallet and sign to take over.' });
        dropSession(sid);
      }
      for (const [tk, q2] of queue) {
        if (q2.address !== addr) continue;
        if (!proven && q2.ip !== ip) return send(res, 409, { error: 'That address is already waiting in line. If it is yours on another device, connect your wallet and sign to take over.' });
        queue.delete(tk);
      }
      const entry = { address: addr, ip, hold, proven, since: Date.now(), last: Date.now() };
      if (world.miners.size < SLOTS && queue.size === 0) {
        const r = admitSession(entry);
        if (r) return send(res, 200, r);
      }
      if (queue.size >= MAX_QUEUE) return send(res, 503, { error: 'The mine and the waiting line are both full. Try again later.' });
      const ticket = crypto.randomBytes(12).toString('hex');
      queue.set(ticket, entry);
      promote();
    scaleHardness();
      const order = queueOrder().map((x) => x[0]);
      console.log('Queued: ' + addr + ' (#' + (order.indexOf(ticket) + 1) + ')');
      return send(res, 200, { queued: true, ticket, position: order.indexOf(ticket) + 1, size: queue.size });
    }
    if (url.pathname === '/api/queue' && req.method === 'POST') {
      const body = await readBody(req), ticket = String(body.ticket);
      const done = queueResults.get(ticket);
      if (done) return send(res, 200, done.result.failed ? { failed: done.result.failed } : { promoted: true, ...done.result });
      const e = queue.get(ticket);
      if (!e) return send(res, 404, { error: 'Unknown ticket' });
      e.last = Date.now();
      const order = queueOrder().map((x) => x[0]);
      return send(res, 200, { queued: true, position: order.indexOf(ticket) + 1, size: queue.size });
    }
    if (url.pathname === '/api/ping' && req.method === 'POST') {
      const body = await readBody(req);
      const sess = sessions.get(String(body.sessionId));
      if (!sess) return send(res, 404, { error: 'Unknown session' + (kicked.has(String(body.sessionId)) ? '. ' + kicked.get(String(body.sessionId)) : '') });
      sess.last = Date.now();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/leave' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.ticket) queue.delete(String(body.ticket));
      if (body.sessionId) dropSession(String(body.sessionId));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/chat' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, { messages: chat.filter((m) => m.id > since), last: chatSeq });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const sess = sessions.get(String(body.sessionId));
      if (!sess) return send(res, 404, { error: 'Unknown session' });
      const text = String(body.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
      if (!text) return send(res, 400, { error: 'Empty message' });
      if (muted.has(sess.address)) return send(res, 403, { error: 'You have been muted' });
      if (/https?:|www\.|[a-z0-9-]+\.(com|net|org|io|xyz|app|gg|me|sol|fun|ly|co)\b/i.test(text)) return send(res, 400, { error: 'Links are not allowed in chat' });
      const now = Date.now();
      if (now - (sess.lastChat || 0) < 1500) return send(res, 429, { error: 'Slow down a little' });
      sess.lastChat = now;
      chat.push({ id: ++chatSeq, addr: sess.address, verified: !!sess.verified, text, ts: now });
      if (chat.length > 100) chat.shift();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/verify-start' && req.method === 'POST') {
      const body = await readBody(req);
      const sess = sessions.get(String(body.sessionId));
      if (!sess) return send(res, 404, { error: 'Unknown session' });
      sess.challenge = 'Pay Dirt ' + NETWORK + ': I own wallet ' + sess.address + '. Nonce ' + crypto.randomBytes(8).toString('hex') + '. This is a message, not a transaction.';
      return send(res, 200, { message: sess.challenge });
    }
    if (url.pathname === '/api/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const sess = sessions.get(String(body.sessionId));
      if (!sess || !sess.challenge) return send(res, 404, { error: 'No verification in progress' });
      if (DRY_RUN) return send(res, 400, { error: 'Dry run uses made-up addresses, so there is nothing to verify.' });
      let ok = false;
      try { ok = verifySig(sess.address, sess.challenge, String(body.signature)); } catch (e) { ok = false; }
      if (!ok) return send(res, 400, { error: 'That signature does not match this wallet.' });
      sess.verified = true; sess.challenge = null;
      return send(res, 200, { verified: true });
    }
    if (url.pathname === '/api/admin-check' && req.method === 'POST') return send(res, isAdmin(req) ? 200 : 403, { admin: isAdmin(req) });
    if ((url.pathname === '/api/dry-fund' || url.pathname === '/api/dry-holder' || url.pathname === '/api/reset-pool' || url.pathname === '/api/pause' || url.pathname === '/api/mute') && req.method === 'POST' && !isAdmin(req)) return send(res, 403, { error: 'Admin only' });
    if (url.pathname === '/api/dry-holder' && req.method === 'POST' && DRY_RUN) {
      const body = await readBody(req);
      dryHolders.set(String(body.address), Math.round((Number(body.amount) || 0) * UI()));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/dry-fund' && req.method === 'POST' && DRY_RUN) {
      const body = await readBody(req);
      dryExtra += Math.round((Number(body.sol) || Number(body.amount) || 0) * (TOKEN_MODE ? UI() : LAMPORTS_PER_SOL));
      await topUp();
      return send(res, 200, await state());
    }
    if (url.pathname === '/api/mute' && req.method === 'POST') {
      const body = await readBody(req);
      const a = String(body.address || '').trim();
      if (!a) return send(res, 400, { error: 'address required' });
      if (body.off) muted.delete(a); else { muted.add(a); if (body.kick) for (const [sid, s2] of sessions) if (s2.address === a) kick(sid, 'Removed from the mine by the admin.'); }
      return send(res, 200, { muted: Array.from(muted) });
    }
    if (url.pathname === '/api/pause' && req.method === 'POST') {
      const body = await readBody(req);
      setPaused(body.paused !== false, 'Paused by the admin');
      return send(res, 200, await state());
    }
    if (url.pathname === '/api/reset-pool' && req.method === 'POST') {
      await buildPool();
      return send(res, 200, await state());
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});

(async function main() {
  if (!DRY_RUN) {
    try {
      const g = await connection.getGenesisHash();
      if (g !== GENESIS) { console.error('Refusing to start: that RPC is not Solana ' + NETWORK + '.'); process.exit(1); }
    } catch (e) {
      if (MAINNET) fatal('could not reach the RPC to confirm it is mainnet.');
      console.warn('Could not reach the RPC to verify devnet (' + RPC_URL + '). Continuing; payouts will fail until it is reachable.');
    }
  }
  if (TOKEN_MINT) {
    try {
      mintKey = new PublicKey(TOKEN_MINT);
      const info = await connection.getAccountInfo(mintKey, 'confirmed');
      if (!info) { console.error('That mint does not exist on ' + NETWORK + ': ' + TOKEN_MINT); process.exit(1); }
      tokenProgram = info.owner;
      const mint = await spl.getMint(connection, mintKey, 'confirmed', tokenProgram);
      DEC = mint.decimals;
      payerAta = spl.getAssociatedTokenAddressSync(mintKey, payer.publicKey, true, tokenProgram);
    } catch (e) { console.error('Could not read the token from ' + NETWORK + ': ' + e.message); process.exit(1); }
  }
  configureAsset();
  configureTopup();
  if (TOKEN_MODE) console.log(`Token mode: paying ${TOKEN_SYMBOL}${TOKEN_MINT ? ' (' + TOKEN_MINT + ')' : ' (dry run)'}, ${DEC} decimals. Minimum holding: ${HOLD_REQUIRED ? (MIN_HOLD / UI()).toLocaleString('en-US') + ' ' + TOKEN_SYMBOL : 'none'}.`);
  if (!(await loadState())) await buildPool();
  if (STATE_FILE) {
    setInterval(saveState, SAVE_EVERY_MS);
    const bye = () => { saveState(); process.exit(0); };
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
    saveState();
  } else if (MAINNET) console.log('WARNING: STATE_FILE is not set, so a restart forgets the mine and the per-wallet limits. Put it on a persistent volume.');
  let lastT = Date.now(), n = 0;
  setInterval(() => {
    const now = Date.now(), dt = Math.min(0.2, (now - lastT) / 1000);
    lastT = now;
    if (!seasonOver()) world.tick(dt);
    if (++n % 2 === 0 && clients.size) {
      if (world.takeWorldDirty()) broadcast(world.worldMsg());
      broadcast(tickMsg(world.flush()));
    } else if (!clients.size) world.flush();
  }, 50);
  setInterval(() => {
    const now = Date.now();
    for (const [sid, sess] of sessions) if (now - sess.last > 20000) dropSession(sid);
    for (const [tk, e] of queue) if (now - e.last > 20000) queue.delete(tk);
    for (const [tk, r] of queueResults) if (now - r.at > 60000) queueResults.delete(tk);
    if (SHIFT_MS > 0 && queue.size > 0 && world.miners.size >= SLOTS) {   // full and people are waiting: rotate out whoever has mined longest
      const oldest = Array.from(sessions.entries()).filter(([, s2]) => now - s2.joinedAt > SHIFT_MS).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      const need = Math.min(queue.size, oldest.length);
      for (let i = 0; i < need; i++) kick(oldest[i][0], 'Removed from the mine: your shift is over and others are waiting. Join the line to come back.');
    }
    promote();
    for (const c of clients) { try { c.write(': keepalive\n\n'); } catch (e) { clients.delete(c); } }
  }, 5000);
  // Holders are re-checked every minute; a wallet that dropped below the minimum is removed from the mine.
  if (HOLD_REQUIRED) setInterval(async () => {
    for (const [sid, sess] of Array.from(sessions)) {
      const now = await holderBalance(sess.address);
      if (now == null) continue;
      sess.hold = now; sess.holdAt = Date.now();
      if (now < MIN_HOLD) kick(sid, 'Removed from the mine: your ' + TOKEN_SYMBOL + ' balance is below the minimum.');
    }
  }, Number(process.env.HOLD_RECHECK_MS) || 120000);
  setInterval(() => { topUp().catch((e) => console.error('Top-up check failed: ' + e.message)); }, Number(process.env.TOPUP_EVERY_MS) || 30000);
  server.listen(PORT, HOST, () => {
    if (HOST !== '127.0.0.1' && !MAX_PER_IP) console.log('WARNING: the server is reachable from outside but MAX_PER_IP is not set.');
    console.log('');
    console.log('Pay Dirt (' + NETWORK + ') running at http://127.0.0.1:' + PORT);
    console.log('Admin link (keep private): ' + (ALLOWED_ORIGINS[0] || 'http://127.0.0.1:' + PORT) + '/#admin=' + ADMIN_KEY);
    console.log('Reward wallet (send ' + NETWORK.toUpperCase() + ' ' + (TOKEN_MODE ? TOKEN_SYMBOL + ' and a little SOL for fees' : 'SOL') + ' here): ' + payer.publicKey.toBase58());
    if (pool.total === 0) console.log(TOKEN_MODE ? 'The pool is empty. Send the token (node make-token.js does this) and some SOL to the reward wallet; the pool builds itself.' : 'The wallet needs devnet SOL. Fund it at https://faucet.solana.com (network: devnet); the pool builds itself.');
  });
})();
