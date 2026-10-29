#!/usr/bin/env python3
"""Crop the browser paper preview for the eleven night-card guest peeks."""
from pathlib import Path
from PIL import Image, ImageDraw
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: python3 tools/record/guest-contact.py screenshot-dir output.png')

source, output = Path(sys.argv[1]), Path(sys.argv[2])
ids = ['peacock', 'rabbit', 'snail', 'fish', 'duck', 'butterfly',
       'heron', 'stag', 'crab', 'dog', 'elephant']
width, height, label = 480, 320, 28
sheet = Image.new('RGB', (4 * width, 3 * (height + label)), '#1b1511')
draw = ImageDraw.Draw(sheet)
for index, name in enumerate(ids):
    with Image.open(source / f'{name}.png') as frame:
        if frame.size != (1280, 720):
            raise ValueError(f'{name}: expected 1280x720 browser preview, got {frame.size}')
        paper = frame.convert('RGB').crop((430, 220, 870, 515))
        tile = paper.resize((width, height), Image.Resampling.LANCZOS)
    x, y = (index % 4) * width, (index // 4) * (height + label)
    sheet.paste(tile, (x, y))
    draw.text((x + 8, y + height + 5), name, fill='#ffe2ad')
output.parent.mkdir(parents=True, exist_ok=True)
sheet.save(output, optimize=True)
print(f'{output}: {len(ids)} peeks, 4x3, {sheet.width}x{sheet.height}')
