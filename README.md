# Pay Dirt (devnet test)

A 3D mining game. Your miner digs through an eight-level cave, each level with its own irregular outline,, and hidden blocks pay real **devnet** SOL
from a throwaway wallet to the Phantom wallet you connect. Devnet SOL has no value.

How it works:
- `server.js` holds a throwaway keypair in `reward-wallet.json` (git-ignored), decides every reward, and sends it with a normal SOL transfer.
- The page only reads your public address from Phantom. It never asks you to sign anything.
- The pool (default 0.5 SOL) is split into up to 60 rewards, each hidden inside one specific block or floor. Deeper spots hold bigger shares. The server knows where they are and the browser does not, so nobody can forge a reward.
- The server refuses to run against anything but devnet and listens on 127.0.0.1 only.

## Run it (Windows, PowerShell)

Needs Node 18 or newer.

```powershell
cd D:\Repo\Miner
npm install
npm start
```

1. `npm start` prints the **reward wallet address** and serves the game at http://127.0.0.1:3000 (open that in the browser where Phantom is installed).
2. Fund that address with devnet SOL, at least 0.51: https://faucet.solana.com (choose devnet). `npm run airdrop` also tries, but the public RPC often rate-limits it.
3. In the page, press **New pool** so the server reads the new balance.
4. In Phantom: Settings > Developer Settings > Testnet Mode > Solana Devnet, so you can see the SOL arrive.
5. Press **Connect Phantom**. Your miner drops in, and every reward shows up with a link to the transaction on Solana Explorer (devnet).

## One shared world

The server runs the cave and every miner (`world.js`) and streams the state to every browser, so everyone sees the same mine, the same miners and the same blocks breaking at the same place and time.

- Opening the page without connecting lets you watch the live mine. Connecting a wallet adds your miner (up to 4 at once, one per wallet).
- The pool is shared: whichever miner breaks a block that holds a reward gets it. A lone miner takes a long time to find them all, and more miners find them faster. If the whole mine is dug out it rebuilds, and the unfound rewards are hidden again in the new cave.
- Miners are removed a few seconds after their tab closes, or when you press Leave.
- Open a second browser profile with another Phantom wallet to watch two miners in the same cave.

## Chat and wallet check

- Everyone connected to the same server shares one chat (last 100 messages, 140 characters each). The chat window sits inside the mine view (bottom right, with a button to collapse it), and a message also pops up above that miner's head.
- **Verify my wallet** asks Phantom to sign a short text message. The server checks the signature, and your chat messages then get a green check, which proves you own that address. It is a message, not a transaction, and it is free.
- Chat is local to your server. Other people can only join if you make the server reachable to them, which this project does not set up.

## Try it without any network

```powershell
npm run dry
```

Dry run needs no `npm install` and sends nothing: payouts are fake signatures. It is for checking the game flow.

## Settings (environment variables)

| Name | Default | Meaning |
| --- | --- | --- |
| `DIFFICULTY` | `easy` | `easy`, `normal`, `hard` or `brutal`. Sets rewards per level and how many hits blocks take |
| `REWARDS_PER_LEVEL` | by difficulty (4 / 8 / 12 / 20) | Hidden rewards in each of the 8 levels |
| `HARD_MULT` | by difficulty (1 / 1.5 / 3 / 6) | Multiplies the hits every block and floor takes |
| `POOL_SOL` | `0.5` | Size of the reward pool, capped by the wallet balance minus a small reserve |
| `MAX_MINERS` | `12` | Most miners in the mine at once (1 to 16) |
| `PORT` | `3000` | Local port |
| `RPC_URL` | public devnet RPC | Use your own devnet RPC if you get rate-limited. Mainnet URLs are refused. |

## Notes

- Never put real funds in `reward-wallet.json`. It is an unencrypted key file.
- Restarting the server builds a fresh pool from the current balance.
- Rewards are only paid when the server itself sees a miner break the block that holds one, so the browser cannot ask for one.


## Mine 2 (overflow mine)

There are two mines sharing one reward pool. Mine 1 is always open. Mine 2 starts closed; the admin opens it with the **Open Mine 2 (admin)** button (or `POST /api/mine-open {"open": true}` with the admin key). Open it and about half of the hidden rewards on every level move into it. People are placed in Mine 1 first, and in Mine 2 only when Mine 1 is full; nobody chooses. Each mine has its own cave, level locks and block hardness, and a viewer can switch the watched mine with the tabs under "Miners underground".

