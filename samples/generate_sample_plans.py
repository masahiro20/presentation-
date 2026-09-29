#!/usr/bin/env python3
"""
サンプル間取りPDFジェネレーター

CADから出力された平面図PDFを模したテスト用データを生成する。
- 910モジュール / S=1/100
- 壁はダブルライン（バリエーションによって塗りつぶし・線の太さが異なる）
- 窓は壁開口内のサッシ線、ドアは円弧、引戸は平行線
- 室名・帖数、寸法線、方位記号、通り芯、階段、設備を描画

出力:
  samples/sample_house_A3.pdf         1階・2階を1枚のA3に並べたもの（線の太さで壁を区別）
  samples/sample_house_pages.pdf      1階・2階を別ページ（線の太さ均一・壁塗り・通り芯・家具あり、方位回転）
  samples/sample_house_truth.json     正解データ（テスト用）
"""
import json
import math
import os

from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
P = 910.0  # モジュール(mm)
SCALE = 100  # 1/100
MM2PT = 72.0 / 25.4
EXT_T = 150.0
INT_T = 120.0

FONT = "IPAGothic"
for cand in ["/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf"]:
    if os.path.exists(cand):
        pdfmetrics.registerFont(TTFont(FONT, cand))
        break

# ---------------------------------------------------------------------------
# 間取り定義（グリッド単位: 1 = 910mm, x→東, y→南, 原点=北西角）
# ---------------------------------------------------------------------------
HOUSE = {
    1: {
        "rooms": [
            ("浴室", [(0, 0, 2, 2)]),
            ("洗面室", [(2, 0, 4, 2)]),
            ("収納", [(4, 0, 5, 2)]),
            ("階段", [(5, 0, 7, 2)]),
            ("トイレ", [(7, 0, 8, 2)]),
            ("玄関", [(8, 0, 10, 3)]),
            ("ホール", [(5, 2, 8, 3)]),
            ("LDK", [(0, 2, 5, 8), (5, 3, 7, 8)]),
            ("SC", [(7, 3, 8, 4)]),
            ("物入", [(8, 3, 10, 4)]),
            ("和室", [(7, 4, 10, 8)]),
        ],
        # 壁を設けない境界（開放）
        "open_edges": [
            ((5, 2), (7, 2)),  # 階段-ホール
            ((8, 2), (8, 3)),  # ホール-玄関
        ],
        # 開口: (x1,y1,x2,y2 グリッド, 種別)
        "openings": [
            ((10, 0.8), (10, 1.8), "entrance"),  # 玄関ドア(東)
            ((1, 8), (3, 8), "window_tall"),  # LDK 南 掃き出し
            ((3.5, 8), (5.5, 8), "window_tall"),  # LDK 南 掃き出し
            ((0, 3.5), (0, 5), "window"),  # LDK 西 腰窓
            ((7.8, 8), (9.2, 8), "window"),  # 和室 南
            ((10, 5), (10, 6.5), "window"),  # 和室 東
            ((0, 0.5), (0, 1.5), "window_small"),  # 浴室 西
            ((2.5, 0), (3.5, 0), "window_small"),  # 洗面 北
            ((7.2, 0), (7.8, 0), "window_small"),  # トイレ 北
            ((5.5, 0), (6.5, 0), "window_small"),  # 階段 北
            ((2.5, 2), (3.4, 2), "sliding"),  # 洗面-LDK
            ((2, 0.55), (2, 1.45), "door"),  # 浴室-洗面
            ((4, 0.55), (4, 1.45), "door"),  # 収納-洗面
            ((7.05, 2), (7.95, 2), "door"),  # トイレ-ホール
            ((5.05, 3), (5.95, 3), "door"),  # ホール-LDK
            ((7, 5), (7, 7), "sliding"),  # LDK-和室
            ((8.3, 3), (9.7, 3), "sliding"),  # 玄関-物入
            ((7.05, 3), (7.95, 3), "door"),  # ホール-SC
        ],
        "stairs": (5, 0, 7, 2, "UP"),
        "fixtures": ["bath", "wash", "toilet_1", "kitchen"],
    },
    2: {
        "rooms": [
            ("WIC", [(0, 0, 2, 2)]),
            ("書斎", [(2, 0, 4, 2)]),
            ("収納", [(4, 0, 5, 2)]),
            ("階段", [(5, 0, 7, 2)]),
            ("トイレ", [(7, 0, 8, 2)]),
            ("納戸", [(8, 0, 10, 2)]),
            ("ホール", [(4, 2, 10, 3)]),
            ("主寝室", [(0, 2, 4, 6)]),
            ("洋室1", [(4, 3, 7, 6)]),
            ("洋室2", [(7, 3, 10, 6)]),
        ],
        "open_edges": [((5, 2), (7, 2))],
        "openings": [
            ((1, 6), (3, 6), "window"),
            ((0, 3), (0, 4), "window"),
            ((4.8, 6), (6.2, 6), "window"),
            ((7.8, 6), (9.2, 6), "window"),
            ((10, 4), (10, 5), "window"),
            ((10, 2.1), (10, 2.9), "window_small"),
            ((2.5, 0), (3.5, 0), "window"),
            ((8.5, 0), (9.5, 0), "window_small"),
            ((7.2, 0), (7.8, 0), "window_small"),
            ((0.55, 2), (1.45, 2), "door"),
            ((2.55, 2), (3.45, 2), "door"),
            ((4.05, 2), (4.95, 2), "door"),
            ((7.05, 2), (7.95, 2), "door"),
            ((8.55, 2), (9.45, 2), "door"),
            ((4, 2.05), (4, 2.95), "door"),
            ((4.55, 3), (5.45, 3), "door"),
            ((8.55, 3), (9.45, 3), "door"),
        ],
        "stairs": (5, 0, 7, 2, "DN"),
        "fixtures": ["toilet_2"],
    },
}


