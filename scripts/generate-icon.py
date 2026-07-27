#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
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

# Rounded-square background with a vivid vertical gradient.
corner = 224
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(22 + (8 - 22) * t)
    g = int(35 + (119 - 35) * t)
    b = int(70 + (146 - 70) * t)
    draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE, SIZE), radius=corner, fill=255)
img.putalpha(mask)

# Subtle top glow.
glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow)
glow_draw.ellipse((-160, -250, 1180, 720), fill=(86, 203, 255, 72))
glow = glow.filter(ImageFilter.GaussianBlur(36))
img = Image.alpha_composite(img, glow)

# Floating board pill.
pill_shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
shadow_draw = ImageDraw.Draw(pill_shadow)
shadow_draw.rounded_rectangle((202, 455, 822, 592), radius=68, fill=(0, 0, 0, 88))
pill_shadow = pill_shadow.filter(ImageFilter.GaussianBlur(24))
img = Image.alpha_composite(img, pill_shadow)

draw = ImageDraw.Draw(img)
draw.rounded_rectangle((184, 426, 840, 560), radius=67, fill=(236, 248, 255, 245))
draw.rounded_rectangle((204, 446, 820, 540), radius=47, fill=(15, 31, 58, 245))

# Agent/session dots, matching board status colors.
dots = [
    (316, 493, (34, 211, 238, 255)),
    (512, 493, (250, 204, 21, 255)),
    (708, 493, (34, 197, 94, 255)),
]
for x, y, color in dots:
    draw.ellipse((x - 42, y - 42, x + 42, y + 42), fill=color)
    draw.ellipse((x - 18, y - 18, x + 10, y + 10), fill=(255, 255, 255, 88))

# Small connection arc to suggest an agent board.
draw.arc((290, 300, 734, 748), start=210, end=330, fill=(148, 232, 255, 190), width=28)

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
