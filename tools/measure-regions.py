#!/usr/bin/env python3
"""Measure sRGB mean and 90th percentile in named fractional image boxes."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def parse_box(value: str) -> tuple[str, tuple[float, float, float, float]]:
    name, separator, bounds = value.partition("=")
    if not separator or not name:
        raise argparse.ArgumentTypeError("box must be NAME=x0,y0,x1,y1")
    try:
        coordinates = tuple(float(part) for part in bounds.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("box coordinates must be numbers") from error
    if len(coordinates) != 4:
        raise argparse.ArgumentTypeError("box needs four coordinates")
    left, top, right, bottom = coordinates
    if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
        raise argparse.ArgumentTypeError("box must lie within 0..1 and have positive area")
    return name, coordinates


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--box", type=parse_box, action="append", required=True,
                        metavar="NAME=x0,y0,x1,y1")
    args = parser.parse_args()
    with Image.open(args.image) as source:
        pixels = np.asarray(source.convert("RGB"))
    height, width, _ = pixels.shape
    regions = {}
    for name, bounds in args.box:
        left, top, right, bottom = bounds
        pixel_bounds = [round(left * width), round(top * height), round(right * width), round(bottom * height)]
        x_start, y_start, x_end, y_end = pixel_bounds
        sample = pixels[y_start:y_end, x_start:x_end].reshape(-1, 3)
        if not len(sample):
            parser.error(f"box {name} is empty at this image size")
        regions[name] = {
            "fraction": list(bounds),
            "pixels": pixel_bounds,
            "mean": np.rint(sample.mean(axis=0)).astype(int).tolist(),
            "p90": np.rint(np.percentile(sample, 90, axis=0)).astype(int).tolist(),
        }
    print(json.dumps({"image": str(args.image), "size": [width, height], "regions": regions}, indent=2))


if __name__ == "__main__":
    main()
