"""Bounded, host-only preparation of the fixed signed Node source for an experimental build.

Only the original archive is admitted. No project input, downloads, build commands, execution or caller pins exist.
Baseline files are never build inputs in place. Working validation permits generated extras without visiting them;
all original files and their ancestors still need the authenticated catalog and complete-content verification.
The syntax and standard-library interfaces deliberately remain compatible with Python 3.6.
"""
import hashlib
import contextlib
import json
import os
import pathlib
import re
import stat
import sys
import tarfile
import zipfile


class SourceError(Exception):
    pass


def _fail(stage):
    raise SourceError(stage)


def _pin():
    with pathlib.Path(__file__).with_name("windows-node-source-pin.json").open(encoding="utf-8") as stream:
        return json.load(stream)


def _safe_relative(name, pin):
    if not isinstance(name, str) or not name or len(name) > pin["limits"]["pathChars"] or "\\" in name:
        _fail("path")
    unicode_allowed = name in pin["unicodePaths"]
    parts = name.split("/")
    for part in parts:
        if (not part or part in (".", "..") or part.endswith((".", " ")) or
                any(ord(c) < 32 or (ord(c) > 126 and not unicode_allowed) or c in ':<>"|?*' for c in part) or
                re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)):
            _fail("path")
    return parts


def _identity(info):
    return info.st_dev, info.st_ino


def _ordinary(info, directory=False):
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        _fail("alias")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            _fail("directory")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        _fail("entry")


def _ancestors(directory):
    target = pathlib.Path(directory)
    if not target.is_absolute() or os.path.normpath(str(target)) != str(target):
        _fail("path")
    for ancestor in reversed((target,) + tuple(target.parents)):
        try:
            _ordinary(os.lstat(str(ancestor)), directory=True)
        except OSError:
            _fail("directory")


def _fresh_directory(destination):
    target = pathlib.Path(destination)
    _ancestors(target.parent)
    try:
        os.mkdir(str(target), 0o700)
    except OSError:
        _fail("destination")
    info = os.lstat(str(target))
    _ordinary(info, directory=True)
    return _identity(info)


def _file_manifest(files):
    digest = hashlib.sha256()
    for entry in files:
        digest.update(("{} {} {}\n".format(entry["sha256"], entry["bytes"], entry["path"])).encode("utf-8"))
    return digest.hexdigest()


def _directory_manifest(directories):
    return hashlib.sha256("".join(value + "\n" for value in directories).encode("utf-8")).hexdigest()


def _validate_catalog(catalog, pin):
    if (not isinstance(catalog, dict) or set(catalog) != {"schema", "issuer", "version", "files", "directories"} or
            catalog["schema"] != 1 or catalog["issuer"] != pin["issuer"] or catalog["version"] != pin["version"]):
        _fail("catalog")
    files, directories = catalog["files"], catalog["directories"]
    if (not isinstance(files, list) or not isinstance(directories, list) or len(files) != pin["inventory"]["files"] or
            len(directories) != pin["inventory"]["directories"]):
        _fail("catalog")
    seen, total, previous = set(), 0, None
    for entry in files:
        if (not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"} or
                type(entry["bytes"]) is not int or entry["bytes"] < 0 or entry["bytes"] > pin["limits"]["fileBytes"] or
                not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            _fail("catalog")
        name = entry["path"]
        _safe_relative(name, pin)
        if name.lower() in seen or previous is not None and name <= previous:
            _fail("catalog")
        seen.add(name.lower())
        previous, total = name, total + entry["bytes"]
    previous = None
    for name in directories:
        _safe_relative(name, pin)
        if name.lower() in seen or previous is not None and name <= previous:
            _fail("catalog")
        seen.add(name.lower())
        previous = name
    if (total != pin["inventory"]["stockBytes"] or _file_manifest(files) != pin["inventory"]["stockManifestSha256"] or
            _directory_manifest(directories) != pin["inventory"]["directoryManifestSha256"]):
        _fail("catalog")
    records = dict((entry["path"], entry) for entry in files)
    for name, patch in _patches(pin).items():
        if name not in records or records[name]["bytes"] != patch["beforeBytes"] or records[name]["sha256"] != patch["beforeSha256"]:
            _fail("patch")
    known_directories = set(directories)
    for name in [entry["path"] for entry in files] + directories:
        components = name.split("/")
        for end in range(1, len(components)):
            if "/".join(components[:end]) not in known_directories:
                _fail("catalog")
    return files, directories


def _hash_file(file_path, expected_size, expected_hash=None, include_bytes=False):
    source = pathlib.Path(file_path)
    _ancestors(source.parent)
    before = os.lstat(str(source))
    _ordinary(before)
    if before.st_size != expected_size:
        _fail("content")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(str(source), flags), "rb") as handle:
        opened = os.fstat(handle.fileno())
        _ordinary(opened)
        if _identity(opened) != _identity(before) or opened.st_size != expected_size:
            _fail("content")
        digest, length, chunks = hashlib.sha256(), 0, []
        while True:
            chunk = handle.read(min(1024 * 1024, expected_size + 1 - length))
            if not chunk:
                break
            length += len(chunk)
            if length > expected_size:
                _fail("content")
            digest.update(chunk)
            if include_bytes:
                chunks.append(chunk)
        after, named = os.fstat(handle.fileno()), os.lstat(str(source))
        _ordinary(after)
        _ordinary(named)
        if (_identity(after) != _identity(opened) or _identity(named) != _identity(opened) or
                after.st_size != expected_size or opened.st_mtime_ns != after.st_mtime_ns or
                opened.st_ctime_ns != after.st_ctime_ns or length != expected_size):
            _fail("content")
        value = digest.hexdigest()
        if expected_hash is not None and value != expected_hash:
            _fail("content")
        return b"".join(chunks) if include_bytes else value


