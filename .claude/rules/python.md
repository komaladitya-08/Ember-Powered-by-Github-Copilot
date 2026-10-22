---
paths:
  - "**/*.py"
---

# Python: the AT-SPI sidecar and the GTK fixtures

Every Python file here runs on RHEL 8's system interpreter, platform-python 3.6, with pyatspi 2.26. That covers `sidecar/atspi/ember_atspi.py`, its self-test, and the `test/fixtures/gtk3_*.py` windows. The local `python3` is usually much newer, so code that passes locally can still fail on the target.

- **Imports.** Import only the standard library plus the system's `pyatspi` (and `gi` in the GTK fixtures). Tests use `unittest`, never pytest.
- **No Python 3.7+ features.** These all fail on 3.6:
  - the walrus operator;
  - dataclasses;
  - f-string `=`;
  - `dict | dict`;
  - `from __future__ import annotations`;
  - `subprocess.run(capture_output=…, text=…)`;
  - `asyncio.run`;
  - `str.removeprefix`;
  - `functools.cache`.
- **Importable helpers.** Keep the sidecar's helpers importable without pyatspi or a display, so the self-test runs anywhere.
- **Twins in TypeScript.** Keep the sidecar's constants in step with their TypeScript twins, which are marked "Keep in step with … in ember_atspi.py". Examples are the secret-field word lists and the role names. The JSON-RPC methods and their shapes are the contract with app/main/perception/sidecar.ts; change both sides together.
- **Never read password text.** The sidecar skips hidden nodes and never reads password text. Unnamed controls borrow the label to their left.
- **Test on 3.6 before you push.** Run the self-test on 3.6 as well as locally: CI's `el8` job runs `/usr/libexec/platform-python -B sidecar/atspi/test_ember_atspi.py`. Without platform-python, run it in a `rockylinux:8` container (podman or docker), as scripts/rebuild-el8.sh does for native code. If you can't, say so in the PR.
