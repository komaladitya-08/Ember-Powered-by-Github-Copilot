"""Read only two attested tool versions through the fixed Windows VERSION APIs, after a public resource-only PE fixture gate.

Usage: python -I -B windows-uv-spawn-file-version.py --compiler <cl.exe> --linker <link.exe>
Python syntax and ordinary helpers remain 3.6 compatible. Only the attested Windows 3.12 host uses WinDLL(winmode=...).
"""
import ctypes
import json
import os
import re
import stat
import struct
import sys
import tempfile


MAX_INFO_BYTES = 1024 * 1024
MAX_TRANSLATIONS = 256
MAX_STRING_UNITS = 28
FALLBACKS = (0x040904B0, 0x040904E4, 0x04090000)
SIGNATURE = 0xFEEF04BD


class VersionRefusal(Exception):
    pass


def _fail(stage):
    raise VersionRefusal(stage)


def _integer(value, minimum, maximum):
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _check_windows_abi():
    if (ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ctypes.c_wchar) != 2 or
            ctypes.sizeof(ctypes.c_uint32) != 4 or ctypes.sizeof(ctypes.c_int) != 4):
        _fail(4)


def _ordinary(info, directory=False, sole_link=True):
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        return False
    if directory:
        return stat.S_ISDIR(info.st_mode)
    return stat.S_ISREG(info.st_mode) and info.st_nlink >= 1 and (not sole_link or info.st_nlink == 1)


def _identity(info):
    # Compare lstat with lstat, avoiding Windows' differing stat/fstat creation-time representations.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def _validated_path(value, directory=False, sole_link=True, stage=7):
    try:
        if (not isinstance(value, str) or not value or len(value) > 240 or not os.path.isabs(value) or
                os.path.normpath(value) != value or any(ord(c) < 32 or ord(c) > 126 for c in value)):
            _fail(stage)
        if os.name == "nt" and (not re.fullmatch(r"[A-Za-z]:", os.path.splitdrive(value)[0]) or value.startswith("\\\\")):
            _fail(stage)
        chain = []
        parent = value if directory else os.path.dirname(value)
        while True:
            chain.append(parent)
            next_parent = os.path.dirname(parent)
            if next_parent == parent:
                break
            parent = next_parent
        for parent in reversed(chain):
            if not _ordinary(os.lstat(parent), directory=True):
                _fail(stage)
        info = os.lstat(value)
        if not _ordinary(info, directory=directory, sole_link=sole_link) or os.path.normcase(os.path.realpath(value)) != os.path.normcase(value):
            _fail(stage)
        return _identity(info)
    except VersionRefusal:
        raise
    except BaseException:
        _fail(stage)


def _query(api, buffer, name, stage):
    try:
        value = api.query(buffer, name)
        if not isinstance(value, tuple) or len(value) != 3 or type(value[0]) is not bool:
            _fail(stage)
        return value
    except VersionRefusal:
        raise
    except BaseException:
        _fail(stage)


