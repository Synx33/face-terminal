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
2. Open a normal (non-administrator) PowerShell in the project folder and run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\windows\install.ps1 -DevicePass "<the terminal's admin password>"
   ```
   (leave off `-DevicePass` and it'll prompt for it interactively instead)

Installing a Windows service and opening a firewall port both need admin
rights — the installer detects it isn't elevated and relaunches itself,
which pops the standard Windows "Do you want to allow this app to make
changes?" prompt. Click **Yes** and it continues in the new elevated
window (the original window can be closed).

This registers `face-terminal` as a Windows service (auto-starts on boot,
survives reboots and power loss, and restarts itself automatically if it
ever crashes), opens the firewall for port 3070, and starts it. It also
takes a database backup right away and daily after that (kept in
`data\backups\`, last 14 days). When it finishes you'll see the dashboard
URL to open in a browser.

Customize with parameters if needed:
```powershell
.\windows\install.ps1 -DevicePass "..." -Port 8080 -DeviceIp 10.0.0.50
```

Service management:
```powershell
Get-Service face-terminal
Restart-Service face-terminal
Stop-Service face-terminal
```

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
| `CHECKIN_DEBOUNCE_SECONDS` | Initial debounce window (default 60s) — same as above, overridable live from Settings. |
| `RECEIVER_IP` | Hostname/IP shown in the startup log line for the dashboard URL (cosmetic only). |
| `FACE_TERMINAL_DATA` | Where the SQLite DB, snapshots, backups, and log file live. |

## What it does

The dashboard is organized into three tabs — **ჩანაწერები** (Feed),
**თანამშრომლები** (Workers), **ხელფასი** (Payroll) — plus a Settings dialog
(gear icon in the header) for terminal/device config and maintenance.

- **Live check-in feed** — polls the terminal's own event log (not push
  notifications — see below) every 1.5s (customizable), shows who badged
  in/out with a photo, in real time. Filterable by date and by worker;
  exports to CSV.
- **Check-in/check-out** — this terminal has no in/out mode selector, so
  direction is derived: 1st scan of the day for a person is "in", 2nd is
  "out", and so on. Repeat scans within a debounce window (customizable,
  default 60s) collapse into one session instead of spamming the feed.
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
  too, not only from the Workers tab. Exports to CSV.
- **Settings** — site name, currency symbol, poll interval, and debounce
  window are all live-editable, no restart needed. Also: pin/change the
  device IP, clear check-in history, view/clear the log, and trigger or
  review database backups — all without touching a config file or SSH/RDP.
- **Automatic backups** — a full database backup runs at startup and every
  24h after, keeping the last 14 dated copies in `data/backups/` (uses
  `node:sqlite`'s own online-backup API, safe even while the live DB is
  being written to).

### Why polling, not the terminal's push notifications

Arming the terminal's `httpHosts` push config flooded the receiver with an
unrelated historical backlog of operation-log noise instead of real-time
events. Polling its `AcsEvent` search API directly is slower in theory
(bounded by the poll interval) but proved far more reliable in practice.

## Security notes

Built for a trusted LAN, not the public internet — same model as
[face-logger](https://github.com/Synx33/face-logger):

- **No login on any endpoint.** Anyone who can reach the dashboard's port
  can view attendance history and photos, enroll/rename/remove a worker,
  edit daily wages, view payroll, change the device IP or any other
  setting, or clear check-in history/logs. There's no auth layer at all.
  If that's ever not acceptable for how this is deployed, that needs adding
  before relying on it — it is not currently a "safe by default" app.
- **The Windows installer's firewall rule is scoped to Domain/Private
  networks only, not Public**, specifically because of the point above —
  see the installer's network-profile warning if the dashboard isn't
  reachable from other machines on site.
- The device's admin password lives in plain text in `.env` on this
  machine. Treat that file (and this machine generally) as holding a real
  credential.
- Snapshots contain faces — they're served as static files under
  `/snapshots/*` with no access control either.
