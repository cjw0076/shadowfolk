#!/usr/bin/env python3
"""Lay out one captured XR frame per second with time labels."""
from pathlib import Path
from PIL import Image, ImageDraw
import sys

if len(sys.argv) not in (3, 4):
    raise SystemExit('usage: python3 tools/record/contact-sheet.py shot-dir output.png [fps]')
shot = Path(sys.argv[1])
output = Path(sys.argv[2])
fps = int(sys.argv[3]) if len(sys.argv) == 4 else 30
frames = sorted((shot / 'frames').glob('f*.png'))
if not frames:
    raise SystemExit(f'no frames in {shot / "frames"}')
selected = frames[::fps]
width, height, label = 480, 270, 28
columns = 4
rows = (len(selected) + columns - 1) // columns
sheet = Image.new('RGB', (columns * width, rows * (height + label)), '#1b1511')
draw = ImageDraw.Draw(sheet)
for second, path in enumerate(selected):
    x = second % columns * width
    y = second // columns * (height + label)
    with Image.open(path) as frame:
        sheet.paste(frame.convert('RGB').resize((width, height), Image.Resampling.LANCZOS), (x, y))
    draw.text((x + 8, y + height + 5), f'{second:02d} s', fill='#ffe2ad')
output.parent.mkdir(parents=True, exist_ok=True)
sheet.save(output, optimize=True)
print(f'{output}: {len(selected)} frames, {sheet.width}x{sheet.height}')
