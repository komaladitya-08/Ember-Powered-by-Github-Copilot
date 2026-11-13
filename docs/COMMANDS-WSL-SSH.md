# Commands, WSL and other computers

Ember can run commands for you, work in WSL on a Windows PC, and work on other computers you reach over SSH. This
page says what each does, what Ember asks you first, what it never does, how to turn each off, and what it can't do
yet. §6 is for administrators. The examples call the other computer "build-01" and the WSL distro "Ubuntu".

All three are **off until you turn them on**, and each has its own first-use card that says what it means before
anything happens: one for WSL, one for each computer you connect to, and one for commands on each computer. New users
see this in the "Before Ember starts" list; people who already use Ember aren't asked to agree again, because nothing
new happens until they accept a card.

Wherever Ember works, **your voice and your GitHub sign-in stay on this computer**. Listening, speech recognition,
the Copilot conversation and Ember's questions all stay here; another computer only receives the steps Ember takes
there and the commands it runs.

## 1. Choosing where Ember works

| Where | Apps on its screen | Commands |
|---|---|---|
| This computer (Linux) | as always | bash or sh, in a terminal Ember provides (`script`) |
| This computer (macOS) | as always | zsh, bash or sh, in a terminal; Homebrew's tools are found |
| This computer (Windows) | as always, plus Linux apps shown by WSL (§3) | Windows PowerShell 5.1, without typing (§2.9) |
| A WSL distro (WSL 2 or WSL 1) | the Windows screen, Linux apps included | bash, zsh or sh inside the distro; WSL 1: commands only |
| An SSH computer: Linux (x64 or arm64, glibc 2.28 or newer, kernel 4.18 or newer) with your own X11 desktop | reading, opening apps and using their controls, every step asked (§4.4) | bash, zsh or sh |
| An SSH computer: Linux with a Wayland desktop | none yet: commands only (§4.4) | yes |
| An SSH computer: Linux without a desktop, or only a VNC or xrdp session | none | yes |
| An SSH computer: macOS 13.5 or newer | none yet | zsh, bash or sh |
| An SSH computer that is WSL on another PC | none | yes |
| An SSH computer running Windows, or musl, older glibc, another CPU | not supported yet: Ember says why when you connect | — |

**Picking one.** With more than one computer, the handle menu has **Work on**: **This computer**, "Ubuntu (WSL)",
"build-01" and so on. A computer that is connecting shows "(connecting…)", a lost one "(lost)". The handle then shows
the active computer's name beside "Ready", and the ask box shows a chip such as "On build-01".

**Naming one in a request.** Say or type where: "on build-01, check the disk", "in Ubuntu, list my home folder",
"build-01: restart the web server". "WSL", "in Linux" and "the Linux side" mean your default distro (on a Windows PC
while WSL is on in Ember; otherwise they are just words of the request, see §2.5). "This computer" or "my computer"
(or PC, Mac, laptop), "locally", and on a Windows PC "on Windows" mean this one. A bare "here" doesn't move a task:
"check what's taking space here" with build-01 picked in **Work on** works on build-01. A name counts only after a
place word (on, in, at, inside, over, via, into, onto), as the request's first words followed by a colon or a comma
("build-01: …", "build-01, …"), or before "'s desktop", "'s screen", "'s server" and the like. So "send build-01's
report to Ana" names no computer, and neither does "build-01 restart the web server": without the colon, that task
goes to the computer Ember is set to work on (and nothing dangerous in it runs on an announcement: §2.5). Only your
own words choose: never text on a screen, in a file or in a command's output.

