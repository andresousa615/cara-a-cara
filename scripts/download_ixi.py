# -*- coding: utf-8 -*-
"""
Downloads the IXI T1 scans the game needs, directly from the IXI project.

The archive (IXI-T1.tar, about 4.8 GB) is read as a stream and only the
exams that have an anonymised counterpart in assets/anon/ are written to
ixi/. The full archive is never stored on disk.

    python scripts/download_ixi.py            # asks for confirmation
    python scripts/download_ixi.py --yes      # accepts the IXI terms
    python scripts/download_ixi.py --tar IXI-T1.tar   # use a local copy
"""

import argparse
import os
import sys
import tarfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets", "anon")
OUT = os.path.join(ROOT, "ixi")

IXI_PAGE = "https://brain-development.org/ixi-dataset/"
IXI_T1_URL = "https://biomedic.doc.ic.ac.uk/brain-development/downloads/IXI/IXI-T1.tar"

ATTRIBUTION = """\
IXI dataset — T1-weighted head MRI
Source:  {page}
Licence: Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0)
         https://creativecommons.org/licenses/by-sa/3.0/legalcode

These scans are downloaded by you, from the IXI project, under the IXI
terms. They show real people. They are used locally to render the
"original" cards of the game and are never meant to be redistributed.
""".format(page=IXI_PAGE)


class ResumableDownload:
    """
    File-like reader over HTTP that survives dropped connections.

    The archive is a plain tar read once from start to end. If the connection
    drops, the reader reconnects with an HTTP Range request from the exact byte
    where it stopped, so the tar parser never notices.
    """

    def __init__(self, url, retries=20):
        self.url, self.retries, self.pos, self.resp = url, retries, 0, None
        self.total = None
        self._connect()

    def _connect(self):
        headers = {"User-Agent": "cara-a-cara"}
        if self.pos:
            headers["Range"] = "bytes={}-".format(self.pos)
        self.resp = urllib.request.urlopen(urllib.request.Request(self.url, headers=headers), timeout=60)
        if self.pos and self.resp.status != 206:
            raise SystemExit("The server does not support resuming; run the script again.")
        if self.total is None:
            self.total = int(self.resp.headers.get("Content-Length") or 0)

    def read(self, n=-1):
        for attempt in range(self.retries + 1):
            try:
                data = self.resp.read(n)
                if data or (self.total and self.pos >= self.total):
                    self.pos += len(data)
                    return data
                raise ConnectionError("connection closed early")
            except Exception as exc:                              # noqa: BLE001
                if attempt == self.retries:
                    raise
                wait = min(60, 2 ** attempt)
                print("  connection lost at {:.0f}% ({}); resuming in {}s ...".format(
                    100 * self.pos / max(self.total or 1, 1), type(exc).__name__, wait), flush=True)
                time.sleep(wait)
                try:
                    self.resp.close()
                except Exception:                                 # noqa: BLE001
                    pass
                try:
                    self._connect()
                except Exception:                                 # noqa: BLE001
                    continue
        return b""

    def close(self):
        self.resp.close()


def needed_exams():
    if not os.path.isdir(ASSETS):
        raise SystemExit("assets/anon/ not found; run from a full clone of the repository.")
    return sorted(e for e in os.listdir(ASSETS) if os.path.isdir(os.path.join(ASSETS, e)))


def already_have(exam):
    path = os.path.join(OUT, exam + ".nii.gz")
    return os.path.isfile(path) and os.path.getsize(path) > 0


def extract(stream_tar, wanted):
    """Writes the wanted members of a streamed tar. Returns those found."""
    found = set()
    for member in stream_tar:
        name = os.path.basename(member.name)
        exam = name[:-len(".nii.gz")] if name.endswith(".nii.gz") else None
        if exam not in wanted or not member.isfile():
            continue
        src = stream_tar.extractfile(member)
        tmp = os.path.join(OUT, name + ".part")
        with open(tmp, "wb") as fh:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
        os.replace(tmp, os.path.join(OUT, name))
        found.add(exam)
        print("  [{}/{}] {}".format(len(found), len(wanted), exam), flush=True)
        if found == wanted:
            break
    return found


def main():
    ap = argparse.ArgumentParser(description="Download the IXI T1 scans used by the game.")
    ap.add_argument("--yes", action="store_true", help="accept the IXI terms without asking")
    ap.add_argument("--tar", help="read from a local IXI-T1.tar instead of downloading")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    wanted = {e for e in needed_exams() if not already_have(e)}
    total = len(needed_exams())
    if not wanted:
        print("All {} IXI scans already in ixi/.".format(total))
        return 0

    print(ATTRIBUTION)
    with open(os.path.join(OUT, "ATTRIBUTION.txt"), "w", encoding="utf-8") as fh:
        fh.write(ATTRIBUTION)

    if not args.yes:
        answer = input("Download {} scans under these terms? [y/N] ".format(len(wanted)))
        if answer.strip().lower() not in ("y", "yes", "s", "sim"):
            print("Cancelled.")
            return 1

    if args.tar:
        print("Reading {} ...".format(args.tar))
        with tarfile.open(args.tar, mode="r|*") as tar:
            found = extract(tar, wanted)
    else:
        print("Streaming {} (about 4.8 GB; only {} scans are kept) ...".format(IXI_T1_URL, len(wanted)))
        stream = ResumableDownload(IXI_T1_URL)
        try:
            with tarfile.open(fileobj=stream, mode="r|") as tar:
                found = extract(tar, wanted)
        finally:
            stream.close()

    missing = sorted(wanted - found)
    if missing:
        print("Missing from the archive: {}".format(", ".join(missing)))
        return 1
    print("Done: {} scans in ixi/.".format(total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