def _copy(buffer, size, pointer, length, alignment, stage):
    base = ctypes.addressof(buffer)
    if (not _integer(size, 1, MAX_INFO_BYTES) or ctypes.sizeof(buffer) != size or not _integer(pointer, 1, (1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1) or
            not _integer(length, 1, size) or pointer % alignment or pointer < base or pointer - base > size - length):
        _fail(stage)
    return ctypes.string_at(pointer, length)


def _framework_translation(first_pair):
    # ReferenceSource uses two signed Marshal.ReadInt16 values, addition, then uppercase eight-digit two's-complement hex.
    language, codepage = struct.unpack("<hh", first_pair)
    return ((language << 16) + codepage) & 0xffffffff


def _version_string(api, buffer, size, key):
    # Mirror ReferenceSource's doubled runtime separators rather than assuming undocumented normalization.
    ok, pointer, units = _query(api, buffer, r"\\StringFileInfo\\%08X\\FileVersion" % key, 12)
    if not ok:
        return None
    if not _integer(units, 1, MAX_STRING_UNITS):
        _fail(12)
    raw = _copy(buffer, size, pointer, units * 2, 2, 12)
    try:
        text = raw.decode("utf-16le")
    except UnicodeError:
        _fail(12)
    if not text.endswith("\0") or "\0" in text[:-1]:
        _fail(12)
    return text[:-1] or None


def parse_version_block(api, buffer, size):
    """Pure API-injected parser. Production passes only its own allocated buffer and fixed VERSION adapter."""
    ok, pointer, length = _query(api, buffer, "\\", 10)
    if not ok or length != 52:
        _fail(10)
    fixed = struct.unpack("<13I", _copy(buffer, size, pointer, 52, 4, 10))
    if fixed[0] != SIGNATURE or fixed[1] != 0x10000:
        _fail(10)
    words = (fixed[2] >> 16, fixed[2] & 0xffff, fixed[3] >> 16, fixed[3] & 0xffff)
    ok, pointer, length = _query(api, buffer, "\\VarFileInfo\\Translation", 11)
    declared = []
    if ok:
        if not _integer(length, 4, MAX_TRANSLATIONS * 4) or length % 4:
            _fail(11)
        translations = _copy(buffer, size, pointer, length, 4, 11)
        initial = _framework_translation(translations[:4])
        for offset in range(0, length, 4):
            language, codepage = struct.unpack("<HH", translations[offset:offset + 4])
            declared.append((language << 16) | codepage)
    else:
        initial = 0x040904E4
    reachable = [initial] + [key for key in FALLBACKS if key != initial]
    queried = {}
    for key in declared + reachable:
        if key not in queried:
            queried[key] = _version_string(api, buffer, size, key)
    winner = next((key for key in reachable if queried[key] is not None), None)
    if winner is None:
        _fail(13)
    literal = queried[winner]
    for text in queried.values():
        if text is None:
            continue
        if text != literal or re.fullmatch(r"[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}", text) is None:
            _fail(13)
        components = tuple(int(part) for part in text.split("."))
        if components != words[:len(components)] or len(components) == 3 and words[3] != 0:
            _fail(13)
    return literal, winner


class WindowsVersionApi:
    def __init__(self, system_root):
        if os.name != "nt":
            _fail(2)
        _check_windows_abi()
        _validated_path(system_root, directory=True, stage=3)
        self.path = os.path.join(system_root, "System32", "version.dll")
        # Windows components may have legitimate WinSxS hard links; aliases/reparse points stay refused.
        self.identity = _validated_path(self.path, sole_link=False, stage=4)
        try:
            self.library = ctypes.WinDLL(self.path, winmode=0x00000800)
            self.size_fn = self.library.GetFileVersionInfoSizeW
            self.size_fn.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32)]
            self.size_fn.restype = ctypes.c_uint32
            self.info_fn = self.library.GetFileVersionInfoW
            self.info_fn.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
            self.info_fn.restype = ctypes.c_int
            self.query_fn = self.library.VerQueryValueW
            self.query_fn.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32)]
            self.query_fn.restype = ctypes.c_int
        except BaseException:
            _fail(4)

    def get_size(self, name):
        ignored = ctypes.c_uint32(0)
        return int(self.size_fn(name, ctypes.byref(ignored)))

    def fill(self, name, size, buffer):
        return bool(self.info_fn(name, 0, size, ctypes.addressof(buffer)))

    def query(self, buffer, name):
        pointer = ctypes.c_void_p()
        length = ctypes.c_uint32()
        ok = bool(self.query_fn(ctypes.addressof(buffer), name, ctypes.byref(pointer), ctypes.byref(length)))
        return (True, pointer.value, length.value) if ok else (False, 0, 0)

    def check_identity(self):
        if self.identity != _validated_path(self.path, sole_link=False, stage=14):
            _fail(14)


def read_file_version(path, api):
    before = _validated_path(path)
    try:
        size = api.get_size(path)
    except BaseException:
        _fail(8)
    if not _integer(size, 1, MAX_INFO_BYTES):
        _fail(8)
    buffer = ctypes.create_string_buffer(size)
    try:
        filled = api.fill(path, size, buffer)
    except BaseException:
        _fail(9)
    if filled is not True:
        _fail(9)
    result = parse_version_block(api, buffer, size)
    if before != _validated_path(path, stage=14):
        _fail(14)
    return result