Closing it (`{"open": false}`) stops new people entering Mine 2; the miners already there stay until they leave (`"kick": true` removes them), and when it is empty its rewards go back into Mine 1 (which can lock a level there again). The saved state file (`STATE_FILE`) now holds both mines; old v1 files still load.

## Level gating

Miners cannot dig through a level's floor until **every reward hidden on that level has been found**. Level 1 opens first; finding its last reward unlocks level 2, and so on. Rewards only hide in walls (never floors), spread evenly over the 8 levels, with bigger shares deeper down. Simulated one-miner times to clear the whole mine: easy about 2 h, normal about 2 h, hard about 3 h, brutal about 4 h (more miners finish faster). Change `DIFFICULTY`, `REWARDS_PER_LEVEL` or `HARD_MULT` to tune it.

## Elevator

A new miner rides a mine elevator down from above the world (about 4.5 seconds) through an opening in the roof of level 1 before it starts digging. Timing and height are `ELEV_TIME` and `ELEV` in `world.js` and `index.html`.

## Season end and sweeping leftovers

Set `SEASON_END` (for example `2026-12-31T23:59:00Z`) and the mine freezes at that moment: no more digging, no more rewards paid. Then stop the server and send what is left to a wallet you own:

```
node sweep.js --to <your address>            # asks you to type "yes"
node sweep.js --to <your address> --keep 0.05 --yes
```

`sweep.js` refuses to run while the game server is up, checks that the RPC is devnet, and subtracts the network fee. Tell players your leftover policy before launch.

## Top-ups (fees flowing into the pool)

Every 30 seconds the server checks the reward wallet. Whatever arrived since the pool was built (creator fees, a manual transfer) becomes new hidden rewards once it adds up to `TOPUP_MIN_SOL` (default 0.01 SOL). New rewards go on levels that are not cleared yet, so they extend the level gating. Anything above `POOL_SOL` when the pool was first built is left alone. In a dry run you can pretend: `curl -X POST localhost:3000/api/dry-fund -H "origin: http://127.0.0.1:3000" -H "content-type: application/json" -d "{\"sol\":0.05}"`.

## Admin access

"New pool" and the dry-run funding endpoint are admin-only. On start the server prints an **Admin link** like `http://127.0.0.1:3000/#admin=...`. Open that link and the "New pool (admin)" button appears; everyone else never sees it, and the server refuses the request without the key. Set your own with `ADMIN_KEY=<long random hex>` so the link stays the same between restarts. Keep the link private.

## Limits per connection, and hosting (Railway)

`MAX_PER_IP=1` allows one miner per connection address (a second wallet from the same IP is refused; the same wallet reconnecting just replaces its old miner). Joins are also limited to 10 per minute per IP. With `MAX_PER_IP` on, a connection is also tied to the last address it mined with for `IP_SWITCH_MINUTES` (default 10; `0` turns it off), so nobody can hop between wallets to reuse the same tokens. Coming back with the same address is always fine. IPv6 users are grouped by their /64 block. This is a speed bump, not a guarantee: VPNs get around it, and people sharing a home or mobile network share a limit. Pair it with a minimum holding when real value is involved.

Behind a host like Railway the server sees the proxy's address, so set `TRUST_PROXY=1` to read the visitor's real IP from the proxy headers. Only do that when a trusted proxy really is in front; on a directly exposed server the header can be forged.

Variables to set on Railway (devnet only for now):

| Variable | Value |
|---|---|
| `HOST` | `0.0.0.0` |
| `TRUST_PROXY` | `1` |
| `MAX_PER_IP` | `1` |
| `ALLOWED_ORIGINS` | your public address, e.g. `https://your-app.up.railway.app` |
| `ADMIN_KEY` | a long random hex string (your admin link is that address plus `/#admin=<key>`) |
| `REWARD_WALLET_JSON` | the throwaway devnet keypair as a JSON array (Railway has no persistent disk for `reward-wallet.json`) |
| `DIFFICULTY`, `SEASON_END`, `POOL_SOL` | as you like |

Run exactly one instance: the mine lives in that process's memory. A restart rebuilds the mine and re-hides the unfound rewards from the wallet balance (rewards already paid stay paid).

