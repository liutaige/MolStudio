#!/usr/bin/env python3
"""
MolStudio 应用图标生成：macOS Big Sur / Sequoia 规范，极简黑曜石底板 + 纯白 Kekulé 苯环结构式。
输出：AppIcon.iconset/、AppIcon.icns 与 AppIcon-preview.png，并同步更新 dist/.
"""
import math
import os
import shutil
import subprocess

from PIL import Image, ImageDraw

SS = 4                       # 超采样倍数（保证最高精度抗锯齿）
CANVAS = 1024 * SS           # 工作画布：4096 x 4096
OUT = os.path.dirname(os.path.abspath(__file__))

# ---- 配色：深黑曜石渐变（Apple Pro 工具极简质感） ----
TOP = (28, 28, 30)           # #1C1C1E
BOT = (12, 12, 14)           # #0C0C0E
WHITE = (255, 255, 255, 255)


def rounded_gradient_plate(size: int, radius: int) -> Image.Image:
    """Big Sur 风格底板：居中圆角方块 + 垂直渐变 + 顶边微光微倒角。"""
    plate = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    grad = Image.new("RGBA", (CANVAS, CANVAS))
    px = grad.load()
    x0 = (CANVAS - size) // 2
    y0 = (CANVAS - size) // 2
    for y in range(y0, y0 + size):
        t = (y - y0) / size
        r = int(TOP[0] + (BOT[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOT[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOT[2] - TOP[2]) * t)
        for x in range(x0, x0 + size):
            px[x, y] = (r, g, b, 255)
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x0 + size, y0 + size], radius=radius, fill=255)
    plate.paste(grad, (0, 0), mask)

    # 绘制 1.5px 微反光边缘倒角
    d = ImageDraw.Draw(plate)
    d.rounded_rectangle([x0, y0, x0 + size, y0 + size], radius=radius, outline=(255, 255, 255, 36), width=int(1.5 * SS))
    return plate


def draw_benzene(img: Image.Image, cx: int, cy: int, R: int):
    """精确绘制标准 Kekulé 苯环结构式（外六边形单键 + 3 条对称平行的内侧双键）。"""
    d = ImageDraw.Draw(img)

    # 六边形 6 个顶点（从正上方顶点顺时针）
    verts = []
    for k in range(6):
        ang = math.radians(90 - 60 * k)
        verts.append((cx + R * math.cos(ang), cy - R * math.sin(ang)))

    stroke = int(26 * SS)
    # 1. 外单键正六边形骨架
    d.line(verts + [verts[0]], fill=WHITE, width=stroke, joint="curve")
    for v in verts:
        d.ellipse([v[0] - stroke / 2, v[1] - stroke / 2, v[0] + stroke / 2, v[1] + stroke / 2], fill=WHITE)

    # 2. 3 条对称内侧平行的双键（边 0-1, 2-3, 4-5）
    pad = int(28 * SS)
    offset = int(38 * SS)
    inner_w = int(20 * SS)

    for i in (0, 2, 4):
        p1 = verts[i]
        p2 = verts[(i + 1) % 6]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length

        # 垂直向内的精确单位法线（从边中点直接指向多边形几何中心）
        mid_x = (p1[0] + p2[0]) / 2.0
        mid_y = (p1[1] + p2[1]) / 2.0
        to_cx = cx - mid_x
        to_cy = cy - mid_y
        dist = math.hypot(to_cx, to_cy)
        nx, ny = to_cx / dist, to_cy / dist

        in1 = (p1[0] + ux * pad + nx * offset, p1[1] + uy * pad + ny * offset)
        in2 = (p2[0] - ux * pad + nx * offset, p2[1] - uy * pad + ny * offset)

        d.line([in1, in2], fill=WHITE, width=inner_w)
        for p in (in1, in2):
            d.ellipse([p[0] - inner_w / 2, p[1] - inner_w / 2, p[0] + inner_w / 2, p[1] + inner_w / 2], fill=WHITE)


def main():
    plate_size = int(832 * SS)          # Big Sur / Sequoia 规范：832 / 1024
    radius = int(188 * SS)
    img = rounded_gradient_plate(plate_size, radius)

    cx, cy = CANVAS // 2, CANVAS // 2
    R = int(235 * SS)                   # 苯环外接圆半径
    draw_benzene(img, cx, cy, R)

    # 降采样到 1024x1024
    final = img.resize((1024, 1024), Image.Resampling.LANCZOS)
    preview_path = os.path.join(OUT, "AppIcon-preview.png")
    final.save(preview_path)

    # 生成 AppIcon.iconset 多分辨率图标
    iconset = os.path.join(OUT, "AppIcon.iconset")
    os.makedirs(iconset, exist_ok=True)
    specs = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    for name, size in specs.items():
        final.resize((size, size), Image.Resampling.LANCZOS).save(os.path.join(iconset, name))

    icns_path = os.path.join(OUT, "AppIcon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns_path], check=True)
    print("New AppIcon.icns generated:", icns_path)

    # 同步更新已编译的 MolStudio.app
    app_icns = os.path.join(OUT, "dist", "MolStudio.app", "Contents", "Resources", "AppIcon.icns")
    if os.path.exists(os.path.dirname(app_icns)):
        shutil.copy2(icns_path, app_icns)
        print("Updated app bundle icon:", app_icns)


if __name__ == "__main__":
    main()