def _resource_block(key, value=b"", value_type=1, children=()):
    encoded = key.encode("utf-16le") + b"\0\0"
    data = bytearray(b"\0" * 6 + encoded)
    data.extend(b"\0" * (-len(data) % 4))
    data.extend(value)
    for child in children:
        data.extend(b"\0" * (-len(data) % 4))
        data.extend(child)
    struct.pack_into("<HHH", data, 0, len(data), len(value) // 2 if value_type else len(value), value_type)
    return bytes(data)


def fixture_pe(literal, words, tables, translations):
    """Fixed public resource-only PE: no entry, imports or code; .rsrc is READ and never executable."""
    fixed = struct.pack("<13I", SIGNATURE, 0x10000, (words[0] << 16) | words[1], (words[2] << 16) | words[3], 0, 0, 0x3f, 0, 0x40004, 2, 0, 0, 0)
    strings = [_resource_block("%08X" % key, children=(_resource_block("FileVersion", literal.encode("utf-16le") + b"\0\0"),)) for key in tables]
    children = [_resource_block("StringFileInfo", children=strings)]
    if translations is not None:
        value = b"".join(struct.pack("<HH", language, codepage) for language, codepage in translations)
        children.append(_resource_block("VarFileInfo", children=(_resource_block("Translation", value, 0),)))
    resource = _resource_block("VS_VERSION_INFO", fixed, 0, children)
    rsrc = bytearray(88)
    for directory, entry, key, target in ((0, 16, 16, 0x80000018), (24, 40, 1, 0x80000030), (48, 64, 0x0409, 72)):
        struct.pack_into("<IIHHHH", rsrc, directory, 0, 0, 0, 0, 0, 1)
        struct.pack_into("<II", rsrc, entry, key, target)
    struct.pack_into("<IIII", rsrc, 72, 0x1000 + 88, len(resource), 0, 0)
    rsrc.extend(resource)
    raw_size = (len(rsrc) + 511) // 512 * 512
    image = bytearray(512 + raw_size)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3c, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", image, 0x84, 0x8664, 1, 0, 0, 0, 240, 0x2022)
    optional = 0x98
    struct.pack_into("<H", image, optional, 0x20b)
    struct.pack_into("<I", image, optional + 8, raw_size)
    struct.pack_into("<Q", image, optional + 24, 0x180000000)
    struct.pack_into("<II", image, optional + 32, 0x1000, 512)
    struct.pack_into("<HH", image, optional + 40, 6, 2)
    struct.pack_into("<HH", image, optional + 48, 6, 2)
    struct.pack_into("<II", image, optional + 56, 0x2000, 512)
    struct.pack_into("<HH", image, optional + 68, 3, 0x100)
    struct.pack_into("<QQQQ", image, optional + 72, 0x100000, 0x1000, 0x100000, 0x1000)
    struct.pack_into("<I", image, optional + 108, 16)
    struct.pack_into("<II", image, optional + 112 + 2 * 8, 0x1000, len(rsrc))
    section = optional + 240
    image[section:section + 8] = b".rsrc\0\0\0"
    struct.pack_into("<IIII", image, section + 8, len(rsrc), 0x1000, raw_size, 512)
    struct.pack_into("<I", image, section + 36, 0x40000040)
    image[512:512 + len(rsrc)] = rsrc
    return bytes(image)


def _write_fixture(path, data):
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags, 0o600), "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _validated_path(path, stage=5)
    except BaseException:
        _fail(5)


def ordinary_fixture_gate(api):
    cwd = os.getcwd()
    _validated_path(cwd, directory=True, stage=5)
    try:
        directory = tempfile.mkdtemp(prefix="ember-fixed-version-", dir=cwd)
        _validated_path(directory, directory=True, stage=5)
    except BaseException:
        _fail(5)
    cases = (("four.bin", "1.2.3.0", (1, 2, 3, 0), (0x041104B0, 0x040904B0), ((0x040c, 0x04b0), (0x0411, 0x04b0)), 0x040904B0),
             ("three.bin", "4.5.6", (4, 5, 6, 0), (0x040904B0, 0x040904E4), None, 0x040904E4))
    for name, literal, words, tables, translations, winner in cases:
        path = os.path.join(directory, name)
        _write_fixture(path, fixture_pe(literal, words, tables, translations))
        try:
            if read_file_version(path, api) != (literal, winner):
                _fail(6)
        except BaseException:
            _fail(6)


def run(arguments):
    if len(arguments) != 4 or arguments[0] != "--compiler" or arguments[2] != "--linker":
        _fail(1)
    if os.name != "nt":
        _fail(2)
    compiler, linker = arguments[1], arguments[3]
    if os.path.basename(compiler).lower() != "cl.exe" or os.path.basename(linker).lower() != "link.exe":
        _fail(7)
    _validated_path(compiler)
    _validated_path(linker)
    api = WindowsVersionApi(os.environ.get("SystemRoot"))
    ordinary_fixture_gate(api)
    compiler_version, unused = read_file_version(compiler, api)
    linker_version, unused = read_file_version(linker, api)
    api.check_identity()
    return {"compilerVersion": compiler_version, "linkerVersion": linker_version}


def main():
    code = 0
    try:
        value = run(sys.argv[1:])
        payload = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        if len(payload) > 256:
            _fail(15)
    except VersionRefusal as error:
        code = 1
        stage = error.args[0] if len(error.args) == 1 and _integer(error.args[0], 0, 15) else 0
        payload = json.dumps({"schema": 1, "status": "failed", "stage": stage}, separators=(",", ":"))
    except BaseException:
        code = 1
        payload = '{"schema":1,"status":"failed","stage":0}'
    try:
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()
    except BaseException:
        return 1
    return code


if __name__ == "__main__":
    sys.exit(main())
