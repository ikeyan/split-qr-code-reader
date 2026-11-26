"""Download a pinned, public-domain subset of imazen-26 into a local directory."""
import argparse
import csv
import hashlib
import io
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

from PIL import Image, ImageOps

REPOSITORY = "https://raw.githubusercontent.com/imazen/imazen-26-originals"
REVISIONS = {
    "train": ("9c940538a94bcd6fa61ce89e8bd403f4c3d375ef",
              "f0f84363ad8b4584a41672c2b8b196d4c7d1f996fee7fae9943655f19fa3f9e4"),
    "validate": ("091ae5a37537bfd25ea79a7dda6de8149696ce28",
                 "742d4309ea1a5f3331251cc1dbb1ba9e8d1b2042f2dc0907c3e67e04cf4bec47"),
    "test": ("2f31cc7f54642964bcbf81e9836e77e3bc8e7f8a",
             "cfc75057dc1fc8b42287be1e5b88ac215ccfe7f275343d8d71f3b04d3e8ef190"),
}
LICENSES = {"CC0", "PD", "PD-own", "PD-USGov"}


def fetch(url, digest):
    for attempt in range(3):
        try:
            with urlopen(url, timeout=25) as response:
                data = response.read()
        except OSError:
            if attempt == 2:
                raise
        else:
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f"Unexpected digest for {url}")
            return data


def records(bucket):
    revision, manifest_digest = REVISIONS[bucket]
    base = f"{REPOSITORY}/{revision}"
    raw = fetch(f"{base}/manifest.tsv", manifest_digest)
    for row in csv.DictReader(io.StringIO(raw.decode()), delimiter="\t"):
        # Exclude screenshots with mixed underlying content rights.
        if row["license"] in LICENSES and "screenshots/" not in row["path"]:
            yield row, f"{base}/{quote(row['path'])}"


def prepare(row, url, destination):
    filename = destination / f"{row['id']}.png"
    if filename.exists():
        return
    data = fetch(url, row["sha256"])
    if row["path"].lower().endswith((".heic", ".heif")):
        data = subprocess.run(
            ["magick", "heic:-", "-auto-orient", "-resize", "720x720>",
             "-colorspace", "sRGB", "png:-"],
            input=data, stdout=subprocess.PIPE, check=True, timeout=60,
        ).stdout
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
        image.thumbnail((720, 720))
        # Flatten transparent product and artwork images onto a light background.
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        temporary = filename.with_suffix(".tmp")
        background.save(temporary, format="PNG", compress_level=2)
        temporary.replace(filename)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("buckets", nargs="+", choices=REVISIONS)
    args = parser.parse_args()
    with ThreadPoolExecutor(max_workers=8) as workers:
        for bucket in args.buckets:
            destination = args.output / bucket
            destination.mkdir(parents=True, exist_ok=True)
            tasks = [(row, workers.submit(prepare, row, url, destination))
                     for row, url in records(bucket)]
            failed = 0
            for row, task in tasks:
                try:
                    task.result()
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    print(f"{bucket}/{row['id']}: {error}", flush=True)
                    failed += 1
            print(f"{bucket}: {len(tasks) - failed}/{len(tasks)} images prepared", flush=True)
            if failed:
                raise RuntimeError("Re-run to retry unsuccessful files")


if __name__ == "__main__":
    main()
