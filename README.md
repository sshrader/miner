# Bedrock Bots (devnet test)

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


## Level gating

Miners cannot dig through a level's floor until **every reward hidden on that level has been found**. Level 1 opens first; finding its last reward unlocks level 2, and so on. Rewards only hide in walls (never floors), spread evenly over the 8 levels, with bigger shares deeper down. Simulated one-miner times to clear the whole mine: easy about 2 h, normal about 2 h, hard about 3 h, brutal about 4 h (more miners finish faster). Change `DIFFICULTY`, `REWARDS_PER_LEVEL` or `HARD_MULT` to tune it.
