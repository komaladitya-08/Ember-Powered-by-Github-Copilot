# Built by scripts/package/rpm.sh from the folder scripts/package/stage.mjs makes.
# Electron and its libraries are prebuilt: no debuginfo, no stripping, and no
# automatic library dependencies (the list below is explicit and checked in CI).
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
%global __requires_exclude_from ^/opt/ember/.*$
%global __provides_exclude_from ^/opt/ember/.*$

Name:           ember
Version:        %{ember_version}
# 1 unless rpm.sh is given another (EMBER_RPM_RELEASE: CI builds Release 2 to test an upgrade).
Release:        %{?ember_release}%{!?ember_release:1}%{?dist}
Summary:        A cursor companion that works visibly in your apps, powered by GitHub Copilot
# Ember and Electron are MIT; bundled are Chromium (BSD-3-Clause and others, with FFmpeg under
# LGPL-2.1-or-later: LICENSES.chromium.html), sharp, detect-libc and sherpa-onnx (Apache-2.0; its
# WebAssembly also holds ONNX Runtime and piper-phonemize (MIT), Protocol Buffers and RE2 (BSD-3-Clause),
# and eSpeak NG (GPL-3.0-or-later), part of the text-to-speech that speaks Ember's voice), semver
# (ISC), koffi, zod and the Copilot SDK and runtime (MIT), and libvips (LGPL-3.0-or-later) with the
# libraries @img/sharp-libvips bundles: cairo (MPL-1.1), aom, libarchive and libimagequant (BSD-2-Clause;
# aom also grants the AOMedia Patent License 1.0), highway and libwebp (BSD-3-Clause), mozjpeg (IJG,
# BSD-3-Clause, Zlib), zlib-ng (Zlib), freetype (FTL), libpng (libpng-2.0), libtiff (libtiff), fontconfig
# (HPND-sell-variant), and more under MIT and LGPL-3.0-or-later (its README.md, shipped as %%license).
# The Inter typeface Ember's windows use is under the SIL Open Font License 1.1 (OFL-1.1).
# This tag is the one list for every target: the Windows and macOS packages also carry sherpa-onnx's
# native addon, with Eigen (MPL-2.0) in it (never in the RPM: it needs a newer glibc than RHEL 8's).
# The texts are in /opt/ember: THIRD_PARTY_NOTICES, LICENSE, LICENSES.chromium.html. stage.mjs fails if
# a bundled package's licence, or a library one declares it bundles, is missing here
# (scripts/package/licences.mjs).
License:        MIT AND Apache-2.0 AND BSD-3-Clause AND ISC AND LGPL-2.1-or-later AND LGPL-3.0-or-later AND GPL-3.0-or-later AND BSD-2-Clause AND MPL-1.1 AND MPL-2.0 AND Zlib AND IJG AND FTL AND libpng-2.0 AND libtiff AND HPND-sell-variant AND OFL-1.1
URL:            https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot
Source0:        ember-%{version}-staged.tar
ExclusiveArch:  x86_64
AutoReqProv:    no

# Electron (Chromium) runtime libraries.
Requires:       gtk3, nss, nspr, alsa-lib, mesa-libgbm, libdrm, libxkbcommon, cups-libs, dbus-libs
Requires:       libX11, libXcomposite, libXdamage, libXext, libXfixes, libXrandr, libxcb, libXtst
# Reading apps (the accessibility sidecar runs on the system Python).
Requires:       platform-python, python3-pyatspi, python3-gobject, at-spi2-core, at-spi2-atk
Requires:       glib2, desktop-file-utils
# Nice to have: Ember's desk, the system voice (only when Ember's own is missing), the microphone list and the
# speakers' stream, tray icons. Weak: dnf installs what the computer's repositories have, and Ember works without them.
Recommends:     xorg-x11-server-Xvfb, xorg-x11-xauth, dbus-daemon
Recommends:     speech-dispatcher, speech-dispatcher-espeak-ng, pulseaudio-utils
Recommends:     gnome-shell-extension-top-icons
Suggests:       metacity
%if 0%{?with_models}
# The speech models are in this package (one RPM installs everything Ember runs here); before 0.2 they were a
# package of their own, which this one replaces on upgrade.
Provides:       ember-voice-models = %{version}-%{release}
Obsoletes:      ember-voice-models < %{version}-%{release}
%endif

