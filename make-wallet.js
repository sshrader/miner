// Makes a new throwaway reward wallet on THIS computer. Needs only Node.
//   node make-wallet.js
// It writes the secret key to reward-key.json (never commit or share it) and prints only the public address.
// Paste the file's contents into Railway as REWARD_WALLET_JSON, send the funds to the address, then delete the file.
const crypto = require('crypto');
const fs = require('fs');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
if (fs.existsSync('reward-key.json')) { console.error('reward-key.json already exists. Move or delete it first so it is not overwritten.'); process.exit(1); }
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' });
const seed = Buffer.from(jwk.d, 'base64url'), pub = Buffer.from(jwk.x, 'base64url');
const secret = Buffer.concat([seed, pub]);   // Solana keypairs are 64 bytes: seed then public key
fs.writeFileSync('reward-key.json', JSON.stringify(Array.from(secret)), { mode: 0o600 });
console.log('Reward wallet address (send the funds here): ' + b58(pub));
console.log('The secret key is in reward-key.json. Paste its contents into Railway as REWARD_WALLET_JSON, then delete the file.');
