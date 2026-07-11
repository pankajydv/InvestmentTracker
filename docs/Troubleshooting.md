# Production Troubleshooting Guide

A layered checklist for diagnosing "the site is down / unreachable" for the
Investment Tracker production deployment. Work **top-to-bottom** — each layer
assumes the ones above it are healthy. Most incidents are resolved within the
first two or three layers.

> First incident this guide was written for (2026-07-11): DuckDNS nameserver
> flakiness made the domain fail to resolve while the server and app were 100%
> healthy. See [Layer 2](#layer-2--dns-resolution) — it self-healed and a
> local hosts-file entry was the break-glass fix.

---

## Production architecture (know this first)

```
Browser / Phone
      │  https://investtrack.duckdns.org  (443)
      ▼
┌─────────────────────────────────────────────┐
│ Oracle Cloud VM  (ap-mumbai-1)               │
│ Public IP: 92.4.90.130  (Ephemeral)          │
│ SSH: ubuntu@92.4.90.130  (port 22)           │
│                                              │
│  Caddy (systemd)  :80 / :443                 │
│   - Terminates TLS (Let's Encrypt cert for   │
│     investtrack.duckdns.org, auto-renew)     │
│   - imports investtrack-upstream.caddy →     │
│     the ACTIVE app color (blue/green)        │
│                                              │
│  App containers (Docker):                    │
│   - investment-tracker-blue  → :8081         │
│   - investment-tracker-green → :8082         │
│   - only the ACTIVE color receives traffic   │
│   - SQLite DB at /data/investments.db (WAL)  │
└─────────────────────────────────────────────┘

DNS: DuckDNS  (investtrack.duckdns.org → 92.4.90.130)
     served by ns1..ns9.duckdns.org
```

Key facts that shape debugging:
- **Caddy is the public entrypoint**, not the app. The app runs as **two**
  containers (blue `:8081` / green `:8082`); Caddy proxies to whichever is
  **active** via `/etc/caddy/investtrack-upstream.caddy`. Neither app port is
  public and neither needs an Oracle Security List rule — public traffic is 80/443.
- The app being reachable on `localhost:8080` on the server does **not** mean
  the public site works — Caddy and DNS sit in front of it.
- Auth is Google OAuth with an **email allowlist** (multiple emails, configured
  via the `ALLOWED_EMAILS` GitHub secret).

Reference config: [configs/investtrack-prod.json](../configs/investtrack-prod.json)

---

## Quick triage (30 seconds)

Run these three from your local machine to localize the fault fast:

```powershell
# 1. Does the name resolve? (DNS layer)
nslookup investtrack.duckdns.org 8.8.8.8

# 2. Is the server reachable at all? (network/host layer)
Test-NetConnection -ComputerName 92.4.90.130 -Port 443 -InformationLevel Detailed

# 3. Does HTTPS answer? (Caddy/app layer)
curl.exe -I https://investtrack.duckdns.org
```

| #1 nslookup | #2 port 443 | #3 curl | Likely layer | Go to |
|:-----------:|:-----------:|:-------:|--------------|-------|
| FAIL | (n/a) | FAIL | **DNS** | [Layer 2](#layer-2--dns-resolution) |
| OK | FAIL | FAIL | **Host / network / Oracle** | [Layer 3](#layer-3--host--network-reachability) |
| OK | OK | FAIL / 502 / SSL err | **Caddy or app** | [Layer 4](#layer-4--caddy-reverse-proxy--tls) / [Layer 5](#layer-5--application-docker-container) |
| OK | OK | 200 | Site is up — problem is client-side | [Layer 1](#layer-1--client-side) |

> Tip: to test the app **independent of DNS**, add a hosts entry (see
> [Layer 2 break-glass](#break-glass-bypass-dns-immediately)) or `curl` with a
> forced host: `curl.exe -I --resolve investtrack.duckdns.org:443:92.4.90.130 https://investtrack.duckdns.org`

---

## Layer 1 — Client side

Rule out your own machine/network before touching production.

- Try a **different network** (mobile hotspot) and a **different device**.
- Hard-refresh / try an incognito window (rules out stale cache / service worker).
- Flush local DNS cache:
  ```powershell
  ipconfig /flushdns
  ```
- If it works elsewhere but not on one device → local DNS, VPN, hosts file, or
  cached service worker on that device. Check for a stale hosts entry:
  ```powershell
  Get-Content $env:SystemRoot\System32\drivers\etc\hosts | Select-String investtrack
  ```

---

## Layer 2 — DNS resolution

Symptom: `Could not resolve hostname` / `nslookup` fails / SERVFAIL.

### Diagnose
```powershell
# Local resolver
nslookup investtrack.duckdns.org

# Bypass ISP — public resolver
nslookup investtrack.duckdns.org 8.8.8.8
```
Check **global** resolution + whether it's DuckDNS-wide or just your record.
Open in a browser (DNS-over-HTTPS, sees the truth regardless of your ISP):
```
https://dns.google/resolve?name=investtrack.duckdns.org&type=A     # your record
https://dns.google/resolve?name=duckdns.org&type=NS                # DuckDNS nameservers
https://dns.google/resolve?name=www.duckdns.org&type=A             # DuckDNS itself
https://dns.google/resolve?name=ns1.duckdns.org&type=A             # get an NS IP to query directly
```
Interpretation:
- `Status: 0` + `Answer` with `92.4.90.130` → DNS is fine, look elsewhere.
- `Status: 2` (SERVFAIL) / timeout for **your** record only, while `duckdns.org`
  NS and `www.duckdns.org` resolve → DuckDNS nameserver-pool flakiness or a
  stuck record. Confirm the record itself is intact by querying an NS directly:
  ```powershell
  nslookup investtrack.duckdns.org 99.79.143.35   # ns1 IP (re-check via the ns1 query above)
  ```
  - If the NS returns `92.4.90.130` but public resolvers SERVFAIL → **record is
    fine, DuckDNS NS pool is flaky.** It usually self-heals. Use break-glass
    below and wait.
  - If the NS itself doesn't have the record → **stuck/removed record.** Re-add
    on the DuckDNS dashboard or re-publish (below).

### Fix — re-publish the DuckDNS record
From any machine (there is **no auto-updater on the server** — the record is set
manually):
```bash
curl "https://www.duckdns.org/update?domains=investtrack&token=<DUCKDNS_TOKEN>&ip=92.4.90.130"
# expect: OK
```
If the record is stuck, **delete and re-add** the `investtrack` domain on
https://www.duckdns.org (same name, IP `92.4.90.130`).

### Break-glass: bypass DNS immediately
Because Caddy routes by SNI/Host and holds a valid cert, you can reach the site
by mapping the name to the IP locally — **no cert warning**.

**Windows** (Admin PowerShell):
```powershell
Add-Content -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Value "`n92.4.90.130`tinvesttrack.duckdns.org"
ipconfig /flushdns
```
Remove the line once DNS recovers.

**Android**: no `/etc/hosts` without root. Use a local-VPN hosts app
(e.g. Hosts Go / RethinkDNS) to map `investtrack.duckdns.org → 92.4.90.130`, or
just wait for DuckDNS to recover.

---

## Layer 3 — Host / network reachability

Symptom: name resolves (or you use the IP) but nothing connects.

### Diagnose from local
```powershell
Test-NetConnection -ComputerName 92.4.90.130 -Port 22  -InformationLevel Detailed   # SSH
Test-NetConnection -ComputerName 92.4.90.130 -Port 443 -InformationLevel Detailed   # HTTPS
Test-NetConnection -ComputerName 92.4.90.130 -Port 80  -InformationLevel Detailed   # HTTP
```
- All fail → server down, IP changed, or Oracle-level block.
- Only 443/80 fail (22 OK) → Caddy down or Oracle ingress for 80/443 missing →
  [Layer 4](#layer-4--caddy-reverse-proxy--tls).

### Check the VM + public IP (Oracle Cloud Console)
1. **Compute → Instances → investment-tracker** — status should be **Running**.
   If **Stopped**, click **Start**. If reclaimed after a plan change, re-provision.
2. Confirm the **public IP is still `92.4.90.130`**
   (Instance → Attached VNICs → VNIC → IP administration). It's an **Ephemeral**
   IP but persists across reboots and stop/start — it only changes if the instance
   is **terminated/recreated**. If it ever changes, follow Runbook E (update
   DuckDNS + `oracle.host`).
3. **Ingress rules** (only relevant if 80/443 are blocked): the instance uses the
   subnet **Security List** (no NSG attached). Ensure ingress allows
   **TCP 22, 80, 443** from `0.0.0.0/0`:
   VCN → `public-subnet` → Security List → Ingress Rules.
   **Do not** add 8080 — it is internal only.

### SSH in
```powershell
ssh -i .\configs\ssh-key-2026-05-06.key ubuntu@92.4.90.130
```
Once in, sanity-check the box:
```bash
uptime          # load + how long up (watch for unexpected reboots)
df -h           # disk full? (SQLite + logs can fill /)
free -h         # memory pressure / OOM risk
last reboot | head
```
- **Disk full** is a classic silent killer (app can't write DB/logs). Clean logs
  under `/data/logs` and old backups if `/` is near 100%.

---

## Layer 4 — Caddy (reverse proxy + TLS)

Symptom: port 443 open but HTTPS errors, `502 Bad Gateway`, or cert problems.

```bash
# Is Caddy running?
systemctl status caddy --no-pager | head -20

# What's listening on the web ports?
sudo ss -tlnp | grep -E ':(80|443|8081|8082)'
#   caddy on :80 and :443, docker-proxy on the ACTIVE app port (8081 or 8082)

# Which app color is Caddy currently serving?
cat /etc/caddy/investtrack-upstream.caddy   # -> reverse_proxy 127.0.0.1:8081 (or 8082)

# Recent Caddy logs (look for cert renewal errors or proxy 502s)
sudo journalctl -u caddy -n 100 --no-pager
```
Common cases:
- **Caddy not running** → `sudo systemctl restart caddy` then re-check status/logs.
- **`502` / `dial tcp 127.0.0.1:<port>: connect: connection refused`** → Caddy is
  fine, the **active app container is down** → [Layer 5](#layer-5--application-docker-container).
  (A stale 502 from *before* a deploy is harmless.)
- **TLS/cert errors** → check the Caddyfile and that ports 80/443 are reachable
  from the internet (Let's Encrypt needs 80 for HTTP-01):
  ```bash
  sudo cat /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile
  sudo systemctl reload caddy
  ```
- Cert lives under `/var/lib/caddy/.local/share/caddy`. Caddy auto-renews; you
  rarely touch this.

---

## Layer 5 — Application (Docker container)

Symptom: Caddy up, but 502 / app errors.

```bash
# Which color is live? (the port in the upstream file)
cat /etc/caddy/investtrack-upstream.caddy   # -> reverse_proxy 127.0.0.1:8081 (blue) or :8082 (green)

# Container status — expect "Up ..." for the ACTIVE color
docker ps -a | grep investment-tracker

# Does the ACTIVE app answer locally? (use its port: 8081 blue / 8082 green)
curl -I http://localhost:8081        # or 8082 — expect 200 + HTML

# App logs (scheduler output, errors, stack traces)
docker logs --tail 200 investment-tracker-blue     # or -green
docker logs --since 1h investment-tracker-blue
```
Fixes:
- **Active container down / crash-looping** → inspect logs, then start it and
  point Caddy at it:
  ```bash
  docker start investment-tracker-blue          # the color you want live
  sudo /usr/local/bin/investtrack-switch-upstream.sh 8081   # match the port
  ```
- **Roll back a bad deploy** → start the previous color and switch back:
  ```bash
  docker start investment-tracker-green
  sudo /usr/local/bin/investtrack-switch-upstream.sh 8082
  ```
  (The deploy also prints the exact rollback command at the end of each run.)
- **Crash loop** → read `docker logs` for the stack trace. Common culprits:
  bad env in `/opt/investment-tracker.env`, DB lock/corruption, disk full.
- **DB issues** (SQLite/WAL): confirm `/data/investments.db` exists and the
  volume is mounted; check disk space (Layer 3). Backups: `backup.retentionDays`
  and `backupScript` in the prod config; restore from `/data` backups if needed.
- Restart policy is `unless-stopped`, so the app should survive reboots on its
  own — an unexpected "down after reboot" means it was manually stopped or
  failed health at startup (check logs).

---

## Layer 6 — Application behaviour (up but misbehaving)

Site loads but login fails or data looks wrong:
- **Google login broken** → the OAuth **authorized redirect URI** must match the
  current domain exactly; `GOOGLE_CLIENT_ID` / `ALLOWED_EMAILS` set correctly in
  the server env file. A domain change (e.g. migrating off DuckDNS) requires
  updating the redirect URI in Google Cloud Console.
- **Prices/NAVs stale** → scheduler + upstream providers; check `docker logs` for
  fetch errors (e.g. `getaddrinfo ENOTFOUND` = the *server's* outbound DNS/network,
  not your inbound problem). LOCF (last-observation-carried-forward) entries are
  normal on holidays/weekends.
- **Health endpoint**: `GET /api/auth/config` (see `monitoring` in prod config)
  is a lightweight liveness check.

---

## Common incidents — fast reference

| Symptom | Most likely cause | Fix |
|---------|-------------------|-----|
| `Could not resolve hostname` | DNS (DuckDNS) | [Layer 2](#layer-2--dns-resolution) + hosts-file break-glass |
| Site works by IP-behaviour but domain SERVFAILs globally | DuckDNS NS pool flaky (record intact) | Wait / re-publish; break-glass meanwhile |
| `ERR_SSL_PROTOCOL_ERROR` when hitting bare IP over HTTPS | Expected — wrong entrypoint | Use the hostname, not the IP |
| `502 Bad Gateway` | App container down | [Layer 5](#layer-5--application-docker-container): `docker start` / logs |
| 443 refused, 22 works | Caddy down or 80/443 ingress missing | [Layer 4](#layer-4--caddy-reverse-proxy--tls) + Oracle Security List |
| Nothing reachable, IP changed | Ephemeral IP changed after stop/start | Update DuckDNS + prod config; reserve static IP |
| App down only after a reboot | Disk full / bad env / manual stop | [Layer 3](#layer-3--host--network-reachability) disk, [Layer 5](#layer-5--application-docker-container) logs |
| Login fails after domain change | OAuth redirect URI mismatch | Update Google OAuth authorized redirect URI |
| Deploy aborted: "new color failed health checks" | New build unhealthy | Old color still serving; read `docker logs investment-tracker-<color>`, fix, redeploy |

---

## Security / hygiene notes

- **DuckDNS token**: there is **no DuckDNS updater on the server** (empty crontab,
  no timer, no script) — the record is set **manually** via duckdns.org, so the
  token isn't stored anywhere on the box. It was shared in a support chat on
  2026-07-11 but deliberately **not rotated** (low-sensitivity app). To rotate:
  just regenerate at duckdns.org — nothing on the server to change.
  ⚠️ There's no auto-updater; the ephemeral IP is stable in normal operation
  (survives reboot/stop-start) and only changes on instance termination. If it
  ever changes, update DuckDNS manually — see Runbook E.
- SSH sees constant internet-wide brute-force attempts on port 22 (background
  noise). Key-only auth (no passwords) already blocks them; **fail2ban** is also
  installed — bans an IP for 1h after 5 failed attempts. Config
  `/etc/fail2ban/jail.local` uses `backend = systemd` (this image logs SSH to the
  journal, not `/var/log/auth.log`). Check: `sudo fail2ban-client status sshd`.
- Remove any temporary hosts-file entries once DNS recovers.

---

## Backup & Disaster Recovery

### What is backed up, and where
| What | Where | How |
|------|-------|-----|
| **Database** `/data/investments.db` | **Google Drive → `InvestTrackBackups/db`** (+ local `/data/backups`), 30-day retention | Nightly 02:30 UTC: `investtrack-backup-db.sh` snapshot → gzip → rclone upload |
| **Secrets/config** (SSH key, `Caddyfile`, `gcp-client.json`, server env file) | **Google Drive → Investments → InvestTrack** | Manual copy |
| **Logs** `/data/logs` | On the VM (not backed up off-box) | App-managed: today plain, older gzipped, >30 days deleted ([appLogger.js](../server/services/appLogger.js)) |

Where the backup machinery lives (to rebuild it):
- **rclone config** (OAuth token): `/etc/investtrack/rclone.conf` (server) and
  `%APPDATA%\rclone\rclone.conf` (PC). Re-creatable from Google Cloud Console →
  **Clients → rclone**.
- **Backup script/config/schedule:** `/usr/local/bin/investtrack-backup-db.sh`,
  `/etc/investtrack/backup-db.env`, `investtrack-backup.timer` (02:30 UTC).
- Backups are plain gzip (not encrypted) — restore is always possible; protection
  is your private Google Drive + Google login (keep 2FA on).
- The old full-`/data` tar cron (`investment-backup.sh`) and the external
  `investment-tracker-log-cleanup` cron were **retired** 2026-07-11.

### Restore the database
Use [scripts/server/restore-db.sh](../scripts/server/restore-db.sh) (fetches the
latest from Drive, decompresses, integrity-checks, prints the swap-in steps), or
manually:
```bash
# 1. Get the latest backup from Google Drive
rclone copy gdrive:InvestTrackBackups/db/ ./restore/ --include "investments-*.db.gz"

# 2. Decompress (latest file)
gunzip -c ./restore/investments-<stamp>.db.gz > ./restore/investments.db

# 3. Sanity-check the DB opens and has data
sqlite3 ./restore/investments.db "PRAGMA integrity_check; SELECT count(*) FROM investments;"

# 4. Stop app, replace /data/investments.db (back up the current one first), start app
docker stop investment-tracker-blue investment-tracker-green 2>/dev/null || true
cp /data/investments.db /data/investments.db.bak-$(date +%F) 2>/dev/null || true
cp ./restore/investments.db /data/investments.db
rm -f /data/investments.db-wal /data/investments.db-shm
# start the app again via your normal deploy/start flow
```
> **Do a dry-run restore periodically** (e.g. quarterly) so you know it works.

### Restore secrets/config
Download the files from **Google Drive → Investments → InvestTrack** and put them
back: `configs/ssh-key-2026-05-06.key` (local), `/etc/caddy/Caddyfile`,
`configs/gcp-client.json` (local), `/opt/investment-tracker.env`. Re-create the
rclone remote from Google Cloud Console → Clients → rclone if needed.

---

## Zero-downtime deploys (blue/green)

Goal: the app stays reachable while deploying. Caddy never restarts; only the app
container is swapped.

```
Caddy (:443) ──import─► /etc/caddy/investtrack-upstream.caddy ─► active app port
        ┌───────────────┴───────────────┐
   investment-tracker-blue :8081   investment-tracker-green :8082
```
Deploy flow ([scripts/deploy-remote.sh](../scripts/deploy-remote.sh)):
1. Detect the active color from the upstream file; build the new image.
2. Start the **other** color container; health-check `http://localhost:<port>/health`
   until 200 (served by the app / SPA fallback).
3. Flip Caddy via the root helper `investtrack-switch-upstream.sh <port>`
   (writes the upstream file, `caddy validate`, `systemctl reload` — graceful, no
   dropped connections).
4. Stop the old color (kept for fast rollback) and remove the legacy 8080 container.

**Fail-safe:** if the new container fails health checks, or the Caddy switch/helper
fails, the deploy **aborts before touching the old container** — production is
unchanged. Both colors share `/data/investments.db` (low-concurrency, so the brief
overlap is safe under SQLite WAL).

**Operate manually:**
```bash
cat /etc/caddy/investtrack-upstream.caddy                 # which color is live
docker start investment-tracker-green                     # bring a color up
sudo /usr/local/bin/investtrack-switch-upstream.sh 8082   # point Caddy at it
```

---

## Secrets & un-checked-in config inventory

Required to rebuild the setup but **not in git** — backed up to a **private
Google Drive** folder (Runbook D).

| Item | Location | Backed up where |
|------|----------|-----------------|
| SSH private key | `configs/ssh-key-2026-05-06.key` (local, git-ignored) | Google Drive (private) |
| Server env file | `/opt/investment-tracker.env` (SESSION_SECRET, GOOGLE_CLIENT_ID) | Google Drive (private) |
| Caddyfile | `/etc/caddy/Caddyfile` (server) | Google Drive (private) |
| Google OAuth client (app login) | `configs/gcp-client.json` (local, git-ignored) | Google Drive (private) |
| rclone config (backup pipeline) | `/etc/investtrack/rclone.conf` + `%APPDATA%\rclone\rclone.conf` | re-creatable via Google Cloud Console → Clients → rclone |
| DuckDNS token | duckdns.org account only (not stored on the server) | not rotated (low-sensitivity app) |

> Ensure `configs/*.key`, `configs/gcp-client.json`, and `_secrets/` stay in
> `.gitignore` so secrets never get committed.

---

# Setup reference (how each piece is configured)

How the moving parts were set up — kept here so the environment can be rebuilt if
lost. Scripts live under [scripts/](../scripts) and [scripts/server/](../scripts/server).

## Runbook A — Off-box DB backup (rclone → Google Drive)

**What is rclone?** A command-line tool that uploads/syncs files to cloud
storage. Here it uploads the nightly DB dump to Google Drive (no new account;
survives losing the Oracle machine/account).

**1) Create your own Google OAuth client for rclone** (the built-in shared client
is being retired in 2026 — your own is permanent):
- Google Cloud Console → enable **Google Drive API**.
- **Auth Platform → Audience** → set publishing status to **In production**
  (avoids 7-day token expiry; the `drive.file` scope needs no verification).
- **Clients → Create client → Desktop app** → copy the **Client ID** + **Client secret**.

**2) Configure the rclone remote on Windows** (browser is local), then ship the
config to the server:
```powershell
winget install Rclone.Rclone
rclone config
#  n) new remote     name> gdrive     Storage> drive
#  client_id>     <your Client ID>
#  client_secret> <your Client secret>
#  scope> 3        (drive.file — rclone only sees files it creates; safest)
#  root_folder_id / service_account_file > (blank)
#  Edit advanced config? n
#  Use auto config? y     -> browser opens, log in + Allow
#  Shared Drive? n        -> confirm y
rclone mkdir gdrive:InvestTrackBackups
rclone lsd gdrive:        # with drive.file it only shows folders rclone created —
                          # empty output right after setup is normal
# Ship the config (holds the OAuth token) to the server:
scp -i .\configs\ssh-key-2026-05-06.key "$env:APPDATA\rclone\rclone.conf" ubuntu@92.4.90.130:/tmp/rclone.conf
```

> **Reconfigure later** (token issues / changed client): `rclone config` → `e`
> edit `gdrive` → update client_id/secret → at *"Already have a token - refresh?"*
> choose **Yes** to re-auth → re-copy `rclone.conf` to the server.

**On the server (as ubuntu):**
```bash
sudo apt-get update && sudo apt-get install -y rclone sqlite3
sudo mkdir -p /etc/investtrack /data/backups
sudo mv /tmp/rclone.conf /etc/investtrack/rclone.conf
sudo chown root:root /etc/investtrack/rclone.conf && sudo chmod 600 /etc/investtrack/rclone.conf

# Install the backup script + config
sudo cp scripts/server/backup-db.sh /usr/local/bin/investtrack-backup-db.sh
sudo chmod +x /usr/local/bin/investtrack-backup-db.sh
sudo cp scripts/server/backup-db.env.example /etc/investtrack/backup-db.env
sudo nano /etc/investtrack/backup-db.env      # set RCLONE_REMOTE=gdrive:InvestTrackBackups/db

# Test once, then verify the object landed in Drive
sudo BACKUP_DB_ENV=/etc/investtrack/backup-db.env /usr/local/bin/investtrack-backup-db.sh
sudo RCLONE_CONFIG=/etc/investtrack/rclone.conf rclone ls gdrive:InvestTrackBackups/db

# Schedule daily via systemd timer
sudo cp scripts/server/investtrack-backup.service /etc/systemd/system/
sudo cp scripts/server/investtrack-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now investtrack-backup.timer
systemctl list-timers investtrack-backup.timer
```
Restore: use [scripts/server/restore-db.sh](../scripts/server/restore-db.sh)
(fetches latest from the remote, decompresses, integrity-checks, prints the
swap-in steps).

## Runbook C — Zero-downtime deploys (blue/green)

Deploys keep the app reachable by running two app containers (blue `:8081` /
green `:8082`) and having Caddy flip between them via an includable upstream file.
The deploy script ([scripts/deploy-remote.sh](../scripts/deploy-remote.sh)) calls a
single root helper to switch + graceful-reload Caddy. If the helper is missing or
the switch fails, the deploy aborts **before** touching the old container, so
production stays up (fail-safe).

**One-time server prep** (safe — keeps serving on the current port throughout):
```bash
# 1. Install the switch helper (root-owned) + allow the deploy user to run ONLY it
sudo cp scripts/server/switch-upstream.sh /usr/local/bin/investtrack-switch-upstream.sh
sudo sed -i 's/\r//g' /usr/local/bin/investtrack-switch-upstream.sh
sudo chown root:root /usr/local/bin/investtrack-switch-upstream.sh
sudo chmod 755 /usr/local/bin/investtrack-switch-upstream.sh
echo 'ubuntu ALL=(root) NOPASSWD: /usr/local/bin/investtrack-switch-upstream.sh' | sudo tee /etc/sudoers.d/investtrack-caddy
sudo chmod 440 /etc/sudoers.d/investtrack-caddy

# 2. Point Caddy at an includable upstream file — start at the CURRENT port (8080)
echo 'reverse_proxy 127.0.0.1:8080' | sudo tee /etc/caddy/investtrack-upstream.caddy

# 3. Switch the Caddyfile to import that file (keep a backup), then reload
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-bluegreen
printf 'investtrack.duckdns.org {\n    encode gzip zstd\n    import /etc/caddy/investtrack-upstream.caddy\n}\n' | sudo tee /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy    # graceful; still serving via :8080
```
After prep, the next deploy runs blue on `:8081`, health-checks it, flips Caddy to
`:8081`, then removes the legacy fixed-`:8080` container — **no downtime**.
Subsequent deploys alternate blue↔green. Each deploy prints a rollback command.

## Runbook D — Secrets/config off-box backup

**Chosen approach (simplest): plaintext files in personal Google Drive.**
These secrets are all *regenerable* (new SSH key via Oracle console, new OAuth
client in Google Cloud, new session secret), so this is a convenience/rebuild
kit, not the irreplaceable data (that's the DB → Google Drive). Copy these 4 files into a
**private** Google Drive folder:
- `configs/ssh-key-2026-05-06.key` (local)
- `configs/gcp-client.json` (local)
- server `/opt/investment-tracker.env`
- server `/etc/caddy/Caddyfile`

```powershell
New-Item -ItemType Directory -Force -Path .\_secrets | Out-Null
Copy-Item .\configs\ssh-key-2026-05-06.key,.\configs\gcp-client.json .\_secrets\
scp -i .\configs\ssh-key-2026-05-06.key ubuntu@92.4.90.130:/opt/investment-tracker.env .\_secrets\
scp -i .\configs\ssh-key-2026-05-06.key ubuntu@92.4.90.130:/etc/caddy/Caddyfile .\_secrets\
# then upload .\_secrets\* to a PRIVATE Google Drive folder, and:
Remove-Item .\_secrets -Recurse -Force
```
**Conditions:** keep **2-Step Verification ON** for the Google account, and keep
the Drive folder **private** (never "anyone with link"). Residual risk: a
Google-account breach exposes these too — acceptable here since they're regenerable.

## Runbook E — If the public IP ever changes

The instance uses an **Ephemeral** public IP (`92.4.90.130`). It persists across
reboots and stop/start and only changes if the instance is **terminated and
recreated**. Reserving a static public IP isn't offered on this Always Free setup
(the console's "Reserve IPv4 address" applies to the **private** IP, not the
public one), so we just handle a change if it happens.

If the IP changes:
1. Get the new IP: Console → Instance → **Attached VNICs → VNIC → IP administration**,
   or on the box: `curl -s ifconfig.me`.
2. Update **DuckDNS**: at duckdns.org set the `investtrack` record to the new IP
   (or `curl "https://www.duckdns.org/update?domains=investtrack&token=<TOKEN>&ip=<NEW_IP>"`).
3. Update `oracle.host` in [configs/investtrack-prod.json](../configs/investtrack-prod.json)
   (used by SSH/deploy).
4. Remove any stale hosts-file entry (Layer 2 break-glass) pointing to the old IP.
5. Verify: `nslookup investtrack.duckdns.org` resolves to the new IP and the site loads.

## Runbook F — Rotate the DuckDNS token

There is **no DuckDNS updater on the server** (the record is set manually via the
website), so the token isn't stored anywhere on the box.

1. https://www.duckdns.org → **recreate/regenerate token**.
2. That's it — nothing on the server to change. (If you later add a DuckDNS updater
   cron, put the new token there.)
3. Optional, after any IP change: `curl "https://www.duckdns.org/update?domains=investtrack&token=<NEW>&ip=<IP>"` → `OK`.

---

## Not in place (by design)

For a future debugger — the following are intentionally **not** set up, so don't
go looking for them:
- No reserved/static public IP (the ephemeral IP is stable; see Runbook E).
- No Cloudflare / custom domain — DNS is DuckDNS only.
- No Litestream or continuous replication — the nightly gzip backup is the only DB backup.
- No multi-node / load-balanced HA — single VM, single SQLite writer.
- No server-side DuckDNS updater; the DuckDNS token is not rotated.
