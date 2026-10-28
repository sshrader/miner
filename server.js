'use strict';
// Bedrock Bots devnet server. DEVNET ONLY.
// Holds a throwaway keypair (reward-wallet.json), decides rewards, and pays them to the connected wallet.
// Binds to 127.0.0.1 so only this computer can reach it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const POOL_SOL = parseFloat(process.env.POOL_SOL || '0.5');
// The Solana library is only needed for real devnet payouts. A dry run (--dry-run) works without installing it.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const LAMPORTS_PER_SOL = 1000000000;
let Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction;
if (!DRY_RUN) ({ Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js'));
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const MAX_REWARDS = 60;
const MIN_REWARD = 1000000;               // 0.001 SOL; also clears the rent minimum for a brand-new recipient account
const RESERVE = 2000000 + MAX_REWARDS * 5000; // keep rent minimum + fees in the reward wallet
const MIN_DIG_GAP_MS = 100;
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

let balanceCache = { at: 0, v: null };
async function getBalance(force) {
  if (DRY_RUN) return Math.round(POOL_SOL * LAMPORTS_PER_SOL) + RESERVE;
  if (!force && Date.now() - balanceCache.at < 8000) return balanceCache.v;
  try {
    balanceCache = { at: Date.now(), v: await connection.getBalance(payer.publicKey, 'confirmed') };
  } catch (e) {
    balanceCache = { at: Date.now(), v: null };
  }
  return balanceCache.v;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The pool: `total` lamports split into `count` rewards, each hidden behind a server-chosen dig number.
let pool = { total: 0, left: 0, digs: 0, rewards: new Map(), retry: [] };
async function buildPool() {
  const bal = await getBalance(true);
  const cfg = Math.round(POOL_SOL * LAMPORTS_PER_SOL);
  const total = bal == null ? 0 : Math.max(0, Math.min(cfg, bal - RESERVE));
  const count = Math.min(MAX_REWARDS, Math.floor(total / (2 * MIN_REWARD)));
  const rewards = new Map();
  if (count > 0) {
    const w = [];
    let sum = 0;
    for (let i = 0; i < count; i++) { const r = Math.random(); w.push(0.25 + r * r * 3); sum += w[i]; }
    const spare = total - count * MIN_REWARD;
    const amts = w.map((x) => MIN_REWARD + Math.floor(spare * x / sum));
    let got = amts.reduce((a, b) => a + b, 0);
    amts[amts.indexOf(Math.max(...amts))] += total - got;
    const span = Math.max(count * 8, 20);
    const idx = shuffle(Array.from({ length: span }, (_, i) => i + 1)).slice(0, count);
    if (Math.min(...idx) > 12) idx[idx.indexOf(Math.min(...idx))] = 1 + crypto.randomInt(12);
    shuffle(amts);
    idx.forEach((d, i) => rewards.set(d, amts[i]));
  }
  pool = { total, left: total, digs: 0, rewards, retry: [] };
  console.log(`Pool ready: ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL in ${count} hidden rewards` + (DRY_RUN ? ' (dry run, nothing is sent)' : ''));
}

async function state() {
  let bal = await getBalance(false);
  // Funded after startup? Build the pool automatically so no manual reset is needed.
  if (pool.total === 0 && bal != null && bal - RESERVE >= 2 * MIN_REWARD) { await buildPool(); bal = await getBalance(false); }
  return {
    devnet: true,
    dryRun: DRY_RUN,
    rewardWallet: payer.publicKey.toBase58(),
    balance: bal,
    poolTotal: pool.total,
    poolLeft: pool.left,
    rewardsLeft: pool.rewards.size + pool.retry.length,
    needsFunding: pool.total === 0,
    explorer
  };
}

async function pay(address, lamports) {
  if (DRY_RUN) return 'DRYRUN' + crypto.randomBytes(24).toString('hex');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(address), lamports }));
  return sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
}

const sessions = new Map();

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

async function handleDig(sess) {
  pool.digs++;
  let amt = 0;
  if (pool.retry.length) amt = pool.retry.shift();
  else if (pool.rewards.has(pool.digs)) { amt = pool.rewards.get(pool.digs); pool.rewards.delete(pool.digs); }
  const out = { reward: 0, signature: null, error: null };
  if (amt) {
    try {
      out.signature = await pay(sess.address, amt);
      out.reward = amt;
      pool.left -= amt;
      balanceCache.at = 0;
      console.log(`Paid ${(amt / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${sess.address} ${out.signature}`);
    } catch (e) {
      pool.retry.push(amt);
      out.error = 'Payout failed, will retry on a later dig: ' + String((e && e.message) || e).slice(0, 140);
      console.error(out.error);
    }
  }
  out.poolLeft = pool.left;
  out.rewardsLeft = pool.rewards.size + pool.retry.length;
  return out;
}

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(res, 403, { error: 'Bad origin' });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await state());
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      let addr;
      try { addr = DRY_RUN ? checkAddr(String(body.address)) : new PublicKey(String(body.address)).toBase58(); } catch (e) { return send(res, 400, { error: 'Invalid wallet address' }); }
      const id = crypto.randomBytes(12).toString('hex');
      sessions.set(id, { address: addr, last: 0 });
      console.log('Session started for ' + addr);
      return send(res, 200, { sessionId: id });
    }
    if (url.pathname === '/api/dig' && req.method === 'POST') {
      const body = await readBody(req);
      const sess = sessions.get(String(body.sessionId));
      if (!sess) return send(res, 404, { error: 'Unknown session' });
      const now = Date.now();
      if (now - sess.last < MIN_DIG_GAP_MS) return send(res, 429, { error: 'Too fast' });
      sess.last = now;
      return send(res, 200, await handleDig(sess));
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
  await buildPool();
  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('Bedrock Bots (devnet) running at http://127.0.0.1:' + PORT);
    console.log('Reward wallet (send DEVNET SOL here): ' + payer.publicKey.toBase58());
    if (pool.total === 0) console.log('The wallet needs devnet SOL. Fund it at https://faucet.solana.com (network: devnet), then click "New pool" in the page.');
  });
})();
