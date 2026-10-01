# -*- coding: utf-8 -*-
"""
Builds data/: the cards the game shows, and the manifest that pairs them.

For every exam in assets/anon/:
  - renders the "original" cards locally, from the IXI scan in ixi/;
  - copies the "anon" cards from assets/anon/;
  - lists the exam in data/manifest.json only if all its cards exist.

The game reads the manifest, never the folder, so a card without its pair can
never reach the board. data/ holds real faces and is never committed.

    python scripts/build_cards.py
    python scripts/build_cards.py --limit 3     # quick test
    python scripts/build_cards.py --verify      # check data/ without rendering
"""

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rendering import (FRAMINGS, KINDS, POSES, WEBP_QUALITY,  # noqa: E402
                       card_name, ensure_display, render_all)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets", "anon")
IXI = os.path.join(ROOT, "ixi")
DATA = os.path.join(ROOT, "data")


def rel(exam, framing, kind, pose):
    return "cards/{}/{}".format(exam, card_name(framing, kind, pose))


def complete(exam):
    return all(os.path.isfile(os.path.join(DATA, rel(exam, f, k, p)))
               for f in FRAMINGS for k in KINDS for p in POSES)


def build_exam(exam, force):
    out = os.path.join(DATA, "cards", exam)
    os.makedirs(out, exist_ok=True)

    for framing in FRAMINGS:
        for pose in POSES:
            name = card_name(framing, "anon", pose)
            dst = os.path.join(out, name)
            if force or not os.path.isfile(dst):
                shutil.copy2(os.path.join(ASSETS, exam, name), dst)

    originals = [os.path.join(out, card_name(f, "original", p)) for f in FRAMINGS for p in POSES]
    if not force and all(os.path.isfile(o) for o in originals):
        return False
    for framing, pose, img in render_all(os.path.join(IXI, exam + ".nii.gz")):
        Image.fromarray(img).save(os.path.join(out, card_name(framing, "original", pose)),
                                  "WEBP", quality=WEBP_QUALITY, method=6)
    return True


def write_manifest(exams):
    patients = [{"id": e, "cards": {f: {k: {p: rel(e, f, k, p) for p in POSES} for k in KINDS}
                                    for f in FRAMINGS}}
                for e in exams if complete(e)]
    manifest = {
        "version": 3,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "poses": list(POSES), "framings": list(FRAMINGS), "kinds": list(KINDS),
        "patients": patients,
    }
    with open(os.path.join(DATA, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
    return len(patients)


def main():
    ap = argparse.ArgumentParser(description="Build the game cards and manifest.")
    ap.add_argument("--limit", type=int, default=0, help="only the first N exams")
    ap.add_argument("--force", action="store_true", help="re-render existing cards")
    ap.add_argument("--verify", action="store_true", help="only check data/")
    args = ap.parse_args()

    exams = sorted(e for e in os.listdir(ASSETS) if os.path.isdir(os.path.join(ASSETS, e)))
    if args.limit:
        exams = exams[:args.limit]

    if args.verify:
        ok = [e for e in exams if complete(e)]
        print("{} of {} exams complete in data/.".format(len(ok), len(exams)))
        return 0 if len(ok) == len(exams) else 1

    missing = [e for e in exams if not os.path.isfile(os.path.join(IXI, e + ".nii.gz"))]
    if missing:
        raise SystemExit("{} IXI scans missing in ixi/ — run scripts/download_ixi.py first.\n"
                         "  e.g. {}".format(len(missing), ", ".join(missing[:3])))

    ensure_display()
    t0 = time.time()
    for i, exam in enumerate(exams, 1):
        t = time.time()
        rendered = build_exam(exam, args.force)
        print("  [{}/{}] {}  {}".format(i, len(exams), exam,
              "{:.1f}s".format(time.time() - t) if rendered else "already built"), flush=True)

    n = write_manifest(exams)
    print("{} exams in data/manifest.json ({:.0f}s).".format(n, time.time() - t0))
    return 0 if n == len(exams) else 1


if __name__ == "__main__":
    sys.exit(main())