def room_cells(rects):
    return sum((x2 - x1) * (y2 - y1) for x1, y1, x2, y2 in rects)


def room_edges(rects):
    """部屋の外周エッジを単位グリッド長で列挙"""
    cells = set()
    for x1, y1, x2, y2 in rects:
        for x in range(x1, x2):
            for y in range(y1, y2):
                cells.add((x, y))
    edges = []
    for (x, y) in cells:
        if (x, y - 1) not in cells:
            edges.append(((x, y), (x + 1, y)))
        if (x, y + 1) not in cells:
            edges.append(((x, y + 1), (x + 1, y + 1)))
        if (x - 1, y) not in cells:
            edges.append(((x, y), (x, y + 1)))
        if (x + 1, y) not in cells:
            edges.append(((x + 1, y), (x + 1, y + 1)))
    return edges, cells


def build_floor_geometry(fl):
    data = HOUSE[fl]
    all_cells = set()
    edge_count = {}
    for name, rects in data["rooms"]:
        edges, cells = room_edges(rects)
        all_cells |= cells
        for e in edges:
            k = tuple(sorted(e))
            edge_count[k] = edge_count.get(k, 0) + 1
    # 開放境界
    open_set = set()
    for (a, b) in data["open_edges"]:
        (x1, y1), (x2, y2) = a, b
        if x1 == x2:
            for y in range(min(y1, y2), max(y1, y2)):
                open_set.add(tuple(sorted(((x1, y), (x1, y + 1)))))
        else:
            for x in range(min(x1, x2), max(x1, x2)):
                open_set.add(tuple(sorted(((x, y1), (x + 1, y1)))))
    wall_polys = []
    for e, cnt in edge_count.items():
        if e in open_set:
            continue
        exterior = cnt == 1
        t = EXT_T if exterior else INT_T
        (x1, y1), (x2, y2) = e
        ls = LineString([(x1 * P, y1 * P), (x2 * P, y2 * P)])
        wall_polys.append(ls.buffer(t / 2, cap_style=3, join_style=2))
    walls = unary_union(wall_polys)
    # 開口を切り取る
    open_polys = []
    for (a, b, kind) in data["openings"]:
        (x1, y1), (x2, y2) = a, b
        ls = LineString([(x1 * P, y1 * P), (x2 * P, y2 * P)])
        open_polys.append((ls, kind))
        walls = walls.difference(ls.buffer(EXT_T, cap_style=2, join_style=2))
    return walls, open_polys, all_cells


