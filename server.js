'use strict';
// Bedrock Bots devnet server. DEVNET ONLY.
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
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
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
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

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

if (/mainnet/i.test(RPC_URL)) {
  console.error('Refusing to start: RPC_URL looks like mainnet. This project is devnet only.');
  process.exit(1);
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
  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log('Created a new throwaway DEVNET wallet in reward-wallet.json');
  return kp;
}

const payer = loadWallet();
const connection = DRY_RUN ? null : new Connection(RPC_URL, 'confirmed');
const explorer = 'https://explorer.solana.com';

let dryExtra = 0;   // dry run only: pretend fees arrived, see /api/dry-fund
const dryHolders = new Map();   // dry token mode: made-up holder balances (base units), set by the admin
let solCache = { at: 0, v: null };
let payerAta = null;
let _unused_dryExtra = 0;   // dry run only: pretend fees arrived, see /api/dry-fund
let balanceCache = { at: 0, v: null };
// What the pool is made of: lamports in SOL mode, token base units in token mode.
async function getBalance(force) {
  if (DRY_RUN) return (TOKEN_MODE ? Math.round((Number(process.env.POOL_TOKENS) || 1000) * UI()) : Math.round(POOL_SOL * LAMPORTS_PER_SOL) + RESERVE) + dryExtra;
  if (!force && Date.now() - balanceCache.at < 8000) return balanceCache.v;
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
  if (!force && Date.now() - solCache.at < 8000) return solCache.v;
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
function splitAmounts(keys, total) {
  const w = keys.map((k) => { const r = Math.random(); return (0.25 + r * r * 3) * (1 + 0.45 * levelOfKey(k)); });
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
    devnet: true,
    dryRun: DRY_RUN,
    asset: { token: TOKEN_MODE, sym: TOKEN_SYMBOL, dec: DEC },
    mint: TOKEN_MINT || null,
    holdRequired: HOLD_REQUIRED,
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
const paidBy = new Map();   // address -> { amt, since } for the per-wallet cap
function sessionOfMiner(id) { for (const [sid, s2] of sessions) if (s2.minerId === id) return [sid, s2]; return [null, null]; }
class HoldError extends Error {}
function onDig(m, info) {
  const key = info.kind === 'floor' ? NN + info.g : info.g;
  const amt = pool.cells.get(key) || 0;
  if (!amt) return 0;
  const [sid, sess] = sessionOfMiner(m.id);
  // A wallet below the minimum holding, or over its cap, digs the block but the reward stays hidden for someone else.
  if (HOLD_REQUIRED && (!sess || sess.hold == null || sess.hold < MIN_HOLD)) return 0;
  let rec = paidBy.get(m.addr);
  if (!rec || Date.now() - rec.since > 86400000) { rec = { amt: 0, since: Date.now() }; paidBy.set(m.addr, rec); }
  if (MAX_WALLET_PAYOUT > 0 && rec.amt + amt > MAX_WALLET_PAYOUT) return 0;
  pool.cells.delete(key);
  recomputeUnlock();
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
    inflight -= amt;
    balanceCache.at = 0;
    world.emit({ e: 'paid', by: m.id, amt, sig });
    console.log(`Paid ${showAmt(amt)} to ${m.addr} ${sig}`);
  }).catch((err) => {
    inflight -= amt;
    rec.amt -= amt;
    pool.left += amt;
    const per = new Array(LV).fill(0); per[levelOfKey(key)] = 1;
    const again = world.pickRewardCells(per);   // put the unpaid reward back into a fresh hiding spot on the same level
    if (again.length) pool.cells.set(again[0], amt);
    const hold = err instanceof HoldError;
    const msg = hold ? err.message : 'Payout failed, will retry on a later dig: ' + String((err && err.message) || err).slice(0, 140);
    world.emit({ e: 'perr', by: m.id, msg });
    console.error(msg);
    if (hold && sid) kick(sid, 'Removed from the mine: your ' + TOKEN_SYMBOL + ' balance is below the minimum.');
  });
  return amt;
}
const world = createWorld({
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

const kicked = new Map();   // sessionId -> reason, so the page can say why
function kick(sid, reason) { kicked.set(sid, reason); setTimeout(() => kicked.delete(sid), 120000); dropSession(sid); }
function dropSession(sid) {
  const sess = sessions.get(sid);
  if (!sess) return;
  sessions.delete(sid);
  world.removeMiner(sess.minerId);
  console.log('Miner ' + sess.minerId + ' left: ' + sess.address);
}
function tickMsg(ev) {
  return { t: 'tick', m: world.minersSnap(), ev, pool: { left: pool.left, rewards: pool.cells.size, unlocked: unlockedLv + 1, lv: levelCounts(), over: seasonOver() } };
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
const joinLog = new Map();   // ip -> recent join times, to slow down hammering
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}` && !ALLOWED_ORIGINS.includes(origin)) return send(res, 403, { error: 'Bad origin' });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
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
      const message = 'Bedrock Bots devnet: I want to mine with wallet ' + a + '. Nonce ' + crypto.randomBytes(8).toString('hex') + '. This is a message, not a transaction.';
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
        if (n >= MAX_PER_IP) return send(res, 429, { error: 'Only ' + MAX_PER_IP + (MAX_PER_IP === 1 ? ' miner is' : ' miners are') + ' allowed per connection. Disconnect your other wallet first.' });
      }
      // Mines that pay a token check who is asking (a signature) and what they hold.
      let hold = null, proven = false;
      if (HOLD_REQUIRED) {
        if (!DRY_RUN) {
          const ch = challenges.get(addr);
          challenges.delete(addr);
          let ok = false;
          try { ok = !!ch && Date.now() - ch.at < 120000 && verifySig(addr, ch.message, String(body.signature || '')); } catch (e) { ok = false; }
          if (!ok) return send(res, 403, { error: 'Please sign the message in your wallet to prove you own this address.' });
          proven = true;
        }
        hold = await holderBalance(addr);
        if (hold == null) return send(res, 503, { error: 'Could not check your ' + TOKEN_SYMBOL + ' balance right now. Try again in a moment.' });
        if (hold < MIN_HOLD) return send(res, 403, { error: 'You need at least ' + (MIN_HOLD / UI()).toLocaleString('en-US') + ' ' + TOKEN_SYMBOL + ' to mine. This wallet holds ' + (hold / UI()).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '.' });
      }
      // One miner per wallet: a new session for the same address replaces the old one.
      for (const [sid, s2] of sessions) if (s2.address === addr) dropSession(sid);
      const miner = world.addMiner(addr, hashStr(addr) % 360);
      if (!miner) return send(res, 409, { error: 'The mine is full (' + SLOTS + ' miners). Try again in a bit.' });
      const id = crypto.randomBytes(12).toString('hex');
      sessions.set(id, { address: addr, minerId: miner.id, last: Date.now(), ip, hold, holdAt: Date.now(), verified: proven });
      console.log('Miner ' + miner.id + ' joined: ' + addr);
      return send(res, 200, { sessionId: id, minerId: miner.id, verified: proven });
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
      dropSession(String(body.sessionId));
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
      sess.challenge = 'Bedrock Bots devnet: I own wallet ' + sess.address + '. Nonce ' + crypto.randomBytes(8).toString('hex') + '. This is a message, not a transaction.';
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
    if ((url.pathname === '/api/dry-fund' || url.pathname === '/api/dry-holder' || url.pathname === '/api/reset-pool') && req.method === 'POST' && !isAdmin(req)) return send(res, 403, { error: 'Admin only' });
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
      if (g !== DEVNET_GENESIS) { console.error('Refusing to start: that RPC is not Solana devnet.'); process.exit(1); }
    } catch (e) {
      console.warn('Could not reach the RPC to verify devnet (' + RPC_URL + '). Continuing; payouts will fail until it is reachable.');
    }
  }
  if (TOKEN_MINT) {
    try {
      mintKey = new PublicKey(TOKEN_MINT);
      const info = await connection.getAccountInfo(mintKey, 'confirmed');
      if (!info) { console.error('That mint does not exist on devnet: ' + TOKEN_MINT); process.exit(1); }
      tokenProgram = info.owner;
      const mint = await spl.getMint(connection, mintKey, 'confirmed', tokenProgram);
      DEC = mint.decimals;
      payerAta = spl.getAssociatedTokenAddressSync(mintKey, payer.publicKey, true, tokenProgram);
    } catch (e) { console.error('Could not read the token from devnet: ' + e.message); process.exit(1); }
  }
  configureAsset();
  configureTopup();
  if (TOKEN_MODE) console.log(`Token mode: paying ${TOKEN_SYMBOL}${TOKEN_MINT ? ' (' + TOKEN_MINT + ')' : ' (dry run)'}, ${DEC} decimals. Minimum holding: ${HOLD_REQUIRED ? (MIN_HOLD / UI()).toLocaleString('en-US') + ' ' + TOKEN_SYMBOL : 'none'}.`);
  await buildPool();
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
  }, Number(process.env.HOLD_RECHECK_MS) || 60000);
  setInterval(() => { topUp().catch((e) => console.error('Top-up check failed: ' + e.message)); }, Number(process.env.TOPUP_EVERY_MS) || 15000);
  server.listen(PORT, HOST, () => {
    if (HOST !== '127.0.0.1' && !MAX_PER_IP) console.log('WARNING: the server is reachable from outside but MAX_PER_IP is not set.');
    console.log('');
    console.log('Bedrock Bots (devnet) running at http://127.0.0.1:' + PORT);
    console.log('Admin link (keep private): ' + (ALLOWED_ORIGINS[0] || 'http://127.0.0.1:' + PORT) + '/#admin=' + ADMIN_KEY);
    console.log('Reward wallet (send DEVNET ' + (TOKEN_MODE ? TOKEN_SYMBOL + ' and a little SOL for fees' : 'SOL') + ' here): ' + payer.publicKey.toBase58());
    if (pool.total === 0) console.log(TOKEN_MODE ? 'The pool is empty. Send the token (node make-token.js does this) and some devnet SOL to the reward wallet; the pool builds itself.' : 'The wallet needs devnet SOL. Fund it at https://faucet.solana.com (network: devnet); the pool builds itself.');
  });
})();
