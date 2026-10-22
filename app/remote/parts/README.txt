Ember's helper on this computer
===============================

Ember is a desktop assistant. Someone on another computer connected to this one over SSH with Ember, and Ember put
this small helper here so it can run commands (and, on a Linux desktop, read and use apps) on this computer for them.
Every command and step is checked on their computer and again here, against this computer's own Ember policy
(/etc/ember/policy.json, or /Library/Application Support/Ember/policy.json on a Mac), and written to this computer's
audit log.

The helper never listens on the network, never starts on its own and leaves nothing running: it runs only while
Ember's SSH connection is open, and stops when the connection ends.

What is where (Linux; on a Mac the same folders are under ~/Library/Application Support/Ember Remote):
- ~/.local/share/ember-remote/runtime/   the Node runtime the helper runs with
- ~/.local/share/ember-remote/versions/  the helper itself, one folder per version (this file is in one of them)
- ~/.local/state/ember-remote/<machine>/ this computer's audit log (audit/), the helper's logs (logs/) and the
                                         consent record (consent.json)

To remove the helper, run:
    sh ~/.local/share/ember-remote/versions/<version>/uninstall.sh
It keeps the audit log. To delete that as well, afterwards:
    rm -rf ~/.local/state/ember-remote

An administrator can turn Ember off on this computer, or limit what it may do here, with its policy file; see Ember's
documentation ("Admin policy keys").
