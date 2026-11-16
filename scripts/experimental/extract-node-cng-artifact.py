#!/usr/bin/env python3
"""Fixed authenticated CNG-artifact ZIP boundary; Python3.6 stdlib, no download/launch.
Usage: python -I -B extract-node-cng-artifact.py <fixed-archive> <fresh-destination>
"""
import hashlib
import json
import os
import stat
import sys
import zipfile

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'windows-node-cng-artifact-pin.json'), 'r') as handle:
    PIN = json.load(handle)

DIAGNOSTIC = {'schema': 1, 'status': 'refused', 'stage': 0, 'entryCount': 0, 'acceptedMask': 0, 'entries': [], 'failure': 0, 'code': 0, 'identityMismatch': 0}
MEMBERS = {'source-node.exe': 1, 'bootstrap.exe': 2, 'build-receipt.json': 3, 'LICENSE': 4}


def at(stage):
    DIAGNOSTIC['stage'] = stage


def bounded(value, maximum):
    return min(max(value, 0), maximum)


def inventory(infos):
    DIAGNOSTIC['entryCount'] = min(len(infos), 65)
    for item in infos[:8]:
        mode = item.external_attr >> 16
        native_type = stat.S_IFMT(mode)
        kind = 0 if native_type == 0 else 1 if native_type == stat.S_IFREG else 2 if native_type == stat.S_IFDIR else 3 if native_type == stat.S_IFLNK else 4
        member = MEMBERS.get(item.filename, 0)
        if member:
            DIAGNOSTIC['acceptedMask'] |= 1 << (member - 1)
        DIAGNOSTIC['entries'].append({'member': member, 'kind': kind, 'mode': bounded(mode, 65535),
            'attributes': bounded(item.external_attr, 0xffffffff), 'compression': bounded(item.compress_type, 65535),
            'flags': bounded(item.flag_bits, 65535), 'bytes': bounded(item.file_size, PIN['maximumExpandedBytes'] + 1),
            'compressedBytes': bounded(item.compress_size, PIN['zipBytes'] + 1)})


def refusal(error):
    DIAGNOSTIC['failure'] = 3 if isinstance(error, zipfile.BadZipFile) else 5 if isinstance(error, UnicodeError) else 1 if isinstance(error, ValueError) else 2 if isinstance(error, OSError) else 4 if isinstance(error, RuntimeError) else 6
    code = getattr(error, 'winerror', None) or getattr(error, 'errno', None)
    DIAGNOSTIC['code'] = bounded(code, 65536) if isinstance(code, int) and not isinstance(code, bool) else 0
    return DIAGNOSTIC


def refuse():
    raise ValueError('The fixed source artifact failed its ZIP contract.')


def ancestry(path, leaf_exists=True):
    absolute = os.path.abspath(path)
    if os.path.normpath(path) != absolute or os.path.realpath(absolute).lower() != absolute.lower():
        refuse()
    current = absolute if leaf_exists else os.path.dirname(absolute)
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or current != absolute and not stat.S_ISDIR(info.st_mode):
            refuse()
        if getattr(info, 'st_file_attributes', 0) & 0x400:
            refuse()
        parent = os.path.dirname(current)
        if current == parent:
            break
        current = parent
    return absolute


def identity(info):
    # CPython3.12 Windows lstat ctime is creation time, while fstat ctime is change time.
    # Only stable fields cross that API boundary; each API's ctime is guarded separately below.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_nlink)


def identity_mismatch(left, right, same_api=False):
    # Keep the public six-bit mapping: dev, ino, size, mtime_ns, ctime_ns, nlink.
    values = zip(identity(left), identity(right))
    mismatch = sum(bit for bit, fields in zip((1, 2, 4, 8, 32), values) if fields[0] != fields[1])
    if same_api and left.st_ctime_ns != right.st_ctime_ns:
        mismatch |= 16
    return mismatch