**Short names.** A computer added by its full name also answers to its first part when that has a digit or a hyphen ("on
build-01" for build-01.example.com; "in the app" never names app.example.com), and a distribution's WSL distro to its
first word ("in Ubuntu" for Ubuntu-22.04, "in kali" for kali-linux; a distro you imported as build-env answers only to
build-env, so "delete the logs in build" names none). The longest name you say wins when you write it as one name, its
parts joined by a hyphen, an underscore or a dot, or followed by a version ("on build-01-test" is build-01-test, not
build-01; "in Ubuntu 24.04" is Ubuntu-24.04). "On db-01, back up the database", with db-01 and db-01-backup both added,
names both, so Ember asks which one. When two computers share the short name you said, Ember asks which one; when you
name a version of a distro that isn't installed ("in Ubuntu 24.04" with only Ubuntu-22.04), Ember asks whether you meant
the one you have.

**One computer per task.** A task works on one computer from start to end. A request that names two is answered with
a question; moving text from one computer to another happens only through a step Ember asks about. Task cards, the
bubble and questions say where they act ("on build-01", "in Ubuntu (WSL)"): on screen, to a screen reader ("Ember needs
you, on build-01: …"), aloud ("Ember asks, on build-01: …"), in the notification when you're away, and on the corner
card without a compositor.

## 2. Commands

### 2.1 Turning them on

Settings › **Commands** has a switch per computer: **Run commands on this computer**, **Run commands in Ubuntu (WSL)**,
**Run commands on build-01**. When you turn one on, Ember shows the card "Let Ember run commands on this computer?" (or
"on build-01?") with **Turn on** and **Not now**. It opens big enough to show the whole card on most screens, and names
the stop chord in its first line. The card is answered with a click only, never with Ember's approve keys or by voice,
and **Turn on** works only once the whole card has been in view (on a small screen, or with larger text, scroll to its
end: "Scroll down to read it all first."). While a computer's switch is off, Ember runs no commands there and a task
can't bring up the card: turn the switch on yourself. If Ember can't show the card that asks you first (this one, the
WSL card or a computer's card), nothing changes and it says "Ember couldn't show the card that asks you first, so
nothing changed." (when connecting, in the bubble with **Try again**). If a later Ember changes what the card says, the
next command a task runs there shows the new card first. Under each switch, **Ask me before every command** makes every
command on that computer ask. **Open the command window** shows it. Where commands run as root or as an administrator
(Ember itself, a distro or a login that is, or one where Ember can't tell), every command asks anyway, so **Ask me
before every command** shows on there, can't be turned off, and says why under it, as it does where your organisation
asks.

To turn commands off again, turn the switch off. This cancels commands still waiting for approval, a countdown or a
free slot. Turning the switch back on does not revive them. Commands already running keep running. The stop chord (Ctrl+Alt+X on Linux, Win+Alt+X on Windows,
Control+Shift+Command+X on macOS), "Ember, stop" and **Stop everything** stop every running command at once.

### 2.2 Ember's command window

Commands run in Ember's own window, **Ember commands**, never in your own terminal windows: Ember still never types into
a terminal of yours. Each command gets a tab (the newest first, the last 20 kept) with a header such as "On build-01 as
deploy · bash · in ~/src/app", a status line ("Running…", "Finished in 3.2 s.", "Ended with exit code 2 after 1.1 s.")
with **Copy output** and **Stop**, then its live output. What a command already changed stays changed when you stop it.
A command the kill switch ended says "Stopped with everything else after 2 s. What it already changed stays." It names
no chord: the kill switch is also pulled from the handle, settings, "Ember, stop" or a policy change. Closing the window
while a command runs asks first ("A command is still running"): **Stop and close** stops it and closes the window,
**Keep it open** leaves both, and closing it again stops and closes, so a command never runs on where you can't see it.
Quitting Ember asks its own question.

When a command asks for something (a password, a "y/n"), type it in the window: "Type here to answer the command; paste
with Ctrl+V. Ember never sees what you type." (Command+V on a Mac). The keyboard is already in the command's terminal
when its tab comes up, so what you type there goes straight to it. Every new command brings the window above your other
windows without taking the keyboard, and when a command's output stops at a question for a couple of seconds
("Password:", "Username for 'https://github.com':", "[y/N]"), its tab says "Waiting for you to type in this window.",
the window comes up and flashes in the taskbar or Dock, and the task's bubble says "A command is waiting for you to type
in the command window." (Needs you) with **Show**, which brings the command window up with the keyboard in the command,
and "Or press Alt+Tab to go there." under it on Linux and Windows; a screen reader hears both. It stays until you type
or the command ends. The command's time limit still runs while it waits; if it runs out, the tab says it was waiting for
you. What you type goes only to the command: it never reaches Copilot, the log or the audit. Tab and Shift+Tab always
move on to the window's buttons and tabs, never into the command (Ctrl+I types a tab for a program that wants one). Off
a Mac, Ctrl+C copies the text you selected (without a selection it interrupts the command, as in any terminal) and
Ctrl+Shift+C always copies; **Copy output** copies everything the command printed. Commands without a terminal (on
Windows, or where `script` isn't installed) say "This command can't take typing here." and are left out of the Tab
order; programs there run with their non-interactive settings, so one that wants a password fails at once instead of
waiting. While a screen reader runs (Orca, NVDA, JAWS, Narrator, VoiceOver), what a command prints is read out as it
comes and can be read again line by line.

The window never reaches Copilot as a picture: Ember blacks out its own windows in every screenshot.

### 2.3 What runs straight away

Most commands: reading files, listing folders, searching, building, running tests, editing files inside your work,
`git status`, `git diff`, `git log`, `git add`, `git commit`, `git pull`, `p4 opened`, `p4 sync`, `p4 edit`,
`npm test`, `make`, `df -h`. They still run in the command window where you can watch and stop them, they are
recorded in the audit log, and their output goes back to Copilot as described in §2.7.

### 2.4 What asks first

Ember stops and asks before a command that:

- **deletes or destroys data**: `rm`, `rmdir`, `del`, `Remove-Item`, `find -delete`, the deleters a project's
  scripts reach for (`rimraf` and `del-cli`, also from `node_modules/.bin` or as `yarn rimraf` or `yarn run rimraf`,
  which expand a pattern themselves, so a quoted one is read as a pattern too; one whose braces or `+(…)`, read as
  a shell reads them, could reach Ember's files, such as `'{..,x}'` from a project in your home folder, is refused,
  and one whose braces the deleter may read another way, with a stray `}` or a `\` in them, is asked about as
  any deletion is), `trash`, `gio trash`, `trash-rm`, `shred`, `scrub`,
  a Mac's GNU `grm`, duplicate finders told to delete (`fdupes -d`, `jdupes -d`), rewriting a repository's history
  (`bfg`, `git filter-repo`), a program Ember doesn't know given your home folder, a folder that holds it or one
  that holds Ember's own files (`mytool ~`, `mytool ..` in a folder in your home folder, `stow -t ~ dotfiles`; other
  folders don't ask, such as your project's from its build folder, `qmake ..`, nor does an install prefix, `./configure
  --prefix ~/.local`), `git clean`,
  `git reset --hard`, discarding changes (`git checkout -- <file>`, `git restore`), `git branch -D`,
  `git stash drop`, overwriting a file that exists (`>`, `cp` or `mv` onto it, `dd of=`, `tee` without `-a`; a `cp`
  or `mv` into a folder asks only when a file of the same name is in it, "Replaces ~/Documents/report.pdf if it
  exists.", on this computer, in WSL and on an SSH computer, which each say which names are folders; but
  `cp --parents`, `rsync -R` (`--relative`, `--files-from` or a `/./` in the name), which put a file at its path
  under the folder, and a Mac's `cp -R build/ ~/Documents`, which copies what is in build straight into the folder,
  ask whenever the folder is there: "Replaces files in ~/Documents if they exist."),
  `truncate`, formatting or partitioning a disk, emptying the trash, giving a container a folder outside your project
  that it can change (`docker run -v ~/Documents:/d`; a read-only `:ro` mount doesn't ask), changing or deleting what
  a database holds (`psql -c 'DROP TABLE x'`, `redis-cli FLUSHALL`, and the same given on the client's input:
  `redis-cli <<< FLUSHALL`, `echo 'db.dropDatabase()' | mongosh`; commands or code on its input or its line that
  Ember can't see or follow ask too, such as `redis-cli "$CMD"` and options held in a variable, `redis-cli $OPTS`;
  a file redis-cli's options name is judged as that file, so `redis-cli --rdb ~/.bashrc`, which writes a dump over
  it, asks; so is the file `psql -o` writes its results to, which asks when it is there, the one `psql -L` or
  `mysql --tee` logs to, and Ember's own files are refused there too; a client's own commands that can run a
  program or write a file ask, with the shell command or file they name judged as if written out: psql's `\!`,
  `\o`, `\copy` and any other backslash command that doesn't only describe or show, written straight after SQL too
  (`select 1\g out.txt`; a backslash inside a quoted string is text, unless the text has a comment, a `$$` string or
  an escaped quote, where every backslash counts), psql's `-c` and mysql's `-e` at the end of a cluster of options
  read as well (`psql -Atc '…'`, `mysql -Ne '…'`), mysql's `system`, `source`,
  `tee` and `pager` after a `;` or at the start of a line, `--pager` and `--init-command`, and every sqlite3 or
  duckdb dot-command (in duckdb's `-c` and `-s` text as well) but the ones that only
  show things written whole, `.tables`, `.schema`, `.mode`, `.headers` and the like, because sqlite3 takes any
  shortening: `.sh` is `.shell`, `.o` is `.output`), and package scripts, make targets and SQL or command files named clean, wipe, purge,
  reset, drop and the like (`psql -f drop_users.sql`, `psql app < drop_users.sql`);
- **submits or publishes anywhere**: `git push`, pull requests, releases and repository changes on GitHub (`gh pr
  create`, `gh release create`, `gh api` with a write), `p4 submit`, `p4 shelve`, publishing packages (`npm publish`,
  `twine upload`, `docker push`), copying files or sending data to another computer or service (`scp`, `rsync host:`,
  `rclone copy` or `sync` with a cloud remote as the destination or in an option such as `--backup-dir remote:old`,
  `curl -T`, `curl -d`, `ssh host <command>`, a file fed to `openssl s_client`), adding your key to another computer
  (`ssh-copy-id`), using a share on another computer (`dir \\server\share`, `net use`, `New-PSDrive` on Windows,
  `mount_smbfs` on a Mac), which signs in there with your account, starting a server other computers can reach or
  one that shares a folder outside your project (`python3 -m http.server`, `php -S 0.0.0.0:8000`, `caddy
  file-server`, `miniserve`, `busybox httpd`; one on `127.0.0.1` or `localhost` serving your project doesn't ask, but
  `caddy reverse-proxy` listens on every address whatever `--from` says),
  opening a tunnel from the internet (`cloudflared tunnel`, `ngrok http`), changing cloud services or clusters
  (`kubectl apply`, `terraform apply`), and scripts or targets named deploy, publish, release, push and the like;
- **deletes from source control or a service**: `git push --force`, deleting a remote branch or tag, `p4 delete`,
  `p4 obliterate`, `p4 revert` of opened work, `gh repo delete`, `kubectl delete`, `terraform destroy`;
- **reads or changes passwords, keys or other secrets**: anything under `~/.ssh` (except reading public keys,
  `known_hosts` and `config`), `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/gh`, `~/.docker/config.json`,
  `.netrc`, `.npmrc`, `.pypirc`, `.env` files, GitHub Copilot's sign-in (`~/.config/github-copilot`, `~/.copilot`), cloud
  and hosting tools' sign-ins (`~/.config/gcloud`, `~/.oci`, `~/.config/doctl`), Kerberos tickets, the display's key
  (`~/.Xauthority`), chat apps' and VS Code's stored sign-ins, keychains and credential stores, browser profiles,
  password managers, `/etc/shadow`, your shell history; printing tokens or environment variables that may hold them (`gh auth token`,
  `env`, `printenv`); reading the clipboard; taking a screenshot without Ember's privacy filters; a password or token
  written on the command line;
- **changes the system or needs privileges**: `sudo`, `su`, `runas`, installing or removing packages (`apt`, `dnf`,
  `brew`, `winget`, `npm install`, `pip install`), services, the registry and desktop settings (`gsettings set`,
  `dconf write`, and `defaults write` to the screen saver, firewall and remote-access settings), the firewall, the
  certificates the computer trusts, users and groups, giving a container the container engine's socket or a system
  folder (`docker run -v /var/run/docker.sock:…`, `-v /usr:…`),
  permissions changed recursively or outside your home, scheduled tasks and login items, shutting down or logging
  out, stopping other programs (`kill`, `taskkill`), your shell's start-up files (`~/.bashrc`, `~/.bashrc.d`,
  `$PROFILE`) and git hooks, putting a program in a folder your shell searches for commands (`~/.local/bin`, `~/bin`),
  settings a program runs code from (`~/.vimrc`, `~/.tmux.conf`, `~/.config/pip`, `~/.cargo/config.toml`), and
  launchers and desktop extensions (`~/.local/share/applications`, GNOME Shell extensions), even when the file is new;
- **downloads code and runs it, or keeps running after Ember stops**: `curl … | sh`, `iwr … | iex`, running a file
  downloaded in this task (one fetched with `curl`, `wget` and the like, cloned, or handed over by another tool:
  `gh release download` and `gh run download`, `aws s3 cp`, `gsutil cp` and `gcloud storage cp` from a bucket, `az
  storage blob download`, `docker cp` and `kubectl cp` out of a container or a pod, `scp` and `rsync` from another
  computer, or what `ssh host …` prints, saved with `>` or piped into a shell; checked out or fetched with `svn
  checkout`, `svn export`, `hg clone`, `rclone copy`, `pip download` or `git archive --remote`; anything at all once
  the task has used a settings file curl or wget reads, a `wget -e` setting or a file-transfer client that can fetch
  (`curl -K cfg.txt`, `wget --config=w.rc`, `sftp`, `ftp`, `lftp`, `tftp`, `smbclient`), since Ember can't tell what
  they saved or where (a client whose commands on the line only send, `lftp -c 'put dist.tgz' host`, doesn't count);
  also once it is renamed, copied, linked or written out again with `mv`, `cp`, `ln`,
  `rsync`, `dd`, `cat x.py > y.py`, `tee`, `dos2unix -n`, `sort -o`, `split` and `cat` of its pieces, or a `tar` or
  `zip` of it unpacked again, also through `xargs`, with PowerShell's `Rename-Item`, `Move-Item`, `Copy-Item`
  or a `New-Item` link, also from a pipeline (`Get-Item x.exe | Copy-Item -Destination y.exe`; when Ember can't tell
  which files a pipeline or a variable hands over, the copy counts as a download whenever the task downloaded
  something it could be: running a file from where it went asks, but that folder's own tools, such as `npm test` or
  `make`, ask only when the download could be one of their files), with cmd's `ren`, `move`, `copy` or `mklink`, or with `robocopy` (a folder's copy keeps each download under its own name, so the folder's other files and tools are as before), run as a module with `python3 -m`, loaded with `node -r`,
  built from a downloaded source and then run (a compiler's `-o` output or its default `a.out`, a file decompressed with `gunzip`, `xz -d` or `bzip2 -d`, a package unpacked with `dpkg -x`), handed to a runner Ember knows (`java -jar`, `-cp` entries or a class or source file; `mono` or `wine`; `pwsh x.ps1`; `node x` with no extension or `python3 a.p*`; `awk -f`, `sed -f` or `psql -f`; `jupyter nbconvert --execute`; `go run .` and `cargo run`, which build the folder's own `.go` or `.rs` sources), or picked up by name
  by a build tool or test runner: a downloaded `Makefile`, `package.json`, `conftest.py` or test file in its folder;
  a download whose saved name Ember can't tell (one the server or a list picks: `curl -OJ`, `wget
  --content-disposition`, `wget -r`, `wget -i`, `aria2c -i`; one in a variable or an expression: `curl -o "$f"`,
  `aria2c -o "$f"` or `-d "$d"`, `axel -o "$f"`, `fetch -o "$f"`, `lwp-download … "$f"`, `Invoke-WebRequest -OutFile $f`, `-OutFile (Join-Path …)`, `Start-BitsTransfer -Destination $d`; a WebClient's
  `DownloadFile`; one named after an address Ember can't see the end of: `curl -O "$URL"`, `wget $URL`, `aria2c
  "$URL"`, `curl -O "https://example.com/$NAME"`, addresses `xargs`, `parallel` or a loop hands over, `xargs -n1 curl
  -sO < urls.txt`, curl's `file[1-3].sh` and `{a,b}.sh`, which name several files, and httpie's `http -d`, where the
  server may pick the name) asks "Downloads to a file Ember can't name.", and afterwards running any file from the folder it
  saved into or below, or that folder's build tools and test runners, asks too, and unless the file that runs is
  one the task saved under a name Ember knows the card says it may be a download ("May run a file downloaded in
  this task: Ember can't tell which files an earlier command downloaded or changed."), not that it is, whatever
  else the task saved by name (anywhere, when Ember can't tell the
  folder either, as for a file saved by name in a folder Ember can't tell: `cd "$d" && curl … > x.py`); a listing or a
  read never does; a download a program run through `env -C` or `sudo -D` writes with the shell's `>` is the file in
  the shell's own folder, so `env -C src curl -s … > x.py` and then `python3 x.py` asks; and a patch this task downloaded or fetched applied with `patch`,
  `git apply` or `git am`, in whichever folder it is applied in (`patch -d src -p1 < x.patch`, `env -C src patch -p1 <
  x.patch`, `git -C sub am < x.patch`), or code pulled or fetched from an address rather than the repository's own
  remote (`git pull https://…`), marks the files it changes the same way, so the next `make`, `npm test` or `bash
  build.sh` asks). An address a variable holds only the start of still ends in a name Ember can read, so `curl -LO
  "$BASE/run.sh"` records run.sh, and a variable the command line sets is followed (`V=1.2; curl -LO
  https://example.com/tool-$V.sh` records tool-1.2.sh); `wget -x` records the file under the host's folder
  (`example.com/dir/a.py`, with a port both `example.com:8080/dir/a.py` and `example.com/dir/a.py`) and by its name alone as well, also without the
  host's folder when `-nH` is anywhere in its options (`-xnH`, `--no-host-dir`); text a fetch printed that a variable carries into a file is the download too (`x=$(curl -s
  …); echo "$x" > a.py`, also through a copy of the variable, `y=$x`, one `read` fills, `read x < <(curl …)`, any
  program given the text that writes its output to a file, `tee a.py <<< "$x"`, `dd of=a.py`, and a group's own
  redirection, `{ echo "$x"; } > a.py`); a repository cloned from an address or into a folder Ember can't see (`git clone $REPO`)
  makes the folder it is cloned in count, so building there asks, and so do `gh repo clone a/b -- --depth 1` (the
  folder is named before git's options), `gh gist clone`, `git submodule add` and a pull or fetch from a remote the
  same line adds with an address (`git remote add e https://… && git pull e main`); and `node .` or `python3 tool` asks when the
  folder's entry file (`index.js`, `package.json`, `__main__.py`) is a download. Once the task has downloaded
  anything, a build tool or test runner (or `python3 -m`) in a folder Ember can't name asks as it would in the
  download's folder: after `cd b;`, `cd b || exit`, `pushd b` or a `cd` on its own line, any of which may have
  failed, so `git clone https://…; cd b; npm test` asks. A download Ember can name never
  makes the project's own tools ask in a folder Ember knows: after `curl -LO https://example.com/data.csv`, `python3 analyze.py`, `npm
  test` and `cd src && npm test` run as before; in a task that downloaded nothing, `cd src; npm test` runs too),
  running a program or script from another computer's share (`\\server\share\x.exe`),
  `npx <package>`, `nohup`, `setsid`, `&`, `docker run -d`, `Start-Process` without `-Wait`;
- **Ember can't read with certainty**: `eval`, encoded commands (`powershell -EncodedCommand`, `base64 -d | sh`),
  aliases it can't see, unusual syntax, interactive programs such as `vim`, `less`, `top` or `python` with no
  script ("This opens an interactive program; you'd have to use it yourself in the command window."), a job count
  held in a variable, whatever the command set the variable to (`make -j$N`, `N=4; make -j$N`, `./gradlew
  --max-workers=$N`, `mvn --threads $N`, `xargs -P"$N" echo`: only a number, `$(nproc)` and the like, or arithmetic of
  numbers such as `$((2*4))`, quoted or not, is a count, so `make -j4`, `make -j$(nproc)` and `cmake --build build -j
  $(nproc)` run; a variable apart after make's `-j` or `--jobs`, Maven's `-T` or ninja's `-j` is taken as before, so
  `make -j $JOBS` runs, unless the command set it from a command's output, `X=$(cat jobs.txt); make -j $X`, or to
  words after the count that are targets, `T='4 deploy'; make -j $T`), and a value Ember can't see written straight
  after an option of a program that runs another one, quoted or not (`nice -n"$X" cmd`, `xargs -n$X cmd`, `env
  -C"$d" cmd`), which may hold the command it runs; only `xargs -P` and `parallel -j` take a count there (`xargs
  -P$(nproc) cmd`); and `rclone copy`, `sync` or `move` with more words than it takes, after an option Ember
  doesn't know took a value (`rclone copy ./src remote:dst --max-transfer 10G`), so it can't tell where the files go;
  and a command behind an option that an earlier version of Ember read another way, where that reading asked:
  `git commit -S -m wip` (and `-u`, `--gpg-sign` or `--untracked-files` apart in front of `-m`), `redis-cli --tls GET
  x` (and `-c`, `--sni x`, `--cacertdir x`, `--show-pushes yes`), `ls | parallel --timeout 5 echo` (and parallel's other
  value options, and `-X`), `env --block-signal ls`, `numactl -H x cmd`, `ltrace -L x cmd`, `faketime -m x y cmd`,
  `nsenter -t 1 -m x cmd` ("Ember can't tell whether one of its options takes the word after it."). Ember judges such
  a line both ways and keeps the stricter answer, with what the older reading named still on the card, so `sudo -h
  host rm -rf ~` is refused and `sudo -h host printenv` still says what printenv prints. Write the value attached
  (`git commit -SKEY -m wip`, `redis-cli --tls=1 PING`) or after the message (`git commit -m wip -S`) and it runs.
  The same holds for every tool whose options Ember has learned to read better since (tar, rsync, cp, grep, ls, curl,
  wget, gh, git's branch, tag, checkout, switch and rebase, make and Maven, pip, zip, cpio, `docker run`, `uv run` and
  its like, pkill): a word the older reading took for a file, a target, a command or an option of its own is still
  judged as one, so `tar -xf a.tar --exclude-tag ~/.ssh/id_rsa` and `uv run --cache-dir printenv` ask, `ls --cached
  ~/.config/ember/settings.json` is refused, and so is `zip -T -n ~/.config/ember/settings.json`. The word after
  `dos2unix -c` or `-D` is still judged as a file too, and `-I` asks for every tar ("It runs a command Ember can't
  see."): on a Mac it names a list of files, but the `tar` there may be GNU's, which runs the program `-I` names;
  write `tar -T list.txt` for a list and it runs. `git checkout
  --track -b feature origin/feature` asks for the same reason (the older reading took `-b` for `--track`'s word and
  the rest for files to throw changes away in); write `git checkout -b feature --track origin/feature` or `git switch
  -c feature --track origin/feature` and it runs. Everyday lines are untouched: `tar -xf a.tar --strip-components 1`,
  `uv run --cache-dir .cache pytest`, `mvn -T 4 package`, `docker run -P nginx`, `git branch --color`, `git rebase -S
  main` and `wget --progress bar https://example.com/a.txt` run.

**Loops on a command line** in bash or sh always ask, whatever their body: a line with `for`, `while`, `until` or
`select` anywhere in it asks with the loop's own words ("Ember can't tell exactly what this does."), so `for i in 1 2
3; do echo $i; done`, `for f in *.log; do …` and `while read -r l; do echo "$l"; done <<< 'a b'` ask too. Ember
judges a loop's body once, and a value from the loop's own list or a `read` can reach an option that nothing Ember
judges looks at: `for f in --hard; do git reset $f; done` is `git reset --hard`. Ember doesn't judge a loop pass by
pass, however short its list: what a shell runs on each pass can differ from the loop's words written out (`for f in
a; do >~/.bashrc echo $f; done` overwrites a file; `printf -v` or an alias can set the loop's variable from inside the
body). Ember's own folder named in a loop is still refused before anything asks (`for d in ~/.config/ember; do rm -rf
"$d"; done`), the card still says what a dangerous command in the loop does ("Deletes a.log and b.log.", "Deletes
each file the loop names."), and a loop never runs with a Stop because your words asked for what it does. (A shell
script's loops are read; below.)

**An `if` on a command line** in bash or sh runs without a question only when the whole line is plain: then `if`,
`then`, `elif`, `else` and `fi` don't ask by themselves, and Ember judges every command in it as if it were written
out, in the folder the line starts in. So `if [ -f package.json ]; then npm test; fi` and `if git diff --quiet; then
echo clean; else echo dirty; fi` run. A program that is only named like one of these words (`./if`, `bin/else arg`,
`'fi'`, `\if`) is not the shell's own word and asks, on a command line and in a script ("It runs a program named like
one of the shell's own words."). Anything else asks with the `if`'s own words ("Ember can't tell exactly what
this does."), whatever it does:
- **a command in the line that Ember says anything about**, one that would ask or not. `if [ -f x ]; then rm x; fi`
  asks, and so does `if true; then echo hi > out.txt; fi` even when out.txt isn't there (written out, `echo hi >
  out.txt` runs then); an `if` never runs with a Stop because your words asked for what it does: with "delete the
  build folder", `if [ -d build ]; then rm -rf build; fi` asks.
- **a folder change** (`cd`, `chdir`, `pushd`, `popd`) anywhere in the line: `if [ -d x ]; then cd x; fi` asks.
- **a variable set** anywhere in the line, from text Ember sees or not (`x=…`, also in front of a command, `export`,
  `declare`, `typeset`, `local`, `readonly`, `printf -v`, `set`, `unset`, `shift`, `wait -p`, `exec`, `${x:=…}`), or a
  file sourced (`source`, `.`): `if x=$(cat f); then echo $x; fi` and `if [ -f x ]; then y=1; fi` ask. A `read` of
  written-out text (below) is the exception.
- **a `!`** in front of a command in the `if`: `if ! [ -f "$f" ]; then echo no; fi` and `if ! mkdir -p x; then echo no;
  fi` ask.
- **a `[[ … ]]` test** in an `if` or a loop: `if [[ -d build ]]; then make; fi` asks. On a line with no `if` and no
  loop, a test that `[ … ]` reads the same way is judged as that test: one file or text (`[[ -f package.json ]]`,
  `[[ -n "$CI" ]]`), two texts (`=`, `==`, `!=`), two whole numbers (`-lt`, `-eq`) or two files (`-nt`), each a plain
  word or one word in double quotes. So `[[ -f package.json ]] && echo yes` runs as `[ -f package.json ] && echo yes`
  does, and `[[ -d build ]] && rm -rf build` asks (never with a Stop). Any other test asks: a variable outside
  quotes, a pattern, `&&`, `||`, `!`, `=~`, `-v`, `~`, a word that holds `[[` or `]]`. (In a script, a plain one
  is read; below.)
- **text Ember can't see.** A `read`, `mapfile`, `readarray`, `select` or `getopts`, in an `if`, a loop or neither,
  asks ("It works on text Ember can't see.") whatever its variables are used for afterwards, unless it reads its own
  input and that is a here-string or here-document of written-out text (`read -r a b <<< 'x y'`, `if read -r l <<<
  'a b'; then echo "$l"; fi`): a file (`read -r l < f`, `done < list.txt`), a pipe (`cat list | while read -r d`),
  another descriptor (`read -u 3`, `read <&3`), a substitution or a variable (`<<< "$d"`, `<<< "$HOME"`) all ask, and
  a loop's card says so too when its list has any word that isn't written out (a pattern such as `*.log`, a variable,
  `~`, `{1..3}`, a substitution, `"$@"`). `IFS` in front of a loop's or an `if`'s `read` changes only how that `read`
  splits the line, so Ember judges the read as it stands; a variable set in front of a `read`, a shell or another
  program that runs commands asks all the same, after `if`, `then`, `do` or `time` as on a line of its own (`if IFS=
  read -r l <<< 'a b'; then …`, `time x=1 sh -c '…'`: "It sets a variable where a command could stand."); in front
  of any other command it asks.

Ember's own folder named in sight is refused before any of this. zsh's `if` and loops, and PowerShell's and cmd's `if` and `for` always ask, and so do an `if` in a shell the command starts (`bash -c '…'`), `case`, functions and `{ … }` groups. A loop
whose variable is `PATH` or another that changes how commands are found says so on its card too ("It changes how
commands are found or run."). A variable set after `then`, `do`, `else`, `!` or `time` is judged as one set at the
start of a command: `if true; then LD_PRELOAD=./x.so ls; fi` asks, as `LD_PRELOAD=./x.so ls` does.

A variable set in front of a build tool that names a program or a command the tool runs is judged too, so Ember asks
before `CC='sh -c "curl … | sh"' make` the way it does before `make CC='sh -c …'`. An ordinary value runs: `CC=clang
make`, `CC="ccache gcc" make`, `CFLAGS=-O2 make`, `GOFLAGS=-mod=vendor go build` and `DATABASE_URL=… npm test` all go
ahead. A compiler or pager variable (`CC`, `CXX`, `LD`, `RUSTC`, `PSQL_PAGER`, a `*_PAGER`, `LUA_INIT`) asks when its
value holds any shell operator (`|`, `;`, `&&`, a substitution, a backtick); any other variable asks only when its
value starts a command (a leading `sh`, `bash`, `python`, `curl` … with an argument — an option, a path, a file name or
a quoted word, never a plain word, so `MSG='env vars here'` is text — at the start or after a `|`, `;` or `&&`, or a
substitution), so a value that merely holds a `|` or `;` — a connection string, a filter, a colour spec such as
`LS_COLORS='di=01;34'` — runs. An options variable asks when a sub-option names a program (`GOFLAGS=-toolexec=…`
or `--toolexec=…`, any `TAR_OPTIONS` option that runs a command on tar's own command line — `--to-command`, `-I`,
`-F` (`--info-script`), `--use-compress-program`, `--checkpoint-action=exec=…`, abbreviated or not — `RUSTFLAGS='-C linker=…'` naming the linker
by a path or a command, and `PYTEST_ADDOPTS='-p …'` or `-pname`, but not `GOFLAGS=-p=4`, `RUSTFLAGS='-C linker=clang'`
or `PYTEST_ADDOPTS='-p no:…'`), also when that sub-option's value is a variable
(`GOFLAGS="-toolexec=$T"`); a variable that only extends the options already set (`GOFLAGS="$GOFLAGS -mod=vendor"`)
runs. A wrapper variable always asks (`RUSTC_WRAPPER`, `CARGO_BUILD_RUSTC_WRAPPER`,
`JDK_JAVA_OPTIONS`, `DOTNET_STARTUP_HOOKS`). The same goes for a `cmake -DCMAKE_<lang>_COMPILER=…` override that holds a
command, `go test -exec`, `go build -toolexec`/`-vettool` (with one dash or two, and with a value Ember can't see:
`-toolexec="$T"`, `-vettool=$(which shadow)`), tar's own options that run a command with a value Ember can't see
(`tar xf a.tar --to-command="$T"`, `-I"$T"`), and `npm`'s `--script-shell` or `npm config set script-shell`.

**Shell scripts are read first.** When a command runs a shell script (`sh deploy.sh`, `bash t.sh`, `source env.sh`,
`./t.sh`, `powershell -File t.ps1`, `& .\t.ps1`, `cmd /c t.bat`, and the same behind `env`, `nice`, `timeout` and the
like), Ember reads the script first, on the computer that runs it, and judges its text as it judges a command: a
script that deletes, publishes or reads secrets asks ("In t.sh: Deletes build and everything in it."), even when you
asked for that kind of operation, and one that would touch Ember's own safety files is refused. A script also asks
when Ember can't read all of it: an sh or bash script's `if`, `for` and `while` and a plain `[[ … ]]` test are read
(the commands inside them are judged, a loop's body once, in the folder the script starts in, so a `cd` in a loop
isn't followed from one pass to the next), but `case`, functions, `trap`, `{ … }` groups, a `[[` that compares numbers or
uses `-v`, a variable in a file name, a loop whose variable is `PATH` or the like, a `read` or a loop's list over text
Ember can't see (as on a command line, above), more than 64 commands or more than
8,000 characters ask, and so do zsh's `if`, `for` and `while` (also from a bash script's `zsh -c '…'`) and
PowerShell's and cmd's `if` and `for`; the card then says why ("Ember can't read all of
build.sh (it has more commands than Ember can check one by one).", "In build.sh: Ember can't tell what cat is
given."). When you named the script ("run the build script", "run build.sh") and that is all the card says, it doesn't
add "You didn't ask for this."; a script that deletes, publishes or reads secrets still says it unless your words ask
for that. Scripts it runs in turn are read too (four deep, sixteen in all; past that, it asks). A script whose `#!` line names another shell such
as fish or csh, scripts named by a pattern (`sh *.sh`), a script read from a device (`sh /dev/fd/3`), and a script
that the same command writes first (`echo 'rm -rf build' > t.sh; sh t.sh`) ask. A script this task downloaded always
asks (that is downloading code and running it); one it wrote in an earlier command asks when Ember can't read all of
it (bigger than 64 KB, unreadable, or not a plain file). When the same command line both downloads a script and runs
it (`curl -o t.sh https://example.com/t.sh; sh t.sh`, `pip download requests; ./t.sh`), Ember also reads the t.sh
that is there now, because that is the file that runs if nothing is saved over it: the line asks as a download does
("Runs a file downloaded in this task."), what the file there deletes, publishes or reads is on the card too, and one
that would touch Ember's own safety files is refused. Any other script Ember can't read in full (a large build
script of your project) is judged by its name, as before (§2.9). Ember reads scripts on this computer and in WSL; on
an SSH computer, build-01's helper reads them there and asks when it finds more than this computer could see (§4.5).
Programs in other languages (`python x.py`, `node x.js`) aren't read: their names count (§2.9).

**A script named with `..`** (`sh sub/../t.sh`, `cd link && sh ../t.sh`) is read where the computer really runs it:
on Linux, macOS, in WSL and on an SSH computer, `..` after a link is the folder above where the link leads, so with sub
a link to ~/other/inner, `sub/../t.sh` is ~/other/t.sh, not the t.sh beside sub. Ember asks the computer where the
name leads and reads that file by the name the shell opens. When the computer can't say (it didn't answer in time, or
an old `realpath` there can't resolve it), Ember asks: "Ember can't tell which script this runs." Windows (PowerShell,
cmd) takes `..` out of a name before anything opens it, as Ember does, so nothing changes there. Every other path with
`..` is judged where it really leads too (`cat sub/../credentials` with sub a link into `~/.aws` reads a secret and
asks), and so is an overwrite (`echo x > sub/../notes.txt` asks when the notes.txt it would really overwrite exists).

**How it asks.** The bubble says "May I run a command?" with **Show the command** and **Not now**, and the command
window shows the card "Ember wants to run this command" ("… on build-01", "… in Ubuntu (WSL)" for another computer; a
tab there carries the computer's name too): the whole command in monospace, nothing cut, with characters you wouldn't
see shown in ⟨ ⟩, letters from another alphabet inside a word underlined (each folder of a path is judged on its own,
so `C:\Users\Иван` marks nothing, while letters that only look Latin, as in `https://аррӏе.com` or `deploy@аррӏе`,
are underlined), and Hebrew or Arabic text shown in the order it runs, as the terminal shows it;
then why it asks ("Deletes build and everything in it.", "Pushes feature-x to origin.", "You didn't ask for this.",
"This can reach your Windows files."), naming a folder in the home folder from ~ as the header does ("Deletes
everything in ~/Documents."); then the model's reason, quoted. "You didn't ask for this." means your words
asked for nothing of the kind; when they asked for that kind of step but not exactly this one ("push my changes" for
`git push origin main`, "reinstall the dependencies" for `npm ci`, "schedule the jobs in jobs.txt" for `crontab
jobs.txt`) the card says "Your words don't name exactly this,
so Ember checks first." instead, and a command whose program you named in full ("run npm ci") says neither. Words
that say not to ("don't git push yet", "never force push") ask for nothing, so the card still says "You didn't ask for
this.", typed or spoken, and so does a step on what your words leave out ("delete everything except build/" for
`rm -r build`), a step of the kind they rule out ("push without force" for a force push, "prepare the release
(don't publish)" for `npm publish`, "don't (ever) delete build") or one they say not to do by name ("delete build/
but don't delete src/" for `rm -r src`, "kill 5678 but don't kill 1234"); "delete build/ and don't delete anything
else" says it of every step but the one you named, and of one that does that and more (`rm -rf build dist`, or a
force you didn't ask for), and "show my crontab and nothing else" says it of `crontab -r`, since a step that names
nothing of its own counts as named only by its kind ("remove my crontab") or its command in full. A "not" in a condition, an exception or a reminder leaves the rest as you asked it ("push my changes if
the tests don't fail", "delete everything in build except .gitkeep", "don't forget to push"); any "not" in your words
still keeps Ember from announcing a step instead of asking. A
command that asks for what it does (deleting, publishing, secrets, system changes, downloading and running code, or
what Ember can't read with certainty), which the bubble tags "Risky step", has a yellow bar on its card's edge, and
its **Allow** is a plain button rather than the highlighted one. **Allow** and **Not now**
stay at the bottom of the card while a long command scrolls; **Allow** stays off until the whole command has been in
view ("Read the whole command to allow it."). The approve chord (Ctrl+Alt+Y, Win+Alt+Y, Control+Shift+Command+Y)
works only while that card shows the whole command (not while the window is blank after its page crashed, until the
page loads again and shows it); **Not now** and the deny chord always work. While the card is up,
Ember and its bubble keep clear of the command window (as they do of settings), and the same goes for Ember's sign-in
and consent cards. There is never an "Always" for commands. A spoken “Ember, allow” approves one from anyone heard while
**Only my voice can say yes (Voice Match)** is off, its default, and only when Voice Match recognises your voice while
it is on; either way only while the card shows the whole command, as the approve chord does. “Ember, not now” works for
anyone. With **Work without asking** on (Settings › Apps & privacy), an ordinary command on this computer that would ask
only because it carries text Ember read in another window runs after its Stop countdown instead; in WSL and over SSH it
asks as before, and dangerous ones always ask.
A notification (and
Ember's speech) only says "Ember wants to run a command on build-01." with how to get to the command window from the
keyboard ("press Alt+Tab to go there" on Linux and Windows); screen readers hear that too, and a question's key hint
("Ctrl+Alt+Y allow; Ctrl+Alt+N not now"). A question nobody answers counts as "no" after 2 minutes (20 with **More
time to read and answer** in Settings › Comfort & access). Your yes covers exactly that command, on that computer, in
that folder, for that task: any change asks again. After a "no", Ember doesn't try again or work around it.

### 2.5 When you asked for exactly that

If your own words for this task asked for that kind of operation on that computer and that object, a dangerous command
runs without a question, after an announcement: "delete build/" covers `rm -r build`, "push my branch to GitHub" covers
`git push origin <that branch>`, "submit my changelist" covers `p4 submit -c <n>`. The bubble shows the announcement
("Pushing feature-x to origin, as you asked.", naming a path in the home folder from ~ as the card does: "Deleting
~/proj/build, as you asked.", with "It starts in 4 seconds. Ctrl+Alt+X stops everything at once." and
**Stop**), the command window shows "About to run this, as you asked" with the command, what it does and the model's
reason, "Starts in 4 s.", "Or press Ctrl+Alt+X to stop everything." and **Stop**. While another app holds the stop
chord, both name its fallback (Ctrl+Alt+Shift+X); while another app holds that too,
neither the bubble nor the command window names it: **Stop** is the way, as the spoken "Press Stop to cancel."
says. When Ember speaks (**Speak replies, questions and results out loud** set to Always, the default, or a screen
reader running with it on When a screen reader runs), Ember says it and adds how to cancel it: "Say 'Ember, stop' to
cancel." only where Ember can tell its own voice from yours (Linux with speaker rejection on and parec installed);
elsewhere it names the stop chord ("Press Windows key, Alt, X to cancel."), because its own microphone would hear it say
the phrase and stop everything. There it never says "Ember, stop" or "Hey Ember" out loud at all (it says "the stop
phrase" and "the wake phrase"; the bubble still shows them). When the command runs in WSL, or on this computer while
your words named another, the spoken announcement starts with where it runs, as the bubble's badge does ("In Ubuntu
(WSL): …", "On this computer: …"). **Stop** in either place, the stop chord or "Ember, stop" within those 4 seconds
cancels it. While a screen reader runs, the countdown is 15 seconds instead, so there is time to hear it and act. If
the command window's page crashes during the countdown, the command doesn't run; one announced while the page loads
again counts down once it is back. When the page crashes or the window closes during a countdown, Ember tells you the
command window couldn't show it to the end, not that you stopped it. The audit log records it as requested by you.

Only what you typed or said counts, never the model's words, text on the screen, a file or a command's output; a
task that didn't start from your own words always asks. What you said counts only where Ember can tell your voice from
what your speakers play (Linux with speaker rejection on and parec installed): on Windows, on macOS and on Linux
without it, a call, a video or Ember's own voice could say the same words, so a dangerous command you asked for by
voice asks ("You asked by voice. Ember can't tell your voice from what your speakers play, so it checks first.");
typed words still count. Your words have to ask for it: "delete build/", "please delete
build/", "Ember, delete build/", "can you delete build/?" and "I want to delete build/" do; a question ("should I delete build/?", "how do I push
my branch?"), something already done ("I pushed my branch"), a maybe ("I might delete build/ later") and words about
something else ("fix the script that deletes build/") don't, so the command asks. Nor do words that hold the step
back, since the announcement runs it now: a condition ("delete src/ only if I say so", "if the build fails, delete
src/", "once the tests pass", "when I tell you", "in case the tests fail", "each time the tests pass"), a later time
("tomorrow", "next week", "in 5 minutes", "in 1h", "at 5pm", "at 5.30pm", "at the end of the task", "first thing
Monday", "Monday"), a deadline ("before Friday", "before the release", "ahead of the demo"; "before you run the tests",
"before rebuilding", "before npm install", "before I run make", "before we start" and "before that" only put your steps
in order, and "as we did before" says how), a step that keeps a copy of what a deletion or discard throws
away asked for first ("back up then delete the build folder", "commit my changes and delete build/", "make a backup
and then delete …"; Ember can't tell it was done), asking to be asked first ("ask me first", "check
with me", "wait for my ok", "show me the command first", "let me see the command", "run it by me", "on my go", "hold
off", "I'll say when") or asking how ("explain how to delete build/ and delete src/"); "tell me if it worked", "say if it
worked", "let me know when it's done", "let me see the output", "if you can", "as soon as possible", "if it exists" and a time or
a condition of another step of yours said after it ("delete build/ now, I'll rebuild later", "then run the tests once
it's gone") hold nothing back, but the step itself said again with a time does ("delete build/, but run the command
tomorrow", "… start the cleanup tomorrow"), and so does "wait, then delete build/". So do words that say not to, or
that keep or leave something out ("don't delete build/", "delete everything but build/", "delete dist/ and keep
build/", "instead of", "other than"), since the step may be on what you meant to keep. Only what the verb you
asked with acts on counts, in its own part of the sentence: "kill 5678, 1234 is my editor" doesn't cover `kill 1234`,
"stop apache and check nginx" doesn't cover stopping nginx, and "delete my old branches, main stays" (or "main and
develop stay") doesn't cover deleting main, so those ask. Nor does a name you use only to place, describe or say
something else of: "delete node_modules in the frontend folder" doesn't cover `rm -r frontend`, and neither do "the
backup of the build folder", "the branches merged into main", "the children of 1234", "the process that 1234 started",
"stop apache because nginx wants port 80", "stop apache, nginx serves the site", "kill 5678, 1234 my editor", "the
build logs", "the process blocking 1234", "whatever is blocking 1234", "the services that depend on nginx", "the
parent process for pid 1234" or "the branches based on main". Nor is a file whose contents you name to copy from the one
to overwrite: "overwrite config.yml with the contents of config.yml.bak" and "save the contents of notes.txt to out.txt"
never cover writing over config.yml.bak or notes.txt. "delete build/, dist/ and the cache folder" covers all three, and so do the same verb
said again ("delete build/ and delete dist/", "delete build/. Delete dist/ too.") and a list after a colon ("delete
these folders: build/ and dist/"), a thing after "then" or a sentence that only adds one ("stop apache, then nginx",
"stop apache. nginx too.", "then nginx right away", "and dist/ on my machine"; "then nginx back up" or "and nginx on 80"
asks, since that is another verb's), and "it" for the one thing you just said is hung ("1234 is hung, kill it", "nginx is
stuck, restart it"), when "it" is all the verb acts on ("kill it already", "kill it for good", "restart it to fix it";
"kill whatever is blocking it" asks), but never another verb ("stop apache and restart nginx" doesn't cover restarting
apache). A pull request you numbered anywhere in your words keeps `gh pr merge` without a number asking ("look at pull
request 45. merge the pr"), since that merges the current branch's; "check pr 45, then merge the pr" covers
`gh pr merge 45`. A folder you place a name
in is where it must be: "delete the build folder in dist" covers `rm -r dist/build`, never `rm -r build`, and so do
"the build folder, which is in dist", "(the one in dist)", "from dist", "the build folder of dist", "… for dist", "… at
dist/", "in dist, delete the build folder" and "dist's build folder"; "in my home folder" means the home folder, and "at the
root", "at this point", "at your convenience" and "of mine" name no folder. A place is read from all your words,
wherever it stands: "the build folder at the root of frontend/" and "at the top of the frontend repo"
are frontend's, "…, but only the one in frontend", "…, the frontend one" and "… in the folder called frontend" are
too, and so is a folder you say to go into first or name before the thing ("cd into frontend and delete the build
folder", "at the root of frontend, delete the build folder"). A place Ember can't check a path against always asks:
beside something ("next to frontend", "near src", "above frontend", "by the src folder"), up from here ("up one
level", "in the folder above", "in ..") or on another computer or service, said before or after ("on the
server", "on staging", "on the remote", "off the server", "over ssh", "remotely"; "on this computer" and "on my
laptop" place nothing, and straight after the name "on the desktop" and "on my desktop" are
the Desktop folder). Ember reads places loosely, so a folder named for something else in the same words ("run the
tests in frontend and delete the build folder") asks too. A name written without a folder is the one in the folder
the task works in, so a command that changes folder first asks unless your words named a folder the file is in: after
"delete the build folder", `cd .. && rm -rf build` and `cd frontend && rm -rf build` ask; after "delete the build
folder in frontend", `cd frontend && rm -rf build` is announced. A word before a deleted path's name, or between it
and "folder", that names nothing in the path describes another one, so it asks: "delete the production build folder"
(or the staging, frontend, other, remote, shared, release or debug one, or "the build output folder") never covers `rm
-rf build`, nor `rm -rf staging/build`, which "delete the staging build folder" covers; a word that only says what it
is like ("the old, stale, whole, entire, generated, empty or huge build folder") doesn't. Anything broader than what you named asks: a force flag, a
wildcard, a folder outside the one you named, another branch, remote, changelist, package or computer. Name a folder
as a folder: "delete build/" (with the slash) or "delete the build folder" covers `rm -r build`, but plain "delete
build" asks before `rm -r build`, because it doesn't say build is a folder (it covers only `rm build`). The
first word in what you said that names the folder must say so too: "before you build, delete the build folder" and
"the build is broken, delete the build folder" ask, because their first "build" isn't the folder.

**When your words name another computer.** If your words for the task also name a computer other than the one the task
runs on, even without a place word ("build-01 delete build/" while Ember works on this computer), or a place that
looks like a computer Ember doesn't know ("delete build/ on prod-db", "at deploy@10.0.0.5", "from the server web-2",
"ssh prod-db and …", "prod-db: …": a name with a dot, a hyphen or a digit, or `user@host`, after on, in, at, inside,
over, via, into, onto, from or ssh, or first in the request before a colon or a comma), nothing in that task runs on
an announcement: every dangerous command asks, and the card's first line says where it runs ("It looks like you named
another computer (prod-db), but this runs on this computer.", "You also named build-01, but this runs on this
computer."). Ordinary commands still run. Everyday places ("on the desktop", "in my home folder", "on line 12", "in
main.ts", "in 5 minutes") don't count, nor do dates and number ranges ("on 2026-10-22,", "from 10-20"). Nor does a
folder or a branch the computer shows: "in my-app" (or inside, into) when my-app is a folder where the task works or
one of the folders it is in, and "on feature-x" when feature-x is the branch the task's folder is on; the command then
announces only if it acts on what is directly in that folder ("delete build/ in my-app" covers `rm -r my-app/build`,
not `rm -r build` elsewhere, nor `my-app/packages/core/build`). When the computer can't say, it asks. A name in quotes, backticks, guillemets or brackets,
written with any kind of dash, with a port or a folder after it ("prod-db:22", "deploy@prod-db:/srv"), or after a word
such as server, host or machine ("on the server prod-db", "ssh to prod-db") counts too. On a Windows PC where WSL
isn't on in Ember (or isn't installed, or your organisation turned it off), "WSL", "Linux" and "the Linux side" don't
move a task, so "search for how to install Python on Linux" works here as before; but for dangerous commands they
count as another computer: "in WSL, delete build/" asks, and its card says "You also named WSL, but this runs on this
computer."

These **always ask, even when you asked for them**: secrets (anything in §2.4's secrets item), downloading and
running code, commands that keep running after Ember stops, and anything Ember can't read with certainty. Every
command also asks when it runs as root or as an administrator, when **Ask me before every command** or your
organisation's policy says so, in a Podman distro, after a step in this task came up that you didn't ask for, and
when the command may carry text Ember read in another app.

### 2.5a When Copilot reviewed it

With **Ask only about dangerous commands** on (Settings › **Apps & privacy**; off by default while the reviewer is
evaluated), a command that would ask
only because of what it does (it deletes, publishes, downloads and runs something, or Ember can't tell exactly what it
does) is first shown to Copilot, in a conversation of its own with no tools: your own words for the task, the command,
where and in which folder it runs, the model's reason and what Ember's checks found. Never a command's output or your
screen, where text aimed at the reviewer would come from. When Copilot answers that it is routine for what you asked,
the command runs after the announcement above (the bubble says what it does; the command window adds "Ember's review:"
and the reason, with **Stop** and the countdown). When it answers that it is dangerous, can't tell, or doesn't answer
within 20 seconds, it asks as before, the card adding Copilot's reason when it gave one.

Never reviewed, always asked: commands that touch passwords, keys or other secrets, or change the system; commands
where Ember runs as root or an administrator; every command when your organisation, or you (**Ask before every
command**), asked for that; a task something on screen or in a command's output tried to steer; a command that may
carry text read in another window; a command your words place on another computer; and a task without your own words.
Turn the switch off to have every such command ask.

### 2.6 What Ember never runs

A command that would read or change Ember's own safety settings, records or programs (its organisation policy, audit
log, sign-in, settings or install folder, here or on the other computer), stop or debug Ember's own processes, or press
keys and click in Ember's windows (`xdotool`, `SendKeys`, `osascript` keystrokes). Ember says: "Ember won't run this:
it would change Ember's own safety settings, records or programs." ("it would read …" for a command that only reads
them, such as `cat` or `Get-Content`) or "Ember won't run this: it could press keys or click in Ember's own windows."
The same goes for the folder a command works in, named after `cd --` or `pushd --` (`cd -- ~/.config/ember && sed -i …
settings.json`) or given to `patch -d` or `--directory` (also shortened, down to `--di`), which changes the files the
patch names there (`patch -d ~/.config/ember -p0 < x.patch`; a folder Ember can't see there asks), and when a shell
loop's list or a variable the command sets names them (`for f in ~/.config/ember/*; do …`,
`d=~/.config/ember; rm -rf "$d"`, `d=~/.config; rm -rf "$d"/emb*`), in PowerShell too (`$d = "$env:LOCALAPPDATA\ember";
Remove-Item -Recurse $d`, `$d = Join-Path $env:LOCALAPPDATA 'ember'`), and so do `set --` (`"$1"`, `"$@"`),
`printf -v` and the text a here-string or here-document gives `read` or `xargs` (`while read f; do rm -rf "$f"; done <<<
~/.config/ember`); when it names a folder that holds them for a delete or a move (`for f in ~; do rm -rf "$f"; done`),
and when a name Ember can't see stands where one of Ember's folders is (`rm -rf ~/.config/$x`, or a cut or a default
of a variable, `~/.config/"${x%y}"`, which may be other text than its value) or a pattern before it could match one
(`rm -rf ~/.c*/$x`); `${HOME:?}` is the home folder, as `$HOME` is (and `${PWD:?}` the current one; Ember reads the
path it names, and also asks wherever it asked before it read such a word, "It uses a ${…:?} word, which Ember reads
as the folder it names but can't be sure of.": `ls ${HOME:?}/x`, `bash "${HOME:?}/x.sh"` and an unquoted `test -d
${HOME:?}/x` ask, `[ -f "${HOME:?}/.bashrc" ]` and `cd "${HOME:?}/proj"` run; inside an `if` the same holds, so `if true; then cat
${HOME:?}/x; fi` asks), and a default's text counts as a value
(`"${XDG_CONFIG_HOME:-$HOME/.config}/ember"` is Ember's folder). A variable is judged where a command uses it, so one that only names Ember's
folder to test or print it on the terminal (`p=~/.config/ember; [ -d "$p" ] && echo yes`), or that a text filter only reads on its
input while nothing takes what it prints (`grep -q ember <<< "$p"`, `echo "$p" | wc -c`; never an awk or sed program
that runs or writes what it reads, such as `awk '{system(…)}'` or `sed '…/e'`, which is refused given Ember's folder,
named or not), runs, unless it is exported to a
program (`export p`, `set -a`) or a program gets it some other way: as its own name (`"$p/bin/ember"`), through a
wrapper's option (`xargs -a "$p/settings.json"`, `xargs --arg-file="$p/settings.json"`), on its input (`xargs rm -rf <<< "$p"`, `read -r f <<< "$p"; rm -rf
"$f"`, `mapfile -t a <<< "$p"; rm -rf "${a[@]}"`), printed into another program or a file (`echo "$p" | xargs rm -rf`,
`echo "$p" > list.txt; xargs rm -rf < list.txt`, a loop or group whose output goes on, and in PowerShell `$p |
Remove-Item -Recurse` or `Write-Output $p | Remove-Item`) or through `${p:?}`, `${p:-…}` or `${p%/}`. What echo or
printf prints into the next command is that command's input, as a here-string's text is (`echo ~/.config/ember | xargs
rm -rf` is refused too); printf's escapes other than a line break, a tab and `\0` (`\056`, `\x2e`, `\u002e`) are text
Ember can't see, so the command after it asks (`printf '\056\056\057\056netrc' | xargs cat`). Only the shell's own
`echo` and `printf` count: a program merely named so (`./echo`, `/tmp/printf`, `node_modules/.bin/echo`) prints what
it likes, so the command after it is judged as given input Ember can't see, and Ember's own folder handed to it that
way is still refused. A command `xargs`
builds from text Ember reads is judged batch by batch (`echo test publish | xargs -n1 npm` asks about `npm publish`,
`printf 'status\nclean -fdx\n' | xargs -L1 git` about the clean); with an option Ember can't batch by (`-x`, `-s`,
`-E`, a count that is no number) the text is still judged, as one command (`echo publish | xargs -x cargo` asks,
`echo ~/.config/ember | xargs -x rm -rf` is refused), and with `-I` or `-i` beside `-L` or `-n`, where xargs keeps
only the later one, both ways are judged (`xargs -I{} -L1 git` given `push --force` asks). With `-I` or `-i` and more than 32 lines of text
it asks, having judged the first 32. Reading the text, or an
option's value, never makes it run or announce
where it asked before (a database client, `make -f -` or `awk -f -` given printed text asks too, "It runs the text
another command prints into it.", saying as well when the text changes data: `echo 'drop table users;' | psql app`): `echo build | xargs ls` asks ("xargs builds this command from its input."), and `echo build |
xargs rm -rf` asks whatever you said. Handed to a program that
may change what it names (an export, the input of a program Ember can't follow), Ember says it would change its files. A value Ember can't see at all (a file `read` reads, a command's output) isn't followed: such a command asks, as any delete
does.

### 2.7 What Copilot gets back

A command's output goes to Copilot as part of the task, marked as untrusted data, at most 200 lines and 16 KB (the first
40 lines and the last 160, with very long lines cut). Before it leaves this computer Ember removes terminal codes, cuts
out every line you typed, withholds what follows a password-like prompt (until the program's next line after you press
Enter, or to the end when the command can't take typing), and hides the passwords, keys and tokens it recognises
(GitHub, AWS, Slack, Google, npm, OpenAI, Anthropic, Stripe, Hugging Face, GitLab, SendGrid, DigitalOcean and Twilio tokens and keys, private keys, JWTs, `password=` values, `Authorization:` headers, a Docker config's `"auth"`, a one-line `.netrc` entry's password, passwords
in URLs, a password given to a program's short option such as `mysql -p…` (also after a prompt such as `C:\>`, a
comment's `#` or from a quoted folder), `curl -u user:…`, `docker login -p …` or `sshpass -p …`, the same where the arguments are a list
(`["mysql", "-uroot", "-p…"]`, `["sshpass", "-p", "…"]`, `"--password", "…"`, but not after `"--no-password"`, nor `"none"`,
`"string"` or the option's own name, as in `"--api-key", "api_key"`), and the like). Hiding is best effort: a secret in a form Ember doesn't recognise can get through, so don't print
secrets on purpose.

Output that reads like instructions to Ember ("ignore previous instructions", "you are an AI assistant", `curl … |
sh`) is not followed: it marks the task, and every further command in that task asks you ("Ember is checking each step:
an earlier command printed text that looked like instructions.").

### 2.8 Stopping, timeouts and the working folder

- **Stop** in the window, the task's **Stop**, the stop chord and "Ember, stop" end the command and the programs it
  started. A program that leaves on purpose (detaches and clears its environment, runs as another user through
  `sudo`, or is handed to a service such as `docker run -d` or `systemd-run`) can keep running. Ember asks before the
  forms it recognises (`nohup`, `setsid`, `&`, `sudo`, `docker run -d`, `systemd-run` and the like), but a program
  that detaches by itself can't be told from the command line; the window names any program it started that is still
  running.
- If Ember itself crashes, a command on Windows ends with it, but one on Linux or macOS (or in WSL) runs on until it
  writes output or ends by itself: newer versions of `script` don't end it when Ember goes (§7, L10).
- A command stops after 2 minutes unless the task gives it longer (at most 15 minutes): "Stopped after 2 min: it took
  too long."
- Each task keeps one folder per computer, starting at your home folder. A command that is only `cd <folder>` changes
  it (by the name as written, links included, `cd -P` too); a `cd` inside a longer command affects only that command.
  Each command's shell (on this computer, in WSL and on SSH computers) is told the task's folder as Ember named it,
  so its `cd ..` goes where Ember judged (a shell not told starts from the folder's real path, and `cd ..` would land
  beside a link's target). Inside a longer command, what follows `cd -P`, and what `env -C <folder>` runs, has no
  folder Ember knows (only the computer knows where a link leads), so a name relative to it asks ("Ember can't tell
  which folder this command runs in."); `set -P`, `set -o physical` (also as `set -euo physical`), zsh's `-w`,
  `chase_links`, `chase_dots` or `cdable_vars`, a command that sets or removes `PWD` itself, and a shell started without it (`env -i`,
  `env -u PWD`, `exec -c`) make later `cd`s go where Ember doesn't follow, so they ask ("It makes the shell follow links
  when it changes folder, which Ember doesn't follow.", or "It changes how commands are found or run.").
- One command at a time per task; at most three at once on one computer.

### 2.9 Things to know

- **Your shell profile isn't loaded.** Commands run without `~/.bashrc`, `~/.zshrc`, `~/.profile` or PowerShell's
  `$PROFILE`, so aliases and tools that they set up (conda, nvm, pyenv) are missing; Ember says so when a tool isn't
  found. Name the tool by its full path, or tell Ember where it is. On a Mac, Homebrew's folders and `/etc/paths` are
  added. Over SSH, the remote login's own start-up files (bash's `~/.bashrc`, zsh's `~/.zshenv`) did run when Ember's
  helper started there.
- **On Windows**, commands run in Windows PowerShell 5.1 (not PowerShell 7) and can't take typing, so they can't ask
  you for a password or an answer; a cmd command runs inside PowerShell as `cmd /c "…"`. Stop ends the command and
  everything it started at once.
- **As root or administrator**, every command asks ("Commands here run as root (the administrator), so each one asks
  first." / "Ember is running as an administrator here, so each command asks first.").
- **Ember judges the command line it can see, and the shell scripts it can read.** A shell script is read and judged
  first (§2.4); one Ember can't read all of (`case`, functions, `{ … }` groups, a `[[` with arithmetic, a variable in
  a file name, more than 64 commands or 8,000 characters, or zsh's, PowerShell's or cmd's `if` and `for`) asks, so most build and install scripts ask. What a build file, a program, a script in another language, or a shell script too big to read
  (more than 64 KB) does inside (`make`, `npm test`, `python build.py`) runs like a build, unless its name says deploy,
  publish, release, push, upload, delete, clean, wipe, prod, install or the like, which asks. A script this task
  downloaded always asks, and one it wrote asks when it can't be read in full. A script an earlier command of the
  task downloaded is asked about without being read (it is code from elsewhere either way); one the same line
  downloads is read as it stands before the download (§2.4).
- **Links.** Ember checks where each path really leads before it decides (a link into `~/.ssh` counts as `~/.ssh`,
  and `sub/../x` counts as the x beside where sub leads, §2.4); a link changed between that check and the run is not
  caught.
- **Writes Ember can't see.** A script this task wrote counts as its own only when Ember could see the write: a
  redirection (`>`, `>>`), `cp`, `mv`, `tee`, `sed -i`, or an archive unpacked. Programs that write files without
  naming them on the command line, such as `uudecode`, `split`, `base64 -o` on a Mac, or a program that generates a
  script (`python gen.py`), don't make that script the task's own: if it is then too big to read, it is judged by its
  name like any other script (§7, L8).
- **Same-user programs.** While a command runs, its text is in its own environment, which other programs of yours
  can read; they could already use your keys and SSH agent.
- A command can't use Ember's GitHub sign-in: `git` and `gh` use your own credential helpers and keys.

## 3. WSL (Windows)

### 3.1 Turning it on

When you ask for something in WSL or in a distro Settings lists while WSL is off for Ember ("in WSL, list my files",
"in Ubuntu, …"; "Linux" alone doesn't), and Windows has a distro Ember could use, Ember offers "I can work in WSL"
(**Open settings**, **Not now**), once each time it runs (again at your next such request if it couldn't show within
25 seconds); the task itself goes on where Ember is set to work.
Settings › **Computers** › **Let Ember work in WSL** shows the card "Use
Ember with WSL?" (**Turn on**, **Not now**). It says Ember starts a small helper inside each distro that has a Linux
app open, only while one is open, and never starts a distro on its own to read it; what it reads goes to Copilot as
for your other windows; and commands in WSL, once you turn them on for a distro, can reach your Windows files and
programs.

Settings lists each distro as "Ubuntu (WSL)" with its state ("Running", "Stopped", "WSL 1: commands only").
Docker Desktop's and Rancher Desktop's own distros are never listed. A Podman machine is commands only, and every
command there asks. A distro that hasn't finished its first-run set-up isn't used: "Set up Ubuntu first: open it from
the Start menu once."

### 3.2 Linux apps (WSLg)

With WSL on, Ember reads Linux apps shown by WSLg ("gedit (Ubuntu)"), opens them from their Start menu entries and
uses their controls (buttons, fields, lists, menus) as it does for Windows apps. Grants are per app and distro:
**Always in gedit (Ubuntu)** covers only gedit in Ubuntu. Linux terminals, password prompts (polkit, pinentry,
ssh-askpass) and never-look apps are refused there as on Linux.

- **No mouse or keyboard in Linux apps yet.** Ember uses their controls instead ("Ember can't use the mouse or
  keyboard in Linux apps yet; it uses their controls instead"). Apps whose controls can't be read can't be used.
- **A Linux app Ember can't identify** (no helper, no session bus, an app without accessibility such as xterm, two
  windows it can't tell apart) is treated like a remote desktop window: Ember reads its title only, never acts in it,
  and blacks it out of screenshots. A WSLg menu or tooltip counts as part of its app's window for screenshots only.
- **Linux apps shown by an X server on Windows** (VcXsrv, X410, Xming, GWSL, Cygwin/X) are never used: "Linux apps
  shown by an X server (VcXsrv, X410…) can't be used; WSLg's can."
- **WSL 1** shows no Linux apps: those distros are commands only.
- **A distro whose default user is root**: Ember doesn't use its Linux apps, and every command there asks.

### 3.3 What a distro needs

Ember never installs anything itself; the setup check names the command. In each distro you want Ember to read apps in:

| Distro | Command |
|---|---|
| Debian, Ubuntu | `sudo apt install python3-pyatspi at-spi2-core` |
| Fedora | `sudo dnf install python3-pyatspi at-spi2-core` |
| Arch | `sudo pacman -S python-atspi at-spi2-core` |
| openSUSE | `sudo zypper install python3-pyatspi at-spi2-core` |

Then turn on accessibility for Linux apps (the **Accessibility in Ubuntu** row of the settings window's setup check
has a button that runs `gsettings set org.gnome.desktop.interface toolkit-accessibility true` in the distro) and
restart those apps. The button runs nothing when your organisation has turned WSL or commands in WSL off ("Couldn't
change it: Your organisation has turned this off."), when WSL is off in Ember's settings ("… WSL isn't turned on for
Ember. Turn it on in Ember's settings (Computers)."), or when the distro isn't running ("… Start Ubuntu first: Ember
doesn't start a distro to change its settings."). Some apps stay unreadable: Qt apps need
`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` in their environment, Chromium, Electron and Firefox apps need their own
accessibility switch, and if Ember can't find the session bus your Linux apps use, it says so ("Ember can't find the
session bus your Linux apps use in Ubuntu, so it can't read them. Commands in Ubuntu still work."). WSLg itself needs
the Store or MSI WSL: "Update WSL to use Linux apps with Ember: run `wsl --update` in PowerShell." Commands need
`base64` (coreutils) in the distro.

### 3.4 Commands in WSL

Commands run inside the distro as its default user, never as root through `wsl -u root`. The first command in a
stopped distro starts it: while it boots, the task's bubble and the command window say "Starting Ubuntu…" (a line
above the tabs while Ember checks the command, before it has a tab; then the command's own tab, once it runs). Shell
scripts a command runs are read inside the distro before it runs (§2.4), only while the distro runs (Ember never
starts it just to read one). A command in WSL may start Windows programs and read or write Windows drives
(`/mnt/c`); it is judged like any other command, and the card adds "This can reach your Windows files." when it does.
`wsl.exe`'s own options (another user, `--shutdown`, `--unregister`, `--export`…) and changes to `.wslconfig` or
`/etc/wsl.conf` ask.

## 4. Other computers over SSH

### 4.1 Connecting

- **Add a computer** in Settings › **Computers**: type an alias from your `~/.ssh/config`, `user@host`,
  `user@host:port` or `ssh://user@host:port` and press **Connect**. The handle menu's **Bring Ember to a computer…**
  (there unless your organisation has turned SSH off) opens that section, ready to type in. While a computer is
  connecting, the handle menu has **Cancel connecting to build-01**. The same computer and login typed another way (an
  alias, or user@host with its full name) is the one Ember already has: it connects that one and says "Already added as
  build-01".
- **Or let Ember notice your own `ssh`.** Once you've added a computer (and said yes to its card), when the window
  you're in is a terminal and its title changes, Ember may look (at most every 10 seconds) at your own `ssh` processes:
  their command lines (the host and a few options), never your terminal's contents. Until then it doesn't look at all.
  It offers "You're connected to build-01" — "Bring me there too? I'll open my own connection with your SSH settings."
  (**Bring Ember**, **Not now**, **Don't offer again**). The offer waits until you've finished reading what the bubble
  shows, ignores a press in its first half second, and goes after 25 seconds unanswered (as **Not now**; ten times that
  with **More time to read and answer**). While it is up, Ember stops following the pointer and holds still beside it,
  as it does while you read an answer, so its buttons stay where you reach for them. Its buttons, like those of "Lost
  build-01" and "Can't connect", take only the mouse; under them the bubble says where the same buttons are from the
  keyboard (Settings › **Computers**, with the settings shortcut). An offer to work on another computer that you didn't
  ask for waits while "Lost build-01" or "Can't connect to build-01" is up, and shows (for its 25 seconds) once that
  goes; one you asked for shows at once, and the Lost bubble comes back after it. An offer you didn't ask for waits
  25 seconds at most (whatever it waits behind): one that couldn't show by then goes unseen. The next time Ember
  looks, an offer whose `ssh` it finds has ended goes too, whether it is up or still waiting. It offers each
  computer once per run (again, the next time it looks, if you never saw the offer), and **Don't offer again**
  sticks. It doesn't offer for an `ssh` that runs a command without a terminal (git, `scp`, `rsync`, scripts), one
  started with `-T`, or one to a git hosting service such as GitHub. Turn the offers off with
  **Offer to bring Ember along when I connect with SSH** (shown once a computer is added). Ember always opens its own
  connection; it never uses or types into yours. If it can't connect there (your organisation doesn't allow that
  computer, its settings throw host keys away, it is this same computer…), the bubble says so: "Can't connect to
  build-01" with the reason. Ember looks at your `ssh` in WSL only in distros that are running at that moment, and never
  starts one to look. On a Linux computer running more than 5,000 processes it doesn't look at all (reading them all
  would take too long), so it neither offers nor takes an offer away there. The same goes for a WSL distro whose
  running `ssh` commands come to more than about 1 MiB of text: Ember can't read them all at once.
- **The card.** The first time (and again when the user, host name or port your SSH settings give changes, or the
  computer behind the name changes), Ember shows "Bring Ember to build-01?" (**Connect**, **Not now**): who it
  connects as and through which jump hosts, the keys and settings file it carries over from your own `ssh` command,
  what it does on the screen there if build-01 has a desktop (a server with no desktop, or a Mac, gets commands only),
  that your voice and sign-in stay here, what it copies there and to which folder (§4.3), and that build-01 keeps its
  own record. Asked again because your SSH settings changed, it starts with what changed: "Your SSH settings now send
  build-01 to deploy@new.example.com, port 22 (before: deploy@old.example.com, port 22)." **Connect** works once the
  whole card has been in view, as for the commands card. **Cancel** on the connecting bubble, **Forget** and the stop
  chord take the card away with the connection.
- **Your SSH settings and keys.** Ember runs the system's OpenSSH client with your `~/.ssh/config`, keys and SSH
  agent, through your jump hosts. On Linux and macOS, if you already have a shared connection open (`ControlMaster`),
  Ember rides it, so you aren't asked to sign in again; it never creates one. It forwards nothing (no agent, no X11,
  no ports).
- **Passwords, passphrases and codes** are asked in Ember's own small window ("Sign in to build-01", "Unlock your SSH
  key", "Verification code for build-01", "Touch your security key"), handed to SSH only, and never saved, logged or
  sent to Copilot. A prompt for a jump host names that host "on the way to build-01". One card shows at a time: a
  password card waits while a consent card is open. The window takes the keyboard as settings does; if another app keeps
  it (macOS after a shortcut, Windows' focus rules), the card says "Click here before you type: the keyboard is still in
  another app." and a notification says so too. **Cancel** (or Esc) on a sign-in card ends the connection quietly, as
  the bubble's **Cancel** does. A sign-in card Ember can't show (no window, its window crashed, or a server's question
  too long to show) ends it with "Ember couldn't show build-01's sign-in question." and **Try again**. **With OpenSSH
  older than 8.5** on this computer (RHEL 8 has 8.0, Ubuntu 20.04 8.2, Debian 11 8.4), SSH can't mark which questions
  come from the other computer, so a server could word its own question as SSH's. There every password, passphrase or
  code is shown as "A question while connecting to build-01", with the question quoted as it came, never as "Unlock
  your SSH key" or as a sign-in to another host. The card says so ("This computer's SSH can't show whether this
  question comes from SSH itself or from build-01, so read it before you answer: what you type goes to whoever
  asked.") and that Ember hands the answer to SSH only, never saving, logging or sending it to Copilot.
- **A computer you haven't connected to before** shows "Is this really build-01?" with its key's fingerprint. Check
  it with whoever looks after build-01; **Trust and connect** is never the default. If the key has changed, Ember
  won't connect ("build-01's identity changed"); remove the old key with `ssh-keygen -R build-01` only if you know
  why it changed.
- **Not this computer.** Ember refuses to connect to this same computer ("build-01 is this computer. Ember already
  works here.") or to a WSL distro on it ("build-01 is WSL on this computer: use it as WSL instead.").
- **Disconnect** from the handle menu or Settings. If the connection drops, everything there stops ("Lost build-01";
  each task stopped there says "build-01's connection dropped, so I stopped this.") and Ember tries to reconnect for up
  to 10 minutes. If build-01 was where Ember worked, the bubble says it works on this computer until build-01 is back,
  and stays until you answer it or the connection comes back. When Ember reconnects by itself it says "build-01 is back"
  and works there again, unless you picked another computer meanwhile. A reconnect starts fresh: no task resumes and no
  approval carries over. Reconnecting never asks you anything, so when it needs you (a password, a passphrase your SSH
  agent doesn't hold) it stops trying and the bubble says "build-01 needs you to sign in again" — "Reconnect to sign
  in."; for a host key to accept, "build-01 needs you to check its key again" — "Reconnect to check it."; when it gives
  up for another reason (after 10 minutes, or a refusal), it says "Can't reconnect to build-01" with the reason. All
  have **Reconnect**, which connects with Ember's sign-in window.

### 4.2 What stays here

Copilot, the conversation, listening, speech recognition, speaking, Ember's questions and approvals, and your GitHub
sign-in all stay on this computer; nothing Copilot-related is installed on the other one. Ember sends build-01 only
the steps it takes there (element ids, values, commands); what it reads there comes back here and goes to Copilot from
here when you ask something. Your request reaches build-01 as steps, never as audio.

### 4.3 What Ember copies there, and where

Ember checks build-01 first (system, free space, its own Ember policy, whether it is this same computer) and copies
nothing until every check passes. Then it copies a helper over the same SSH connection: Node.js (about 32 MB as
`.tar.xz`, or 53 to 58 MB as `.tar.gz` where build-01 has no `xz`, as on most Macs; this computer downloads it from
nodejs.org, or your organisation's mirror, and checks it against a pinned SHA-256 before sending) and Ember's own
parts (about 1 MB, shipped inside Ember), about 33 MB in all (up to about 60 MB on a Mac or other computer without
xz), unpacked to about 130 MB (Node.js without its headers and npm, which the helper doesn't use); build-01 needs
about 400 MB free in your home folder. build-01 checks every file again before running it. A newer Ember sends only
what changed (about 1 MB).

| On build-01 | Linux | macOS |
|---|---|---|
| The helper | `~/.local/share/ember-remote/` (`runtime/`, `versions/`) | `~/Library/Application Support/Ember Remote/` (`runtime/`, `versions/`) |
| Its record and logs | `~/.local/state/ember-remote/<machine>/` (`audit/`, `consent.json`, `logs/`) | `~/Library/Application Support/Ember Remote/state/<machine>/` |
| While connected | `$XDG_RUNTIME_DIR/ember-remote/`, else `/tmp/ember-remote.*` | the user's temporary folder (`getconf DARWIN_USER_TEMP_DIR`) |

**Nothing persists.** The helper runs only while Ember is connected and stops when you disconnect, quit Ember, press
the stop chord or the connection ends. Ember adds no service, autostart entry, cron job, LaunchAgent or scheduled
task, writes nothing outside those folders, and opens no network port there. Only one Ember at a time works on a
computer for a user ("Ember from another computer is already working on build-01."). Helper versions unused for 30
days are deleted.

### 4.4 build-01's screen

Ember uses build-01's screen only when **the same user it logged in as is the person at that computer's own screen**
(its local console session), and only while that screen is unlocked. While it does, build-01 shows a small window
"Ember on &lt;PC name&gt; is using this screen." with a **Stop** button; a click there stops everything ("Stopped on
build-01" — "Someone at build-01 pressed Stop."). If build-01's administrator requires it, someone at that screen must
first click **Allow**.

- **Every step there is asked**, Ember never borrows build-01's mouse and keyboard, and you aren't shown its screen.
  Screenshots taken there are masked on build-01 (never-look windows, password fields) before they leave it, and go
  only to the model. A live view of the remote screen may come later.
- **The screen locks, or that session stops being the active one**: the tasks using build-01's screen stop ("build-01's
  screen locked, so I stopped working on its screen.", or "build-01's desktop session isn't active any more, …"). A task
  that has only run commands there goes on: its command window is on this computer. A click on the notice's **Stop**, a
  lost connection, **Disconnect** and the stop chord still stop everything there. This computer's own screen is treated
  the same way: while it is locked, or its session isn't the one in front, Ember doesn't listen for "Hey Ember", doesn't
  speak, takes no requests ("Your screen is locked, so I didn't take that.") and doesn't read or act on this computer's
  screen (or a WSL app's window on it), even for a request already under way: it doesn't describe the screen, open apps
  on it or change its settings; and the tasks that have used this computer's screen stop ("Your screen locked, so I
  stopped the task working on it.", once you're back); one that has only run commands goes on. Listening starts again
  when you unlock it. Windows and macOS say when the screen locks; on Linux, logind does (GNOME sets its LockedHint),
  watched with `gdbus monitor`, or read every 5 s without gdbus.
- **No desktop, or only a VNC or xrdp session**: commands only ("build-01's desktop is a remote session: Ember will run
  commands only."). VNC and xrdp desktops aren't used because Ember can't be sure who sees its notice there.
- **Wayland**: reading and using controls only, no screenshots. Until Ember's own test of it passes, a Wayland desktop
  is commands only ("Ember can't use build-01's Wayland desktop yet; it can run commands there.").
- **A Mac**: commands only ("Ember can't use a Mac's screen over SSH yet; it will run commands there."). Commands
  there can't open your Desktop, Documents or Downloads folders until "Allow full disk access for remote users" is on
  (System Settings › General › Sharing › Remote Login › ⓘ).
- **WSL on another PC**: commands only (its Linux apps show on that PC's screen).
- **Windows**: not supported yet ("build-01 runs Windows: Ember can't work there yet.").
- **Logged in as root**: Ember doesn't use the screen, and every command asks.

### 4.5 Commands on build-01

They follow §2. build-01's helper also checks each command with its own rules and its own administrator's policy;
when it finds more than this computer did, it asks you ("build-01's own check also found:", then its words), and the
command's tab says "Not run: build-01's own check asks for your OK first." until the run you allow takes its place
("Not run: you didn't allow it." if you don't; if build-01 sends the allowed run back too, its tab says build-01 refused
it, and Ember doesn't ask again). A shell
script the command runs (`sh build.sh`, `./tools/gen.sh`) is read by that check on build-01, not by this computer, which
can't see build-01's files: anything dangerous in the script asks this way, and so does a script this task wrote or
downloaded there that can't be read in full. Both computers record the command in their audit logs.

build-01's helper remembers what a task wrote or downloaded there only while it runs. When the connection is lost and
Ember reconnects, the helper starts afresh and has forgotten it: a script the task padded past 64 KB before the
reconnect then runs unread, judged by its name like any other script too big to read, and a script that runs a file
downloaded before the reconnect is no longer known to run a download (this computer still remembers the task's
downloads, so a command that runs one by name still asks) (§7, L8).

If the connection goes silent for 5 seconds, the bubble says "build-01 isn't answering" — "Commands running there
stop in 15 seconds unless it answers again. I'll send nothing new until then.", and each running command's tab counts
down ("build-01 isn't answering. This command stops in 12 seconds unless it answers again.") until the link comes
back or is lost; so a network blip doesn't kill a long build. The stop chord ends Ember's own connection at once, but
while the network is down a command on build-01 ends only when build-01 notices, within 20 seconds of the last thing
it heard (an administrator can set 3 to 120; the bubble and the tab say what is left of it).

A command that prints faster than the connection can carry waits for it: once about 1 MB of its output is waiting to
be sent, build-01's helper holds the command's output back (the command pauses as it would on a slow terminal) until
the backlog is under a quarter of that, so the connection stays free for Stop and for other work. A command you
stopped is never held back, so its end comes through at once; if it keeps printing past that limit as it ends, the
rest of its output is dropped and you won't see it. After the stop chord, output still waiting on build-01 is dropped.

### 4.6 Windows PCs, WSL tabs and jump hosts

- **On a Windows PC** Ember needs the OpenSSH Client 8.1 or newer ("Ember needs OpenSSH 8.1 or newer: update the
  OpenSSH Client in Settings › Apps › Optional features."). Its own password window works only with **8.4 or newer**
  (Windows 10's built-in client is older), and not under Constrained Language Mode or where application control
  blocks the small helper Ember compiles for it. There, connect with keys and the ssh-agent service ("build-01 didn't
  accept your key. Add it to the ssh-agent with ssh-add, then connect again."), and accept an unknown host's key once
  yourself ("Connect once with ssh build-01 in a terminal, check its key, then try again.").
- **`ssh` typed in a WSL tab** is noticed too. Ember connects with Windows' SSH unless connecting through the distro
  has been proven to work; then the offer says "I connect with Windows' SSH. Add your key to Windows' ssh-agent,
  or connect once from PowerShell, then bring me there." Connections through a distro use its keys and agent only,
  with no password window.
- **Jump hosts** from your SSH config or `ssh -J` are carried over (up to three; on a Windows PC one). A sign-in
  helper set as your `ProxyCommand` runs as your own `ssh` would run it.

### 4.7 Removing Ember from a computer

- **With Ember**: Settings › **Computers** › build-01's **Remove helper** ("Remove Ember's helper from build-01? This
  stops anything Ember is running there and forgets build-01 here. Its record of what Ember did there stays on
  build-01."). Ember connects, removes the helper, its consent record and its logs, and keeps the audit record; the row
  says "Removing Ember's helper…" meanwhile, with a **Cancel** that stops it where it is (remove it again to finish),
  and "Removed. build-01 is no longer in your list." once it is done.
  **Forget** (it asks first too) removes the computer and your OKs for it from Ember's list without touching it.
- **Without Ember**, on build-01: run the `uninstall.sh` in any version folder of the helper,
  `sh ~/.local/share/ember-remote/versions/<version>/uninstall.sh` (macOS:
  `sh ~/Library/Application\ Support/Ember\ Remote/versions/<version>/uninstall.sh`); `README.txt` beside it says the
  same. It too keeps the audit record. To remove everything, disconnect Ember first, then delete the folders:

  ```bash
  rm -rf ~/.local/share/ember-remote ~/.local/state/ember-remote             # Linux
  rm -rf ~/Library/Application\ Support/Ember\ Remote                       # macOS
  ```

Remove the helper with Ember from each computer you added before you remove Ember from this computer: once Ember is
gone from here, only the way without Ember is left.

### 4.8 When connecting fails

The bubble ("Can't connect to build-01") stays until you close it (**Try again** too when another try may help), and
build-01's row in Settings › **Computers** keeps the reason until it connects. A changed host key also opens the
"build-01's identity changed" card with the fix.

| Ember says | What to do |
|---|---|
| "Ember can't find SSH on this computer.", then how to install it on yours alone: on Linux "Install OpenSSH with sudo dnf install openssh-clients, then try again.", on Windows "Install the OpenSSH Client in Settings › Apps › Optional features, then try again." (through a WSL distro, the Linux line) | As it says; on a Mac, SSH comes with macOS at /usr/bin/ssh |
| "Ember can't find build-01. Check the name, or add it to your SSH config." (for a computer you were adding, "It wasn't added to Computers." too: a name Ember can't find on its first connection isn't kept, so fixing a typo adds one row) | Check the name, then connect again (the field keeps what you typed) |
| "Ember can't reach build-01 (&lt;reason in a few words&gt;). Check you're on the right network or VPN." (also "its name couldn't be looked up just now" when this computer is offline: a computer you were adding is kept) | On macOS 15, for a computer on your local network, also allow Ember in System Settings › Privacy & Security › Local Network |
| "Your SSH settings for build-01 have a line this SSH can't use: &lt;the line&gt;. Fix or remove it, then connect again." | As it says |
| "build-01 took too long to answer (a jump host or sign-in helper may be waiting)." | Check the jump host or sign-in helper |
| "build-01 refused after too many keys. In your SSH config, add IdentitiesOnly yes and an IdentityFile line with the right key for build-01." | As it says |
| "build-01's settings throw host keys away, so Ember can't check it's really build-01." | Remove `UserKnownHostsFile /dev/null` for that host |
| "build-01 didn't run Ember's set-up (it may be Windows, or this login runs a fixed program)." | Ember needs a normal shell login there |
| "build-01's system is too old for Ember (it needs glibc 2.28 or newer, as in RHEL 8 or Ubuntu 20.04)." | Ember can't work there |
| "build-01 doesn't have room for Ember's helper (it needs about 400 MB in your home folder)." | Free some space |
| "build-01 doesn't let programs run from your home folder, so Ember can't run there." | Ask its administrator (§6.6) |
| "build-01's security software doesn't let programs from your home folder run. Ask its administrator to allow Ember's helper there (with fapolicyd, by trusting its folders)." | §6.6 |
| "Ember couldn't download what it needs for build-01 (&lt;reason&gt;). Check your internet connection, or ask your administrator about a mirror." | As it says; the mirror is §6.1's `ssh.runtimeMirror` |
| "The download of what Ember needs for build-01 stalled. Try again." | Nothing arrived for 60 seconds, so Ember ended the download (nothing was copied to build-01). **Try again**; if it keeps stalling, check your proxy or ask your administrator about a mirror |
| "Your organisation doesn't allow Ember to connect to build-01." | Your administrator's `ssh.allowedHosts` |
| "build-01's administrator doesn't allow Ember there." / "build-01's Ember policy is broken, so Ember won't work there." | build-01's own policy (§6.4) |

## 5. The setup check

`ember doctor` and the settings window's setup check gain these rows:

| Row | Warns or fails when | What to do |
|---|---|---|
| **SSH client** (while SSH is allowed) | No client, or too old (OpenSSH 7.6 on Linux and macOS, 8.1 on Windows); on Windows 8.1 to 8.3: "Passwords can't be asked here: keys and the ssh-agent only". Only ever a warning: SSH is optional | Install or update OpenSSH (§4.8); on Windows, 8.4 or newer to enter passwords in Ember |
| **Command window terminal** (Linux, macOS, while your organisation allows commands here) | "No script program: commands can't ask for passwords or answers" | Linux: `sudo dnf install util-linux` (macOS comes with `script`) |
| **PowerShell for commands** (Windows, while your organisation allows commands here) | Windows PowerShell missing, or Constrained Language Mode ("command output may not be UTF-8, and SSH passwords can't be asked") | Turn on Windows PowerShell in Windows features |
| **WSL** (Windows) | No distros; WSLg off ("Remove `guiApplications=false` from `%USERPROFILE%\.wslconfig`."); the built-in WSL ("Run `wsl --update`."); an X server showing Linux apps | As the row says |
| **Linux apps in Ubuntu** (a running distro, while WSL is on in Ember) | The helper, Python 3, pyatspi or the session bus is missing, or the distro runs as root | §3.3 |
| **Accessibility in Ubuntu** (likewise) | Toolkit accessibility is off | The row's button in the setup check (§3.3), then restart your Linux apps |
| **Linux apps in WSL** (while WSL is off in Ember) | Never: "WSL is off in Ember's settings, so Ember doesn't look inside its distros" | Turn WSL on in Settings › **Computers** to check them |
| **Helper for other computers** (an installed Ember, while SSH is allowed) | Missing from this install (only a warning: SSH is optional) | Reinstall Ember |
| **Folders on build-01** (a connected Mac) | Commands can't open Desktop, Documents or Downloads | Turn on "Allow full disk access for remote users" on that Mac: System Settings › General › Sharing › Remote Login › ⓘ |

## 6. For administrators

### 6.1 The keys

The organisation policy (the same file or registry value as for everything else: §6.3) gains these keys. Compared
with having no policy at all, none of them can make Ember less strict. But a policy that exists turns commands off
until it says otherwise (§6.2), so adding `commands` to an existing policy is what allows them.

| Key | Values | Effect |
|---|---|---|
| `features.wsl` | `true` / `false` | `false`: no WSL at all (no Linux apps, no WSL computer, no WSL commands) |
| `features.ssh` | `true` / `false` | On the PC, `false`: no connecting to other computers, and no SSH commands. On a computer Ember connects to: `false` refuses Ember there |
| `commands.local` | `"on"` / `"ask"` / `"off"` | Commands on this computer: allowed (the user still turns them on), every command asked (no announcements), or off |
| `commands.wsl` | `"on"` / `"ask"` / `"off"` | Commands in WSL distros |
| `commands.ssh` | `"on"` / `"ask"` / `"off"` | Commands on computers reached over SSH (both computers' values apply: the stricter wins) |
| `ssh.allowedHosts` | up to 200 patterns | The only computers Ember may connect to (§6.5) |
| `ssh.desktop` | `true` / `false` | On the PC, `false`: commands only on every remote, no desktop. On a remote: no desktop for Ember arriving over SSH |
| `ssh.requireConsoleConsent` | `true` / `false` | On a remote: a person at its screen must click **Allow** before Ember reads anything there |
| `ssh.runtimeMirror` | an `https://` URL | Where the PC downloads Node.js for remotes instead of `https://nodejs.org/dist/` (same layout: `v<version>/node-v<version>-<os>-<arch>.tar.xz` and `.tar.gz`); still checked against Ember's pinned SHA-256 |
| `ssh.commandGraceSeconds` | 3 to 120 (default 20) | How long a command on a remote keeps running while the connection is silent; the smaller of both computers' values applies |

`features.actions: false` also turns commands off on every computer: Ember then answers and guides but starts no
task, and commands run only inside tasks.

Example for a fleet that allows SSH to build hosts, commands with questions on remotes, and none locally:

```json
{
  "features": { "ssh": true, "wsl": false },
  "commands": { "local": "off", "ssh": "ask" },
  "ssh": { "allowedHosts": ["*.build.example.com"], "desktop": false }
}
```

### 6.2 Defaults and what fails closed

| Policy state | WSL | SSH | Commands |
|---|---|---|---|
| No policy | available (the WSL card) | available (the card per computer) | available on every kind of computer, each after its switch and card |
| A policy without the new keys | available | available | **off** on every kind: the administrator never agreed to them |
| `features.wsl: false` / `features.ssh: false` | off | off | that kind's commands off too |
| `commands.<kind>: "ask"` | — | — | every command there asks; nothing runs on an announcement |
| `confirmEveryAction: true` | — | — | every command asks, as with `"ask"`, on every kind whose commands are on |
| `features.actions: false` | — | — | off (no task starts) |
| A broken policy (Ember locks down) | off | off | off |
| SSH, both computers | — | a remote's own `features.ssh: false` refuses Ember there | the stricter of both computers' `commands.ssh` |
| A WSL distro's own `/etc/ember/policy.json` | ignored: root inside a distro needs no password, so it isn't an administrator's file | — | — |

A locked-down Ember (a broken policy) also connects to no model service, neither GitHub Copilot nor the organisation's
own endpoint, and prunes nothing from the audit log, until the policy reads fine again.

Ember reads the PC's policy again every 10 seconds, as the helper on a remote does. When what it says changes
(tightened, repaired, added or removed) and the next read says so too, Ember stops everything, holds itself locked down
as above, and asks the user to restart it; the restart reads the new policy whole. One read that differs (a file caught
mid-write) is let pass when the next one says what the policy said before; three reads in a row that differ count as a
change. **What Ember did** records the stop as "Everything stopped: your organisation changed Ember's policy".

**An older Ember locks down when it reads a policy with these keys.** The policy schema is strict, so an Ember from
before this release reads `commands`, `ssh`, `features.wsl` or `features.ssh` as a mistake and locks down (no actions,
no listening) until the policy is fixed or Ember is updated. Update Ember everywhere before deploying a policy that
uses them.

### 6.3 Where policies live

| OS | Location |
|---|---|
| Linux | `/etc/ember/policy.json` (root-owned, writable only by root) |
| Windows | `HKLM\SOFTWARE\Policies\Ember`, value `PolicyJson` (`REG_SZ` or `REG_MULTI_SZ`) |
| macOS | `/Library/Application Support/Ember/policy.json` (root-owned folder and file) |

[DEVELOPING.md](DEVELOPING.md) §5, §10.7 and §11.7 say how to deploy each.

### 6.4 The remote computer's own policy

A Linux or macOS computer Ember connects to is bound by **its own** policy file at the same path, as well as the
PC's: for everything Ember does there, each value is the stricter of the two (features, never-look lists, "confirm
every action", grants, the rate limit, commands, the desktop, console consent, the grace, allowed models). Ember reads
the remote's policy before it copies anything, and the helper reads it again every 10 seconds. On the remote:

- a broken policy refuses Ember there ("build-01's Ember policy is broken, so Ember won't work there.");
- `features.ssh: false` refuses Ember there;
- `ssh.desktop: false` means no desktop for Ember; `ssh.requireConsoleConsent: true` asks the person at the screen;
- `commands.ssh` decides commands there (a policy without it turns them off, as on the PC);
- `provider` (the organisation's own model endpoint), or `models.allowed` without a model the PC uses, refuses
  Ember there: the remote's requirement can't be met by a PC that uses its own models.

The helper keeps its own audit log on the remote (`~/.local/state/ember-remote/<machine>/audit/`, files readable by
the user only; on Linux also copied to the system journal, with commands, titles and values as sizes only), kept for
the remote policy's `auditRetentionDays` (default 30; while the remote's policy can't be read nothing is pruned, as on
the PC). The PC never deletes or rewrites it, and removing Ember's
helper keeps it. A user-space install can't stop the remote account itself (or root there) from changing the helper:
the remote's policy binds an honest helper, and nothing from a remote can approve anything or run anything on the PC.

### 6.5 `ssh.allowedHosts`

Each pattern is matched against `user@hostname:port`, `hostname:port` and `hostname`, as the user's SSH settings
resolve them (`ssh -G`): `*` matches any run of characters, `?` one character, nothing else is special; host names
are compared without regard to case. Every jump host must match too. An empty list allows no computer. A computer
that doesn't match is refused before Ember connects: "Your organisation doesn't allow Ember to connect to build-01.",
and settings say "Your organisation lets Ember connect only to some computers."

### 6.6 Hardened remotes: fapolicyd, SELinux, noexec

Ember's helper runs from the user's home folder (`~/.local/share/ember-remote/runtime/<version>/bin/node` and
`~/.local/share/ember-remote/versions/<version>/ember-remote.cjs`). Before marking it installed, Ember checks that it
can run there. On a host where fapolicyd (DISA's RHEL 8 STIG requires it), a confined SELinux user or a `noexec` home
stops programs in home folders, Ember says so ("build-01's security software doesn't let programs from your home
folder run. Ask its administrator to allow Ember's helper there (with fapolicyd, by trusting its folders).") and does
nothing there. To allow it, trust those folders with the host's own tools (for fapolicyd, add them
to its trust database with `fapolicyd-cli --file add <folder>`, then `fapolicyd-cli --update`), and again after an
Ember update replaces them. These files sit in the user's own home folder, so the user can change them after you trust
them: with fapolicyd, set its `integrity` option to `sha256` (or `ima`) so that a changed file is no longer trusted.
build-01 checks every file against Ember's SHA-256 list only when it is installed. A root-owned remote package is
planned.

### 6.7 What is recorded

The audit log gains command, connection and WSL entries: what was decided for each command (its classes, the rule, and
that the user requested it when it ran on an announcement), each answer, start and end (exit code, duration, how much
output, how many lines the user typed, never what), the folder, and connections and their losses. A command's text is
recorded with secrets hidden as in §2.7 (at most 2000 characters, and sizes only in the system journal), and so are the
AI review's own words for why it cleared one (they can name the file and what you asked); a refused command's text
isn't recorded at all. What the user types into a command, and every SSH password, passphrase or code,
are never recorded anywhere. Settings › **What Ember did** shows a line for each command question, answer, refusal and
end (where it ran, the shell and how it ended, never the command's text) and for each connection made, lost, ended or
failed. A reconnect's tries make one line, when it stops trying; the audit log keeps each try.

## 7. Known limits

Each item says what Ember can't do in this release and what happens instead.

| # | Limit | What happens instead |
|---|---|---|
| L1 | No new consent page for existing users | A first-use card for WSL, for each SSH computer and for commands on each computer; nothing new happens until it is accepted |
| L2 | Ember can't tell when a program has turned off echo for a password | Everything you type into a command is cut out of what Copilot gets, and so is the output after a password-like prompt until the program's next line after you press Enter (to the end of a command that can't take typing). It may hide a little more than needed |
| L3 | Windows commands can't take typing; only Windows PowerShell 5.1 | Programs run non-interactively and fail instead of waiting; cmd runs inside PowerShell; Stop ends everything at once |
| L4 | No borrowed mouse and no view of a remote screen | Every step there is asked; Ember reads, uses controls and opens apps only |
| L5 | Wayland remotes: no screenshots, no mouse or keyboard | Reading and controls only; commands only until Ember's Wayland test passes |
| L6 | No desktop on Mac remotes; no Windows remotes | Commands only on a Mac (protected folders need full disk access for remote users); Windows remotes refused with a message |
| L7 | No mouse or keyboard in WSLg Linux apps; X servers' Linux apps unusable | Ember uses their controls; X-server windows and unidentified ones are refused and blacked out |
| L8 | Ember judges the command line and the shell scripts it can read (up to 64 KB, read on the computer that runs them; over SSH by that computer's helper), not what a build file, a program or a script in another language does inside | Those run as ordinary unless their name says publish, delete, install and the like; a shell script Ember can read but not follow in full (`case`, functions, `trap`, `{ … }` groups, a `[[` with arithmetic, a variable in a file name, more than 64 commands or 8,000 characters, zsh's, PowerShell's or cmd's `if` and `for`) asks, which most real scripts do; a shell script this task downloaded always asks, one it wrote asks when it can't be read in full, and other scripts too big to read keep the name rule. Writes Ember can't see (`uudecode`, `split`, `base64 -o` on a Mac, a program that generates a script such as `python gen.py`) don't make a script the task's own, so its size alone doesn't ask; over SSH, the helper forgets what a task wrote or downloaded when it restarts on a reconnect, so a padded script written before the reconnect runs unread after it |
| L9 | No shell profile | Aliases and tools set up in rc files are missing; use full paths; Homebrew is added on macOS |
| L10 | Stop can miss programs that leave on purpose; over SSH a command outlives a silent link by up to 20 s | Ember asks before the forms it recognises (`nohup`, `setsid`, `&`, `docker run -d`…), not before a program that detaches by itself, and names stragglers; the administrator can lower the grace to 3 s; after an Ember crash, a command on this computer (Linux or macOS) runs on until it writes output or ends (`script` from util-linux 2.39 on doesn't end it when Ember goes), and Linux programs of a WSL command until they write output or the distro stops; a Windows command ends with Ember |
| L11 | Another always-on-top window could cover the command card | The approve chord works only while the card says the whole command is in view; on Windows and macOS the card can't be captured (L27) |
| L12 | The remote account (and root there) can lie to Ember's helper or change it | Nothing from a remote can approve anything or run anything on the PC; its words are shown as untrusted |
| L14 | Other programs of yours on the PC can reach Ember's SSH password channel, a shared SSH connection and a running command's text | They could already use your keys and SSH agent |
| L15 | Ember's SSH password window needs Win32-OpenSSH 8.4+ on a Windows PC | Keys and the ssh-agent only; accept a new host key once with `ssh build-01` |
| L16 | Remote screenshots travel as PNG | Slower on slow links; still masked on the remote before they leave it |
| L17 | No remote desktop as root, no Linux apps of a root distro | Every command there asks |
| L18 | Interactive full-screen programs (vim, less, top, a REPL) | Ember asks, and you use them yourself in the command window |
| L19 | Commands in WSL can reach Windows files and programs | Judged like any command; the card says "This can reach your Windows files." |
| L20 | One computer per task | Text read on one computer and typed on another is always asked about |
| L21 | VNC and xrdp desktops on remotes aren't used | Commands only there |
| L22 | `ssh` in a WSL tab: connecting through the distro only once proven | Otherwise the offer says how to connect from Windows; through a distro, keys and agent only |
| L23 | A remote that is WSL on another PC: no desktop | Commands only |
| L24 | Hardened remotes (fapolicyd, confined SELinux users, `noexec` homes) | Ember says the administrator must trust its helper (§6.6) |
| L25 | A link changed between Ember's check and the run | Paths are judged on their real target too (`..` after a link included: `sh sub/../t.sh` reads the t.sh the computer really runs), so links into secret folders ask; a script named with `..` that the computer can't resolve asks |
| L26 | Output can steer the model in ways rules can't see | Instruction-like output makes every later command in the task ask; dangerous commands always show the whole command |
| L27 | On Windows and macOS, tools that work by capturing the screen can't show the command window or Ember's small cards (host key, password, consent) | They are left out of screen captures there, so no other app records a command's output or a card: TeamViewer, AnyDesk, Quick Assist, VNC and magnifiers that capture the screen show a blank space where they are. Remote Desktop shows them, and so may Mac apps built on ScreenCaptureKit. Approve commands and type passwords at the computer itself, or over Remote Desktop |

(L13 is a rule for Ember's code, in [DEVELOPING.md](DEVELOPING.md) §14.3.)
