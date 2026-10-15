# Developing Ember on RHEL 8.4

This guide gets a development copy of Ember running on RHEL 8.4. It also works on
Rocky, Alma and Oracle Linux 8.

## 1. Log in to "GNOME on Xorg"

Ember v1 needs an X11 session. On the login screen, click your name, then the gear
icon next to **Sign In**, and choose **GNOME on Xorg**. Check it in a terminal:

```bash
echo $XDG_SESSION_TYPE   # must print: x11
```

The choice is remembered for the next login.

## 2. Install system packages

```bash
sudo dnf install -y git gcc-c++ make python3 \
  libX11-devel libXtst-devel libXt-devel \
  gtk3 nss alsa-lib mesa-libgbm libxkbcommon at-spi2-core at-spi2-atk cups-libs \
  xorg-x11-server-Xvfb xorg-x11-xauth
```

A standard RHEL Workstation install already has most of the runtime libraries. The
compilers and `-devel` packages are needed when native modules are rebuilt (§6).

Later milestones also use these (safe to install now):

```bash
sudo dnf install -y python3-pyatspi python3-gobject speech-dispatcher speech-dispatcher-espeak-ng
```

## 3. Install Node 22 and npm 11

RHEL 8.4's own Node streams are too old, so use the official Node 22 build (it runs on
glibc 2.28):

```bash
curl -fsSLO https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz
sudo mkdir -p /opt/node22 && sudo tar -xJf node-v22.22.0-linux-x64.tar.xz -C /opt/node22 --strip-components=1
echo 'export PATH=/opt/node22/bin:$PATH' >> ~/.bashrc && source ~/.bashrc
npm install -g npm@11.6.2
```

npm 10 crashes while resolving the test tools (`Cannot read properties of null (reading
'edgesOut')`), so npm 11 is required.

## 4. Turn on accessibility

Ember reads apps through the accessibility service:

```bash
gsettings set org.gnome.desktop.interface toolkit-accessibility true
```

Log out and in again so running apps pick it up.

## 5. Run it

```bash
git clone https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot.git ember
cd ember
npm ci
npm run dev
```

The Ember window opens with a **Setup check**. Every row should be green on RHEL 8.4
with GNOME on Xorg. If `npm ci` reports that Electron failed to download, run
`npx install-electron` and try again.

| Command | What it does |
|---|---|
| `npm run dev` | Build and start Ember |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run test:smoke` | Starts Ember, checks the window appears and a second launch hands over. Without a desktop: `xvfb-run -a npm run test:smoke` |
| `npm run build:lab` | Builds the character lab demo into `dist/ember-character-lab.html` |
| `npm run rebuild:el8` | Rebuilds native modules for RHEL 8 and checks every binary (§6) |
| `npm run check:symvers` | Only the binary check |
| `scripts/install-desktop-entry.sh [--autostart]` | Adds "Ember (dev)" to the GNOME app menu (and to login) |
| `scripts/demo/desktop.sh start` then `DISPLAY=:55 node test/demo/m1-tour.mjs out/` | Records a video tour on a throw-away desktop (needs Xvfb, openbox, xcompmgr, feh, mousepad, xdotool, ffmpeg) |

### Using Ember

- Ember appears beside your cursor; its handle sits in the bottom-right corner. Click the handle for
  **Settings**, **Stay put / Follow my cursor**, **Hide / Show Ember** and **Quit**.
- **Ctrl+Alt+E** opens settings from anywhere.
- Without a compositor (xrdp, VNC), transparent windows can't work, so Ember lives in an opaque
  card in the corner instead.

### Where Ember keeps things

| What | Where |
|---|---|
| Settings | `~/.config/ember/settings.json` |
| Logs (JSON lines, rotated at 5 MB) | `~/.config/ember/logs/ember.log` |

Environment variables for development:

| Variable | Effect |
|---|---|
| `EMBER_USER_DATA=/tmp/x` | Use another settings and log folder |
| `EMBER_LOG_LEVEL=debug` | More detail in the log |
| `EMBER_LOG_STDOUT=1` | Also print log lines to the terminal (on by default in development) |

## 6. Native modules and RHEL 8

Every compiled file Ember ships (`.node`, `.so`, executables) must work with RHEL 8.4's
glibc 2.28 and libstdc++ (GLIBCXX_3.4.25). Many npm packages ship prebuilt binaries made
on newer systems that **will not load** on RHEL 8 (for example `robotjs` 0.9.1 and
`uiohook-napi` 1.5.5).

Rules:

1. List every native module in `package.json` under `"ember": { "nativeModules": [...] }`.
2. Run `npm run rebuild:el8`. On RHEL 8 it rebuilds in place; elsewhere it runs inside a
   `rockylinux:8` container (needs podman or docker).
3. `scripts/check-symvers.sh` must pass. CI runs both steps on every pull request.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Setup check says "Wayland session" | Log in with **GNOME on Xorg** (§1) |
| `The SUID sandbox helper binary was found, but is not configured correctly` | User namespaces are disabled (common on STIG-hardened machines; check `sysctl user.max_user_namespaces`, 0 means disabled). For development only: `npx electron . --no-sandbox`. The RPM sets up the sandbox helper properly (task M9.2). |
| `npm ci` fails with `edgesOut` | Upgrade npm: `npm install -g npm@11.6.2` |
| Electron download fails | `npx install-electron` |

## Repository layout

```
app/main/           Electron main process (settings, logging, environment checks, windows)
app/preload/        contextBridge APIs, one per window
app/renderer/       window pages (home)
app/shared/         IPC channel names and types
packages/characters Ember's characters and the shared emotion rig
packages/bubble     reasoning bubble
packages/motion     follow spring and flight path
demo/character-lab  interactive character prototype
scripts/            build, RHEL 8 rebuild and binary checks
test/unit           Vitest tests;  test/smoke  launch test
```
