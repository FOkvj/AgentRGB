#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import subprocess
import shutil

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
ICONSET = ASSETS / 'AgentLight.iconset'
PNG = ASSETS / 'app-icon.png'
ICNS = ASSETS / 'app-icon.icns'
SIZE = 1024

ASSETS.mkdir(exist_ok=True)
if ICONSET.exists():
    shutil.rmtree(ICONSET)
ICONSET.mkdir()

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

# Black rounded capsule body (matching reference style).
capsule_w = 760
capsule_h = 380
capsule_x0 = (SIZE - capsule_w) // 2
capsule_y0 = (SIZE - capsule_h) // 2
capsule_x1 = capsule_x0 + capsule_w
capsule_y1 = capsule_y0 + capsule_h
capsule_r = capsule_h // 2

# Soft drop shadow.
shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
shadow_draw = ImageDraw.Draw(shadow)
shadow_draw.rounded_rectangle(
    (capsule_x0, capsule_y0 + 24, capsule_x1, capsule_y1 + 24),
    radius=capsule_r,
    fill=(0, 0, 0, 105),
)
shadow = shadow.filter(ImageFilter.GaussianBlur(22))
img = Image.alpha_composite(img, shadow)

draw = ImageDraw.Draw(img)
draw.rounded_rectangle(
    (capsule_x0, capsule_y0, capsule_x1, capsule_y1),
    radius=capsule_r,
    fill=(8, 10, 13, 255),
)

# Traffic-light dots: red, yellow, green.
dot_y = SIZE // 2
dot_radius = 74
dot_spacing = 200
center_x = SIZE // 2
dots = [
    (center_x - dot_spacing, dot_y, (255, 69, 58, 255)),
    (center_x, dot_y, (255, 214, 10, 255)),
    (center_x + dot_spacing, dot_y, (50, 215, 75, 255)),
]

for x, y, color in dots:
    glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((x - 96, y - 96, x + 96, y + 96), fill=(color[0], color[1], color[2], 110))
    glow = glow.filter(ImageFilter.GaussianBlur(14))
    img = Image.alpha_composite(img, glow)

draw = ImageDraw.Draw(img)
for x, y, color in dots:
    draw.ellipse((x - dot_radius, y - dot_radius, x + dot_radius, y + dot_radius), fill=color)
    draw.ellipse((x - 30, y - 46, x + 12, y - 4), fill=(255, 255, 255, 92))

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
