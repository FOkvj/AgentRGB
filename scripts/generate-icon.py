#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw
import subprocess
import shutil

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
ICONSET = ASSETS / 'AgentBoard.iconset'
PNG = ASSETS / 'app-icon.png'
ICNS = ASSETS / 'app-icon.icns'
SIZE = 1024

ASSETS.mkdir(exist_ok=True)
if ICONSET.exists():
    shutil.rmtree(ICONSET)
ICONSET.mkdir()

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# White rounded-square background.
corner = 224
draw.rounded_rectangle((0, 0, SIZE, SIZE), radius=corner, fill=(255, 255, 255, 255))

# Three minimal status dots.
dot_y = SIZE // 2
spacing = 220
radius = 72
center_x = SIZE // 2
dots = [
    (center_x - spacing, dot_y, (255, 196, 0, 255)),
    (center_x, dot_y, (255, 59, 48, 255)),
    (center_x + spacing, dot_y, (50, 215, 75, 255)),
]
for x, y, color in dots:
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)

img.save(PNG)

sizes = [
    ('icon_16x16.png', 16),
    ('icon_16x16@2x.png', 32),
    ('icon_32x32.png', 32),
    ('icon_32x32@2x.png', 64),
    ('icon_128x128.png', 128),
    ('icon_128x128@2x.png', 256),
    ('icon_256x256.png', 256),
    ('icon_256x256@2x.png', 512),
    ('icon_512x512.png', 512),
    ('icon_512x512@2x.png', 1024),
]
for name, size in sizes:
    img.resize((size, size), Image.Resampling.LANCZOS).save(ICONSET / name)

subprocess.run(['iconutil', '-c', 'icns', str(ICONSET), '-o', str(ICNS)], check=True)
shutil.rmtree(ICONSET)
print(f'✓ Generated {ICNS}')
