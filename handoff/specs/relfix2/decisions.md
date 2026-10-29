# Owner decisions, round 2 (2026-10-29, answered in the session)

- D-177 RunAsNode: move every helper off ELECTRON_RUN_AS_NODE (utility processes; SSH askpass runs as Ember itself in a
  no-window mode), then turn the RunAsNode fuse off and flip CI's "plain Node kept" checks. Built on its own branch and
  merged only when real CI is green on every OS.
- D-78 Typed-ahead: no keyboard hook. Document "wait for the box" (README, and a first-run hint in the ask box) and cut
  the time until the box takes the keyboard where possible.
- D-45b Shortcuts: when a default shortcut is taken, register a documented fallback chord for it and say which one;
  add "Ask Ember" to the OS launcher (Windows jump list, Linux .desktop action, macOS Dock menu). No settings UI for
  changing keys.
- D-75 Handle position: Settings > Comfort & access gets "Handle position" (bottom right / bottom left); the handle's
  menu gets "Move to the other side"; task cards and copy follow it.