## Paying a token, and holder checks (devnet, throwaway token)

Rewards can be paid in an SPL token instead of SOL, and mining can require holding a minimum amount. Test it with a throwaway devnet token first.

1. `npm install` (this pulls in `@solana/spl-token`).
2. Fund the reward wallet with about 0.1 devnet SOL (faucet.solana.com). It pays fees, and the token account for each first-time winner (about 0.002 SOL each).
3. Stop the server and run `node make-token.js`. It creates a token, puts 1,000,000 of it in the reward wallet, and prints the start command. Give your own Phantom wallet some: `node make-token.js --mint <mint> --to <your address> --amount 5000`.
4. Start with the token: PowerShell `$env:TOKEN_MINT="<mint>"; $env:TOKEN_SYMBOL="TEST"; $env:MIN_HOLD="1000"; npm start`.

| Variable | Meaning |
|---|---|
| `TOKEN_MINT` | The token to pay. Leave out for SOL mode |
| `TOKEN_SYMBOL` | Name shown in the page |
| `MIN_HOLD` | Tokens a wallet must hold to mine. `0` or unset = no minimum |
| `POOL_TOKENS` | Most tokens in the pool (default: everything the reward wallet holds) |
| `MIN_REWARD_TOKENS` | Smallest single reward (default 1) |
| `MAX_WALLET_PAYOUT` | Most tokens one wallet can win per 24 hours (`0` = no cap) |
| `TOPUP_MIN_TOKENS` | Tokens that must arrive before a top-up (default 10x the smallest reward) |
| `HOLD_RECHECK_MS` | How often holders are re-checked (default 120000) |

With `MIN_HOLD` set:
- Players can **paste a wallet address** (nothing to connect) or **connect Phantom and sign a free message** (proof they own it, never a transaction). Either way the server checks the balance; below the minimum, no miner is sent in and the page says how much is needed. Rewards are paid to the address, so pasting someone else's address only sends them tokens. A pasted address shows as unverified in chat, and someone else cannot kick it out: a second device must connect and sign to take over. Set `REQUIRE_SIGNATURE=1` to turn pasting off and require a signature from everyone.
- Every 2 minutes the server checks holders again; a wallet that sold below the minimum is removed from the mine.
- Right before a payout it checks once more. If the balance dropped, the reward goes back into the mine.
- Both the classic Token program and Token-2022 mints work (detected from the mint).

Dry-run testing without a network: `DRY_RUN=1 DRY_TOKEN=1 MIN_HOLD=100 node server.js`, then give a wallet a fake balance with `POST /api/dry-holder {"address":"...","amount":500}` using your admin key header (`x-admin-key`).

Sweep leftover tokens when the season is over: `$env:TOKEN_MINT="<mint>"; node sweep.js --to <address> --token`, then `node sweep.js --to <address>` for the SOL.

## More miners, the waiting line, and shifts

`MAX_MINERS` now goes up to **50** (default 12). Everyone watching sees the same live mine; only the miners dig.

When the mine is full, new people join a **waiting line** and are let in automatically as places free up (they ride the elevator down). The page shows "You are #3 of 8 in line". Order in line:
- In token mode, **holding more moves you up**: every doubling of your holding (above `MIN_HOLD`) is worth `QUEUE_AGE_MINUTES` minutes of waiting (default 10). Waiting also moves you up on its own, so a smaller holder is never stuck forever.
- Without a token it is first come, first served.
- Leaving the line or the mine puts you at the back (your waiting time starts again). When your turn comes the balance is checked once more.

`SHIFT_MINUTES=30` (default `0` = off) limits how long a miner can stay while others are waiting: the longest-serving miner is rotated out and the next in line takes the place. A removed miner can join the line again.

More miners finds rewards much faster. Simulated time for the miners together to clear level 1: 12 miners about 1 to 4 minutes (easy to brutal), 50 miners about 1 to 2 minutes. Raise `HARD_MULT` (up to 10) and `REWARDS_PER_LEVEL` (up to 30) for bigger crowds, or use `SEASON_END`, and keep an eye on how fast the pool drains.

## Auto scaling

