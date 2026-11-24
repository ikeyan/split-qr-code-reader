"""Prepare public-domain photographs for mining. Requires Pillow."""
import argparse
import csv
import hashlib
from pathlib import Path

from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path, help="checkout of libphash-site-corpus")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    with (args.corpus / "corpus_photos.tsv").open() as manifest:
        photos = csv.DictReader(
            (line for line in manifest if not line.startswith("#")), delimiter="\t"
        )
        for photo in photos:
            if photo["license"] not in {"CC0", "Public domain"}:
                continue
            digest = photo["sha256"]
            source, = (args.corpus / "photos").glob(f"{digest}.*")
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise ValueError(f"Photo digest mismatch: {source}")
            # Group by photographer so edits and similar shots stay together.
            group = hashlib.sha256(photo["author"].strip().casefold().encode()).digest()
            split = "holdout" if group[0] < 64 else "train"
            destination = args.output / split
            destination.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as source_image:
                image = ImageOps.exif_transpose(source_image).convert("RGB")
                image.thumbnail((720, 720))
                image.save(destination / f"{digest}.png")


if __name__ == "__main__":
    main()
