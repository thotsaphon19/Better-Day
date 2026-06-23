#!/usr/bin/env python3
"""
dice_gif.py — สร้าง GIF ลูกเต๋าสั่น
Usage: python3 dice_gif.py <d1> <d2> <d3> [output_path]
Output: base64 GIF ถ้าไม่ระบุ output_path
"""
import sys, io, random, base64
from PIL import Image, ImageDraw

DOTS = {
    1: [(50,50)],
    2: [(22,22),(78,78)],
    3: [(22,22),(50,50),(78,78)],
    4: [(22,22),(78,22),(22,78),(78,78)],
    5: [(22,22),(78,22),(50,50),(22,78),(78,78)],
    6: [(22,22),(78,22),(22,50),(78,50),(22,78),(78,78)],
}

def draw_die(val, size=110, bg=(255,255,255), dot_color=(25,25,25), angle=0):
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    d = ImageDraw.Draw(img)
    m = int(size * 0.06)
    r = int(size * 0.15)
    # shadow
    d.rounded_rectangle([m+2, m+2, size-m+2, size-m+2], radius=r, fill=(180,180,180,120))
    # main face
    d.rounded_rectangle([m, m, size-m, size-m], radius=r,
                        fill=bg, outline=(160,160,160), width=2)
    # dots
    sc = size / 100
    dr = int(7.5 * sc)
    for (cx, cy) in DOTS.get(val, []):
        x, y = int(cx*sc), int(cy*sc)
        # dot shadow
        d.ellipse([x-dr+1, y-dr+1, x+dr+1, y+dr+1], fill=(140,140,140,100))
        d.ellipse([x-dr, y-dr, x+dr, y+dr], fill=dot_color)
    if angle:
        img = img.rotate(angle, expand=False, resample=Image.BICUBIC, center=(size//2, size//2))
    return img

def build_shake_gif(d1, d2, d3, size=110):
    rng = random.Random()
    rv = lambda: rng.randint(1, 6)
    
    # animation frames: (v1,v2,v3, a1,a2,a3, duration_ms)
    seq = [
        (rv(),rv(),rv(), -20, 15,-10, 70),
        (rv(),rv(),rv(),  18,-20, 15, 70),
        (rv(),rv(),rv(), -15, 18,-20, 65),
        (rv(),rv(),rv(),  20,-12, 18, 65),
        (rv(),rv(),rv(), -18, 20,-15, 65),
        (rv(),rv(),rv(),  12,-18, 20, 65),
        (rv(),rv(),rv(), -10, 12,-18, 70),
        (rv(),rv(),rv(),   8,-10, 12, 70),
        (rv(),rv(),rv(),  -5,  6, -8, 80),
        (rv(),rv(),rv(),   4, -4,  5, 80),
        # settle
        (d1, d2, d3, -2,  1, -1, 100),
        (d1, d2, d3,  1, -1,  0, 100),
        (d1, d2, d3,  0,  0,  0, 900),
    ]
    
    gap = 10
    W = size * 3 + gap * 4
    H = size + gap * 2
    BG = (230, 230, 230)
    
    frames, durations = [], []
    
    for (v1,v2,v3,a1,a2,a3,dur) in seq:
        frame = Image.new('RGB', (W, H), BG)
        for i, (v,a) in enumerate([(v1,a1),(v2,a2),(v3,a3)]):
            die_img = draw_die(v, size, angle=a)
            x = gap + i * (size + gap)
            # paste with alpha
            frame.paste(die_img.convert('RGB'), (x, gap))
        # convert to palette
        p = frame.quantize(colors=128, method=2)
        frames.append(p)
        durations.append(dur)
    
    buf = io.BytesIO()
    frames[0].save(
        buf, format='GIF',
        save_all=True, append_images=frames[1:],
        duration=durations, loop=1,
        optimize=False, disposal=2,
    )
    return buf.getvalue()

if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) < 3:
        print('Usage: dice_gif.py <d1> <d2> <d3> [output_path]', file=sys.stderr)
        sys.exit(1)
    
    d1, d2, d3 = int(args[0]), int(args[1]), int(args[2])
    gif_bytes = build_shake_gif(d1, d2, d3)
    
    if len(args) >= 4:
        with open(args[3], 'wb') as f:
            f.write(gif_bytes)
        # print size to stdout
        print(len(gif_bytes))
    else:
        # print base64 to stdout
        sys.stdout.write(base64.b64encode(gif_bytes).decode())
