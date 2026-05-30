"""Generate BookGit PNG icons (16, 48, 128) - pure Python, no deps."""
import struct, zlib, os

def create_png(width, height, pixels):
    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            px = pixels[y * width + x]
            raw += bytes(px)
    compressed = zlib.compress(raw)

    def chunk(type_tag, data):
        c = type_tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    idat = chunk(b'IDAT', compressed)
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

def draw_icon(size):
    bg = (42, 42, 42)
    arrow1 = (200, 200, 200)
    arrow2 = (130, 130, 130)
    blank = (26, 26, 26)

    cx = cy = size // 2
    r_inner = int(size * 0.35)
    r_outer = int(size * 0.46)
    r_bg = int(size * 0.48)

    px = []
    for y in range(size):
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = (dx*dx + dy*dy) ** 0.5
            if dist > r_bg:
                px.append(blank)
            elif dist > r_outer:
                px.append((55, 55, 55))
            elif dist > r_inner:
                if dx >= 0 and dy <= 0:
                    px.append(arrow1)
                elif dx <= 0 and dy >= 0:
                    px.append(arrow2)
                else:
                    px.append(bg)
            else:
                px.append(bg)

    # Arrow heads
    def fill_triangle(cx2, cy2, dx_s, dy_s, color, r=0.12):
        s = int(size * r)
        for dy2 in range(-s, s+1):
            for dx2 in range(-s, s+1):
                if abs(dx2) + abs(dy2) <= s:
                    xp, yp = cx2 + dx2*dx_s, cy2 + dy2*dy_s
                    if 0 <= xp < size and 0 <= yp < size:
                        px[yp*size+xp] = color

    a1x = cx + int(r_outer * 0.7)
    a1y = cy - int(r_outer * 0.7)
    fill_triangle(a1x, a1y, 1, 1, arrow1)

    a2x = cx - int(r_outer * 0.7)
    a2y = cy + int(r_outer * 0.7)
    fill_triangle(a2x, a2y, -1, -1, arrow2)

    return px

def main():
    out = os.path.dirname(__file__)
    for size in [16, 48, 128]:
        pixels = draw_icon(size)
        data = create_png(size, size, pixels)
        path = os.path.join(out, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  Created {path} ({len(data)} bytes)')

if __name__ == '__main__':
    main()
