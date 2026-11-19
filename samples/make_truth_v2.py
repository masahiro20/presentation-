#!/usr/bin/env python3
"""サンプル住宅の正解データを、精度測定（scripts/audit/accuracy.ts）の形式で書き出す。
generate_sample_plans.py の HOUSE（間取り定義）だけを読む（描画用のライブラリは要らない）。
  python3 samples/make_truth_v2.py  → samples/sample_house_truth_v2.json
"""
import ast, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "generate_sample_plans.py"), encoding="utf-8").read()
tree = ast.parse(src)
HOUSE = None
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "HOUSE":
        HOUSE = ast.literal_eval(node.value)
P = 910.0
KIND = {"window": "window", "window_tall": "window", "window_small": "window", "entrance": "entrance", "door": "door", "sliding": "sliding"}

def cells_of(rects):
    return {(x, y) for x1, y1, x2, y2 in rects for x in range(x1, x2) for y in range(y1, y2)}

def outline(cells):
    # 単位格子の外周の辺をつないで 1 周の多角形にする（穴なしの部屋だけ）
    edges = {}
    for (x, y) in cells:
        if (x, y - 1) not in cells: edges[(x, y)] = (x + 1, y)
        if (x + 1, y) not in cells: edges[(x + 1, y)] = (x + 1, y + 1)
        if (x, y + 1) not in cells: edges[(x + 1, y + 1)] = (x, y + 1)
        if (x - 1, y) not in cells: edges[(x, y + 1)] = (x, y)
    start = min(edges)
    pts, p = [start], edges[start]
    while p != start:
        pts.append(p); p = edges[p]
    out = []
    for i, q in enumerate(pts):  # 一直線上の点を除く
        a, b = pts[i - 1], pts[(i + 1) % len(pts)]
        if (q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0]) != 0:
            out.append({"x": q[0] * P, "y": q[1] * P})
    return out

floors = []
for fl, data in HOUSE.items():
    owner = {}
    for name, rects in data["rooms"]:
        for c in cells_of(rects): owner[c] = name
    open_set = set()
    for (x1, y1), (x2, y2) in data["open_edges"]:
        if x1 == x2:
            for y in range(min(y1, y2), max(y1, y2)): open_set.add(("v", x1, y))
        else:
            for x in range(min(x1, x2), max(x1, x2)): open_set.add(("h", x, y1))
    unit = []  # (向き, 位置, 区間の始まり, 外壁か)
    xs = range(min(c[0] for c in owner) - 1, max(c[0] for c in owner) + 2)
    ys = range(min(c[1] for c in owner) - 1, max(c[1] for c in owner) + 2)
    for x in xs:
        for y in ys:
            a, b, c = owner.get((x, y)), owner.get((x, y - 1)), owner.get((x - 1, y))
            if a != b and (a or b) and ("h", x, y) not in open_set: unit.append(("h", y, x, not (a and b)))
            if a != c and (a or c) and ("v", x, y) not in open_set: unit.append(("v", x, y, not (a and c)))
    walls = []
    for d in ("h", "v"):
        for ext in (True, False):
            segs = sorted((o, t) for dd, o, t, e in unit if dd == d and e == ext)
            i = 0
            while i < len(segs):
                o, t0 = segs[i]; t1 = t0 + 1
                while i + 1 < len(segs) and segs[i + 1] == (o, t1): i += 1; t1 += 1
                a = {"x": t0 * P, "y": o * P} if d == "h" else {"x": o * P, "y": t0 * P}
                b = {"x": t1 * P, "y": o * P} if d == "h" else {"x": o * P, "y": t1 * P}
                walls.append({"a": a, "b": b, "thickness": 150 if ext else 120, "exterior": ext})
                i += 1
    rooms = []
    for name, rects in data["rooms"]:
        cells = cells_of(rects)
        rooms.append({"name": name, "type": "", "area": round(len(cells) * (P / 1000) ** 2, 3), "polygon": outline(cells)})
    ops = []
    for (ax, ay), (bx, by), k in data["openings"]:
        ops.append({"kind": KIND[k], "width": round(((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 * P), "center": {"x": (ax + bx) / 2 * P, "y": (ay + by) / 2 * P}})
    sx1, sy1, sx2, sy2, label = data["stairs"]
    floors.append({"level": fl, "walls": walls, "openings": ops, "rooms": rooms,
                   "stairs": [{"kind": "u", "goesUp": label == "UP", "minX": sx1 * P, "minY": sy1 * P, "maxX": sx2 * P, "maxY": sy2 * P}]})
json.dump({"format": "madori-truth-v2", "source": "samples/generate_sample_plans.py（合成の図面。設計者の確認は不要な正解）", "partial": False, "floors": floors},
          open(os.path.join(HERE, "sample_house_truth_v2.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("floors", [(f["level"], len(f["walls"]), len(f["rooms"]), len(f["openings"])) for f in floors])