By default (`AUTO_SCALE=1`) blocks get harder as more miners join, so a crowd of 50 does not drain the pool far faster than a crowd of 6. The multiplier is your difficulty's `HARD_MULT` times `miners / REF_MINERS` (never below the base), re-checked every few seconds in steps of 0.25 and capped at `HARD_CAP` (default 30). `REF_MINERS` defaults to 6: with 12 miners blocks take twice the hits, with 50 miners about 8 times. The left panel shows the current figure.

Simulated time to clear level 1 on `easy`: 6 miners about 2 minutes, 50 miners about 2 minutes (without scaling: about 1). To make everything slower, raise `DIFFICULTY` or `HARD_MULT`, or lower `REF_MINERS` (for example 3 doubles the hardness at any crowd size). `AUTO_SCALE=0` switches it off.

## RPC usage

The server makes a handful of RPC calls: a holder check when someone joins and every `HOLD_RECHECK_MS` per miner, a pool balance check every `TOPUP_EVERY_MS`, cached balance lookups for the page (20 seconds), and the payout transactions. With 12 miners online around the clock that is roughly 0.5 million calls a month, so a free plan from an RPC provider (for example 1 million credits a month) is enough for a small group. The public Solana endpoints are rate limited and not meant for this. Use a provider URL in `RPC_URL`, and make sure it allows WebSocket connections (payout confirmation uses one).

## Going live on mainnet (checklist)

Nothing here is legal advice. Before real money is involved, have a lawyer in your country look at the game, the pool and the rules page (`/rules.html`).

**Safety valves built in**
- `NETWORK=mainnet` refuses to start unless `CONFIRM_MAINNET=yes-i-am-using-real-funds`, a paid or private `RPC_URL`, an `ADMIN_KEY` of 24+ characters, a reward wallet supplied through `REWARD_WALLET_JSON` (it never creates one), and `MAX_PAYOUT_PER_HOUR`.
- `MAX_PAYOUT_PER_HOUR` (in tokens or SOL): the game stops paying once that much went out in the last hour. Digging continues; rewards stay hidden.
- Pause button: open your admin link and use **Pause payouts (admin)**. It pauses at once and survives restarts. The server also pauses itself after `PAUSE_AFTER_FAILURES` (default 5) payout failures in a row.
- `MAX_WALLET_PAYOUT`: most one wallet can win per day. `MAX_PER_IP`: miners per connection. `MIN_HOLD`: token holding required to mine.
- Chat blocks links; the admin can mute (and remove) a wallet with `POST /api/mute` `{ "address": "...", "kick": true }` and the header `x-admin-key`.
- Open live views are capped per visitor (`MAX_STREAMS_PER_IP`, default 6) and in total (`MAX_STREAMS`, default 400). Security headers are sent on every page, and `/healthz` answers for uptime checks.
- Reward positions and amounts use the operating system's secure random source.

**Keeping state across restarts**
Set `STATE_FILE=/data/state.json` and attach a Railway volume mounted at `/data`. The mine, hidden rewards, unlock progress, per-wallet totals, hourly totals, pause flag and muted wallets are saved every 10 seconds and on shutdown. On start, if the wallet now holds less than the saved pool (it was swept or spent), the saved state is ignored and a fresh pool is built.

**Steps**
1. Make a brand-new wallet just for the game. Never reuse the devnet one. Put only an amount you can afford to lose into it.
2. Set the variables in Railway: `NETWORK=mainnet`, `CONFIRM_MAINNET`, `RPC_URL`, `REWARD_WALLET_JSON`, `ADMIN_KEY` (a fresh long random value that was never pasted anywhere), `ALLOWED_ORIGINS` (your https address), `HOST=0.0.0.0`, `TRUST_PROXY=1`, `STATE_FILE`, `MAX_PAYOUT_PER_HOUR`, `MAX_WALLET_PAYOUT`, `MAX_PER_IP`, and for a token `TOKEN_MINT`, `TOKEN_SYMBOL`, `MIN_HOLD`.
3. Run `npm run preflight` with the same variables. Fix every FAIL.
4. Turn on two-factor sign-in for Railway, GitHub and your wallet.
5. Start with a small pool and a few friends. Watch the logs. Use the pause button at the first sign of trouble.
6. Run `npm install` once locally and commit `package-lock.json` so builds are repeatable.
7. At the end of the season, stop the server and use `npm run sweep` (add `--token` for tokens) to move what is left back to your wallet.
