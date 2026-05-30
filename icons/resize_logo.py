"""从 logo.png 缩放生成插件图标"""
from PIL import Image
import os, sys

script_dir = os.path.dirname(os.path.abspath(__file__))
logo_path = os.path.join(script_dir, 'logo.png')
logo = Image.open(logo_path)
for size in [16, 48, 128]:
    resized = logo.resize((size, size), Image.LANCZOS)
    out = os.path.join(script_dir, f'icon{size}.png')
    resized.save(out)
    print(f'icon{size}.png saved ({resized.size})')
