"""Extract only the signed, fixed Node source archive's libuv tree for a host-owned C probe.

This is an asset preparer, not a project filesystem or a Windows containment boundary. It never executes archive
members, restores archive permissions, follows links, extracts other Node content, or accepts caller-supplied pins.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import tarfile


class SourceError(Exception):
    pass


def _fail(stage):
    raise SourceError(stage)


def _safe_relative(name):
    if not isinstance(name, str) or not name or len(name) > 240 or "\\" in name:
        _fail("path")
    parts = name.split("/")
    for part in parts:
        if (not part or part in (".", "..") or part.endswith((".", " ")) or
                any(ord(c) < 32 or ord(c) > 126 or c in ':<>"|?*' for c in part) or
                re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)):
            _fail("path")
    return parts


def _identity(info):
    return info.st_dev, info.st_ino


def _ordinary(info, directory=False):
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        _fail("destination")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            _fail("destination")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        _fail("entry")


def _ancestors(directory):
    target = pathlib.Path(directory)
    if not target.is_absolute() or os.path.normpath(str(target)) != str(target):
        _fail("destination")
    for ancestor in reversed((target, *target.parents)):
        try:
            _ordinary(os.lstat(ancestor), directory=True)
        except OSError:
            _fail("destination")


def _fresh_directory(destination):
    target = pathlib.Path(destination)
    _ancestors(target.parent)
    try:
        os.mkdir(target, 0o700)
    except OSError:
        _fail("destination")
    observed = os.lstat(target)
    _ordinary(observed, directory=True)
    return _identity(observed)


def _extract_members(archive, destination, expected_files, expected_directories, limits, prefix):
    """Pure selection/extraction helper; tests may supply synthetic tar members. The CLI always uses its fixed pin."""
    target = pathlib.Path(destination)
    expected = {entry["path"]: entry for entry in expected_files}
    if len(expected) != len(expected_files):
        _fail("manifest")
    for name in [*expected, *expected_directories]:
        _safe_relative(name)
    files, directories, seen = {}, set(), set()
    selected_bytes = 0
    for index, member in enumerate(archive):
        if index >= limits["archiveEntries"]:
            _fail("limits")
        if member.name == prefix.rstrip("/"):
            if not member.isdir():
                _fail("entry")
            key = ""
        elif member.name.startswith(prefix):
            key = member.name[len(prefix):]
            _safe_relative(key)
        else:
            continue
        folded = key.lower()
        if folded in seen:
            _fail("entry")
        seen.add(folded)
        if (member.mode & 0o7000 or member.linkname or member.issparse() or
                member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)):
            _fail("entry")
        if member.isdir():
            if key:
                directories.add(key)
            continue
        if not isinstance(member.size, int) or member.size < 0 or member.size > limits["fileBytes"]:
            _fail("limits")
        selected_bytes += member.size
        if selected_bytes > limits["selectedBytes"] or len(files) >= limits["files"]:
            _fail("limits")
        files[key] = member
    if set(files) != set(expected) or directories != set(expected_directories):
        _fail("manifest")
    for name, member in files.items():
        if member.size != expected[name]["bytes"]:
            _fail("manifest")
    root_id = _fresh_directory(target)

    def current():
        _ancestors(target)
        if _identity(os.lstat(target)) != root_id:
            _fail("destination")

    # No tarfile.extract/extractall: create only fresh ordinary members from validated relative components.
    for name in sorted(directories, key=lambda value: (value.count("/"), value)):
        current()
        directory = target.joinpath(*_safe_relative(name))
        _ancestors(directory.parent)
        try:
            os.mkdir(directory, 0o700)
        except OSError:
            _fail("destination")
    records = []
    for name in sorted(files):
        current()
        output = target.joinpath(*_safe_relative(name))
        _ancestors(output.parent)
        member = files[name]
        digest, written = hashlib.sha256(), 0
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        try:
            fd = os.open(output, flags, 0o600)
            with os.fdopen(fd, "wb") as writer, archive.extractfile(member) as reader:
                created = os.fstat(writer.fileno())
                _ordinary(created)
                while True:
                    data = reader.read(min(65536, member.size + 1 - written))
                    if not data:
                        break
                    written += len(data)
                    if written > member.size:
                        _fail("entry")
                    digest.update(data)
                    writer.write(data)
                writer.flush()
                after = os.fstat(writer.fileno())
                _ordinary(after)
                if _identity(created) != _identity(after) or after.st_size != written:
                    _fail("entry")
            current()
            path_info = os.lstat(output)
            _ordinary(path_info)
            if _identity(path_info) != _identity(created):
                _fail("entry")
        except (OSError, AttributeError, tarfile.TarError):
            _fail("write")
        value = digest.hexdigest()
        if written != expected[name]["bytes"] or value != expected[name]["sha256"]:
            _fail("manifest")
        records.append({"path": name, "bytes": written, "sha256": value})
    current()
    return records


def extract_verified_archive(archive_path, destination):
    pin_path = pathlib.Path(__file__).with_name("windows-libuv-source-pin.json")
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    source = pathlib.Path(archive_path)
    _ancestors(source.parent)
    try:
        before = os.lstat(source)
        _ordinary(before)
        if before.st_size != pin["sourceArchive"]["bytes"]:
            _fail("archive")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(source, flags), "rb") as handle:
            opened = os.fstat(handle.fileno())
            _ordinary(opened)
            if _identity(before) != _identity(opened):
                _fail("archive")
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
            if digest != pin["sourceArchive"]["sha256"]:
                _fail("archive")
            handle.seek(0)
            with tarfile.open(fileobj=handle, mode="r:xz") as archive:
                records = _extract_members(archive, destination, pin["files"], pin["directories"],
                                           pin["limits"], pin["sourceArchive"]["extractPrefix"])
            after = os.fstat(handle.fileno())
            _ordinary(after)
            if (_identity(opened) != _identity(after) or opened.st_size != after.st_size or
                    opened.st_mtime_ns != after.st_mtime_ns or opened.st_ctime_ns != after.st_ctime_ns):
                _fail("archive")
        return {"schema": 1, "issuer": pin["issuer"], "files": len(records), "bytes": sum(x["bytes"] for x in records)}
    except (OSError, ValueError, KeyError, tarfile.TarError):
        _fail("archive")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            _fail("arguments")
        print(json.dumps(extract_verified_archive(sys.argv[1], sys.argv[2]), separators=(",", ":")))
    except SourceError as error:
        print(json.dumps({"ok": False, "stage": str(error)}, separators=(",", ":")))
        sys.exit(1)
    except Exception:
        print('{"ok":false,"stage":"extractor"}')
        sys.exit(1)
