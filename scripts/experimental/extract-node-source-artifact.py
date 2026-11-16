#!/usr/bin/env python3
"""Fixed authenticated public-artifact ZIP boundary. Python3.6 stdlib compatible; no downloader or executable launch."""
import hashlib
import json
import os
import stat
import sys
import zipfile

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'windows-node-source-artifact-pin.json'), 'r') as handle:
    PIN = json.load(handle)


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
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime, info.st_ctime, info.st_nlink)


def extract(archive, destination):
    archive = ancestry(archive)
    before = os.lstat(archive)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != PIN['zipBytes']:
        refuse()
    destination = ancestry(destination, False)
    if os.path.lexists(destination):
        refuse()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    with os.fdopen(os.open(archive, flags), 'rb') as source:
        opened = os.fstat(source.fileno())
        if identity(before) != identity(opened):
            refuse()
        digest = hashlib.sha256()
        count = 0
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
        with zipfile.ZipFile(source, 'r') as bundle:
            infos = bundle.infolist()
            if len(infos) != 4 or set(item.filename for item in infos) != set(PIN['members']):
                refuse()
            total = 0
            for item in infos:
                mode = item.external_attr >> 16
                if item.filename != item.orig_filename or item.filename not in PIN['members'] or item.flag_bits & 1:
                    refuse()
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or mode & 0o7000 or item.external_attr & 0x410:
                    refuse()
                if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or item.file_size < 1 or item.file_size > PIN['members'][item.filename]:
                    refuse()
                if item.compress_size > PIN['zipBytes']:
                    refuse()
                total += item.file_size
            if total > PIN['maximumExpandedBytes']:
                refuse()
            os.mkdir(destination, 0o700)
            files = []
            for item in sorted(infos, key=lambda value: value.filename):
                target = os.path.join(destination, item.filename)
                count = 0
                digest = hashlib.sha256()
                output_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
                with bundle.open(item, 'r') as member, os.fdopen(os.open(target, output_flags, 0o600), 'wb') as output:
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
                if count != item.file_size:
                    refuse()
                info = os.lstat(target)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != count or getattr(info, 'st_file_attributes', 0) & 0x400:
                    refuse()
                files.append({'name': item.filename, 'bytes': count, 'sha256': digest.hexdigest()})
        if identity(opened) != identity(os.fstat(source.fileno())) or identity(opened) != identity(os.lstat(archive)):
            refuse()
    canonical = ''.join('{sha256} {bytes} {name}\n'.format(**item) for item in files).encode('utf8')
    return {'schema': 1, 'issuer': PIN['issuer'], 'zipSha256': PIN['zipSha256'], 'files': files, 'manifestSha256': hashlib.sha256(canonical).hexdigest()}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            refuse()
        print(json.dumps(extract(sys.argv[1], sys.argv[2]), separators=(',', ':')))
    except Exception:
        print('{"status":"refused"}')
        sys.exit(1)