def _patches(pin):
    patches = pin.get("patches")
    expected = ["deps/uv/src/win/core.c",
                "deps/openssl/openssl/providers/implementations/rands/seeding/rand_win.c",
                "deps/uv/src/win/pipe.c"]
    if (not isinstance(patches, list) or len(patches) != 3 or
            pin.get("patch") != patches[0] or [entry["file"] for entry in patches] != expected):
        _fail("patch")
    return dict((entry["file"], entry) for entry in patches)


def _patched_source(data, patch):
    if len(data) != patch["beforeBytes"] or hashlib.sha256(data).hexdigest() != patch["beforeSha256"]:
        _fail("patch")
    needle, replacement = patch["needle"].encode("utf-8"), patch["replacement"].encode("utf-8")
    if data.count(needle) != 1:
        _fail("patch")
    result = data.replace(needle, replacement)
    if len(result) != patch["afterBytes"] or hashlib.sha256(result).hexdigest() != patch["afterSha256"]:
        _fail("patch")
    return result


def _select_members(archive, pin):
    prefix = pin["sourceArchive"]["extractPrefix"]
    files, directories, seen, total, count = {}, set(), set(), 0, 0
    for member in archive:
        count += 1
        if count > pin["limits"]["archiveEntries"]:
            _fail("limits")
        if member.name == prefix.rstrip("/"):
            key = ""
            if not member.isdir():
                _fail("entry")
        elif member.name.startswith(prefix):
            key = member.name[len(prefix):]
            _safe_relative(key, pin)
        else:
            _fail("path")
        if key.lower() in seen:
            _fail("alias")
        seen.add(key.lower())
        if (member.mode & 0o7000 or member.linkname or member.issparse() or
                member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)):
            _fail("entry")
        if member.isdir():
            if key:
                directories.add(key)
            if len(directories) > pin["limits"]["directories"]:
                _fail("limits")
        else:
            if type(member.size) is not int or member.size < 0 or member.size > pin["limits"]["fileBytes"]:
                _fail("limits")
            total += member.size
            files[key] = member
            if total > pin["limits"]["selectedBytes"] or len(files) > pin["limits"]["files"]:
                _fail("limits")
    if (count != pin["inventory"]["entries"] or len(files) != pin["inventory"]["files"] or
            len(directories) != pin["inventory"]["directories"] or total != pin["inventory"]["stockBytes"] or
            _directory_manifest(sorted(directories)) != pin["inventory"]["directoryManifestSha256"]):
        _fail("inventory")
    return files, sorted(directories)


