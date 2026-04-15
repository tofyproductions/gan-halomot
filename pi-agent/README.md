# timedox-agent

Runs on a Raspberry Pi at each kindergarten branch. Bridges the local
TIMEDOX TANDEM4 PRO biometric clock to the gan-halomot server on Render.

## What it does

Three concurrent loops:

| Loop       | Default interval | What it does                                         |
|------------|------------------|------------------------------------------------------|
| punches    | 15s              | Polls `getAttendances()`, forwards new records       |
| commands   | 30s              | Polls server queue for add-user / delete-user / ping |
| heartbeat  | 60s              | Reports liveness + device stats to the server       |

State lives in `state.json` (atomic writes). The **only** thing we actually
persist between runs is `last_user_sn` — the highest ZKTeco record ID we've
uploaded. That's how we avoid duplicating punches across restarts.

## Why this is needed (the POC bugs we work around)

- `getRealTimeLogs()` is silent on this firmware → we poll.
- Historical records come back with 1999-12-31 timestamps → we tag every
  newly-discovered punch with the Pi's wall-clock time (NTP-synced).
- `getAttendances()` returns inflated/inconsistent counts → we dedupe by
  `userSn` and only ever advance our cursor forward.
- Hebrew names in `getUsers()` are mangled → we match by `userId` (= ת"ז)
  only. Names live on the server.

## Install on a fresh Pi

1. **Flash** Raspberry Pi OS (Bookworm Lite), set hostname `gan-pi-<N>`, enable SSH.
2. **Install Node 18+**: `sudo apt install -y nodejs npm` (or use nvm).
3. **Copy the code** from your Mac:
   ```bash
   rsync -av --exclude node_modules --exclude state.json \
     gan-halomot/pi-agent/ admin@gan-pi-1.local:/home/admin/timedox-agent/
   ```
4. **Create `.env`** on the Pi from `.env.example` and fill in:
   - `BRANCH_ID`     — MongoDB ObjectId for this branch
   - `AGENT_SECRET`  — the secret printed by `scripts/seed-attendance.js`
   - `CLOCK_IP`      — the TIMEDOX device's LAN IP
   - `SERVER_URL`    — `https://gan-halomot.onrender.com`
5. **Run the installer**:
   ```bash
   ssh admin@gan-pi-1.local "cd timedox-agent && bash scripts/install.sh"
   ```
   This runs `npm ci`, does a one-shot smoke test, then installs and starts
   the systemd unit.
6. **Watch the logs**:
   ```bash
   sudo journalctl -u timedox-agent -f
   ```

## Manual one-shot testing

```bash
node agent.js --bootstrap   # baseline last_user_sn, skip device history
node agent.js --once        # run each loop exactly once and exit
node agent.js               # run continuously (what systemd does)
```

## Updating an already-deployed agent

```bash
rsync -av --exclude node_modules --exclude state.json --exclude .env \
  gan-halomot/pi-agent/ admin@gan-pi-1.local:/home/admin/timedox-agent/
ssh admin@gan-pi-1.local "cd timedox-agent && npm ci --omit=dev && sudo systemctl restart timedox-agent"
```

## Verifying end-to-end

1. On the Pi: `sudo journalctl -u timedox-agent -f`
2. Have an employee punch in on the clock.
3. Within 15–30s you should see `uploading N new punches` in the logs.
4. On the server, query MongoDB: `db.punches.find().sort({received_at:-1}).limit(5)`.