# ---------------------------------------------------------------------------
# 描画
# ---------------------------------------------------------------------------
class PlanDrawer:
    def __init__(self, c, origin_pt, page_h, style):
        self.c = c
        self.ox, self.oy = origin_pt
        self.page_h = page_h
        self.style = style
        self.scale = style.get("scale", SCALE)

    def pt(self, x_mm, y_mm):
        """実寸(mm, y下向き) → PDF座標(pt, y上向き)"""
        s = MM2PT / self.scale
        return self.ox + x_mm * s, self.page_h - (self.oy + y_mm * s)

    def line(self, x1, y1, x2, y2, w=0.25):
        c = self.c
        c.setLineWidth(w)
        a, b = self.pt(x1, y1)
        d, e = self.pt(x2, y2)
        c.line(a, b, d, e)

    def poly(self, coords, w, fill=None, stroke=True):
        c = self.c
        p = c.beginPath()
        for i, (x, y) in enumerate(coords):
            X, Y = self.pt(x, y)
            if i == 0:
                p.moveTo(X, Y)
            else:
                p.lineTo(X, Y)
        p.close()
        c.setLineWidth(w)
        if fill is not None:
            c.setFillGray(fill)
        c.drawPath(p, stroke=1 if stroke else 0, fill=1 if fill is not None else 0)
        c.setFillGray(0)

    def text(self, x, y, s, size=7, center=True, vertical=False):
        c = self.c
        c.setFont(FONT, size)
        X, Y = self.pt(x, y)
        if vertical:
            # 縦書き: 1文字ずつ上から下へ
            n = len(s)
            for i, ch in enumerate(s):
                c.drawCentredString(X, Y + (n / 2 - i - 0.5) * size * 1.05 - size * 0.35, ch)
            return
        if self.style.get("char_text"):
            # CAD 風: 1文字ずつ配置
            w = c.stringWidth(s, FONT, size)
            x0 = X - w / 2 if center else X
            for ch in s:
                c.drawString(x0, Y - size * 0.35 if center else Y, ch)
                x0 += c.stringWidth(ch, FONT, size)
            return
        if center:
            c.drawCentredString(X, Y - size * 0.35, s)
        else:
            c.drawString(X, Y, s)

    def arc(self, cx, cy, r, a0, a1, w=0.25):
        """中心(cx,cy) 半径r の円弧（角度は実寸座標系・度）"""
        c = self.c
        c.setLineWidth(w)
        n = 1
        p = c.beginPath()
        # reportlab の arc は bezier で出力される
        X, Y = self.pt(cx, cy)
        s = MM2PT / self.scale
        # 座標系の y 反転に合わせて角度を反転
        p.arc(X - r * s, Y - r * s, X + r * s, Y + r * s, startAng=-a0, extent=-(a1 - a0))
        c.drawPath(p, stroke=1, fill=0)

    def circle(self, cx, cy, r, w=0.25):
        X, Y = self.pt(cx, cy)
        self.c.setLineWidth(w)
        self.c.circle(X, Y, r * MM2PT / self.scale, stroke=1, fill=0)