def _extract_members(archive, destination, pin):
    files, directories = _select_members(archive, pin)
    target = pathlib.Path(destination)
    baseline, working = target / "baseline", target / "working"
    roots = [(baseline, _fresh_directory(baseline)), (working, _fresh_directory(working))]

    def current():
        for root, expected in roots:
            _ancestors(root)
            if _identity(os.lstat(str(root))) != expected:
                _fail("destination")

    for directory in sorted(directories, key=lambda name: (name.count("/"), name)):
        for root, _ in roots:
            current()
            full = root.joinpath(*_safe_relative(directory, pin))
            _ancestors(full.parent)
            os.mkdir(str(full), 0o700)
    records, patches = [], _patches(pin)
    # Preserve archive order while reading xz data; canonicalize the finished catalog separately.
    for name, member in files.items():
        current()
        with archive.extractfile(member) as reader:
            data = reader.read(member.size + 1)
        if len(data) != member.size:
            _fail("entry")
        records.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        for root, _ in roots:
            full = root.joinpath(*_safe_relative(name, pin))
            _ancestors(full.parent)
            content = _patched_source(data, patches[name]) if root == working and name in patches else data
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            with os.fdopen(os.open(str(full), flags, 0o600), "wb") as writer:
                opened = os.fstat(writer.fileno())
                _ordinary(opened)
                writer.write(content)
                writer.flush()
                after = os.fstat(writer.fileno())
                _ordinary(after)
                if _identity(opened) != _identity(after) or after.st_size != len(content):
                    _fail("write")
            named = os.lstat(str(full))
            _ordinary(named)
            if _identity(named) != _identity(opened):
                _fail("write")
            if root == baseline:
                os.chmod(str(full), 0o444)
    records.sort(key=lambda entry: entry["path"])
    current()
    catalog = {"schema": 1, "issuer": pin["issuer"], "version": pin["version"], "files": records, "directories": directories}
    _validate_catalog(catalog, pin)
    payload = (json.dumps(catalog, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(payload) > pin["limits"]["catalogBytes"]:
        _fail("limits")
    with (target / "source-inputs.json").open("xb") as stream:
        stream.write(payload)
    return catalog


@contextlib.contextmanager
def _verified_archive(archive_path, asset):
    source = pathlib.Path(archive_path)
    _ancestors(source.parent)
    before = os.lstat(str(source))
    _ordinary(before)
    if before.st_size != asset["bytes"]:
        _fail("archive")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(str(source), flags), "rb") as handle:
        opened = os.fstat(handle.fileno())
        _ordinary(opened)
        if _identity(opened) != _identity(before):
            _fail("archive")
        digest, length = hashlib.sha256(), 0
        while True:
            chunk = handle.read(min(1024 * 1024, asset["bytes"] + 1 - length))
            if not chunk:
                break
            length += len(chunk)
            if length > asset["bytes"]:
                _fail("archive")
            digest.update(chunk)
        if length != asset["bytes"] or digest.hexdigest() != asset["sha256"]:
            _fail("archive")
        handle.seek(0)
        yield handle
        after, named = os.fstat(handle.fileno()), os.lstat(str(source))
        _ordinary(after)
        _ordinary(named)
        if (_identity(after) != _identity(opened) or after.st_size != opened.st_size or
                _identity(named) != _identity(opened) or
                after.st_mtime_ns != opened.st_mtime_ns or after.st_ctime_ns != opened.st_ctime_ns):
            _fail("archive")


def extract_verified_source(archive_path, destination):
    pin = _pin()
    with _verified_archive(archive_path, pin["sourceArchive"]) as handle:
        with tarfile.open(fileobj=handle, mode="r:xz") as archive:
            _extract_members(archive, destination, pin)
    baseline = validate_source_inputs(str(pathlib.Path(destination) / "baseline"), "stock", False)
    working = validate_source_inputs(str(pathlib.Path(destination) / "working"), "offline", False)
    return {"schema": 1, "issuer": pin["issuer"], "version": pin["version"], "baseline": baseline, "working": working}


def _check_exact_inventory(root, files, directories, pin):
    expected_files, expected_directories = set(entry["path"] for entry in files), set(directories)
    actual_files, actual_directories = set(), set()
    pending, count = [(root, "")], 0
    while pending:
        parent, prefix = pending.pop()
        _ancestors(parent)
        for child in os.listdir(str(parent)):
            count += 1
            if count >= pin["limits"]["archiveEntries"]:
                _fail("limits")
            name = prefix + "/" + child if prefix else child
            _safe_relative(name, pin)
            full = parent / child
            info = os.lstat(str(full))
            if stat.S_ISDIR(info.st_mode):
                _ordinary(info, directory=True)
                if name not in expected_directories:
                    _fail("inventory")
                actual_directories.add(name)
                pending.append((full, name))
            else:
                _ordinary(info)
                if name not in expected_files:
                    _fail("inventory")
                actual_files.add(name)
    if actual_files != expected_files or actual_directories != expected_directories:
        _fail("inventory")


def validate_source_inputs(root, variant, allow_generated):
    pin = _pin()
    if variant not in ("stock", "offline") or type(allow_generated) is not bool:
        _fail("arguments")
    root = pathlib.Path(root)
    if root.name not in ("baseline", "working") or allow_generated and (root.name != "working" or variant != "offline"):
        _fail("arguments")
    _ancestors(root)
    root_id = _identity(os.lstat(str(root)))
    catalog_path = root.parent / "source-inputs.json"
    catalog_size = os.lstat(str(catalog_path)).st_size
    if catalog_size > pin["limits"]["catalogBytes"]:
        _fail("limits")
    catalog = json.loads(_hash_file(catalog_path, catalog_size, include_bytes=True).decode("utf-8"))
    files, directories = _validate_catalog(catalog, pin)
    if not allow_generated:
        _check_exact_inventory(root, files, directories, pin)
    for name in directories:
        _ancestors(root.joinpath(*_safe_relative(name, pin)))
    observed, patches = [], _patches(pin)
    for entry in files:
        size, value = entry["bytes"], entry["sha256"]
        if variant == "offline" and entry["path"] in patches:
            patch = patches[entry["path"]]
            size, value = patch["afterBytes"], patch["afterSha256"]
        actual = _hash_file(root.joinpath(*_safe_relative(entry["path"], pin)), size, value)
        observed.append({"path": entry["path"], "bytes": size, "sha256": actual})
    _ancestors(root)
    expected = pin["inventory"]["stockManifestSha256" if variant == "stock" else "offlineManifestSha256"]
    if _identity(os.lstat(str(root))) != root_id or _file_manifest(observed) != expected:
        _fail("content")
    return {"variant": variant, "files": len(files), "directories": len(directories),
            "bytes": sum(entry["bytes"] for entry in observed), "manifestSha256": expected,
            "directoryManifestSha256": pin["inventory"]["directoryManifestSha256"], "allowGenerated": allow_generated,
            "directoriesExcludeArchiveRoot": True}


def _stage_nasm_members(archive, destination, pin):
    asset = pin["nasmTool"]
    expected = dict((entry["path"], entry) for entry in asset["files"])
    infos = archive.infolist()
    if len(infos) != len(expected) or len(infos) > 3:
        _fail("nasm-inventory")
    seen, content, total = set(), {}, 0
    for info in infos:
        if not info.filename.startswith(asset["extractPrefix"]):
            _fail("path")
        name = info.filename[len(asset["extractPrefix"]):]
        _safe_relative(name, pin)
        if name not in expected or name.lower() in seen:
            _fail("nasm-inventory")
        seen.add(name.lower())
        mode = info.external_attr >> 16
        if (info.flag_bits & 1 or info.is_dir() or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or
                stat.S_IFMT(mode) not in (0, stat.S_IFREG) or mode & 0o7000 or info.external_attr & 0x10):
            _fail("nasm-entry")
        entry = expected[name]
        if info.file_size != entry["bytes"] or info.file_size > 2 * 1024 * 1024 or info.compress_size > asset["bytes"]:
            _fail("limits")
        total += info.file_size
        if total > 3 * 1024 * 1024:
            _fail("limits")
        data = archive.read(info)
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            _fail("nasm-content")
        if entry["stage"]:
            content[name] = data
    if seen != set(name.lower() for name in expected):
        _fail("nasm-inventory")
    target = pathlib.Path(destination)
    root_id = _fresh_directory(target)
    for name, data in sorted(content.items()):
        _ancestors(target)
        if _identity(os.lstat(str(target))) != root_id:
            _fail("destination")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(str(target / name), flags, 0o600), "wb") as stream:
            stream.write(data)
        entry = expected[name]
        _hash_file(target / name, entry["bytes"], entry["sha256"])
    _ancestors(target)
    if _identity(os.lstat(str(target))) != root_id or set(os.listdir(str(target))) != set(content):
        _fail("destination")
    return {"schema": 1, "issuer": pin["issuer"], "tool": "nasm", "version": asset["version"],
            "archiveSha256": asset["sha256"], "files": [entry for entry in asset["files"] if entry["stage"]],
            "verifiedArchiveFiles": len(infos), "signatureVerified": False}


def prepare_nasm_tool(archive_path, destination):
    pin = _pin()
    with _verified_archive(archive_path, pin["nasmTool"]) as handle:
        with zipfile.ZipFile(handle, mode="r") as archive:
            return _stage_nasm_members(archive, destination, pin)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "extract":
            result = extract_verified_source(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 4 and sys.argv[1] == "nasm":
            result = prepare_nasm_tool(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 5 and sys.argv[1] == "validate" and sys.argv[4] in ("exact", "generated"):
            result = validate_source_inputs(sys.argv[2], sys.argv[3], sys.argv[4] == "generated")
        else:
            _fail("arguments")
        print(json.dumps(result, separators=(",", ":")))
    except SourceError as error:
        print(json.dumps({"ok": False, "stage": str(error)}, separators=(",", ":")))
        sys.exit(1)
    except Exception:
        print('{"ok":false,"stage":"source"}')
        sys.exit(1)
