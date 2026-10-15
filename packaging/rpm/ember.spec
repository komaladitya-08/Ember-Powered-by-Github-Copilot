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
Release:        1%{?dist}
Summary:        A cursor companion that works visibly in your apps, powered by GitHub Copilot
License:        MIT
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
# Nice to have: Ember's desk, speaking, the microphone list, tray icons, offline speech models.
Recommends:     xorg-x11-server-Xvfb, xorg-x11-xauth, dbus-daemon
Recommends:     speech-dispatcher, speech-dispatcher-espeak-ng, pulseaudio-utils
Recommends:     gnome-shell-extension-top-icons
Recommends:     ember-voice-models
Suggests:       metacity

%description
Ember lives beside your mouse cursor on GNOME. Ask it something (Ctrl+Alt+Space
or "Hey Ember") and it answers, shows you where things are, or does the job in
your real applications while you keep working, asking before anything that
matters. Run "ember doctor" to check this computer.

%if 0%{?with_models}
%package voice-models
Summary:        Offline speech models for Ember ("Hey Ember")
BuildArch:      noarch
License:        Apache-2.0 AND MIT
Requires:       ember = %{version}-%{release}

%description voice-models
The wake-word spotter, voice-activity detector and speech recogniser Ember uses
for "Hey Ember". With this package Ember doesn't download them (about 125 MB).
Everything runs on this computer.
%endif

%prep
%setup -q -c -n ember-%{version}

%install
mkdir -p %{buildroot}/opt
cp -a ember %{buildroot}/opt/ember
install -Dm755 launcher %{buildroot}%{_bindir}/ember
install -Dm644 ember.desktop %{buildroot}%{_datadir}/applications/ember.desktop
install -Dm644 ember.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/ember.svg
install -Dm644 ember.png %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/ember.png
install -Dm644 policy.example.json %{buildroot}%{_docdir}/ember/policy.example.json
install -dm755 %{buildroot}%{_sysconfdir}/ember
%if 0%{?with_models}
mkdir -p %{buildroot}%{_datadir}/ember
cp -a voice-models %{buildroot}%{_datadir}/ember/voice-models
%endif
# Every file under /opt/ember except the sandbox helper, which gets its own mode below.
(cd %{buildroot} && find opt/ember \( -type f -o -type l \) ! -path opt/ember/chrome-sandbox | sed 's| |?|g; s|^|/|') > files.list
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

%files -f files.list
%dir /opt/ember
# Chromium's setuid sandbox helper: needed where user namespaces are off (STIG hosts).
%attr(4755, root, root) /opt/ember/chrome-sandbox
%{_bindir}/ember
%{_datadir}/applications/ember.desktop
%{_datadir}/icons/hicolor/scalable/apps/ember.svg
%{_datadir}/icons/hicolor/256x256/apps/ember.png
%doc %{_docdir}/ember/policy.example.json
%dir %{_sysconfdir}/ember

%if 0%{?with_models}
%files voice-models
%{_datadir}/ember/voice-models
%endif

%changelog
* Thu Oct 15 2026 Ember developers - %{ember_version}-1
- Packaged build.
