# face-terminal

Attendance and payroll dashboard for a Hikvision DS-K1T343EWX face/card
access terminal — who came in and when, check-in/check-out, live updates,
photo capture, worker enrollment/management, and daily-wage payroll. UI is
in Georgian; almost everything (site name, currency, poll timing, terminal
IP) is customizable from the dashboard itself, no config file editing.

The terminal moves between networks (the office LAN during development, an
install site afterward), so it doesn't need a hardcoded IP: leave `DEVICE_IP`
blank in `.env` and the app finds it by scanning the local network for its
MAC address. You can also just type the IP into the dashboard's Settings
panel at any time — no restart needed.

## Install on Windows

This is the deploy target — the site runs this from a Windows laptop.

1. Install [Node.js LTS](https://nodejs.org) (20+) if not already present:
   ```powershell
   winget install -e --id OpenJS.NodeJS.LTS
   ```
2. Find that site's terminal's MAC address (a sticker on the unit itself,
   or its own local menu under Network settings) — every site has a
   different one, so there's no default to fall back on here.
3. Decide the dashboard's own first login (this is separate from the
   terminal's own admin login — it's the account you'll actually use to
   open the dashboard in a browser afterward).
4. Open a normal (non-administrator) PowerShell in the project folder and run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\windows\install.ps1 -DeviceMac "AA:BB:CC:DD:EE:FF" -DevicePass "<the terminal's admin password>" -AdminPass "<a password for the dashboard's first login>"
   ```
   (leave off `-DeviceMac`, `-DevicePass`, or `-AdminPass` and it'll prompt for them interactively instead; `-AdminUser` defaults to `admin` if not given)

Installing a Windows service and opening a firewall port both need admin
rights — the installer detects it isn't elevated and relaunches itself,
which pops the standard Windows "Do you want to allow this app to make
changes?" prompt. Click **Yes** and it continues in the new elevated
window (the original window can be closed).

This registers `face-terminal` as a Windows service (auto-starts on boot,
survives reboots and power loss, and restarts itself automatically if it
ever crashes), opens the firewall for port 3070, and starts it. It also
backs up the database and worker photos right away and every 10 minutes
after that (kept in `data\backups\`). When it finishes you'll see the
dashboard URL to open in a browser.

Customize with parameters if needed:
```powershell
.\windows\install.ps1 -DeviceMac "AA:BB:CC:DD:EE:FF" -DevicePass "..." -AdminPass "..." -AdminUser "manager" -Port 8080 -DeviceIp 10.0.0.50
```

Service management:
```powershell
Get-Service face-terminal
Restart-Service face-terminal
Stop-Service face-terminal
```

**Update to the latest version** — one command, safe to run any time:
```powershell
.\windows\update.ps1
```
Fetches the latest code from GitHub and replaces the installed copy, but
never touches `.env` (your pinned device IP/credentials) or the data
directory (attendance history, snapshots, backups, logs — which live
entirely under `C:\ProgramData\face-terminal`, a separate location this
script never even looks at). Safe to run from any PowerShell — it
self-elevates the same way `install.ps1` does.

Uninstall:
```powershell
.\windows\uninstall.ps1            # keeps attendance data
.\windows\uninstall.ps1 -Purge     # also deletes it
```

## Install on Linux

```bash
npm install
cp .env.example .env   # fill in DEVICE_USER / DEVICE_PASS / DEVICE_MAC
```

Run directly:
```bash
npm start
```

Or as a systemd service — see `face-terminal.service` for the unit file
(copy to `/etc/systemd/system/`, `systemctl daemon-reload`,
`systemctl enable --now face-terminal`).

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `DEVICE_IP` | Terminal's IP. Leave blank to auto-discover by MAC. |
| `DEVICE_MAC` | Terminal's MAC address, used for discovery. |
| `DEVICE_USER` / `DEVICE_PASS` | Terminal's admin login (ISAPI digest auth). |
| `PORT` | Dashboard port (default 3070). |
| `POLL_INTERVAL_MS` | Initial poll interval (default 1500ms) — overridable live from Settings afterward, which takes precedence once set. |
| `CHECKOUT_AFTER` | Initial checkout-time boundary, "HH:MM" 24h (default 19:00) — same as above, overridable live from Settings. |
| `RECEIVER_IP` | Hostname/IP shown in the startup log line for the dashboard URL (cosmetic only). |
| `FACE_TERMINAL_DATA` | Where the SQLite DB, snapshots, backups, and log file live. |
| `CARD_DEVICE_IP` | Optional second device — a DS-K2802 card-reader controller. Leave blank to run with just the face terminal (the default). No auto-discovery for this one (see below) — must be set explicitly. All three of these (plus credentials) can also be entered straight from the dashboard's Settings dialog, with a live "test connection" button — editing `.env` by hand is not required. |
| `CARD_DEVICE_USER` / `CARD_DEVICE_PASS` | Card controller's admin login. Defaults to `DEVICE_USER`/`DEVICE_PASS` if left blank. |
| `CARD_SDK_LIB_DIR` / `LD_LIBRARY_PATH` | Linux only — where this box's own copy of Hikvision's Linux SDK build lives. See "Setup" under the card-reader section below. |
| `ADMIN_USER` / `ADMIN_PASS` | The dashboard's own first login account, created automatically the first time it ever starts with no accounts yet. Leave blank and a random password gets generated and printed to the log once instead (see "Accounts and permissions" below). |

## What it does

The dashboard is organized into three tabs — **ჩანაწერები** (Feed),
**თანამშრომლები** (Workers), **ხელფასი** (Payroll) — plus a Settings dialog
(gear icon in the header) for terminal/device config and maintenance.

- **Live check-in feed** — polls the terminal's own event log (not push
  notifications — see below) every 1.5s (customizable), shows who badged
  in/out with a photo, in real time. Filterable by date and by worker;
  exports to a formatted Excel report (title block, colored header, zebra
  striping — not a raw CSV).
- **Optional card-reader controller (DS-K2802)** — a second, independent
  device this dashboard can listen to alongside the face terminal for
  card-swipe check-ins, useful anywhere face recognition is too
  slow/unreliable on site. Fully opt-in: set `CARD_DEVICE_IP` in `.env` to
  enable it, leave it blank and nothing about this changes.

  This device doesn't speak ISAPI (the HTTP API the face terminal and the
  rest of this app use) at all — confirmed live against the real hardware,
  its firmware predates that layer. It only speaks Hikvision's older,
  proprietary binary "HCNetSDK" protocol (TCP port 8000), so the
  integration (`src/cardSdk.js`) is a real-time push subscription over that
  protocol instead of an HTTP poll, verified end-to-end against the real
  device: a live alarm fired, and every field of the decoded event matched
  reality exactly (the actual date/time, the actual logged-in username).

  **Card/person enrollment**: cards can be enrolled straight from this
  dashboard now too — Workers tab → "ბარათის მოლოდინი" ("wait for card"),
  tap the physical card, then name it, mirroring the face terminal's own
  "capture first, name later" flow. (Remote card *provisioning* — pushing a
  card onto the device itself via SDK — is still not supported: confirmed
  live that this firmware rejects every such command consistently, unlike
  the event-subscription mechanism, which worked correctly on the first
  attempt. Not a gap in this code, a firmware limitation. This only matters
  if a card needs to unlock a physical door/relay on the controller itself —
  enrolling it here is enough for attendance tracking regardless.) A swipe
  resolves to the right worker locally via
  `employees.card_no`/`POST /api/employees/:employeeNo/card`, entirely
  independent of anything on the device side. Since the DS-K2802 has no
  camera, a card check-in never triggers a photo capture, unlike the face
  terminal.

  **Setup (Windows)**: this needs Hikvision's own Windows "Device Network
  SDK" DLLs to actually load on the site laptop — `vendor/hcnetsdk/win64/`
  is `.gitignore`d (deliberately not committed to this public repo: it's
  Hikvision's proprietary compiled SDK, sourced during development from an
  unofficial mirror rather than Hikvision's own account-gated download
  portal, and that's not this project's call to make about what a public
  clone redistributes). Before enabling `CARD_DEVICE_IP`:
  1. Download "Device Network SDK (for Windows 64-bit)" from
     [Hikvision's own SDK portal](https://www.hikvision.com/en/support/download/sdk/)
     (free account signup).
  2. From the download, copy `HCNetSDK.dll`, `HCCore.dll`, `libeay32.dll`,
     `ssleay32.dll`, and the whole `HCNetSDKCom/` folder into
     `vendor/hcnetsdk/win64/` (create the folder if needed) on the install
     directory.
  3. `npm install` needs to run at least once on that Windows machine
     (unlike the rest of this app's dependencies, `koffi`'s native binary is
     platform-specific — a laptop's `node_modules` bundled from this dev box
     only has the Linux build) — `windows/update.ps1` already falls back to
     this automatically if a dependency is missing.

  **Setup (Linux)**: same idea, but pointed at wherever this box's own copy
  of the Linux SDK build lives (e.g. `/opt/hiksdk/<version>/lib`, installed
  outside this repo — never committed here, same reasoning as the Windows
  DLLs above). Set two variables in `.env`:
  ```
  CARD_SDK_LIB_DIR=/opt/hiksdk/<version>/lib
  LD_LIBRARY_PATH=/opt/hiksdk/<version>/lib:/opt/hiksdk/<version>/lib/HCNetSDKCom
  ```
  `CARD_SDK_LIB_DIR` tells `cardSdk.js` where to `koffi.load()`
  `libhcnetsdk.so` itself; `LD_LIBRARY_PATH` is still needed on top of that
  so the dynamic linker can find *that* library's own further dependencies
  (`libHCCore.so`, the `HCNetSDKCom/*` plugins, etc.) at load time.
- **Check-in/check-out** — this terminal has no in/out mode selector, so
  direction is derived from time of day: any scan before the configured
  checkout time (default 19:00) is "in", the first scan at or after it is
  "out". Any further **face** scans that day on the same side of that
  boundary are ignored entirely — walking past the camera again at lunch
  doesn't create a new row or change the displayed time, only crossing the
  boundary does. **Card-reader taps are never collapsed this way** — a
  face scan can passively re-trigger just from standing in view, but a
  card tap needs a deliberate physical action, so every single tap is
  always read, saved, and shown immediately, with no time-of-day gating.
- **Add worker** — capture a face photo first (no name needed), assign a
  name and (optionally) a daily wage whenever whoever's in charge has a
  moment. Creates the user and uploads the face on the actual device.
- **Worker management** — rename, change daily wage, or remove any enrolled
  worker from the dashboard. Removing deletes their face and door access
  from the terminal itself, not just from this dashboard — their past
  attendance history is kept.
- **Payroll** — for any date range, computes each worker's distinct days
  present × their daily wage (a day counts once no matter how many times
  they scanned it). The daily wage is editable right from the payroll table
  too, not only from the Workers tab. Exports to a formatted Excel report,
  including each employee's actual attended dates (not just a count) and a
  grand-total row.
- **Settings** — site name, currency symbol, poll interval, and the
  checkout-time boundary are all live-editable, no restart needed. Also:
  pin/change the device IP and credentials, clear check-in history,
  view/clear the log, and trigger or review database backups — all without
  touching a config file or SSH/RDP.
- **Automatic backups** — runs at startup and every 10 minutes after,
  covering both the database (via `node:sqlite`'s own online-backup API,
  safe even while the live DB is being written to) and every worker photo
  (mirrored incrementally into `data/backups/snapshots/` — never deletes a
  backed-up photo even if the original is removed). Every backup from the
  last 24h is kept as-is; beyond that, one per day survives for 30 days.

### Why polling, not the terminal's push notifications

Arming the terminal's `httpHosts` push config flooded the receiver with an
unrelated historical backlog of operation-log noise instead of real-time
events. Polling its `AcsEvent` search API directly is slower in theory
(bounded by the poll interval) but proved far more reliable in practice.

## Accounts and permissions

Every route requires logging in — the dashboard opens straight to
`/login.html` for anyone without a valid session. The very first account
(username/password set via `-AdminPass`/`-AdminUser` at install time, or
`ADMIN_USER`/`ADMIN_PASS` in `.env`) is an admin, created automatically the
first time the app ever starts with no accounts yet; leave those unset and a
random password gets generated and printed to the log once instead — check
`data\logs\face-terminal.log`, it's never shown again after that.

Admins manage every other account from Settings → Users: create a login,
toggle four independent permissions per person, or delete an account.
Nothing here is a role name or preset tier — it's exactly these four
switches, each one either on or off:

| Permission | Lets someone... |
|---|---|
| ნახვა (view) | See the check-in feed, payroll, worker list, and export reports |
| რედაქტირება (edit) | Rename workers, change daily wages, assign/clear card numbers |
| დამატება (add) | Capture new faces/cards and enroll new workers |
| წაშლა (remove) | Delete a worker |

Only an admin can manage other accounts, device/card-reader settings, app
settings (site name/currency/poll timing), backups, or logs — those aren't
covered by the four permissions above, they're admin-only outright. The
last remaining admin account can't be demoted or deleted (there'd be no one
left who could ever fix that). Anyone can change their own password from
Settings → My Account, regardless of what else they can do.

## Security notes

Built for a trusted LAN, not the public internet — same model as
[face-logger](https://github.com/Synx33/face-logger):

- **The Windows installer's firewall rule is scoped to Domain/Private
  networks only, not Public** — see the installer's network-profile warning
  if the dashboard isn't reachable from other machines on site.
- Sessions are plain random tokens in a cookie (not JWTs — see auth.js for
  why), stored server-side so they can be revoked immediately (a password
  change signs out every other session for that account). 30-day expiry.
- The device's admin password, and every dashboard account's password hash,
  live in `.env`/the local database on this machine. Treat that file (and
  this machine generally) as holding real credentials.
- Snapshots contain faces — they're served as static files under
  `/snapshots/*` with no access control either.
