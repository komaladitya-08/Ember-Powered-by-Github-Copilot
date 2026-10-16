# Ember — powered by GitHub Copilot

A small, expressive companion that lives next to your cursor, listens for "Hey Ember",
and does the work in your real apps where you can watch, without taking over your mouse.
The agent loop runs on the GitHub Copilot SDK. First platform: RHEL 8.4 (GNOME on Xorg).

Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8):

```bash
sudo dnf install ./ember-0.1.0-1.el8.x86_64.rpm
ember doctor               # checks this computer and explains anything to fix
```

For “Hey Ember” without downloading the speech models on each computer, also install
`ember-voice-models-0.1.0-1.el8.noarch.rpm` when you build it (`node scripts/voice/prepare.mjs` before packaging;
see docs/DEVELOPING.md). Without it, Ember offers to download the models (126 MB) when voice is turned on.

Or run `Ember-0.1.0-x86_64.AppImage` without installing. To develop:

```bash
npm ci && npm run dev      # needs Node 22 and npm 11, see docs/DEVELOPING.md
```

- **[PLAN.md](PLAN.md)**: the frozen v1 plan, task list and progress
- [docs/DEVELOPING.md](docs/DEVELOPING.md): set up a development machine (RHEL 8.4)
- [docs/RESEARCH.md](docs/RESEARCH.md): background research and evidence
- [docs/DESIGN.md](docs/DESIGN.md): characters, emotions and motion
- `demo/character-lab`: interactive character prototype (`npm run build:lab`)