def draw_floor(c, fl, origin_pt, page_h, style, title=True):
    d = PlanDrawer(c, origin_pt, page_h, style)
    walls, openings, cells = build_floor_geometry(fl)
    data = HOUSE[fl]
    wall_w = 1.0 if style["weighted"] else 0.35
    thin = 0.3 if style["weighted"] else 0.35

    # 通り芯
    if style["grid"]:
        c.setDash([6, 2, 1, 2])
        for i in range(0, 11):
            d.line(i * P, -900, i * P, 8 * P + 900, 0.2)
        for j in range(0, 9):
            d.line(-900, j * P, 10 * P + 900, j * P, 0.2)
        c.setDash([])

    # 壁
    geoms = list(walls.geoms) if walls.geom_type == "MultiPolygon" else [walls]
    for g in geoms:
        d.poly(list(g.exterior.coords)[:-1], wall_w, fill=0.55 if style["fill"] else None)
        for ring in g.interiors:
            d.poly(list(ring.coords)[:-1], wall_w, fill=1.0 if style["fill"] else None)

    # 開口部
    for ls, kind in openings:
        (x1, y1), (x2, y2) = ls.coords
        L = ls.length
        ux, uy = (x2 - x1) / L, (y2 - y1) / L
        nx, ny = -uy, ux
        ext = kind.startswith("window") or kind == "entrance"
        t = EXT_T if ext else INT_T
        if kind.startswith("window"):
            if style["window_faces"]:
                for s in (-t / 2, t / 2):
                    d.line(x1 + nx * s, y1 + ny * s, x2 + nx * s, y2 + ny * s, thin)
            # 引違いサッシ
            for (a, b, off) in ((0.0, 0.55, -18), (0.45, 1.0, 18)):
                d.line(x1 + ux * L * a + nx * off, y1 + uy * L * a + ny * off,
                       x1 + ux * L * b + nx * off, y1 + uy * L * b + ny * off, thin)
            # 召し合わせ
            d.line(x1 + ux * L * 0.5 + nx * -18, y1 + uy * L * 0.5 + ny * -18,
                   x1 + ux * L * 0.5 + nx * 18, y1 + uy * L * 0.5 + ny * 18, thin)
        elif kind == "sliding":
            for (a, b, off) in ((0.0, 0.55, -25), (0.45, 1.0, 25)):
                pa = (x1 + ux * L * a + nx * off, y1 + uy * L * a + ny * off)
                pb = (x1 + ux * L * b + nx * off, y1 + uy * L * b + ny * off)
                d.line(pa[0] - nx * 15, pa[1] - ny * 15, pb[0] - nx * 15, pb[1] - ny * 15, thin)
                d.line(pa[0] + nx * 15, pa[1] + ny * 15, pb[0] + nx * 15, pb[1] + ny * 15, thin)
        elif kind in ("door", "entrance"):
            # 開き戸: ヒンジ = 始点, 開き方向 = +n 側（室内側）
            side = 1 if kind == "door" else -1
            hx, hy = x1, y1
            tipx, tipy = hx + nx * L * side, hy + ny * L * side
            d.line(hx, hy, tipx, tipy, 0.6 if kind == "entrance" else thin)
            a0 = math.degrees(math.atan2(ny * side, nx * side))
            a1 = math.degrees(math.atan2(uy, ux))
            # 短い方向の円弧
            diff = (a1 - a0 + 540) % 360 - 180
            d.arc(hx, hy, L, a0, a0 + diff, thin)

    # 階段
    sx1, sy1, sx2, sy2, label = data["stairs"]
    X1, Y1, X2, Y2 = sx1 * P + 60, sy1 * P + 60, sx2 * P - 60, sy2 * P - 60
    mid = (X1 + X2) / 2
    d.line(mid, Y1, mid, Y2 - 400, thin)  # 中央の手摺壁
    n = 6
    for i in range(n + 1):
        y = Y2 - 400 - (Y2 - 400 - Y1) * i / n
        d.line(X1, y, X2, y, thin) if i == 0 else (d.line(X1, y, mid, y, thin), d.line(mid, y, X2, y, thin))
    d.line((X1 + mid) / 2, Y2 - 300, (X1 + mid) / 2, Y1 + 200, thin)
    d.line((mid + X2) / 2, Y1 + 200, (mid + X2) / 2, Y2 - 300, thin)
    d.text((mid + X2) / 2, Y2 - 180, label, 5)

    # 設備
    for f in data["fixtures"]:
        if f == "bath":
            d.poly([(150, 150), (1650, 150), (1650, 900), (150, 900)], thin)
            d.poly([(250, 250), (1550, 250), (1550, 800), (250, 800)], thin)
        elif f == "wash":
            d.poly([(2*P + 150, 100), (2*P + 900, 100), (2*P + 900, 600), (2*P + 150, 600)], thin)
            d.circle(2*P + 525, 330, 150, thin)
            d.poly([(3*P + 100, 100), (3*P + 740, 100), (3*P + 740, 740), (3*P + 100, 740)], thin)
            d.circle(3*P + 420, 420, 230, thin)
        elif f.startswith("toilet"):
            d.poly([(7*P + 250, 90), (7*P + 660, 90), (7*P + 660, 300), (7*P + 250, 300)], thin)
            d.circle(7*P + 455, 600, 200, thin)
        elif f == "kitchen":
            # 対面キッチン（アイランド型）
            d.poly([(0.6*P, 3.4*P), (3.4*P, 3.4*P), (3.4*P, 3.4*P + 700), (0.6*P, 3.4*P + 700)], thin)
            d.poly([(1.0*P, 3.4*P + 150), (1.0*P + 700, 3.4*P + 150), (1.0*P + 700, 3.4*P + 550), (1.0*P, 3.4*P + 550)], thin)
            for k in range(3):
                d.circle(2.3*P + k * 280, 3.4*P + 350, 90, thin)
            # 背面収納
            d.poly([(0.6*P, 2*P + 60), (3.4*P, 2*P + 60), (3.4*P, 2*P + 510), (0.6*P, 2*P + 510)], thin)
    if style.get("furniture") and fl == 1:
        # ダイニングテーブル・ソファ
        d.poly([(1.2*P, 4.9*P), (2.8*P, 4.9*P), (2.8*P, 4.9*P + 850), (1.2*P, 4.9*P + 850)], thin)
        d.poly([(3.6*P, 5.2*P), (4.3*P, 5.2*P), (4.3*P, 7.4*P), (3.6*P, 7.4*P)], thin)

    # 室名
    for name, rects in data["rooms"]:
        big = max(rects, key=lambda r: (r[2] - r[0]) * (r[3] - r[1]))
        cx, cy = (big[0] + big[2]) / 2 * P, (big[1] + big[3]) / 2 * P
        if name == "階段":
            continue
        area = room_cells(rects) * 0.5
        if name == "ホール" and style.get("vertical_hall"):
            d.text(cx, cy, name, 6.5, vertical=True)
        elif name in ("LDK", "和室", "主寝室", "洋室1", "洋室2", "書斎"):
            d.text(cx, cy - 180, name, 8)
            d.text(cx, cy + 180, f"{area:.1f}帖", 6.5)
        else:
            d.text(cx, cy, name, 6.5)

    # 寸法線（外周）
    dim_off = 900
    xs = sorted(set([0, 10] + [x for n, rs in data["rooms"] for r in rs for x in (r[0], r[2])]))
    ys = sorted(set([0, 8 if fl == 1 else 6] + [y for n, rs in data["rooms"] for r in rs for y in (r[1], r[3])]))
    W, H = 10 * P, (8 if fl == 1 else 6) * P
    def hdim(xa, xb, y, lab=True):
        d.line(xa, y, xb, y, 0.25)
        for x in (xa, xb):
            d.line(x - 60, y + 60, x + 60, y - 60, 0.35)
        if lab and style.get("dims", True):
            d.text((xa + xb) / 2, y - 180, f"{int(round(xb - xa))}", 5.5)
    def vdim(ya, yb, x, lab=True):
        d.line(x, ya, x, yb, 0.25)
        for y in (ya, yb):
            d.line(x - 60, y + 60, x + 60, y - 60, 0.35)
        if lab and style.get("dims", True):
            c.saveState()
            X, Y = d.pt(x - 180, (ya + yb) / 2)
            c.translate(X, Y)
            c.rotate(90)
            c.setFont(FONT, 5.5)
            c.drawCentredString(0, -2, f"{int(round(yb - ya))}")
            c.restoreState()
    top_xs = [x for x in xs]
    for a, b in zip(top_xs, top_xs[1:]):
        hdim(a * P, b * P, -dim_off)
    hdim(0, W, -dim_off - 600)
    for a, b in zip(ys, ys[1:]):
        vdim(a * P, b * P, -dim_off)
    vdim(0, H, -dim_off - 600)
    # 引出線
    for x in top_xs:
        d.line(x * P, -150, x * P, -dim_off - 700, 0.2)

    if title:
        d.text(W / 2, H + 1500, f"{fl}階平面図  S=1/{style.get('label_scale', SCALE)}", 10)
    return d