%description
Ember lives beside your mouse cursor on GNOME. Ask it something (Ctrl+Alt+Space
or "Hey Ember") and it answers, shows you where things are, or does the job in
your real applications while you keep working, asking before anything that
matters. Run "ember doctor" to check this computer.

%prep
%setup -q -c -n ember-%{version}

%install
mkdir -p %{buildroot}/opt
cp -a ember %{buildroot}/opt/ember
# Plain modes, whatever the build machine's umask or npm left: the owner writes, everyone reads (and
# runs what is executable). The sandbox helper gets its setuid mode from %%attr below.
chmod -R u=rwX,go=rX %{buildroot}/opt/ember
install -Dm755 launcher %{buildroot}%{_bindir}/ember
install -Dm644 ember.desktop %{buildroot}%{_datadir}/applications/ember.desktop
install -Dm644 ember.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/ember.svg
install -Dm644 ember.png %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/ember.png
install -Dm644 policy.example.json %{buildroot}%{_docdir}/ember/policy.example.json
install -Dm644 policy.README %{buildroot}%{_docdir}/ember/policy.README
install -dm755 %{buildroot}%{_sysconfdir}/ember
%if 0%{?with_models}
mkdir -p %{buildroot}%{_datadir}/ember
cp -a voice-models %{buildroot}%{_datadir}/ember/voice-models
chmod -R u=rwX,go=rX %{buildroot}%{_datadir}/ember/voice-models
%endif
# Every file under /opt/ember except the sandbox helper, which gets its own mode below. Licence and
# notice files are marked %%license, so they're installed even with --excludedocs.
(cd %{buildroot} && find opt/ember \( -type f -o -type l \) ! -path opt/ember/chrome-sandbox | sed 's| |?|g; s|^|/|' \
  | sed -E 's@^(.*/((LICEN[CS]E|COPYING|NOTICE|THIRD_?PARTY_?NOTICES|COPYRIGHTNOTICE)[^/]*|sharp-libvips-[^/]*/README\.md))$@%%license \1@I') > files.list
(cd %{buildroot} && find opt/ember -mindepth 1 -type d | sed 's| |?|g; s|^|%dir /|') >> files.list

%post
/usr/bin/update-desktop-database -q %{_datadir}/applications &>/dev/null || :
/bin/touch --no-create %{_datadir}/icons/hicolor &>/dev/null || :

%postun
/usr/bin/update-desktop-database -q %{_datadir}/applications &>/dev/null || :
if [ $1 -eq 0 ]; then
  /bin/touch --no-create %{_datadir}/icons/hicolor &>/dev/null || :
  /usr/bin/gtk-update-icon-cache %{_datadir}/icons/hicolor &>/dev/null || :
fi

%posttrans
/usr/bin/gtk-update-icon-cache %{_datadir}/icons/hicolor &>/dev/null || :
# Ember stays running from login, so an upgrade usually replaces its files under it: it keeps the old version in
# memory but would open its windows from the new files. Whoever upgrades is told to have it started again.
for exe in /proc/[0-9]*/exe; do
  case "$(readlink "$exe" 2>/dev/null)" in
    "/opt/ember/ember"|"/opt/ember/ember (deleted)")
      echo "Ember is still running the version before this update: quit Ember and start it again (each person using it on this computer) to finish the update."
      break ;;
  esac
done
:

%files -f files.list
%dir /opt/ember
# Chromium's setuid sandbox helper: needed where user namespaces are off (STIG hosts).
%attr(4755, root, root) /opt/ember/chrome-sandbox
%{_bindir}/ember
%{_datadir}/applications/ember.desktop
%{_datadir}/icons/hicolor/scalable/apps/ember.svg
%{_datadir}/icons/hicolor/256x256/apps/ember.png
%dir %{_docdir}/ember
%doc %{_docdir}/ember/policy.example.json
%doc %{_docdir}/ember/policy.README
%dir %{_sysconfdir}/ember

%if 0%{?with_models}
# The wake-word spotter, voice-activity detector, speech recogniser, Ember's own voice and Voice Match's model
# (about 142 MB): Ember never downloads them.
%dir %{_datadir}/ember
%{_datadir}/ember/voice-models
%endif

%changelog
* Thu Oct 15 2026 Ember developers - %{ember_version}-1
- Packaged build.
