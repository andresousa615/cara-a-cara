# -*- coding: utf-8 -*-
"""
Maintainer-only: builds assets/anon/ from anonymised volumes or cards.

The anonymised faces come from the Algernon anonymisation model, which is not
part of this repository (see README, "Data and licensing"). This script is
kept so the provenance of assets/anon/ is documented and the step can be
repeated by whoever holds the model's outputs. Users of the game never run it.

Two possible inputs:
  --cards-dir   folder with <exam>/<framing>_anon_pose<P>.png already rendered
  --volumes-dir folder with <exam>/<exam>_defaced.nii.gz, rendered here

Exams can be excluded with --exclude (repeatable). Nothing is excluded by
default; the list of excluded exams is not kept in this repository.

    python scripts/export_anon_assets.py --cards-dir PATH --exclude ID --exclude ID
"""

import argparse
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rendering import FRAMINGS, POSES, WEBP_QUALITY, card_name  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "anon")


def save(img, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    Image.fromarray(img).save(dst, "WEBP", quality=WEBP_QUALITY, method=6) \
        if not isinstance(img, Image.Image) else \
        img.convert("RGB").save(dst, "WEBP", quality=WEBP_QUALITY, method=6)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--cards-dir")
    src.add_argument("--volumes-dir")
    ap.add_argument("--exclude", action="append", default=[], metavar="EXAM_ID")
    args = ap.parse_args()

    base = args.cards_dir or args.volumes_dir
    exams = sorted(e for e in os.listdir(base)
                   if os.path.isdir(os.path.join(base, e)) and e not in args.exclude)

    if args.volumes_dir:
        from rendering import ensure_display, render_all
        ensure_display()

    written = 0
    for exam in exams:
        if args.cards_dir:
            for framing in FRAMINGS:
                for pose in POSES:
                    src_png = os.path.join(base, exam, "{}_anon_pose{}.png".format(framing, pose))
                    if not os.path.isfile(src_png):
                        raise SystemExit("Missing {}".format(src_png))
                    save(Image.open(src_png), os.path.join(OUT, exam, card_name(framing, "anon", pose)))
        else:
            vol = os.path.join(base, exam, exam + "_defaced.nii.gz")
            for framing, pose, img in render_all(vol):
                save(img, os.path.join(OUT, exam, card_name(framing, "anon", pose)))
        written += 1
        print("  {}  {}".format(written, exam))

    print("{} exams written to {} ({} excluded)".format(written, OUT, len(args.exclude)))


if __name__ == "__main__":
    main()