def extract(archive, destination):
    DIAGNOSTIC.update(stage=0, entryCount=0, acceptedMask=0, entries=[], failure=0, code=0, identityMismatch=0)
    at(1)
    archive = ancestry(archive)
    at(2)
    before = os.lstat(archive)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != PIN['zipBytes']:
        refuse()
    at(3)
    destination = ancestry(destination, False)
    if os.path.lexists(destination):
        refuse()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    with os.fdopen(os.open(archive, flags), 'rb') as source:
        at(4)
        opened = os.fstat(source.fileno())
        DIAGNOSTIC['identityMismatch'] = identity_mismatch(before, opened)
        if identity(before) != identity(opened):
            refuse()
        digest = hashlib.sha256()
        count = 0
        at(5)
        while True:
            block = source.read(min(1024 * 1024, PIN['zipBytes'] + 1 - count))
            if not block:
                break
            count += len(block)
            if count > PIN['zipBytes']:
                refuse()
            digest.update(block)
        if count != PIN['zipBytes'] or digest.hexdigest() != PIN['zipSha256']:
            refuse()
        source.seek(0)
        at(6)
        with zipfile.ZipFile(source, 'r') as bundle:
            infos = bundle.infolist()
            at(7)
            inventory(infos)
            if len(infos) != 4 or set(item.filename for item in infos) != set(PIN['members']):
                refuse()
            total = 0
            for item in infos:
                mode = item.external_attr >> 16
                at(8)
                if item.filename != item.orig_filename or item.filename not in PIN['members'] or item.flag_bits & 1:
                    refuse()
                at(9)
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or mode & 0o7000 or item.external_attr & 0x410:
                    refuse()
                at(10)
                if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or item.file_size < 1 or item.file_size > PIN['members'][item.filename]:
                    refuse()
                if item.compress_size > PIN['zipBytes']:
                    refuse()
                if item.file_size != PIN['verifiedFiles'][item.filename]['bytes']:
                    refuse()
                total += item.file_size
            at(11)
            if total > PIN['maximumExpandedBytes']:
                refuse()
            at(12)
            os.mkdir(destination, 0o700)
            files = []
            for item in sorted(infos, key=lambda value: value.filename):
                target = os.path.join(destination, item.filename)
                count = 0
                digest = hashlib.sha256()
                output_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
                at(13)
                with bundle.open(item, 'r') as member, os.fdopen(os.open(target, output_flags, 0o600), 'wb') as output:
                    at(14)
                    while True:
                        block = member.read(65536)
                        if not block:
                            break
                        count += len(block)
                        if count > item.file_size or count > PIN['members'][item.filename]:
                            refuse()
                        digest.update(block)
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                if count != item.file_size or digest.hexdigest() != PIN['verifiedFiles'][item.filename]['sha256']:
                    refuse()
                at(15)
                info = os.lstat(target)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != count or getattr(info, 'st_file_attributes', 0) & 0x400:
                    refuse()
                files.append({'name': item.filename, 'bytes': count, 'sha256': digest.hexdigest()})
        at(16)
        after, named = os.fstat(source.fileno()), os.lstat(archive)
        DIAGNOSTIC['identityMismatch'] = identity_mismatch(opened, after, True) | identity_mismatch(before, named, True) | identity_mismatch(opened, named)
        if (identity(opened) != identity(after) or opened.st_ctime_ns != after.st_ctime_ns or
                identity(before) != identity(named) or before.st_ctime_ns != named.st_ctime_ns or
                identity(opened) != identity(named)):
            refuse()
    at(17)
    canonical = ''.join('{sha256} {bytes} {name}\n'.format(**item) for item in files).encode('utf8')
    return {'schema': 1, 'issuer': PIN['issuer'], 'zipSha256': PIN['zipSha256'], 'files': files, 'manifestSha256': hashlib.sha256(canonical).hexdigest()}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            refuse()
        print(json.dumps(extract(sys.argv[1], sys.argv[2]), separators=(',', ':')))
    except Exception as error:
        print(json.dumps(refusal(error), separators=(',', ':')))
        sys.exit(1)