def draw_north(c, center_pt, rot_deg=0.0, r=18):
    cx, cy = center_pt
    c.setLineWidth(0.5)
    c.circle(cx, cy, r, stroke=1, fill=0)
    a = math.radians(rot_deg)
    ux, uy = -math.sin(a), math.cos(a)  # 上方向を rot_deg だけ反時計回り
    tip = (cx + ux * r * 1.1, cy + uy * r * 1.1)
    tail = (cx - ux * r * 0.9, cy - uy * r * 0.9)
    px, py = -uy, ux
    p = c.beginPath()
    p.moveTo(*tip)
    p.lineTo(tail[0] + px * 6, tail[1] + py * 6)
    p.lineTo(cx - ux * r * 0.4, cy - uy * r * 0.4)
    p.close()
    c.drawPath(p, stroke=1, fill=1)
    c.setFont(FONT, 10)
    c.drawCentredString(cx + ux * (r + 10), cy + uy * (r + 10) - 3.5, "N")


def truth():
    out = {"module": P, "scale": SCALE, "floors": {}}
    for fl, data in HOUSE.items():
        rooms = []
        for name, rects in data["rooms"]:
            rooms.append({"name": name, "cells": room_cells(rects), "area_m2": room_cells(rects) * (P / 1000) ** 2})
        out["floors"][fl] = {
            "rooms": rooms,
            "openings": [{"kind": k, "from": a, "to": b} for a, b, k in data["openings"]],
            "footprint_mm": [10 * P, (8 if fl == 1 else 6) * P],
        }
    return out


def main():
    # A3 に 1F / 2F 並び
    path = os.path.join(HERE, "sample_house_A3.pdf")
    w, h = landscape(A3)
    c = canvas.Canvas(path, pagesize=(w, h))
    c.setTitle("サンプル邸 平面図")
    style = {"weighted": True, "fill": False, "window_faces": False, "grid": False}
    draw_floor(c, 1, (40 * MM2PT, 60 * MM2PT), h, style)
    draw_floor(c, 2, (230 * MM2PT, 60 * MM2PT), h, style)
    draw_north(c, (395 * MM2PT, h - 30 * MM2PT))
    c.setFont(FONT, 12)
    c.drawString(20 * MM2PT, 15 * MM2PT, "サンプル邸 新築工事   平面図   S=1/100 (A3)")
    c.showPage()
    c.save()

    # 別ページ・スタイル違い・方位回転
    path = os.path.join(HERE, "sample_house_pages.pdf")
    w, h = landscape(A4)
    c = canvas.Canvas(path, pagesize=(w, h))
    style = {"weighted": False, "fill": True, "window_faces": True, "grid": True, "furniture": True}
    for fl in (1, 2):
        draw_floor(c, fl, (70 * MM2PT, 40 * MM2PT), h, style)
        draw_north(c, (265 * MM2PT, h - 30 * MM2PT), rot_deg=20)
        c.setFont(FONT, 9)
        c.drawString(15 * MM2PT, 12 * MM2PT, f"サンプル邸  {fl}階平面図  1:100")
        c.showPage()
    c.save()

    # 敷地・道路入り、CAD 風の1文字ずつの文字、縦書き、寸法値なし、
    # 「S=1/100」表記のまま縮小印刷（実際は 1/150）された図面
    path = os.path.join(HERE, "sample_house_site.pdf")
    w, h = landscape(A4)
    c = canvas.Canvas(path, pagesize=(w, h))
    style = {"weighted": True, "fill": False, "window_faces": False, "grid": False, "char_text": True,
             "vertical_hall": True, "dims": False, "scale": 150, "label_scale": 100}
    d = draw_floor(c, 1, (35 * MM2PT, 45 * MM2PT), h, style)
    draw_floor(c, 2, (200 * MM2PT, 45 * MM2PT), h, style)
    W1, H1 = 10 * P, 8 * P
    site = (-2400, -2400, W1 + 5500, H1 + 2600)  # 左, 上, 右(道路境界), 下
    c.setDash([6, 2, 1, 2])
    x0, y0, x1, y1 = site
    for a, b in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        d.line(a[0], a[1], b[0], b[1], 0.35)
    c.setDash([])
    # 道路（東側・幅員6m）
    d.line(x1 + 6000, y0 - 3000, x1 + 6000, y1 + 3000, 0.35)
    d.text(x1 + 3000, (y0 + y1) / 2 - 600, "前面道路（公道）", 7)
    d.text(x1 + 3000, (y0 + y1) / 2 + 600, "幅員6.0m", 6)
    d.text((x0 + x1) / 2, y1 + 1300, "敷地面積 165.30㎡", 6)
    draw_north(c, (272 * MM2PT, h - 25 * MM2PT))
    c.setFont(FONT, 9)
    c.drawString(15 * MM2PT, 12 * MM2PT, "サンプル邸  平面図  S=1/100 (A3)  ※A4縮小")
    c.showPage()
    c.save()

    with open(os.path.join(HERE, "sample_house_truth.json"), "w") as f:
        json.dump(truth(), f, ensure_ascii=False, indent=2)
    print("generated")


if __name__ == "__main__":
    main()
