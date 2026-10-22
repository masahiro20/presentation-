import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
//#region src/core/types.ts
var ROOM_TYPE_LABEL = {
	ldk: "LDK",
	living: "リビング",
	dining: "ダイニング",
	kitchen: "キッチン",
	japanese: "和室",
	bedroom: "寝室",
	kids: "子ども室",
	study: "書斎",
	bath: "浴室",
	washroom: "洗面室",
	toilet: "トイレ",
	entrance: "玄関",
	hall: "ホール",
	stairs: "階段",
	closet: "クローゼット",
	storage: "収納",
	balcony: "バルコニー",
	porch: "ポーチ",
	garage: "ガレージ",
	void: "吹抜",
	other: "居室"
};
//#endregion
//#region src/parser/textMerge.ts
var CJK = /^[぀-ヿ㐀-鿿ｦ-ﾟ々ー・（）()]$/;
function sameDir(a, b) {
	let d = Math.abs(a.angle - b.angle) % (Math.PI * 2);
	if (d > Math.PI) d = Math.PI * 2 - d;
	return d < .09;
}
/** 横方向（文字の進行方向）の連結 */
function mergeRuns(texts) {
	const items = texts.map((t) => ({ ...t }));
	const used = new Uint8Array(items.length);
	const out = [];
	const proj = (t) => t.cx * Math.cos(t.angle) + t.cy * Math.sin(t.angle);
	const order = items.map((_, i) => i).sort((i, j) => proj(items[i]) - proj(items[j]));
	for (const i of order) {
		if (used[i]) continue;
		used[i] = 1;
		let cur = items[i];
		for (;;) {
			const ux = Math.cos(cur.angle);
			const uy = Math.sin(cur.angle);
			const endX = cur.cx + ux * cur.width / 2;
			const endY = cur.cy + uy * cur.width / 2;
			let best = -1;
			let bestGap = Infinity;
			for (const j of order) {
				if (used[j]) continue;
				const t = items[j];
				if (!sameDir(cur, t)) continue;
				const r = t.size / cur.size;
				if (r < .8 || r > 1.25) continue;
				const sx = t.cx - ux * t.width / 2;
				const sy = t.cy - uy * t.width / 2;
				const gap = (sx - endX) * ux + (sy - endY) * uy;
				if (Math.abs(-(t.cy - cur.cy) * ux + (t.cx - cur.cx) * uy) > cur.size * .3) continue;
				if (gap < -cur.size * .3 || gap > cur.size * .45) continue;
				if (gap < bestGap) {
					bestGap = gap;
					best = j;
				}
			}
			if (best < 0) break;
			used[best] = 1;
			const t = items[best];
			const sx = cur.cx - ux * cur.width / 2;
			const sy = cur.cy - uy * cur.width / 2;
			const ex = t.cx + ux * t.width / 2;
			const ey = t.cy + uy * t.width / 2;
			const width = (ex - sx) * ux + (ey - sy) * uy;
			cur = {
				str: cur.str + (bestGap > cur.size * .25 && /[A-Za-z0-9]$/.test(cur.str) && /^[A-Za-z0-9]/.test(t.str) ? " " : "") + t.str,
				cx: (sx + ex) / 2,
				cy: (sy + ey) / 2,
				size: Math.max(cur.size, t.size),
				width,
				angle: cur.angle
			};
		}
		out.push(cur);
	}
	return out;
}
/** 縦書き（1文字ずつ上から下へ積まれた日本語）の連結 */
function mergeVertical(texts) {
	const single = (t) => [...t.str].length === 1 && CJK.test(t.str) && Math.abs(t.angle) < .09;
	const items = texts.slice();
	const used = new Uint8Array(items.length);
	const out = [];
	const order = items.map((_, i) => i).sort((i, j) => items[i].cy - items[j].cy);
	for (const i of order) {
		if (used[i]) continue;
		used[i] = 1;
		const t0 = items[i];
		if (!single(t0)) {
			out.push(t0);
			continue;
		}
		const col = [t0];
		let last = t0;
		for (;;) {
			let best = -1;
			let bestDy = Infinity;
			for (const j of order) {
				if (used[j]) continue;
				const t = items[j];
				if (!single(t)) continue;
				const r = t.size / last.size;
				if (r < .8 || r > 1.25) continue;
				if (Math.abs(t.cx - last.cx) > last.size * .3) continue;
				const dy = t.cy - last.cy;
				if (dy < last.size * .7 || dy > last.size * 1.5) continue;
				if (dy < bestDy) {
					bestDy = dy;
					best = j;
				}
			}
			if (best < 0) break;
			used[best] = 1;
			last = items[best];
			col.push(last);
		}
		if (col.length === 1) {
			out.push(t0);
			continue;
		}
		const top = col[0].cy - col[0].size / 2;
		const bot = last.cy + last.size / 2;
		out.push({
			str: col.map((c) => c.str).join(""),
			cx: col.reduce((s, c) => s + c.cx, 0) / col.length,
			cy: (top + bot) / 2,
			size: col[0].size,
			width: bot - top,
			angle: Math.PI / 2
		});
	}
	return out;
}
function mergeTextFragments(texts) {
	if (texts.length < 2 || texts.length > 2e4) return texts;
	return mergeVertical(mergeRuns(texts));
}
//#endregion
//#region src/parser/pdfExtract.ts
function mul(m1, m2) {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
	];
}
function apply$1(m, x, y) {
	return {
		x: m[0] * x + m[2] * y + m[4],
		y: m[1] * x + m[3] * y + m[5]
	};
}
async function extractPageVectors(page, OPS, pageIndex = 0) {
	const viewport = page.getViewport({ scale: 1 });
	const base = viewport.transform.slice(0, 6);
	const opList = await page.getOperatorList();
	const segments = [];
	const curves = [];
	const fills = [];
	let gs = {
		ctm: base,
		lineWidth: 1,
		dashed: false,
		stroke: "#000000",
		fill: "#000000",
		clip: null
	};
	let pendingClip = false;
	let imageCount = 0;
	const images = [];
	/** クリップされた塗り（グラデーションを同心円などで描き部屋の形で切り抜いたもの）は、
	*  クリップの形を塗りとして1回だけ出力する */
	const clipEmitted = /* @__PURE__ */ new Set();
	/** 塗りがクリップ全体を覆う（グラデーション・模様） */
	const coversClip = (bb) => {
		const cb = bboxPts(gs.clip);
		return bb.minX <= cb.minX + .5 && bb.minY <= cb.minY + .5 && bb.maxX >= cb.maxX - .5 && bb.maxY >= cb.maxY - .5;
	};
	const emitClipFill = (color) => {
		const c = gs.clip;
		if (!c || clipEmitted.has(c)) return;
		clipEmitted.add(c);
		fills.push({
			polygon: c,
			color
		});
	};
	const stack = [];
	const { fnArray, argsArray } = opList;
	for (let i = 0; i < fnArray.length; i++) {
		const fn = fnArray[i];
		const args = argsArray[i];
		switch (fn) {
			case OPS.save:
				stack.push({ ...gs });
				break;
			case OPS.restore:
				if (stack.length) gs = stack.pop();
				break;
			case OPS.transform:
				gs.ctm = mul(gs.ctm, args);
				break;
			case OPS.paintFormXObjectBegin: {
				stack.push({ ...gs });
				const m = args?.[0];
				if (m && m.length === 6) gs.ctm = mul(gs.ctm, Array.from(m));
				break;
			}
			case OPS.paintFormXObjectEnd:
				if (stack.length) gs = stack.pop();
				break;
			case OPS.setLineWidth:
				gs.lineWidth = args[0];
				break;
			case OPS.setDash: {
				const arr = args[0];
				gs.dashed = Array.isArray(arr) ? arr.length > 0 && arr.some((x) => x > 0) : false;
				break;
			}
			case OPS.setStrokeRGBColor:
				gs.stroke = typeof args[0] === "string" ? args[0] : "#000000";
				break;
			case OPS.setFillRGBColor:
				gs.fill = typeof args[0] === "string" ? args[0] : "#000000";
				break;
			case OPS.clip:
			case OPS.eoClip:
				pendingClip = true;
				break;
			case OPS.paintImageXObject:
			case OPS.paintInlineImageXObject:
			case OPS.paintImageMaskXObject:
			case OPS.paintImageXObjectRepeat:
				imageCount++;
				{
					const m = gs.ctm;
					const xs = [
						m[4],
						m[0] + m[4],
						m[2] + m[4],
						m[0] + m[2] + m[4]
					];
					const ys = [
						m[5],
						m[1] + m[5],
						m[3] + m[5],
						m[1] + m[3] + m[5]
					];
					images.push({
						x0: Math.min(...xs),
						y0: Math.min(...ys),
						x1: Math.max(...xs),
						y1: Math.max(...ys)
					});
				}
				break;
			case OPS.shadingFill:
				emitClipFill("#shading");
				break;
			case OPS.constructPath: {
				const paintOp = args[0];
				const data = args[1]?.[0];
				if (!data) break;
				const isStroke = paintOp === OPS.stroke || paintOp === OPS.closeStroke || paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke || paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
				const isFill = paintOp === OPS.fill || paintOp === OPS.eoFill || paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke || paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
				const m = gs.ctm;
				if (!isStroke && !isFill) {
					if (pendingClip) {
						pendingClip = false;
						const pts = [];
						let ok = true;
						let moves = 0;
						for (let k = 0; k < data.length && ok;) {
							const op = data[k++];
							if (op === 0 || op === 1) {
								if (op === 0 && ++moves > 1) ok = false;
								pts.push(apply$1(m, data[k], data[k + 1]));
								k += 2;
							} else if (op === 4) {} else ok = false;
						}
						gs.clip = ok && pts.length >= 3 && pts.length <= 16 ? pts : null;
					}
					break;
				}
				pendingClip = false;
				const scaleW = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
				const width = gs.lineWidth * scaleW;
				let k = 0;
				let cur = null;
				let start = null;
				let poly = [];
				const flushPoly = () => {
					if (isFill && poly.length >= 3) {
						if (!(gs.clip && coversClip(bboxPts(poly)))) fills.push({
							polygon: poly,
							color: gs.fill
						});
						else emitClipFill(gs.fill);
					}
					poly = [];
				};
				const pushSeg = (a, b) => {
					if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) return;
					if (isStroke) segments.push({
						a,
						b,
						width,
						dashed: gs.dashed,
						source: "stroke",
						color: gs.stroke
					});
					if (isFill) segments.push({
						a,
						b,
						width: 0,
						dashed: false,
						source: "fill",
						color: gs.fill
					});
				};
				while (k < data.length) {
					const op = data[k++];
					if (op === 0) {
						flushPoly();
						cur = apply$1(m, data[k], data[k + 1]);
						start = cur;
						poly.push(cur);
						k += 2;
					} else if (op === 1) {
						const p = apply$1(m, data[k], data[k + 1]);
						k += 2;
						if (cur) pushSeg(cur, p);
						cur = p;
						poly.push(p);
					} else if (op === 2) {
						const p1 = apply$1(m, data[k], data[k + 1]);
						const p2 = apply$1(m, data[k + 2], data[k + 3]);
						const p3 = apply$1(m, data[k + 4], data[k + 5]);
						k += 6;
						if (cur) {
							curves.push({
								p0: cur,
								p1,
								p2,
								p3,
								width,
								dashed: gs.dashed
							});
							for (let s = 1; s <= 8; s++) poly.push(bezier(cur, p1, p2, p3, s / 8));
						}
						cur = p3;
					} else if (op === 3) {
						const p1 = apply$1(m, data[k], data[k + 1]);
						const p2 = apply$1(m, data[k + 2], data[k + 3]);
						k += 4;
						if (cur) {
							const c1 = {
								x: cur.x + 2 / 3 * (p1.x - cur.x),
								y: cur.y + 2 / 3 * (p1.y - cur.y)
							};
							const c2 = {
								x: p2.x + 2 / 3 * (p1.x - p2.x),
								y: p2.y + 2 / 3 * (p1.y - p2.y)
							};
							curves.push({
								p0: cur,
								p1: c1,
								p2: c2,
								p3: p2,
								width,
								dashed: gs.dashed
							});
							poly.push(p2);
						}
						cur = p2;
					} else if (op === 4) {
						if (cur && start) pushSeg(cur, start);
						cur = start;
					} else break;
				}
				flushPoly();
				break;
			}
		}
	}
	const texts = [];
	const tc = await page.getTextContent();
	for (const it of tc.items) {
		if (!it || typeof it.str !== "string") continue;
		const str = it.str.trim();
		if (!str) continue;
		const tm = it.transform;
		const m = mul(base, tm);
		const size = Math.hypot(m[2], m[3]);
		const angle = Math.atan2(m[1], m[0]);
		const w = it.width * (Math.hypot(base[0], base[1]) || 1);
		const ux = Math.cos(angle);
		const uy = Math.sin(angle);
		const bx = m[4];
		const by = m[5];
		const cx = bx + ux * (w / 2) + uy * (size * .35);
		const cy = by + uy * (w / 2) - ux * (size * .35);
		texts.push({
			str,
			cx,
			cy,
			size,
			width: w,
			angle
		});
	}
	return {
		pageIndex,
		width: viewport.width,
		height: viewport.height,
		segments,
		curves,
		fills,
		texts: mergeTextFragments(texts),
		imageCount,
		images
	};
}
function bboxPts(pts) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return {
		minX,
		minY,
		maxX,
		maxY
	};
}
function bezier(p0, p1, p2, p3, t) {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;
	return {
		x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
		y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
	};
}
//#endregion
//#region src/parser/scale.ts
var PT_TO_MM = 25.4 / 72;
var STANDARD = [
	10,
	20,
	30,
	50,
	60,
	100,
	150,
	200,
	250,
	300,
	400,
	500,
	600
];
function toHalfWidth(s) {
	return s.replace(/[０-９Ａ-Ｚａ-ｚ．，：／＝]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248));
}
function parseScaleText(texts) {
	const all = texts.map((t) => toHalfWidth(t.str)).join(" \n ");
	for (const re of [
		/S\s*[=:]\s*1\s*[/:]\s*(\d{2,3})/gi,
		/(?:縮尺|scale)\s*[=:]?\s*1\s*[/:]\s*(\d{2,3})/gi,
		/(?:^|[^\d./])1\s*[/:]\s*(\d{2,3})(?![\d/])/g
	]) {
		re.lastIndex = 0;
		const m = re.exec(all);
		if (m) {
			const n = parseInt(m[1], 10);
			if (STANDARD.includes(n)) return n;
		}
	}
	return null;
}
function parseDimensionValue(str) {
	const s = toHalfWidth(str).replace(/[,，\s]/g, "");
	if (!/^\d{3,5}(\.\d+)?$/.test(s)) return null;
	const v = parseFloat(s);
	if (v < 300 || v > 4e4) return null;
	return v;
}
/**
* 寸法値テキストと、その近傍にある平行な線分（寸法線）の長さの比から mm/pt を推定
*/
function estimateFromDimensions(page) {
	const ratios = [];
	const segs = page.segments.filter((s) => s.source === "stroke" && !s.dashed);
	for (const t of page.texts) {
		const val = parseDimensionValue(t.str);
		if (val == null) continue;
		const ux = Math.cos(t.angle);
		const uy = Math.sin(t.angle);
		let best = null;
		let bestScore = Infinity;
		for (const s of segs) {
			const dx = s.b.x - s.a.x;
			const dy = s.b.y - s.a.y;
			const L = Math.hypot(dx, dy);
			if (L < t.width * 1.05) continue;
			if (Math.abs((dx * ux + dy * uy) / L) < .999) continue;
			const px = t.cx - s.a.x;
			const py = t.cy - s.a.y;
			const along = (px * dx + py * dy) / L;
			if (along < 0 || along > L) continue;
			const perpD = Math.abs(px * dy - py * dx) / L;
			if (perpD > t.size * 2.2) continue;
			const centerOff = Math.abs(along - L / 2) / L;
			const score = perpD / t.size + centerOff * 2;
			if (score < bestScore) {
				bestScore = score;
				best = s;
			}
		}
		if (best) {
			const L = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y);
			ratios.push(val / L);
		}
	}
	if (ratios.length < 2) return null;
	ratios.sort((a, b) => a - b);
	let bestCount = 0;
	let bestCenter = 0;
	for (let i = 0; i < ratios.length; i++) {
		const c = ratios[i];
		const members = ratios.filter((r) => Math.abs(r / c - 1) < .02);
		if (members.length > bestCount) {
			bestCount = members.length;
			bestCenter = members.reduce((a, b) => a + b, 0) / members.length;
		}
	}
	if (bestCount < Math.max(2, ratios.length * .3)) return null;
	return {
		mmPerPt: bestCenter,
		matches: bestCount
	};
}
function detectScale(pages) {
	const dimResults = pages.map(estimateFromDimensions).filter((x) => !!x);
	const textDen = parseScaleText(pages.flatMap((p) => p.texts));
	if (dimResults.length) {
		const best = dimResults.sort((a, b) => b.matches - a.matches)[0];
		if (best.matches >= 3) {
			let den = best.mmPerPt / PT_TO_MM;
			const snapped = STANDARD.find((n) => Math.abs(n / den - 1) < .015);
			den = snapped ?? null;
			return {
				mmPerPt: snapped ? snapped * PT_TO_MM : best.mmPerPt,
				denominator: den,
				source: "dimension",
				matches: best.matches
			};
		}
	}
	if (textDen) return {
		mmPerPt: textDen * PT_TO_MM,
		denominator: textDen,
		source: "text",
		matches: 0
	};
	return {
		mmPerPt: 100 * PT_TO_MM,
		denominator: 100,
		source: "default",
		matches: 0
	};
}
//#endregion
//#region src/core/geometry.ts
var v = (x, y) => ({
	x,
	y
});
var add = (a, b) => ({
	x: a.x + b.x,
	y: a.y + b.y
});
var sub = (a, b) => ({
	x: a.x - b.x,
	y: a.y - b.y
});
var scale = (a, s) => ({
	x: a.x * s,
	y: a.y * s
});
var dot = (a, b) => a.x * b.x + a.y * b.y;
var dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
var lerp = (a, b, t) => ({
	x: a.x + (b.x - a.x) * t,
	y: a.y + (b.y - a.y) * t
});
function polygonArea(poly) {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i];
		const q = poly[(i + 1) % poly.length];
		s += p.x * q.y - q.x * p.y;
	}
	return s / 2;
}
function polygonCentroid(poly) {
	let a = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i];
		const q = poly[(i + 1) % poly.length];
		const f = p.x * q.y - q.x * p.y;
		a += f;
		cx += (p.x + q.x) * f;
		cy += (p.y + q.y) * f;
	}
	if (Math.abs(a) < 1e-9) return scale(poly.reduce((acc, p) => add(acc, p), v(0, 0)), 1 / Math.max(1, poly.length));
	return {
		x: cx / (3 * a),
		y: cy / (3 * a)
	};
}
/** 輪郭が他の輪郭の内側にある（＝穴）か */
function isHoleLoop(loop, loops) {
	const p = loop[0];
	let n = 0;
	for (const l of loops) if (l !== loop && pointInPolygon(p, l)) n++;
	return n % 2 === 1;
}
function pointInPolygon(p, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i];
		const b = poly[j];
		if (a.y > p.y !== b.y > p.y && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}
function bboxOf$2(points) {
	const b = {
		minX: Infinity,
		minY: Infinity,
		maxX: -Infinity,
		maxY: -Infinity
	};
	for (const p of points) {
		if (p.x < b.minX) b.minX = p.x;
		if (p.y < b.minY) b.minY = p.y;
		if (p.x > b.maxX) b.maxX = p.x;
		if (p.y > b.maxY) b.maxY = p.y;
	}
	return b;
}
function bboxGap(a, b) {
	const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
	const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
	return Math.hypot(dx, dy);
}
/** 点と線分の距離 */
function distPointSegment(p, a, b) {
	const ab = sub(b, a);
	const l2 = dot(ab, ab);
	if (l2 === 0) return dist(p, a);
	return dist(p, lerp(a, b, Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))));
}
/** Douglas-Peucker による閉多角形の簡略化 */
function simplifyClosed(poly, tol) {
	if (poly.length <= 4) return poly;
	let i0 = 0;
	let i1 = 0;
	let best = -1;
	for (let i = 0; i < poly.length; i++) {
		const d = dist(poly[0], poly[i]);
		if (d > best) {
			best = d;
			i1 = i;
		}
	}
	const part1 = poly.slice(i0, i1 + 1);
	const part2 = poly.slice(i1).concat([poly[0]]);
	const s1 = simplifyOpen(part1, tol);
	const s2 = simplifyOpen(part2, tol);
	return removeCollinear(s1.slice(0, -1).concat(s2.slice(0, -1)), tol * .5);
}
function simplifyOpen(pts, tol) {
	if (pts.length <= 2) return pts.slice();
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack = [[0, pts.length - 1]];
	while (stack.length) {
		const [s, e] = stack.pop();
		let md = -1;
		let mi = -1;
		for (let i = s + 1; i < e; i++) {
			const d = distPointSegment(pts[i], pts[s], pts[e]);
			if (d > md) {
				md = d;
				mi = i;
			}
		}
		if (md > tol && mi > 0) {
			keep[mi] = 1;
			stack.push([s, mi], [mi, e]);
		}
	}
	return pts.filter((_, i) => keep[i]);
}
function removeCollinear(poly, tol) {
	let out = poly.slice();
	let changed = true;
	while (changed && out.length > 3) {
		changed = false;
		for (let i = 0; i < out.length; i++) {
			const a = out[(i - 1 + out.length) % out.length];
			const b = out[i];
			const c = out[(i + 1) % out.length];
			if (distPointSegment(b, a, c) < tol || dist(a, b) < tol) {
				out.splice(i, 1);
				changed = true;
				break;
			}
		}
	}
	return out;
}
/** 区間の和集合 */
function mergeIntervals(iv, gap = 0) {
	const s = iv.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
	const out = [];
	for (const x of s) {
		const last = out[out.length - 1];
		if (last && x[0] <= last[1] + gap) last[1] = Math.max(last[1], x[1]);
		else out.push([x[0], x[1]]);
	}
	return out;
}
/** 区間 a から区間集合 b を差し引く */
function subtractIntervals(a, b) {
	let parts = [[a[0], a[1]]];
	for (const [s, e] of b) {
		const next = [];
		for (const [ps, pe] of parts) if (e <= ps || s >= pe) next.push([ps, pe]);
		else {
			if (s > ps) next.push([ps, s]);
			if (e < pe) next.push([e, pe]);
		}
		parts = next;
	}
	return parts;
}
function intervalsLength(iv) {
	return iv.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
}
//#endregion
//#region src/parser/walls.ts
var DEFAULTS$1 = {
	minThickness: 45,
	maxThickness: 420,
	minSegment: 40,
	ignoreWidth: false
};
function angleOf(s) {
	let th = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
	if (th < 0) th += Math.PI;
	if (th >= Math.PI) th -= Math.PI;
	return th;
}
function segLen(s) {
	return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}
/** 線幅の2クラス分割（重み付き大津法） */
function heavyWidthThreshold(segs) {
	const strokes = segs.filter((s) => s.source === "stroke" && s.width > 0);
	if (strokes.length < 10) return null;
	const byW = /* @__PURE__ */ new Map();
	for (const s of strokes) {
		const w = Math.round(s.width * 1e3) / 1e3;
		byW.set(w, (byW.get(w) ?? 0) + segLen(s));
	}
	const ws = [...byW.entries()].sort((a, b) => a[0] - b[0]);
	if (ws.length < 2) return null;
	const total = ws.reduce((s, [, l]) => s + l, 0);
	let best = -1;
	let bestT = null;
	for (let i = 1; i < ws.length; i++) {
		const lo = ws.slice(0, i);
		const hi = ws.slice(i);
		const wl = lo.reduce((s, [, l]) => s + l, 0);
		const wh = total - wl;
		if (wl / total < .05 || wh / total < .08) continue;
		const ml = lo.reduce((s, [w, l]) => s + w * l, 0) / wl;
		const mh = hi.reduce((s, [w, l]) => s + w * l, 0) / wh;
		if (mh / ml < 1.6) continue;
		const between = wl * wh * (mh - ml) * (mh - ml);
		if (between > best) {
			best = between;
			bestT = (ws[i - 1][0] + ws[i][0]) / 2;
		}
	}
	return bestT;
}
function findAngleGroups(segs, minFrac = .02) {
	const bins = /* @__PURE__ */ new Float64Array(360);
	let total = 0;
	for (const s of segs) {
		const L = segLen(s);
		const b = Math.floor(angleOf(s) / Math.PI * 360) % 360;
		bins[b] += L;
		total += L;
	}
	const smooth = /* @__PURE__ */ new Float64Array(360);
	for (let i = 0; i < 360; i++) smooth[i] = bins[(i + 359) % 360] + bins[i] + bins[(i + 1) % 360];
	const groups = [];
	const used = /* @__PURE__ */ new Uint8Array(360);
	const order = [...smooth.keys()].sort((a, b) => smooth[b] - smooth[a]);
	for (const i of order) {
		if (smooth[i] <= 0 || smooth[i] < total * minFrac || used[i]) continue;
		for (let k = -4; k <= 4; k++) used[(i + k + 360) % 360] = 1;
		let sw = 0;
		let sa = 0;
		for (let k = -2; k <= 2; k++) {
			const j = (i + k + 360) % 360;
			let a = (j + .5) / 2;
			if (i + k < 0) a -= 180;
			if (i + k >= 360) a += 180;
			sw += bins[j];
			sa += bins[j] * a;
		}
		let deg = sa / sw;
		for (const snap of [
			0,
			90,
			180
		]) if (Math.abs(deg - snap) < .6) deg = snap % 180;
		if (deg < 0) deg += 180;
		const th = deg * Math.PI / 180;
		groups.push({
			theta: th,
			u: {
				x: Math.cos(th),
				y: Math.sin(th)
			},
			n: {
				x: -Math.sin(th),
				y: Math.cos(th)
			}
		});
	}
	return groups;
}
function angleDiff(a, b) {
	let d = Math.abs(a - b) % Math.PI;
	if (d > Math.PI / 2) d = Math.PI - d;
	return d;
}
function assignGroup(s, groups, tolRad) {
	const th = angleOf(s);
	let best = -1;
	let bd = tolRad;
	groups.forEach((g, i) => {
		const d = angleDiff(th, g.theta);
		if (d <= bd) {
			bd = d;
			best = i;
		}
	});
	return best;
}
/** 同一直線上で重なる線を統合 */
function mergeCollinear(lines) {
	lines.sort((a, b) => a.o - b.o || a.t0 - b.t0);
	const out = [];
	let i = 0;
	while (i < lines.length) {
		let j = i;
		const cluster = [];
		while (j < lines.length && lines[j].o - lines[i].o < 1.5) cluster.push(lines[j++]);
		const o = cluster.reduce((s, l) => s + l.o * (l.t1 - l.t0), 0) / Math.max(1e-9, cluster.reduce((s, l) => s + (l.t1 - l.t0), 0));
		cluster.sort((a, b) => a.t0 - b.t0);
		let cur = null;
		for (const l of cluster) if (cur && l.t0 <= cur.t1 + 2) {
			cur.t1 = Math.max(cur.t1, l.t1);
			cur.heavy ||= l.heavy;
			cur.eligible ||= l.eligible;
			cur.fill ||= l.fill;
			cur.width = Math.max(cur.width, l.width);
		} else {
			if (cur) out.push(cur);
			cur = {
				...l,
				o
			};
		}
		if (cur) out.push(cur);
		i = j;
	}
	return out;
}
function thicknessPeaks(hist, binSize, minT) {
	const n = hist.length;
	const sm = new Float64Array(n);
	const k = [
		1,
		2,
		3,
		2,
		1
	];
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let j = -2; j <= 2; j++) {
			const idx = i + j;
			if (idx >= 0 && idx < n) s += hist[idx] * k[j + 2];
		}
		sm[i] = s;
	}
	let max = 0;
	for (const x of sm) max = Math.max(max, x);
	const peaks = [];
	for (let i = 1; i < n - 1; i++) if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1] && sm[i] >= max * .2) {
		let sw = 0;
		let sx = 0;
		for (let j = -2; j <= 2; j++) {
			const idx = i + j;
			if (idx >= 0 && idx < n) {
				sw += hist[idx];
				sx += hist[idx] * (minT + (idx + .5) * binSize);
			}
		}
		peaks.push(sw > 0 ? sx / sw : minT + (i + .5) * binSize);
	}
	peaks.sort((a, b) => a - b);
	const merged = [];
	for (const p of peaks) {
		if (merged.length && p - merged[merged.length - 1] < 18) continue;
		merged.push(p);
	}
	return merged;
}
function detectWalls(allSegs, arcs, opts = {}, masks = []) {
	const O = {
		...DEFAULTS$1,
		...opts
	};
	const segs = allSegs.filter((s) => !s.dashed && segLen(s) >= O.minSegment);
	const heavyT = O.ignoreWidth ? null : heavyWidthThreshold(segs);
	const curved = curvedWallChords(arcs, segs, heavyT, O);
	const chords = curved.segs;
	segs.push(...chords);
	arcs = arcs.filter((a) => !curved.used.has(a));
	const groups = findAngleGroups(segs);
	for (const g of findAngleGroups(chords, 0)) if (groups.every((q) => angleDiff(q.theta, g.theta) > .8 * Math.PI / 180)) groups.push(g);
	const fillSegs = segs.filter((s) => s.source === "fill");
	if (fillSegs.length > 40) {
		for (const g of findAngleGroups(fillSegs, .006)) if (groups.every((q) => angleDiff(q.theta, g.theta) > .8 * Math.PI / 180)) groups.push(g);
	}
	const groupLines = groups.map(() => []);
	for (const s of segs) {
		const gi = assignGroup(s, groups, 1.2 * Math.PI / 180);
		if (gi < 0) continue;
		const g = groups[gi];
		const ta = s.a.x * g.u.x + s.a.y * g.u.y;
		const tb = s.b.x * g.u.x + s.b.y * g.u.y;
		const o = (s.a.x + s.b.x) / 2 * g.n.x + (s.a.y + s.b.y) / 2 * g.n.y;
		const heavy = s.source === "fill" || heavyT == null || s.width >= heavyT;
		groupLines[gi].push({
			o,
			t0: Math.min(ta, tb),
			t1: Math.max(ta, tb),
			heavy,
			eligible: heavy,
			width: s.width,
			fill: s.source === "fill"
		});
	}
	const lines = groupLines.map(mergeCollinear);
	{
		let fillPairLen = 0;
		lines.forEach((ls) => {
			const fl = ls.filter((l) => l.fill);
			for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
				const d = fl[j].o - fl[i].o;
				if (d > 300) break;
				if (d < 60) continue;
				fillPairLen += Math.max(0, Math.min(fl[i].t1, fl[j].t1) - Math.max(fl[i].t0, fl[j].t0));
			}
		});
		if (fillPairLen > 8e3) for (const ls of lines) for (const l of ls) l.eligible = l.fill;
	}
	const pairs = [];
	const binSize = 5;
	const hist = new Float64Array(Math.ceil((O.maxThickness - O.minThickness) / binSize));
	lines.forEach((ls, g) => {
		for (let i = 0; i < ls.length; i++) {
			const A = ls[i];
			if (!A.eligible) continue;
			for (let j = i + 1; j < ls.length; j++) {
				const B = ls[j];
				const d = B.o - A.o;
				if (d > O.maxThickness) break;
				if (d < O.minThickness || !B.eligible) continue;
				const t0 = Math.max(A.t0, B.t0);
				const t1 = Math.min(A.t1, B.t1);
				if (t1 - t0 < 60) continue;
				pairs.push({
					g,
					i,
					j,
					d,
					t0,
					t1
				});
			}
		}
	});
	{
		const bracket = /* @__PURE__ */ new Map();
		let domT = 0;
		{
			const h = /* @__PURE__ */ new Map();
			for (const q of pairs) {
				const b = Math.round(q.d / 5) * 5;
				h.set(b, (h.get(b) ?? 0) + (q.t1 - q.t0));
			}
			let best = 0;
			for (const [b, v] of h) if (v > best) {
				best = v;
				domT = b;
			}
		}
		{
			const rng = globalThis.__WALLDBG_O;
			if (rng) {
				for (let g = 0; g < lines.length; g++) for (const l of lines[g]) if (Math.abs(l.o) >= rng[0] && Math.abs(l.o) <= rng[1]) console.log("LINE", g, JSON.stringify({
					o: Math.round(l.o),
					t0: Math.round(l.t0),
					t1: Math.round(l.t1),
					heavy: l.heavy,
					eligible: l.eligible,
					width: l.width
				}));
				for (const q of pairs) {
					const qo = (lines[q.g][q.i].o + lines[q.g][q.j].o) / 2;
					if (Math.abs(qo) >= rng[0] && Math.abs(qo) <= rng[1]) console.log("PAIR", q.g, JSON.stringify({
						o: Math.round(qo),
						d: Math.round(q.d),
						t0: Math.round(q.t0),
						t1: Math.round(q.t1),
						i: q.i,
						j: q.j
					}));
				}
			}
		}
		for (let qi = 0; qi < pairs.length; qi++) {
			const q = pairs[qi];
			if (q.d > 260) continue;
			{
				const ls = lines[q.g];
				const inner = [];
				for (let k = q.i + 1; k < q.j; k++) {
					const C = ls[k];
					if (C.o <= ls[q.i].o + 3 || C.o >= ls[q.j].o - 3) continue;
					if (Math.min(C.t1, q.t1) - Math.max(C.t0, q.t0) > (q.t1 - q.t0) * .3) inner.push(k);
				}
				if (inner.length === 1 && q.t1 - q.t0 >= 600) {
					const C = ls[inner[0]];
					const ov = Math.min(C.t1, q.t1) - Math.max(C.t0, q.t0);
					const nearT = (d) => d >= Math.max(O.minThickness, 75) && (domT <= 0 || Math.abs(d - domT) <= Math.max(12, domT * .12));
					if (C.heavy && ov > (q.t1 - q.t0) * .5 && C.t1 - C.t0 >= 600 && nearT(C.o - ls[q.i].o) && nearT(ls[q.j].o - C.o)) {
						if (globalThis.__WALLDBG_O) console.log("DOUBLE", q.g, JSON.stringify({
							o0: Math.round(ls[q.i].o),
							oc: Math.round(C.o),
							o1: Math.round(ls[q.j].o),
							t0: Math.round(q.t0),
							t1: Math.round(q.t1),
							ct0: Math.round(C.t0),
							ct1: Math.round(C.t1),
							cw: C.width
						}));
						continue;
					}
				}
			}
			for (let k = q.i + 1; k < q.j; k++) {
				const key = `${q.g}:${k}`;
				if (!bracket.has(key)) bracket.set(key, []);
				bracket.get(key).push([
					q.t0,
					q.t1,
					qi
				]);
			}
		}
		const keep = pairs.filter((p) => {
			const ls = lines[p.g];
			const nearDom = domT > 0 && Math.abs(p.d - domT) <= Math.max(10, domT * .1);
			const lenOf = (k) => ls[k].t1 - ls[k].t0;
			const iv = mergeIntervals([...bracket.get(`${p.g}:${p.i}`) ?? [], ...bracket.get(`${p.g}:${p.j}`) ?? []].filter(([, , qi]) => {
				if (!nearDom) return true;
				const q = pairs[qi];
				if (q.i === p.i) return lenOf(q.j) >= .6 * lenOf(p.j);
				if (q.j === p.j) return lenOf(q.i) >= .6 * lenOf(p.i);
				return true;
			}).map(([a, b]) => [a, b]));
			if (!iv.length) return true;
			return intervalsLength(iv.map(([a, b]) => [Math.max(a, p.t0), Math.min(b, p.t1)]).filter(([a, b]) => b > a)) < (p.t1 - p.t0) * .5;
		});
		pairs.length = 0;
		pairs.push(...keep);
	}
	{
		const claimedPlus = /* @__PURE__ */ new Map();
		const claimedMinus = /* @__PURE__ */ new Map();
		const sorted = pairs.slice().sort((a, b) => a.d - b.d);
		for (const p of sorted) {
			const kp = `${p.g}:${p.i}`;
			const km = `${p.g}:${p.j}`;
			const cp = claimedPlus.get(kp) ?? [];
			const cm = claimedMinus.get(km) ?? [];
			const eff = subtractIntervals([p.t0, p.t1], mergeIntervals([...cp, ...cm]));
			const L = intervalsLength(eff);
			if (L <= 0) continue;
			const bin = Math.floor((p.d - O.minThickness) / binSize);
			if (bin >= 0 && bin < hist.length) hist[bin] += L;
			claimedPlus.set(kp, [...cp, ...eff]);
			claimedMinus.set(km, [...cm, ...eff]);
		}
	}
	const peaks = thicknessPeaks(hist, binSize, O.minThickness);
	const matchesPeak = (d) => peaks.some((p) => Math.abs(d - p) <= Math.max(12, p * .1));
	const pieces = [];
	const pieceLines = [];
	const infills = [];
	const claimedPlus = /* @__PURE__ */ new Map();
	const claimedMinus = /* @__PURE__ */ new Map();
	const accepted = pairs.filter((p) => matchesPeak(p.d)).sort((a, b) => a.d - b.d);
	for (const p of accepted) {
		const kp = `${p.g}:${p.i}`;
		const km = `${p.g}:${p.j}`;
		const cp = claimedPlus.get(kp) ?? [];
		const cm = claimedMinus.get(km) ?? [];
		const eff = subtractIntervals([p.t0, p.t1], mergeIntervals([...cp, ...cm]));
		if (!eff.length) continue;
		claimedPlus.set(kp, [...cp, ...eff]);
		claimedMinus.set(km, [...cm, ...eff]);
		const ls = lines[p.g];
		const A = ls[p.i];
		const B = ls[p.j];
		const center = (A.o + B.o) / 2;
		const betweenLines = [];
		for (let k = p.i + 1; k < p.j; k++) {
			const C = ls[k];
			if (C.o <= A.o + 3 || C.o >= B.o - 3) continue;
			betweenLines.push(C);
		}
		for (const e of eff) {
			if (e[1] - e[0] < 40) continue;
			const inf = [];
			const rel = betweenLines.filter((C) => Math.min(C.t1, e[1]) - Math.max(C.t0, e[0]) >= 150);
			if (new Set(rel.map((C) => Math.round(C.o))).size >= 2) for (const bm of mergeIntervals(rel.map((C) => [C.t0, C.t1]), 30)) {
				const s0 = Math.max(e[0], bm[0]);
				const t = Math.min(e[1], bm[1]);
				if (t - s0 >= 250) inf.push([s0, t]);
			}
			for (const [s0, t] of inf) infills.push({
				g: p.g,
				o: center,
				d: p.d,
				t0: s0,
				t1: t,
				lines: rel.length
			});
			for (const part of subtractIntervals(e, inf)) if (part[1] - part[0] >= 40) {
				pieces.push({
					g: p.g,
					o: center,
					d: p.d,
					t0: part[0],
					t1: part[1]
				});
				pieceLines.push([p.i, p.j]);
			}
		}
	}
	{
		const drop = /* @__PURE__ */ new Set();
		const ov = (a, b) => Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0) > .5 * Math.min(a.t1 - a.t0, b.t1 - b.t0);
		const nextOf = (k) => pieces.findIndex((q, qi) => qi !== k && q.g === pieces[k].g && pieceLines[qi][0] === pieceLines[k][1] && ov(q, pieces[k]));
		const hasPrev = (k) => pieces.some((q, qi) => qi !== k && q.g === pieces[k].g && pieceLines[qi][1] === pieceLines[k][0] && ov(q, pieces[k]));
		for (let k = 0; k < pieces.length; k++) {
			if (hasPrev(k)) continue;
			const chain = [k];
			let cur = k;
			for (let guard = 0; guard < 50; guard++) {
				const n = nextOf(cur);
				if (n < 0 || chain.includes(n)) break;
				chain.push(n);
				cur = n;
			}
			if (chain.length >= 4) chain.forEach((c) => drop.add(c));
		}
		if (drop.size) {
			const kept = pieces.filter((_, k) => !drop.has(k));
			pieces.length = 0;
			pieces.push(...kept);
		}
	}
	const pieceLen = pieces.reduce((s, p) => s + (p.t1 - p.t0), 0);
	const infillLen = infills.reduce((s, p) => s + (p.t1 - p.t0), 0);
	if (!(infillLen < (pieceLen + infillLen) * .4)) {
		for (const f of infills) pieces.push({
			g: f.g,
			o: f.o,
			d: f.d,
			t0: f.t0,
			t1: f.t1
		});
		infills.length = 0;
	}
	const maxPeak = peaks.length ? Math.max(...peaks) : 150;
	const minPeak = peaks.length ? Math.min(...peaks) : 120;
	const axes = mergeAxes(pieces, Math.min(maxPeak + 80, 330));
	const openings = [];
	const doors = detectDoorSymbols(arcs, allSegs, groups);
	for (const dr of doors) {
		const span = (a) => {
			return [...a.pieces.map((p) => [p.t0, p.t1]), ...a.openings.map((p) => [p.t0, p.t1])].some(([t0, t1]) => dr.t0 < t1 + 600 && dr.t1 > t0 - 600);
		};
		let ax = axes.find((a) => a.g === dr.g && Math.abs(a.o - dr.o) <= a.d / 2 + 15 && span(a));
		if (!ax) {
			ax = {
				g: dr.g,
				o: dr.o,
				d: minPeak,
				pieces: [],
				openings: []
			};
			axes.push(ax);
		}
		const op = {
			...dr,
			o: ax.o,
			d: ax.d
		};
		ax.pieces = ax.pieces.flatMap((p) => subtractIntervals([p.t0, p.t1], [[op.t0 + 5, op.t1 - 5]]).filter(([a, b]) => b - a >= 40).map(([a, b]) => ({
			...p,
			t0: a,
			t1: b
		})));
		ax.openings.push(op);
		openings.push(op);
	}
	for (const poly of masks) for (const ax of axes) {
		const grp = groups[ax.g];
		const ts = poly.map((q) => q.x * grp.u.x + q.y * grp.u.y);
		const os = poly.map((q) => q.x * grp.n.x + q.y * grp.n.y);
		const t0 = Math.min(...ts);
		const t1 = Math.max(...ts);
		const o0 = Math.min(...os);
		const o1 = Math.max(...os);
		if (o1 - o0 < ax.d * .5 || o0 < ax.o - ax.d / 2 - 30 || o1 > ax.o + ax.d / 2 + 30) continue;
		if (t1 - t0 < 250 || t1 - t0 > 4600) continue;
		if (!ax.pieces.some((p) => p.t0 < t0 + 10 && p.t1 > t1 - 10)) continue;
		if (ax.openings.some((o) => o.t0 < t1 && o.t1 > t0)) continue;
		ax.pieces = ax.pieces.flatMap((p) => subtractIntervals([p.t0, p.t1], [[t0, t1]]).filter(([a, b]) => b - a >= 20).map(([a, b]) => ({
			...p,
			t0: a,
			t1: b
		})));
		const op = {
			g: ax.g,
			o: ax.o,
			d: ax.d,
			t0,
			t1,
			kind: "window",
			confidence: .75
		};
		ax.openings.push(op);
		openings.push(op);
	}
	const endJoined = (ax, t) => {
		const grp = groups[ax.g];
		const P = {
			x: grp.u.x * t + grp.n.x * ax.o,
			y: grp.u.y * t + grp.n.y * ax.o
		};
		for (const b of axes) {
			if (b.g === ax.g) continue;
			const gb = groups[b.g];
			const off = P.x * gb.n.x + P.y * gb.n.y - b.o;
			if (Math.abs(off) > b.d / 2 + ax.d / 2 + 40) continue;
			const tb = P.x * gb.u.x + P.y * gb.u.y;
			const tol = ax.d / 2 + 40;
			if ([...b.pieces, ...b.openings].some((p) => tb > p.t0 - tol && tb < p.t1 + tol)) return true;
		}
		return false;
	};
	for (const ax of axes) {
		const occ = [...ax.pieces.map((p) => ({
			t0: p.t0,
			t1: p.t1,
			op: false
		})), ...ax.openings.map((p) => ({
			t0: p.t0,
			t1: p.t1,
			op: true
		}))].sort((a, b) => a.t0 - b.t0);
		for (let k = 0; k + 1 < occ.length; k++) {
			const gs = occ[k].t1;
			const ge = occ[k + 1].t0;
			const gap = ge - gs;
			if (gap < 250 || gap > 6e3) continue;
			const op = classifyGap(ax.g, ax.o, ax.d, gs, ge, groups[ax.g], lines[ax.g], infills);
			if (globalThis.__WALLDBG) console.log("GAP", Math.round(ax.o), Math.round(gs), Math.round(ge), op.kind, "opEnds", occ[k].op, occ[k + 1].op, "joined", endJoined(ax, gs), endJoined(ax, ge));
			if (op.kind === "window" && gap > 4600) continue;
			if (op.kind === "open") {
				if (occ[k].op || occ[k + 1].op) continue;
				const jA = endJoined(ax, gs);
				const jB = endJoined(ax, ge);
				if (jA && jB) continue;
				if ((jA || jB) && gap > 1100) continue;
				if (gap > 2800) continue;
			}
			ax.openings.push(op);
			openings.push(op);
		}
		if (occ.length) {
			const grp = groups[ax.g];
			for (const side of [-1, 1]) {
				const tEnd = side < 0 ? occ[0].t0 : occ[occ.length - 1].t1;
				let tCross = null;
				for (const b of axes) {
					if (b.g === ax.g) continue;
					const gb = groups[b.g];
					const dot = grp.u.x * gb.n.x + grp.u.y * gb.n.y;
					if (Math.abs(dot) < .7) continue;
					const t = (b.o - ax.o * (grp.n.x * gb.n.x + grp.n.y * gb.n.y)) / dot;
					const gapHere = (t - tEnd) * side;
					if (gapHere < 250 || gapHere > 4600) continue;
					const P = {
						x: grp.u.x * t + grp.n.x * ax.o,
						y: grp.u.y * t + grp.n.y * ax.o
					};
					const tb = P.x * gb.u.x + P.y * gb.u.y;
					if (!b.pieces.some((p) => tb > p.t0 - b.d / 2 - 40 && tb < p.t1 + b.d / 2 + 40)) continue;
					if (tCross === null || Math.abs(t - tEnd) < Math.abs(tCross - tEnd)) tCross = t;
				}
				if (tCross === null) continue;
				const gs = side < 0 ? tCross : tEnd;
				const ge = side < 0 ? tEnd : tCross;
				if (ax.openings.some((o) => o.t0 < ge && o.t1 > gs)) continue;
				const op = classifyGap(ax.g, ax.o, ax.d, gs, ge, grp, lines[ax.g], infills);
				if (op.kind !== "window" || op.confidence < .7) continue;
				ax.openings.push(op);
				openings.push(op);
			}
		}
		for (const f of infills) {
			if (f.g !== ax.g || Math.abs(f.o - ax.o) > 20) continue;
			if (ax.openings.some((o) => f.t0 < o.t1 && f.t1 > o.t0)) continue;
			if (ax.pieces.some((p) => f.t0 >= p.t0 - 5 && f.t1 <= p.t1 + 5)) continue;
			const op = {
				g: ax.g,
				o: ax.o,
				d: ax.d,
				t0: f.t0,
				t1: f.t1,
				kind: "window",
				confidence: .6
			};
			ax.openings.push(op);
			openings.push(op);
		}
	}
	const finalPieces = [];
	for (const ax of axes) for (const p of ax.pieces) finalPieces.push({
		...p,
		o: ax.o,
		d: ax.d
	});
	for (const op of openings) {
		const ax = axes.find((a) => a.openings.includes(op));
		if (ax) {
			op.o = ax.o;
			op.d = ax.d;
		}
	}
	let heavyLen = 0;
	for (const ls of lines) for (const l of ls) if (l.heavy && !l.fill) heavyLen += l.t1 - l.t0;
	const pairedLen = finalPieces.reduce((s0, q) => s0 + 2 * (q.t1 - q.t0), 0);
	return {
		groups,
		pieces: finalPieces,
		openings,
		thicknessPeaks: peaks,
		heavyThreshold: heavyT,
		heavyPairedFrac: heavyT == null || heavyLen <= 0 ? 1 : Math.min(1, pairedLen / heavyLen)
	};
}
/** 円弧の外接円（中心・半径） */
function circleOf(a, b, c) {
	const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
	if (Math.abs(d) < 1e-9) return null;
	const a2 = a.x * a.x + a.y * a.y;
	const b2 = b.x * b.x + b.y * b.y;
	const c2 = c.x * c.x + c.y * c.y;
	const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
	const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
	return {
		c: {
			x: ux,
			y: uy
		},
		r: Math.hypot(a.x - ux, a.y - uy)
	};
}
function bez(a, t) {
	const u = 1 - t;
	return {
		x: u * u * u * a.p0.x + 3 * u * u * t * a.p1.x + 3 * u * t * t * a.p2.x + t * t * t * a.p3.x,
		y: u * u * u * a.p0.y + 3 * u * u * t * a.p1.y + 3 * u * t * t * a.p2.y + t * t * t * a.p3.y
	};
}
/**
* 円弧を短い直線の連なりで書き出す CAD（ARCHITREND など）向けに、折れ線から円弧を復元する。
* 端点でつながる短い線を、同じ向きに少しずつ曲がる限りたどり、1 つの円に乗っていれば
* 90°以下ずつのベジェ円弧にして返す（開き戸の軌跡の検出に使う）。
*/
function polylineArcs(segs, minR = 300, maxR = 1600) {
	const cand = segs.filter((s) => !s.dashed && segLen(s) >= 3 && segLen(s) <= 260);
	const key = (p) => `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`;
	const at = /* @__PURE__ */ new Map();
	cand.forEach((s, i) => {
		for (const p of [s.a, s.b]) {
			const k = key(p);
			if (!at.has(k)) at.set(k, []);
			at.get(k).push(i);
		}
	});
	const near = (p) => {
		const out = /* @__PURE__ */ new Set();
		const kx = Math.round(p.x / 3);
		const ky = Math.round(p.y / 3);
		for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of at.get(`${kx + dx},${ky + dy}`) ?? []) out.add(i);
		return [...out].filter((i) => Math.min(Math.hypot(cand[i].a.x - p.x, cand[i].a.y - p.y), Math.hypot(cand[i].b.x - p.x, cand[i].b.y - p.y)) < 4);
	};
	const used = new Uint8Array(cand.length);
	const out = [];
	const turn = (a, b, c) => {
		const a1 = Math.atan2(b.y - a.y, b.x - a.x);
		let d = Math.atan2(c.y - b.y, c.x - b.x) - a1;
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d < -Math.PI) d += 2 * Math.PI;
		return d;
	};
	for (let i0 = 0; i0 < cand.length; i0++) {
		if (used[i0]) continue;
		used[i0] = 1;
		const pts = [cand[i0].a, cand[i0].b];
		const w = cand[i0].width;
		for (const dir of [1, -1]) {
			if (dir === -1) pts.reverse();
			for (;;) {
				const end = pts[pts.length - 1];
				const prev = pts[pts.length - 2];
				let t0 = 0;
				for (let k = Math.max(1, pts.length - 4); k + 1 < pts.length; k++) t0 += turn(pts[k - 1], pts[k], pts[k + 1]);
				let best = -1;
				let bestNxt = null;
				let bestT = Infinity;
				for (const j of near(end)) {
					if (used[j]) continue;
					const s = cand[j];
					const nxt = Math.hypot(s.a.x - end.x, s.a.y - end.y) < 4 ? s.b : s.a;
					const t = turn(prev, end, nxt);
					if (Math.abs(t) > 25 * Math.PI / 180) continue;
					if (Math.abs(t0) > 6 * Math.PI / 180 && Math.sign(t0) !== Math.sign(t + t0)) continue;
					const dev = Math.abs(t - t0 / 3);
					if (dev < bestT) {
						bestT = dev;
						best = j;
						bestNxt = nxt;
					}
				}
				if (best < 0 || !bestNxt) break;
				used[best] = 1;
				pts.push(bestNxt);
			}
		}
		if (pts.length < 5) continue;
		let circ = null;
		trim: for (let cut = 0; cut <= Math.floor(pts.length * .3); cut++) for (let lo = 0; lo <= cut; lo++) {
			const sub = pts.slice(lo, pts.length - (cut - lo));
			if (sub.length < 5) break trim;
			const c = circleOf(sub[0], sub[Math.floor(sub.length / 2)], sub[sub.length - 1]);
			if (!c || c.r < minR || c.r > maxR) continue;
			if (sub.some((p) => Math.abs(Math.hypot(p.x - c.c.x, p.y - c.c.y) - c.r) > Math.max(6, c.r * .03))) continue;
			circ = c;
			pts.splice(0, pts.length, ...sub);
			break trim;
		}
		if (!circ) continue;
		let sweep = 0;
		for (let k = 1; k + 1 < pts.length; k++) sweep += turn(pts[k - 1], pts[k], pts[k + 1]);
		sweep *= (pts.length - 1) / Math.max(1, pts.length - 2);
		if (Math.abs(sweep) < 20 * Math.PI / 180) continue;
		const a0 = Math.atan2(pts[0].y - circ.c.y, pts[0].x - circ.c.x);
		const n = Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-6);
		const step = sweep / n;
		const P = (a) => ({
			x: circ.c.x + Math.cos(a) * circ.r,
			y: circ.c.y + Math.sin(a) * circ.r
		});
		const kk = 4 / 3 * Math.tan(Math.abs(step) / 4) * circ.r;
		for (let k = 0; k < n; k++) {
			const s0 = a0 + step * k;
			const s1 = s0 + step;
			const sg = Math.sign(step);
			const p0 = P(s0);
			const p3 = P(s1);
			out.push({
				p0,
				p1: {
					x: p0.x - Math.sin(s0) * kk * sg,
					y: p0.y + Math.cos(s0) * kk * sg
				},
				p2: {
					x: p3.x + Math.sin(s1) * kk * sg,
					y: p3.y - Math.cos(s1) * kk * sg
				},
				p3,
				width: w,
				poly: true
			});
		}
	}
	return out;
}
/**
* 開き戸記号の検出: 円弧（中心=吊元、半径=扉幅、約90度）
* 開口 = 吊元 → 戸先側の円弧端点 (壁上の点)
*/
/**
* 同心に近い 2 本の円弧（壁の内側線と外側線）を、弦に沿った直線壁 2 本（平行線ペア）に置き換える。
* 円弧の壁は角度グループ・平行線ペアの検出に乗らないため、ここで直線化して壁検出に渡す。
*/
function curvedWallChords(arcs, segs, heavyT, O) {
	const wallEnds = [];
	for (const s of segs) {
		if (segLen(s) < 60) continue;
		if (heavyT != null && s.source === "stroke" && s.width < heavyT) continue;
		wallEnds.push(s.a, s.b);
	}
	const touchesWall = (p) => wallEnds.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 120);
	const parts = [];
	for (const a of arcs) {
		if (a.poly) continue;
		const circ = circleOf(a.p0, bez(a, .5), a.p3);
		if (!circ || circ.r < 300 || circ.r > 8e3) continue;
		const q = bez(a, .25);
		if (Math.abs(Math.hypot(q.x - circ.c.x, q.y - circ.c.y) - circ.r) > circ.r * .03) continue;
		const m = parts.find((p) => Math.hypot(p.c.x - circ.c.x, p.c.y - circ.c.y) < 10 && Math.abs(p.r - circ.r) < 10 && [p.e0, p.e1].some((e) => [a.p0, a.p3].some((f) => Math.hypot(e.x - f.x, e.y - f.y) < 5)));
		if (m) {
			const pts = [
				m.e0,
				m.e1,
				a.p0,
				a.p3
			];
			let best = [m.e0, m.e1];
			let bd = -1;
			for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
				const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
				if (dd > bd) {
					bd = dd;
					best = [pts[i], pts[j]];
				}
			}
			m.e0 = best[0];
			m.e1 = best[1];
			m.arcs.push(a);
		} else parts.push({
			c: circ.c,
			r: circ.r,
			e0: a.p0,
			e1: a.p3,
			width: a.width,
			used: false,
			arcs: [a]
		});
	}
	const used = /* @__PURE__ */ new Set();
	const spanOf = (p) => {
		const a0 = Math.atan2(p.e0.y - p.c.y, p.e0.x - p.c.x);
		const a1 = Math.atan2(p.e1.y - p.c.y, p.e1.x - p.c.x);
		let d = Math.abs(a1 - a0);
		if (d > Math.PI) d = 2 * Math.PI - d;
		return d;
	};
	const out = [];
	for (let i = 0; i < parts.length; i++) {
		const P = parts[i];
		if (P.used) continue;
		const sp = spanOf(P);
		if (sp < Math.PI / 6 || sp > Math.PI * (150 / 180)) continue;
		if (!touchesWall(P.e0) || !touchesWall(P.e1)) continue;
		for (let j = i + 1; j < parts.length; j++) {
			const Q = parts[j];
			if (Q.used) continue;
			const sq = spanOf(Q);
			if (sq < Math.PI / 6 || sq > Math.PI * (150 / 180)) continue;
			if (!touchesWall(Q.e0) || !touchesWall(Q.e1)) continue;
			if (Math.hypot(P.c.x - Q.c.x, P.c.y - Q.c.y) > O.maxThickness) continue;
			if (Math.abs(P.r - Q.r) > O.maxThickness) continue;
			const d00 = Math.hypot(P.e0.x - Q.e0.x, P.e0.y - Q.e0.y);
			const d11 = Math.hypot(P.e1.x - Q.e1.x, P.e1.y - Q.e1.y);
			const d01 = Math.hypot(P.e0.x - Q.e1.x, P.e0.y - Q.e1.y);
			const d10 = Math.hypot(P.e1.x - Q.e0.x, P.e1.y - Q.e0.y);
			const straight = d00 + d11 <= d01 + d10;
			const tA = straight ? d00 : d01;
			const tB = straight ? d11 : d10;
			const t = (tA + tB) / 2;
			if (Math.min(tA, tB) < O.minThickness * .8 || Math.max(tA, tB) > O.maxThickness) continue;
			if (Math.abs(tA - tB) > t * .5) continue;
			if (heavyT != null && P.width != null && Q.width != null && Math.max(P.width, Q.width) < heavyT) continue;
			const Qe0 = straight ? Q.e0 : Q.e1;
			const Qe1 = straight ? Q.e1 : Q.e0;
			const m0 = {
				x: (P.e0.x + Qe0.x) / 2,
				y: (P.e0.y + Qe0.y) / 2
			};
			const m1 = {
				x: (P.e1.x + Qe1.x) / 2,
				y: (P.e1.y + Qe1.y) / 2
			};
			const L = Math.hypot(m1.x - m0.x, m1.y - m0.y);
			if (L < 300) continue;
			const nx = -(m1.y - m0.y) / L;
			const ny = (m1.x - m0.x) / L;
			const w = Math.max(1, heavyT ?? 1, P.width ?? 0, Q.width ?? 0);
			for (const sgn of [-1, 1]) out.push({
				a: {
					x: m0.x + nx * sgn * (t / 2),
					y: m0.y + ny * sgn * (t / 2)
				},
				b: {
					x: m1.x + nx * sgn * (t / 2),
					y: m1.y + ny * sgn * (t / 2)
				},
				width: w,
				dashed: false,
				source: "stroke"
			});
			P.used = Q.used = true;
			for (const a of [...P.arcs, ...Q.arcs]) used.add(a);
			if (globalThis.__WALLDBG) console.log("CHORD", Math.round(m0.x), Math.round(m0.y), "->", Math.round(m1.x), Math.round(m1.y), "t", Math.round(t), "r", Math.round(P.r), Math.round(Q.r), "span", Math.round(sp * 180 / Math.PI), Math.round(sq * 180 / Math.PI), "w", P.width, Q.width, "heavyT", heavyT);
			break;
		}
	}
	return {
		segs: out,
		used
	};
}
function detectDoorSymbols(arcs, segs, groups) {
	const parts = [];
	for (const a of arcs) {
		const circ = circleOf(a.p0, bez(a, .5), a.p3);
		if (!circ || circ.r < 400 || circ.r > 1400) continue;
		const q = bez(a, .25);
		if (Math.abs(Math.hypot(q.x - circ.c.x, q.y - circ.c.y) - circ.r) > circ.r * .03) continue;
		const m = parts.find((p) => Math.hypot(p.c.x - circ.c.x, p.c.y - circ.c.y) < 25 && Math.abs(p.r - circ.r) < 25);
		if (m) {
			const pts = [
				m.e0,
				m.e1,
				a.p0,
				a.p3
			];
			let best = [m.e0, m.e1];
			let bd = -1;
			for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
				const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
				if (dd > bd) {
					bd = dd;
					best = [pts[i], pts[j]];
				}
			}
			m.e0 = best[0];
			m.e1 = best[1];
		} else parts.push({
			c: circ.c,
			r: circ.r,
			e0: a.p0,
			e1: a.p3,
			poly: !!a.poly
		});
	}
	const wallArc = (p) => p.poly && parts.some((q) => q !== p && Math.hypot(q.c.x - p.c.x, q.c.y - p.c.y) < 150 && Math.abs(q.r - p.r) > 40 && Math.abs(q.r - p.r) < 300);
	const out = [];
	for (const p of parts) {
		const v0 = {
			x: p.e0.x - p.c.x,
			y: p.e0.y - p.c.y
		};
		const v1 = {
			x: p.e1.x - p.c.x,
			y: p.e1.y - p.c.y
		};
		const cosang = (v0.x * v1.x + v0.y * v1.y) / (Math.hypot(v0.x, v0.y) * Math.hypot(v1.x, v1.y));
		if (Math.abs(cosang) > .26) continue;
		const hasLeaf = (e) => segs.some((s) => Math.hypot(s.a.x - p.c.x, s.a.y - p.c.y) < 40 && Math.hypot(s.b.x - e.x, s.b.y - e.y) < 60 || Math.hypot(s.b.x - p.c.x, s.b.y - p.c.y) < 40 && Math.hypot(s.a.x - e.x, s.a.y - e.y) < 60);
		if (wallArc(p)) continue;
		const l0 = hasLeaf(p.e0);
		const l1 = hasLeaf(p.e1);
		if (p.poly && !l0 && !l1) continue;
		const candidates = l0 && !l1 ? [[p.e1, p.e0]] : l1 && !l0 ? [[p.e0, p.e1]] : [[p.e0, p.e1], [p.e1, p.e0]];
		for (const [S, T] of candidates) {
			const dir = Math.atan2(S.y - p.c.y, S.x - p.c.x);
			let th = dir < 0 ? dir + Math.PI : dir;
			if (th >= Math.PI) th -= Math.PI;
			const gi = groups.findIndex((g) => {
				let d = Math.abs(g.theta - th) % Math.PI;
				if (d > Math.PI / 2) d = Math.PI - d;
				return d < (p.poly ? 6 : 3) * Math.PI / 180;
			});
			if (gi < 0) continue;
			const g = groups[gi];
			const tc = p.c.x * g.u.x + p.c.y * g.u.y;
			const ts = S.x * g.u.x + S.y * g.u.y;
			const o = p.c.x * g.n.x + p.c.y * g.n.y;
			const sw = (T.x - p.c.x) * g.n.x + (T.y - p.c.y) * g.n.y;
			out.push({
				g: gi,
				o,
				d: 0,
				t0: Math.min(tc, ts),
				t1: Math.max(tc, ts),
				kind: "door",
				hingeAtStart: tc < ts,
				swingSign: sw > 0 ? 1 : -1,
				confidence: l0 !== l1 ? .95 : .75
			});
			break;
		}
	}
	out.sort((a, b) => a.g - b.g || a.o - b.o || a.t0 - b.t0);
	const merged = [];
	for (const d of out) {
		const last = merged[merged.length - 1];
		if (last && last.g === d.g && Math.abs(last.o - d.o) < 30 && d.t0 - last.t1 < 60 && d.t0 >= last.t0) {
			last.t1 = Math.max(last.t1, d.t1);
			continue;
		}
		merged.push({ ...d });
	}
	return merged;
}
function mergeAxes(pieces, joinGap) {
	const byG = /* @__PURE__ */ new Map();
	for (const p of pieces) {
		if (!byG.has(p.g)) byG.set(p.g, []);
		byG.get(p.g).push(p);
	}
	const axes = [];
	for (const [g, ps] of byG) {
		ps.sort((a, b) => a.o - b.o);
		const clusters = [];
		for (const p of ps) {
			const c = clusters.find((cl) => Math.abs(cl[0].o - p.o) < 15 && Math.abs(cl[0].d - p.d) < 25);
			if (c) c.push(p);
			else clusters.push([p]);
		}
		for (const cl of clusters) {
			const wsum = cl.reduce((s, p) => s + (p.t1 - p.t0), 0);
			const o = cl.reduce((s, p) => s + p.o * (p.t1 - p.t0), 0) / wsum;
			const d = cl.reduce((s, p) => s + p.d * (p.t1 - p.t0), 0) / wsum;
			const iv = mergeIntervals(cl.map((p) => [p.t0, p.t1]), joinGap);
			axes.push({
				g,
				o,
				d,
				pieces: iv.map(([t0, t1]) => ({
					g,
					o,
					d,
					t0,
					t1
				})),
				openings: []
			});
		}
	}
	return axes;
}
function classifyGap(g, o, d, gs, ge, _grp, lines, infills) {
	const gap = ge - gs;
	const infCover = intervalsLength(mergeIntervals(infills.filter((f) => f.g === g && Math.abs(f.o - o) < 20 && f.t0 < ge && f.t1 > gs).map((f) => [Math.max(gs, f.t0), Math.min(ge, f.t1)])));
	const inBand = lines.filter((l) => Math.abs(l.o - o) <= d / 2 + 4 && Math.min(l.t1, ge) - Math.max(l.t0, gs) >= Math.min(150, gap * .3) && l.t0 > gs - 150 && l.t1 < ge + 150);
	const bandCover = intervalsLength(mergeIntervals(inBand.map((l) => [Math.max(gs, l.t0), Math.min(ge, l.t1)]), 40));
	const offs = [...new Set(inBand.map((l) => Math.round(l.o - o)))];
	const spread = offs.length ? Math.max(...offs) - Math.min(...offs) : 0;
	if (infCover > gap * .5 || bandCover > gap * .6 && offs.length >= 2 && spread >= 10) return {
		g,
		o,
		d,
		t0: gs,
		t1: ge,
		kind: "window",
		confidence: infCover > gap * .5 ? .85 : .7
	};
	const faceCover = (side) => intervalsLength(mergeIntervals(lines.filter((l) => Math.abs((l.o - o) * side - d / 2) <= Math.max(25, d * .3)).map((l) => [Math.max(gs, l.t0), Math.min(ge, l.t1)]).filter(([a, b]) => b > a), 30));
	const f1 = faceCover(1);
	const f2 = faceCover(-1);
	if (f1 > gap * .7 && f2 > gap * .7 || (f1 > gap * .7 || f2 > gap * .7) && bandCover > gap * .6) return {
		g,
		o,
		d,
		t0: gs,
		t1: ge,
		kind: "window",
		confidence: .65
	};
	return {
		g,
		o,
		d,
		t0: gs,
		t1: ge,
		kind: "open",
		confidence: .5
	};
}
var Grid = class Grid {
	w;
	h;
	res;
	ox;
	oy;
	data;
	constructor(w, h, res, ox, oy) {
		this.w = w;
		this.h = h;
		this.res = res;
		this.ox = ox;
		this.oy = oy;
		this.data = new Uint8Array(w * h);
	}
	static around(minX, minY, maxX, maxY, res, margin) {
		const ox = minX - margin;
		const oy = minY - margin;
		const w = Math.ceil((maxX - minX + margin * 2) / res);
		const h = Math.ceil((maxY - minY + margin * 2) / res);
		return new Grid(w, h, res, ox, oy);
	}
	cellOf(p) {
		return [Math.floor((p.x - this.ox) / this.res), Math.floor((p.y - this.oy) / this.res)];
	}
	centerOf(x, y) {
		return {
			x: this.ox + (x + .5) * this.res,
			y: this.oy + (y + .5) * this.res
		};
	}
	get(x, y) {
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 2;
		return this.data[y * this.w + x];
	}
	/** 凸多角形/任意多角形をスキャンラインで塗る（セル中心判定） */
	fillPolygon(poly, val) {
		let minY = Infinity;
		let maxY = -Infinity;
		for (const p of poly) {
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
		}
		const y0 = Math.max(0, Math.floor((minY - this.oy) / this.res - .5));
		const y1 = Math.min(this.h - 1, Math.ceil((maxY - this.oy) / this.res));
		const xs = [];
		for (let y = y0; y <= y1; y++) {
			const cy = this.oy + (y + .5) * this.res;
			xs.length = 0;
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const a = poly[i];
				const b = poly[j];
				if (a.y > cy !== b.y > cy) xs.push(a.x + (cy - a.y) / (b.y - a.y) * (b.x - a.x));
			}
			xs.sort((p, q) => p - q);
			for (let k = 0; k + 1 < xs.length; k += 2) {
				const xa = Math.max(0, Math.ceil((xs[k] - this.ox) / this.res - .5));
				const xb = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.ox) / this.res - .5));
				for (let x = xa; x <= xb; x++) this.data[y * this.w + x] = val;
			}
		}
	}
	/** 太さ d の線分を塗る（少し太らせて隙間を防ぐ） */
	fillThickSegment(a, b, d, val) {
		const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const ux = (b.x - a.x) / L;
		const uy = (b.y - a.y) / L;
		const hw = Math.max(d / 2, this.res * .75);
		const nx = -uy * hw;
		const ny = ux * hw;
		const ex = ux * this.res * .5;
		const ey = uy * this.res * .5;
		this.fillPolygon([
			{
				x: a.x - ex + nx,
				y: a.y - ey + ny
			},
			{
				x: b.x + ex + nx,
				y: b.y + ey + ny
			},
			{
				x: b.x + ex - nx,
				y: b.y + ey - ny
			},
			{
				x: a.x - ex - nx,
				y: a.y - ey - ny
			}
		], val);
	}
	/** 外周から FREE セルを塗りつぶして OUTSIDE にする */
	floodOutside() {
		const { w, h, data } = this;
		const q = new Int32Array(w * h);
		let head = 0;
		let tail = 0;
		const push = (x, y) => {
			const i = y * w + x;
			if (data[i] === 0) {
				data[i] = 2;
				q[tail++] = i;
			}
		};
		for (let x = 0; x < w; x++) {
			push(x, 0);
			push(x, h - 1);
		}
		for (let y = 0; y < h; y++) {
			push(0, y);
			push(w - 1, y);
		}
		while (head < tail) {
			const i = q[head++];
			const x = i % w;
			const y = i / w | 0;
			if (x > 0) push(x - 1, y);
			if (x < w - 1) push(x + 1, y);
			if (y > 0) push(x, y - 1);
			if (y < h - 1) push(x, y + 1);
		}
	}
	/** FREE セルの連結成分ラベル (0 = なし) */
	labelComponents() {
		const { w, h, data } = this;
		const labels = new Int32Array(w * h);
		const sizes = [0];
		const q = new Int32Array(w * h);
		let next = 1;
		for (let s = 0; s < w * h; s++) {
			if (data[s] !== 0 || labels[s]) continue;
			let head = 0;
			let tail = 0;
			labels[s] = next;
			q[tail++] = s;
			let size = 0;
			while (head < tail) {
				const i = q[head++];
				size++;
				const x = i % w;
				const y = i / w | 0;
				const nb = [
					x > 0 ? i - 1 : -1,
					x < w - 1 ? i + 1 : -1,
					y > 0 ? i - w : -1,
					y < h - 1 ? i + w : -1
				];
				for (const j of nb) if (j >= 0 && data[j] === 0 && !labels[j]) {
					labels[j] = next;
					q[tail++] = j;
				}
			}
			sizes.push(size);
			next++;
		}
		return {
			labels,
			sizes
		};
	}
};
/** マスクを k セル膨張（allowed に含まれるセルのみ） */
function dilateMask(mask, w, h, k, allowed) {
	let cur = mask;
	for (let it = 0; it < k; it++) {
		const nxt = cur.slice();
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (cur[i]) continue;
			if (allowed && !allowed(i)) continue;
			if (x > 0 && cur[i - 1] || x < w - 1 && cur[i + 1] || y > 0 && cur[i - w] || y < h - 1 && cur[i + w] || x > 0 && y > 0 && cur[i - w - 1] || x < w - 1 && y > 0 && cur[i - w + 1] || x > 0 && y < h - 1 && cur[i + w - 1] || x < w - 1 && y < h - 1 && cur[i + w + 1]) nxt[i] = 1;
		}
		cur = nxt;
	}
	return cur;
}
function erodeMask(mask, w, h, k) {
	const inv = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
	const d = dilateMask(inv, w, h, k);
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) out[i] = d[i] ? 0 : 1;
	return out;
}
/**
* マスクの境界をたどって多角形（mm座標）を返す。外周ループのみ、面積の大きい順。
*/
function traceMask(mask, grid, simplifyTol) {
	const { w, h } = grid;
	const next = /* @__PURE__ */ new Map();
	const key = (x, y) => y * (w + 1) + x;
	const addEdge = (x0, y0, x1, y1) => {
		const k0 = key(x0, y0);
		if (!next.has(k0)) next.set(k0, []);
		next.get(k0).push(key(x1, y1));
	};
	const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		if (!at(x, y)) continue;
		if (!at(x, y - 1)) addEdge(x + 1, y, x, y);
		if (!at(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1);
		if (!at(x - 1, y)) addEdge(x, y, x, y + 1);
		if (!at(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y);
	}
	const loops = [];
	const unkey = (k) => [k % (w + 1), Math.floor(k / (w + 1))];
	while (next.size) {
		const startK = next.keys().next().value;
		const loop = [startK];
		let cur = startK;
		let prevDir = null;
		for (let guard = 0; guard < 4 * w * h + 10; guard++) {
			const outs = next.get(cur);
			if (!outs || !outs.length) break;
			let idx = 0;
			if (outs.length > 1 && prevDir) {
				const [cx, cy] = unkey(cur);
				let best = -Infinity;
				outs.forEach((o, oi) => {
					const [nx, ny] = unkey(o);
					const dx = nx - cx;
					const dy = ny - cy;
					const crossv = prevDir[0] * dy - prevDir[1] * dx;
					if (crossv > best) {
						best = crossv;
						idx = oi;
					}
				});
			}
			const nk = outs.splice(idx, 1)[0];
			if (!outs.length) next.delete(cur);
			const [cx, cy] = unkey(cur);
			const [nx, ny] = unkey(nk);
			prevDir = [nx - cx, ny - cy];
			cur = nk;
			if (cur === startK) break;
			loop.push(cur);
		}
		if (loop.length >= 4) {
			const pts = loop.map((k) => {
				const [x, y] = unkey(k);
				return {
					x: grid.ox + x * grid.res,
					y: grid.oy + y * grid.res
				};
			});
			loops.push(pts);
		}
	}
	const tol = simplifyTol ?? grid.res * 1.2;
	return loops.map((l) => simplifyClosed(removeCollinear(l, .01), tol)).filter((l) => l.length >= 3 && Math.abs(polygonArea(l)) > grid.res * grid.res * 4).sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}
//#endregion
//#region src/parser/rasterWalls.ts
var DEFAULTS = {
	closeRadius: 4,
	minThickness: 60,
	maxThickness: 330,
	minLength: 450
};
/** 線分を画像に描く（太さ width mm） */
function rasterizeSegments(segs, bbox, res, margin = 600) {
	const ox = bbox.minX - margin;
	const oy = bbox.minY - margin;
	const w = Math.ceil((bbox.maxX - bbox.minX + margin * 2) / res);
	const h = Math.ceil((bbox.maxY - bbox.minY + margin * 2) / res);
	const data = new Uint8Array(w * h);
	for (const s of segs) {
		const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
		const n = Math.max(1, Math.ceil(L / (res * .5)));
		const r = Math.max(0, Math.floor((s.width || 0) / 2 / res));
		for (let k = 0; k <= n; k++) {
			const x = Math.floor((s.a.x + (s.b.x - s.a.x) * k / n - ox) / res);
			const y = Math.floor((s.a.y + (s.b.y - s.a.y) * k / n - oy) / res);
			for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < w && yy < h) data[yy * w + xx] = 1;
			}
		}
	}
	return {
		data,
		w,
		h,
		res,
		ox,
		oy
	};
}
/** 線分の向きの主な角度（長さで重み付け、0〜180度） */
function dominantAngles(segs, minFrac = .06) {
	const bins = /* @__PURE__ */ new Float64Array(360);
	for (const s of segs) {
		const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
		if (L < 100) continue;
		let a = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * 180 / Math.PI;
		a = (a % 180 + 180) % 180;
		bins[Math.floor(a * 2) % 360] += L;
	}
	const sm = /* @__PURE__ */ new Float64Array(360);
	for (let i = 0; i < 360; i++) for (let d = -4; d <= 4; d++) sm[i] += bins[(i + d + 360) % 360] * (1 - Math.abs(d) / 5);
	const max = Math.max(...sm);
	const peaks = [];
	for (let i = 0; i < 360; i++) {
		const v = sm[i];
		if (v < max * minFrac) continue;
		let isPeak = true;
		for (let d = -8; d <= 8 && isPeak; d++) if (d && sm[(i + d + 360) % 360] > v) isPeak = false;
		if (isPeak && peaks.every((p) => Math.min(Math.abs(p - i / 2), 180 - Math.abs(p - i / 2)) > 4)) peaks.push(i / 2 + .25);
	}
	return peaks;
}
/** 画像から壁を検出する */
function detectWallsRaster(img, anglesDeg, opts = {}) {
	const O = {
		...DEFAULTS,
		...opts
	};
	const { w, h, res } = img;
	const closed = erodeMask(dilateMask(img.data, w, h, O.closeRadius), w, h, O.closeRadius);
	const groups = anglesDeg.map((deg) => {
		const th = deg * Math.PI / 180;
		return {
			theta: th,
			u: {
				x: Math.cos(th),
				y: Math.sin(th)
			},
			n: {
				x: -Math.sin(th),
				y: Math.cos(th)
			}
		};
	});
	const pieces = [];
	const openings = [];
	const corners = [
		{
			x: img.ox,
			y: img.oy
		},
		{
			x: img.ox + w * res,
			y: img.oy
		},
		{
			x: img.ox,
			y: img.oy + h * res
		},
		{
			x: img.ox + w * res,
			y: img.oy + h * res
		}
	];
	const minRun = Math.ceil(O.minLength / res);
	groups.forEach((g, gi) => {
		const ts = corners.map((p) => p.x * g.u.x + p.y * g.u.y);
		const os = corners.map((p) => p.x * g.n.x + p.y * g.n.y);
		const t0 = Math.min(...ts);
		const o0 = Math.min(...os);
		const W = Math.ceil((Math.max(...ts) - t0) / res);
		const H = Math.ceil((Math.max(...os) - o0) / res);
		const sample = (ti, oi) => {
			const t = t0 + (ti + .5) * res;
			const o = o0 + (oi + .5) * res;
			const x = Math.floor((g.u.x * t + g.n.x * o - img.ox) / res);
			const y = Math.floor((g.u.y * t + g.n.y * o - img.oy) / res);
			return x >= 0 && y >= 0 && x < w && y < h ? closed[y * w + x] : 0;
		};
		const rows = [];
		for (let oi = 0; oi < H; oi++) {
			const runs = [];
			let start = -1;
			let gap = 0;
			for (let ti = 0; ti <= W; ti++) if (ti < W ? sample(ti, oi) : 0) {
				if (start < 0) start = ti;
				gap = 0;
			} else if (start >= 0) {
				gap++;
				if (gap > 1 || ti === W) {
					const end = ti - gap;
					if (end - start + 1 >= minRun) runs.push({
						a: start,
						b: end
					});
					start = -1;
					gap = 0;
				}
			}
			rows.push(runs);
		}
		const done = [];
		let active = [];
		for (let oi = 0; oi < H; oi++) {
			const next = [];
			const used = /* @__PURE__ */ new Set();
			for (const r of rows[oi]) {
				const b = active.find((bd) => !used.has(bd) && bd.last.some((q) => Math.min(q.b, r.b) - Math.max(q.a, r.a) >= .5 * Math.min(q.b - q.a, r.b - r.a)));
				if (b) {
					used.add(b);
					b.rows.push([r]);
					b.last = [r];
					next.push(b);
				} else {
					const nb = {
						first: oi,
						rows: [[r]],
						last: [r]
					};
					next.push(nb);
				}
			}
			for (const b of active) if (!next.includes(b)) done.push(b);
			active = next;
		}
		done.push(...active);
		const minRows = Math.max(2, Math.round(O.minThickness / res));
		const maxRows = Math.round(O.maxThickness / res);
		for (const b of done) {
			const n = b.rows.length;
			if (n < minRows || n > maxRows) continue;
			const lo = Math.min(...b.rows.map((rs) => rs[0].a));
			const hi = Math.max(...b.rows.map((rs) => rs[0].b));
			const cover = new Int32Array(hi - lo + 2);
			for (const rs of b.rows) for (const r of rs) for (let t = r.a; t <= r.b; t++) cover[t - lo]++;
			let s = -1;
			for (let t = lo; t <= hi + 1; t++) {
				const ok = t <= hi && cover[t - lo] * 2 >= n;
				if (ok && s < 0) s = t;
				if (!ok && s >= 0) {
					if (t - s >= minRun) pieces.push({
						g: gi,
						o: o0 + (b.first + n / 2) * res,
						d: n * res,
						t0: t0 + s * res,
						t1: t0 + t * res
					});
					s = -1;
				}
			}
		}
	});
	const byAxis = /* @__PURE__ */ new Map();
	for (const p of pieces) {
		const k = `${p.g}:${Math.round(p.o / 60)}`;
		if (!byAxis.has(k)) byAxis.set(k, []);
		byAxis.get(k).push(p);
	}
	for (const ps of byAxis.values()) {
		ps.sort((a, b) => a.t0 - b.t0);
		for (let i = 1; i < ps.length; i++) {
			const gap = ps[i].t0 - ps[i - 1].t1;
			if (gap > 150 && gap <= 2600 && Math.abs(ps[i].o - ps[i - 1].o) < 60) openings.push({
				g: ps[i].g,
				o: (ps[i].o + ps[i - 1].o) / 2,
				d: (ps[i].d + ps[i - 1].d) / 2,
				t0: ps[i - 1].t1,
				t1: ps[i].t0,
				kind: "open",
				confidence: .4
			});
		}
	}
	return {
		groups,
		pieces,
		openings,
		thicknessPeaks: [...new Set(pieces.map((p) => Math.round(p.d / 10) * 10))],
		heavyThreshold: null,
		heavyPairedFrac: 1
	};
}
/**
* スキャン画像（グレー）から太い線（壁）だけの2値画像を作る。
* 2値化してから k 画素の収縮→膨張（オープニング）で、寸法線・家具・文字・手書きなどの細い線を消す。
*/
function thickStrokeMask(gray, w, h, k, threshold, closeFirst = 0) {
	let th = threshold;
	if (th == null) {
		const hist = /* @__PURE__ */ new Float64Array(256);
		for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
		const total = gray.length;
		let sum = 0;
		for (let i = 0; i < 256; i++) sum += i * hist[i];
		let sumB = 0;
		let wB = 0;
		let best = 0;
		th = 128;
		for (let t = 0; t < 256; t++) {
			wB += hist[t];
			if (!wB) continue;
			const wF = total - wB;
			if (!wF) break;
			sumB += t * hist[t];
			const mB = sumB / wB;
			const mF = (sum - sumB) / wF;
			const between = wB * wF * (mB - mF) * (mB - mF);
			if (between > best) {
				best = between;
				th = t;
			}
		}
		th = Math.min(th, 150);
	}
	const bin = new Uint8Array(w * h);
	for (let i = 0; i < bin.length; i++) bin[i] = gray[i] < th ? 1 : 0;
	return dilateMask(erodeMask(closeFirst > 0 ? erodeMask(dilateMask(bin, w, h, closeFirst), w, h, closeFirst) : bin, w, h, k), w, h, k);
}
/** 2値画像の主な線の向き（度）。投影の鋭さで評価（縮小した点で粗く→細かく） */
function dominantAnglesFromMask(mask, w, h, maxPeaks = 3) {
	const pts = [];
	const step = Math.max(1, Math.round(Math.sqrt(w * h / 4e5)));
	for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (mask[y * w + x]) pts.push({
		x,
		y
	});
	if (pts.length < 50) return [];
	const score = (deg) => {
		const th = deg * Math.PI / 180;
		const nx = -Math.sin(th);
		const ny = Math.cos(th);
		const bins = /* @__PURE__ */ new Map();
		for (const p of pts) {
			const k = Math.round((p.x * nx + p.y * ny) / (step * 1.5));
			bins.set(k, (bins.get(k) ?? 0) + 1);
		}
		let s = 0;
		for (const v of bins.values()) s += v * v;
		return s;
	};
	const coarse = [];
	for (let d = 0; d < 180; d += 1) coarse.push({
		d,
		s: score(d)
	});
	const base = coarse.reduce((a, c) => a + c.s, 0) / coarse.length;
	const peaks = [];
	const sorted = coarse.slice().sort((a, b) => b.s - a.s);
	for (const c of sorted) {
		if (peaks.length >= maxPeaks) break;
		if (c.s < base * 1.6 || c.s < sorted[0].s * .35) break;
		if (peaks.some((p) => Math.min(Math.abs(p - c.d), 180 - Math.abs(p - c.d)) < 5)) continue;
		let bd = c.d;
		let bs = c.s;
		for (let d = c.d - 1; d <= c.d + 1; d += .1) {
			const s = score(d);
			if (s > bs) {
				bs = s;
				bd = d;
			}
		}
		peaks.push((bd % 180 + 180) % 180);
	}
	return peaks;
}
/**
* 向きを自動で求めて壁を検出する。主な向き（縦横）の壁を取り除いた残りから、斜めの壁など別の向きも探す
*/
function detectWallsRasterAuto(img, opts = {}) {
	const ang = dominantAnglesFromMask(img.data, img.w, img.h);
	if (!ang.length) return null;
	const det = detectWallsRaster(img, ang, opts);
	const rest = img.data.slice();
	const clearPiece = (g, q, pad) => {
		const L = q.t1 - q.t0;
		const n = Math.ceil(L / (img.res * .5));
		const hw = q.d / 2 + pad;
		const m = Math.ceil(hw / (img.res * .5));
		for (let i = 0; i <= n; i++) {
			const t = q.t0 + L * i / n;
			for (let j = -m; j <= m; j++) {
				const o = q.o + hw * j / m;
				const x = Math.floor((g.u.x * t + g.n.x * o - img.ox) / img.res);
				const y = Math.floor((g.u.y * t + g.n.y * o - img.oy) / img.res);
				if (x >= 0 && y >= 0 && x < img.w && y < img.h) rest[y * img.w + x] = 0;
			}
		}
	};
	for (const q of det.pieces) clearPiece(det.groups[q.g], q, img.res * 2);
	const ang2 = dominantAnglesFromMask(rest, img.w, img.h, 2).filter((a) => ang.every((b) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b)) > 5));
	if (ang2.length) {
		const det2 = detectWallsRaster({
			...img,
			data: rest
		}, ang2, opts);
		const off = det.groups.length;
		det.groups.push(...det2.groups);
		det.pieces.push(...det2.pieces.map((q) => ({
			...q,
			g: q.g + off
		})));
		det.openings.push(...det2.openings.map((q) => ({
			...q,
			g: q.g + off
		})));
	}
	return det;
}
//#endregion
//#region src/parser/labels.ts
function normalizeText(s) {
	return s.replace(/[０-９Ａ-Ｚａ-ｚ．，：／＝（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/\s+/g, "").toUpperCase();
}
var RULES = [
	[/吹抜|吹き抜け|VOID/, "void"],
	[/中庭|坪庭|光庭|ライトコート|COURT|^庭[①-⑳0-9]*$/, "balcony"],
	[/土間収納|シューズ(クローク|クローゼット|イン|ボックス)?|^S\.?I\.?C|^S\.?C\.?L|^S\.?C$|^S\.?B$|玄関収納/, "storage"],
	[/パントリー|PANTRY|^PAN$|^P\.?T$|食品庫/, "storage"],
	[/ファミリークローゼット|ファミクロ|^F\.?C\.?L|^F\.?C$/, "closet"],
	[/W\.?I\.?C|W\.?I\.?C\.?L|ウォークイン|ウォーク・イン|W\.?C\.?L|クローゼット|クロゼット|^CL\d*$|^C\.?L\d*$|^CLO$|押入|押し入れ|床の間|仏間|^物$|^収$/, "closet"],
	[/^L\.?D\.?K|LDK|リビング.*ダイニング.*キッチン/, "ldk"],
	[/^L\.?D$|^LD\b|^LD\d|リビングダイニング|リビング・ダイニング/, "ldk"],
	[/^D\.?K$|^DK\d|ダイニングキッチン/, "dining"],
	[/リビング|居間|LIVING|^L$|ファミリースペース|くつろぎ/, "living"],
	[/ダイニング|食堂|DINING|^D$/, "dining"],
	[/キッチン|台所|KITCHEN|^K$|^KIT$/, "kitchen"],
	[/和室|座敷|客間|茶の間|畳コーナー|畳スペース|タタミ|小上がり|小上り|^畳$/, "japanese"],
	[/子供|子ども|こども|キッズ|子室|KIDS|CHILD/, "kids"],
	[/主寝室|寝室|ベッドルーム|MBR|BEDROOM|^BR\d*$|^B\.?R\d*$/, "bedroom"],
	[/洋室|個室|^室\d*$|^居室|ゲストルーム|GUEST/, "bedroom"],
	[/書斎|ワーク|スタディ|STUDY|^DEN$|趣味|ヌック|NOOK|テレワーク|WORK|ライブラリー|シアター/, "study"],
	[/浴室|バスルーム|^バス$|風呂|^UB$|^U\.?B$|ユニットバス|BATH|^浴$/, "bath"],
	[/洗面|脱衣|ランドリー|家事室|サニタリー|UTILITY|ユーティリティ|^UT$|^U\.?T$|洗濯|^洗$|LAUNDRY|ドレッサー|身支度/, "washroom"],
	[/トイレ|便所|^W\.?C$|TOILET|^WC\d*$|^トイ$|化粧室/, "toilet"],
	[/玄関|エントランス|土間|ENTRANCE|^ENT$/, "entrance"],
	[/ホール|廊下|HALL|ろうか|通路/, "hall"],
	[/階段|STAIRS?/, "stairs"],
	[/納戸|物入|収納|^S$|^P\.?S$|物置|倉庫|STORAGE|^収$|ロフト|LOFT|小屋裏|グルニエ|^ST$/, "storage"],
	[/バルコニー|ベランダ|テラス|ルーフバルコニー|デッキ|BALCONY|屋上|インナーバルコニー|ガーデン|ルーフ|^OPEN$|物干/, "balcony"],
	[/ポーチ|PORCH/, "porch"],
	[/ガレージ|車庫|ビルトイン|GARAGE|カーポート/, "garage"]
];
function classifyRoomName(raw) {
	const s = normalizeText(raw);
	if (!s) return null;
	for (const [re, t] of RULES) if (re.test(s)) return t;
	return null;
}
/** 「20.0帖」「6畳」「12.5J」「16.56㎡」 */
function parseAreaLabel(raw) {
	const s = normalizeText(raw);
	let m = /(\d+(?:\.\d+)?)(?:帖|畳|J|じょう|ジョウ)/.exec(s);
	if (m) return { tatami: parseFloat(m[1]) };
	m = /(\d+(?:\.\d+)?)(?:㎡|M2|M²|平米)/.exec(s);
	if (m) return { m2: parseFloat(m[1]) };
	return null;
}
function parseStairMark(raw) {
	const s = normalizeText(raw);
	if (/^(UP|上り?|↑)$/.test(s)) return "up";
	if (/^(DN|DOWN|下り?|↓)$/.test(s)) return "down";
	return null;
}
/** 「1階平面図」「2F」「１Ｆ平面図」→ 階数 */
function parseFloorTitle(raw) {
	const s = normalizeText(raw);
	const kanji = {
		一: 1,
		二: 2,
		三: 3,
		地下: -1
	};
	let m = /([1-4])(?:階|F|FL)(?:平面|PLAN|$)/.exec(s);
	if (m) return parseInt(m[1], 10);
	m = /(一|二|三)階/.exec(s);
	if (m) return kanji[m[1]];
	m = /^([1-4])F$/.exec(s);
	if (m) return parseInt(m[1], 10);
	if (/屋根伏|ROOF/.test(s)) return null;
	return null;
}
/** サッシ記号の高さ記号 → 内法高さ (mm)。幅は上 3 桁 ×10 */
var SASH_HEIGHT = {
	"03": 370,
	"05": 570,
	"07": 770,
	"09": 970,
	"11": 1170,
	"13": 1370,
	"15": 1570,
	"18": 1830,
	"20": 2030,
	"22": 2230,
	"24": 2430
};
/** 「16511」「07405」などのサッシ記号 → 幅・高さ (mm) */
function parseSashCode(raw) {
	const s = normalizeText(raw).replace(/^[A-Z]{1,2}[-・]?/, "");
	const m = /^(\d{3})(\d{2})$/.exec(s);
	if (!m) return null;
	const width = parseInt(m[1], 10) * 10;
	const height = SASH_HEIGHT[m[2]];
	if (!height || width < 300 || width > 4500) return null;
	return {
		width,
		height
	};
}
/** 「FL+2000」「FL+900」→ 床からの高さ (mm) */
function parseFlOffset(raw) {
	const s = normalizeText(raw);
	const m = /^FL\+?(\d{3,4})$/.exec(s);
	if (!m) return null;
	const v = parseInt(m[1], 10);
	return v >= 100 && v <= 2600 ? v : null;
}
/** 「14段」「１４段」→ 段数 */
function parseStepCount(raw) {
	const s = normalizeText(raw);
	const m = /^(\d{1,2})段$/.exec(s);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	return n >= 8 && n <= 24 ? n : null;
}
/** 「開口」（建具の無い開口部）の注記 */
function isOpenMark(raw) {
	const s = normalizeText(raw);
	return /^開口(部)?$/.test(s) || /^(OPEN|W\/O)$/.test(s);
}
/** 「FIX」「引違」「片開」などの建具種別の注記 */
function parseSashKind(raw) {
	const s = normalizeText(raw);
	if (/^FIX$|^はめ殺し$|^嵌め殺し$/.test(s)) return "fix";
	if (/^引違い?$|^引き違い$|^引戸$|^引き戸$/.test(s)) return "sliding";
	if (/^片開き?$|^両開き?$|^開き戸$/.test(s)) return "swing";
	return null;
}
//#endregion
//#region src/parser/stairs.ts
function detectStairs(segs, within) {
	const treads = [];
	for (const s of segs) {
		if (s.dashed) continue;
		const dx = s.b.x - s.a.x;
		const dy = s.b.y - s.a.y;
		const L = Math.hypot(dx, dy);
		if (L < 450 || L > 1600) continue;
		const mx = (s.a.x + s.b.x) / 2;
		const my = (s.a.y + s.b.y) / 2;
		if (mx < within.minX || mx > within.maxX || my < within.minY || my > within.maxY) continue;
		if (Math.abs(dy) < L * .01) treads.push({
			o: my,
			t0: Math.min(s.a.x, s.b.x),
			t1: Math.max(s.a.x, s.b.x),
			orient: "h"
		});
		else if (Math.abs(dx) < L * .01) treads.push({
			o: mx,
			t0: Math.min(s.a.y, s.b.y),
			t1: Math.max(s.a.y, s.b.y),
			orient: "v"
		});
	}
	const runs = [];
	for (const orient of ["h", "v"]) {
		const ts = treads.filter((t) => t.orient === orient).sort((a, b) => a.o - b.o);
		const used = /* @__PURE__ */ new Set();
		for (const t of ts) {
			if (used.has(t)) continue;
			const chain = [t];
			let last = t;
			for (const c of ts) {
				if (c.o <= last.o + 1) continue;
				const sp = c.o - last.o;
				if (sp > 330) break;
				if (sp < 150) continue;
				if (Math.min(c.t1, last.t1) - Math.max(c.t0, last.t0) < Math.min(c.t1 - c.t0, last.t1 - last.t0) * .8) continue;
				if (chain.length >= 2) {
					const prevSp = chain[chain.length - 1].o - chain[chain.length - 2].o;
					if (Math.abs(sp - prevSp) > 25) continue;
				}
				chain.push(c);
				last = c;
			}
			if (chain.length >= 4) {
				chain.forEach((c) => used.add(c));
				runs.push({
					orient,
					items: chain
				});
			}
		}
	}
	const boxes = runs.map((r) => {
		const os = r.items.map((i) => i.o);
		const t0 = Math.min(...r.items.map((i) => i.t0));
		const t1 = Math.max(...r.items.map((i) => i.t1));
		return r.orient === "h" ? {
			minX: t0,
			maxX: t1,
			minY: Math.min(...os),
			maxY: Math.max(...os),
			n: r.items.length,
			orient: r.orient
		} : {
			minX: Math.min(...os),
			maxX: Math.max(...os),
			minY: t0,
			maxY: t1,
			n: r.items.length,
			orient: r.orient
		};
	});
	const out = [];
	const used = /* @__PURE__ */ new Set();
	boxes.forEach((b, i) => {
		if (used.has(i)) return;
		const merged = {
			...b,
			flights: 1
		};
		used.add(i);
		boxes.forEach((c, j) => {
			if (used.has(j)) return;
			const gapX = Math.max(0, c.minX - merged.maxX, merged.minX - c.maxX);
			const gapY = Math.max(0, c.minY - merged.maxY, merged.minY - c.maxY);
			if (gapX < 350 && gapY < 350) {
				merged.minX = Math.min(merged.minX, c.minX);
				merged.minY = Math.min(merged.minY, c.minY);
				merged.maxX = Math.max(merged.maxX, c.maxX);
				merged.maxY = Math.max(merged.maxY, c.maxY);
				merged.n += c.n;
				merged.flights++;
				used.add(j);
			}
		});
		out.push({
			minX: merged.minX,
			minY: merged.minY,
			maxX: merged.maxX,
			maxY: merged.maxY,
			treadCount: merged.n,
			treadOrient: merged.orient,
			flights: merged.flights
		});
	});
	return out;
}
/**
* 昇り口を図面の矢印（UP／DN の矢印線）から読む。御社の図面（ARCHITREND）は昇り口に UP（上階は DN）の文字を置き、
* 階段の中を矢印の線が昇る向きに走り、矢じり（短い 2 本の線）が先端につく。
* 矢印の始点には小さな丸が付き、その横に UP／DN の文字が置かれる（丸は細かすぎて線として残らないので文字を使う）。
*  1. UP／DN の文字が階段のそばにあれば、文字にいちばん近い辺
*  2. 文字が無ければ、階段の中の長い線（矢印の軸）の端の矢じりを探し、軸をたどった反対の端
*     （ジグザグの切断線も短い斜め線なので、文字が無いときだけ使う）
* 読めなければ null（壁の少ない辺にフォールバック）
*/
function stairEntryFromArrow(r, segs, marks) {
	const pad = 160;
	const inside = (p) => p.x >= r.minX - pad && p.x <= r.maxX + pad && p.y >= r.minY - pad && p.y <= r.maxY + pad;
	const W = r.maxX - r.minX;
	const H = r.maxY - r.minY;
	const sideOf = (p) => {
		return [
			["n", p.y - r.minY],
			["s", r.maxY - p.y],
			["w", p.x - r.minX],
			["e", r.maxX - p.x]
		].sort((a, b) => a[1] - b[1])[0][0];
	};
	const L = (q) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
	const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= 45;
	const inner = segs.filter((q) => !q.dashed && inside(q.a) && inside(q.b));
	const axes = inner.filter((q) => L(q) >= Math.max(450, Math.min(W, H) * .35));
	const heads = inner.filter((q) => L(q) >= 60 && L(q) <= 420);
	const headAt = (ax, end) => {
		const dx = (ax.b.x - ax.a.x) / (L(ax) || 1);
		const dy = (ax.b.y - ax.a.y) / (L(ax) || 1);
		let n = 0;
		for (const h of heads) {
			if (h === ax) continue;
			const touch = near(h.a, end) ? h.b : near(h.b, end) ? h.a : null;
			if (!touch) continue;
			const hl = Math.hypot(touch.x - end.x, touch.y - end.y) || 1;
			const c = Math.abs(((touch.x - end.x) * dx + (touch.y - end.y) * dy) / hl);
			if (c >= .25 && c <= .97) n++;
		}
		return n;
	};
	const m = marks.map((t) => ({
		t,
		d: Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY))
	})).filter((q) => q.d <= 500).sort((a, b) => a.d - b.d)[0];
	if (m) return sideOf(m.t);
	let best = null;
	for (const ax of axes) for (const [end, other] of [[ax.a, ax.b], [ax.b, ax.a]]) {
		const n = headAt(ax, end);
		if (!n) continue;
		let tail = other;
		const used = /* @__PURE__ */ new Set([ax]);
		for (let hop = 0; hop < 4; hop++) {
			const next = axes.find((q) => !used.has(q) && (near(q.a, tail) || near(q.b, tail)));
			if (!next) break;
			used.add(next);
			tail = near(next.a, tail) ? next.b : next.a;
		}
		if (!best || n > best.n) best = {
			tail,
			n
		};
	}
	return best ? sideOf(best.tail) : null;
}
//#endregion
//#region src/parser/site.ts
var ROAD_RE = /(道路|公道|私道|市道|町道|区道|村道|県道|府道|都道|国道|認定道|位置指定道|前面道)/;
var NOT_ROAD_RE = /斜線|後退距離|道路高さ|ドウロシャセン/;
var SIDES = [
	"top",
	"right",
	"bottom",
	"left"
];
var SIDE_VEC = {
	top: {
		x: 0,
		y: -1
	},
	right: {
		x: 1,
		y: 0
	},
	bottom: {
		x: 0,
		y: 1
	},
	left: {
		x: -1,
		y: 0
	}
};
/** 方位（北・南東など）→ 図面の辺 */
function compassToSide(word, northAngleDeg) {
	const a = northAngleDeg * Math.PI / 180;
	const n = {
		x: Math.sin(a),
		y: -Math.cos(a)
	};
	const e = {
		x: Math.cos(a),
		y: Math.sin(a)
	};
	let v = {
		x: 0,
		y: 0
	};
	for (const ch of word) {
		if (ch === "北") v = {
			x: v.x + n.x,
			y: v.y + n.y
		};
		if (ch === "南") v = {
			x: v.x - n.x,
			y: v.y - n.y
		};
		if (ch === "東") v = {
			x: v.x + e.x,
			y: v.y + e.y
		};
		if (ch === "西") v = {
			x: v.x - e.x,
			y: v.y - e.y
		};
	}
	if (Math.hypot(v.x, v.y) < .1) return null;
	return nearestSide(v);
}
function nearestSide(v) {
	let best = "bottom";
	let bd = -Infinity;
	for (const s of SIDES) {
		const d = v.x * SIDE_VEC[s].x + v.y * SIDE_VEC[s].y;
		if (d > bd) {
			bd = d;
			best = s;
		}
	}
	return best;
}
/** 「幅員4.0m」「W=6000」「6m道路」→ mm */
function parseRoadWidth(raw) {
	const s = normalizeText(raw).replace(/ｍ/g, "M");
	const m = /(?:幅員|巾員|W=|巾)[:：]?(\d+(?:\.\d+)?)(M|MM)?/.exec(s) ?? /(\d+(?:\.\d+)?)(M)(?:道路|公道|私道|市道|町道|区道|県道|国道)/.exec(s);
	if (!m) return null;
	const v = parseFloat(m[1]);
	if (!Number.isFinite(v) || v <= 0) return null;
	const mm = m[2] === "MM" || v >= 500 ? v : v * 1e3;
	return mm >= 1800 && mm <= 6e4 ? mm : null;
}
function parseSiteArea(raw) {
	const s = normalizeText(raw).replace(/,/g, "");
	const m = /敷地面積[:：]?(\d+(?:\.\d+)?)(?:㎡|M2|M²|平米)/.exec(s);
	return m ? parseFloat(m[1]) : null;
}
/** 辺に平行な長い線（破線は区間をつないで評価） */
function parallelLines(segs, side, bbox) {
	const horizontal = side === "top" || side === "bottom";
	const span0 = horizontal ? bbox.minX : bbox.minY;
	const span1 = horizontal ? bbox.maxX : bbox.maxY;
	const buckets = /* @__PURE__ */ new Map();
	for (const s of segs) {
		const dx = s.b.x - s.a.x;
		const dy = s.b.y - s.a.y;
		const len = Math.hypot(dx, dy);
		if (len < 30) continue;
		if (horizontal ? Math.abs(dy) > len * .02 : Math.abs(dx) > len * .02) continue;
		const pos = horizontal ? (s.a.y + s.b.y) / 2 : (s.a.x + s.b.x) / 2;
		const t0 = horizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y);
		const t1 = horizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
		const key = Math.round(pos / 40);
		const b = buckets.get(key) ?? {
			pos,
			ivs: [],
			dashed: 0,
			total: 0
		};
		b.ivs.push([t0, t1]);
		b.total += len;
		if (s.dashed || len < 1500) b.dashed += len;
		buckets.set(key, b);
	}
	const out = [];
	for (const b of buckets.values()) {
		const ivs = b.ivs.sort((p, q) => p[0] - q[0]);
		const merged = [];
		for (const iv of ivs) {
			const last = merged[merged.length - 1];
			if (last && iv[0] <= last[1] + 1200) last[1] = Math.max(last[1], iv[1]);
			else merged.push([iv[0], iv[1]]);
		}
		let cover = 0;
		for (const [a, c] of merged) cover += Math.max(0, Math.min(c, span1) - Math.max(a, span0));
		out.push({
			pos: b.pos,
			cover: cover / Math.max(1, span1 - span0),
			dashed: b.dashed > b.total * .5
		});
	}
	return out.filter((l) => l.cover >= .6);
}
/** 建物外形の外側で、辺の方向に何 mm 離れているか（その辺の外側でなければ負） */
function outsideDist(side, bbox, pos) {
	switch (side) {
		case "top": return bbox.minY - pos;
		case "bottom": return pos - bbox.maxY;
		case "left": return bbox.minX - pos;
		case "right": return pos - bbox.maxX;
	}
}
function detectSite(texts, segs, bbox, northAngleDeg) {
	const roads = /* @__PURE__ */ new Map();
	let areaM2;
	for (const t of texts) {
		const s = normalizeText(t.str);
		const area = parseSiteArea(t.str);
		if (area) areaM2 = area;
		if (!ROAD_RE.test(s) || NOT_ROAD_RE.test(s)) continue;
		let width = parseRoadWidth(t.str);
		if (width == null) for (const q of texts) {
			if (q === t || Math.hypot(q.x - t.x, q.y - t.y) > Math.max(3e3, t.size * 12)) continue;
			const w = parseRoadWidth(q.str);
			if (w) {
				width = w;
				break;
			}
		}
		const cm = /(北東|北西|南東|南西|北|南|東|西)(?:側)?(?:前面)?(?:公道|私道|市道|町道|区道|県道|国道|道路|接道|前面道)/.exec(s) ?? /接道[:：]?(北東|北西|南東|南西|北|南|東|西)/.exec(s);
		let side = cm ? compassToSide(cm[1], northAngleDeg) : null;
		let source = "compass";
		let dist = Infinity;
		const ox = t.x < bbox.minX ? bbox.minX - t.x : t.x > bbox.maxX ? t.x - bbox.maxX : 0;
		const oy = t.y < bbox.minY ? bbox.minY - t.y : t.y > bbox.maxY ? t.y - bbox.maxY : 0;
		const near = Math.max(ox, oy) > 0 && Math.max(ox, oy) < 3e4;
		if (!side && near) {
			side = ox > oy ? t.x < bbox.minX ? "left" : "right" : t.y < bbox.minY ? "top" : "bottom";
			source = "text";
			dist = Math.max(ox, oy);
		} else if (side && near) {
			source = "text";
			dist = Math.max(ox, oy);
		}
		if (!side) continue;
		const prev = roads.get(side);
		if (!prev || width && !prev.widthMm || dist < prev.textDist) roads.set(side, {
			side,
			widthMm: width ?? prev?.widthMm,
			label: t.str,
			source,
			textDist: dist
		});
	}
	const bounds = {};
	for (const [side, r] of roads) {
		if (!Number.isFinite(r.textDist)) continue;
		const lines = parallelLines(segs, side, bbox).map((l) => ({
			...l,
			d: outsideDist(side, bbox, l.pos)
		})).filter((l) => l.d > 150 && l.d < r.textDist - 200);
		if (!lines.length) continue;
		lines.sort((p, q) => q.d - p.d);
		bounds[side] = lines[0].pos;
	}
	for (const side of SIDES) {
		if (bounds[side] != null) continue;
		const lines = parallelLines(segs, side, bbox).map((l) => ({
			...l,
			d: outsideDist(side, bbox, l.pos)
		})).filter((l) => l.dashed && l.d > 300 && l.d < 12e3).sort((p, q) => q.d - p.d);
		if (lines.length) bounds[side] = lines[0].pos;
	}
	const edges = labeledEdges(texts, segs);
	let polygon;
	let roadList = [...roads.values()].map(({ textDist: _d, ...r }) => r);
	if (edges.length) {
		const c = {
			x: (bbox.minX + bbox.maxX) / 2,
			y: (bbox.minY + bbox.maxY) / 2
		};
		const roadEdges = edges.filter((e) => e.kind === "road");
		if (roadEdges.length) {
			const bySide = /* @__PURE__ */ new Map();
			for (const e of roadEdges) {
				const side = nearestSide({
					x: (e.a.x + e.b.x) / 2 - c.x,
					y: (e.a.y + e.b.y) / 2 - c.y
				});
				const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
				const prev = bySide.get(side);
				if (!prev || len > (prev.len ?? 0)) bySide.set(side, {
					side,
					label: "道路境界線",
					source: "text",
					widthMm: roads.get(side)?.widthMm,
					len
				});
			}
			const widths = roadList.filter((r) => r.widthMm);
			for (const r of bySide.values()) if (!r.widthMm && widths.length === 1) r.widthMm = widths[0].widthMm;
			roadList = [...bySide.values()].map(({ len: _l, ...r }) => r);
		}
		polygon = sitePolygon(edges, c);
		for (const e of edges) {
			const m = {
				x: (e.a.x + e.b.x) / 2,
				y: (e.a.y + e.b.y) / 2
			};
			const side = nearestSide({
				x: m.x - c.x,
				y: m.y - c.y
			});
			const v = side === "left" || side === "right" ? m.x : m.y;
			const cur = bounds[side];
			if (cur == null || (side === "left" || side === "top" ? cur == null || v < cur : cur == null || v > cur)) bounds[side] = v;
		}
		if (polygon) {
			bounds.left = Math.min(...polygon.map((q) => q.x));
			bounds.right = Math.max(...polygon.map((q) => q.x));
			bounds.top = Math.min(...polygon.map((q) => q.y));
			bounds.bottom = Math.max(...polygon.map((q) => q.y));
		}
	}
	if (!roadList.length && !Object.keys(bounds).length && !areaM2 && !edges.length) return null;
	return {
		roads: roadList,
		edges: edges.length ? edges : void 0,
		polygon,
		bounds,
		areaM2
	};
}
/** 境界線の文字に沿った線を探し、同じ直線上の線（1点鎖線の断片）をつないで1本の辺にする */
function labeledEdges(texts, segs) {
	const out = [];
	for (const t of texts) {
		const s = normalizeText(t.str);
		const kind = /道路境界/.test(s) ? "road" : /隣地境界|敷地境界/.test(s) ? "neighbor" : null;
		if (!kind) continue;
		const ang = t.angle ?? 0;
		const dx = Math.cos(ang);
		const dy = Math.sin(ang);
		let best = null;
		let bestD = Math.max(t.size * 3, 500);
		for (const sg of segs) {
			const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
			if (L < 300) continue;
			const ux = (sg.b.x - sg.a.x) / L;
			const uy = (sg.b.y - sg.a.y) / L;
			if (Math.abs(ux * dy - uy * dx) > .07) continue;
			const d = Math.abs((t.x - sg.a.x) * -uy + (t.y - sg.a.y) * ux);
			const tt = (t.x - sg.a.x) * ux + (t.y - sg.a.y) * uy;
			if (tt < -3e3 || tt > L + 3e3) continue;
			if (d < bestD) {
				bestD = d;
				best = sg;
			}
		}
		if (!best) continue;
		const L0 = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y);
		const ux = (best.b.x - best.a.x) / L0;
		const uy = (best.b.y - best.a.y) / L0;
		const ivs = [];
		for (const sg of segs) {
			const offA = (sg.a.x - best.a.x) * -uy + (sg.a.y - best.a.y) * ux;
			const offB = (sg.b.x - best.a.x) * -uy + (sg.b.y - best.a.y) * ux;
			if (Math.abs(offA) > 40 || Math.abs(offB) > 40) continue;
			const ta = (sg.a.x - best.a.x) * ux + (sg.a.y - best.a.y) * uy;
			const tb = (sg.b.x - best.a.x) * ux + (sg.b.y - best.a.y) * uy;
			ivs.push([Math.min(ta, tb), Math.max(ta, tb)]);
		}
		ivs.sort((p, q) => p[0] - q[0]);
		let lo = 0;
		let hi = L0;
		let grew = true;
		while (grew) {
			grew = false;
			for (const [a, b] of ivs) {
				if (b > hi && a <= hi + 1500) {
					hi = b;
					grew = true;
				}
				if (a < lo && b >= lo - 1500) {
					lo = a;
					grew = true;
				}
			}
		}
		const P = (tt) => ({
			x: best.a.x + ux * tt,
			y: best.a.y + uy * tt
		});
		const e = {
			a: P(lo),
			b: P(hi),
			kind
		};
		const dup = out.find((o) => {
			const ol = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
			const ox = (o.b.x - o.a.x) / ol;
			const oy = (o.b.y - o.a.y) / ol;
			return Math.abs((e.a.x - o.a.x) * -oy + (e.a.y - o.a.y) * ox) < 60 && Math.abs(ox * uy - oy * ux) < .02;
		});
		if (dup) {
			if (dup.kind === "neighbor" && kind === "road") dup.kind = "road";
			continue;
		}
		out.push(e);
	}
	return out;
}
/** 境界の辺を建物中心まわりの角度順に並べ、隣り合う辺の交点で敷地の形を作る */
function sitePolygon(edges, c) {
	if (edges.length < 3) return void 0;
	const ang = (e) => Math.atan2((e.a.y + e.b.y) / 2 - c.y, (e.a.x + e.b.x) / 2 - c.x);
	const es = edges.slice().sort((p, q) => ang(p) - ang(q));
	const pts = [];
	for (let i = 0; i < es.length; i++) {
		const A = es[i];
		const B = es[(i + 1) % es.length];
		const d1 = {
			x: A.b.x - A.a.x,
			y: A.b.y - A.a.y
		};
		const d2 = {
			x: B.b.x - B.a.x,
			y: B.b.y - B.a.y
		};
		const den = d1.x * d2.y - d1.y * d2.x;
		if (Math.abs(den) < 1e-6 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) return void 0;
		const t = ((B.a.x - A.a.x) * d2.y - (B.a.y - A.a.y) * d2.x) / den;
		const P = {
			x: A.a.x + d1.x * t,
			y: A.a.y + d1.y * t
		};
		const near = (e) => Math.min(Math.hypot(P.x - e.a.x, P.y - e.a.y), Math.hypot(P.x - e.b.x, P.y - e.b.y));
		if (near(A) > 6e3 || near(B) > 6e3) return void 0;
		pts.push(P);
	}
	return pts;
}
/** 敷地データを平行移動 */
function translateSite(site, dx, dy) {
	const tr = (q) => ({
		x: q.x + dx,
		y: q.y + dy
	});
	if (site.edges) site.edges = site.edges.map((e) => ({
		...e,
		a: tr(e.a),
		b: tr(e.b)
	}));
	if (site.polygon) site.polygon = site.polygon.map(tr);
	const b = site.bounds;
	if (b.left != null) b.left += dx;
	if (b.right != null) b.right += dx;
	if (b.top != null) b.top += dy;
	if (b.bottom != null) b.bottom += dy;
}
//#endregion
//#region src/parser/symbols.ts
/** 端点のつながる細い線をまとめる */
function clusterSegments(segs, maxLen = 2500, minN = 12) {
	const use = segs.filter((s) => s.source !== "fill" && !s.dashed && Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < maxLen);
	const key = (q) => `${Math.round(q.x / 4)},${Math.round(q.y / 4)}`;
	const parent = use.map((_, i) => i);
	const find = (i) => parent[i] === i ? i : parent[i] = find(parent[i]);
	const at = /* @__PURE__ */ new Map();
	use.forEach((s, i) => {
		for (const q of [s.a, s.b]) {
			const k = key(q);
			const j = at.get(k);
			if (j == null) at.set(k, i);
			else {
				const ri = find(i);
				const rj = find(j);
				if (ri !== rj) parent[ri] = rj;
			}
		}
	});
	const groups = /* @__PURE__ */ new Map();
	use.forEach((s, i) => {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, []);
		groups.get(r).push(s);
	});
	const out = [];
	for (const g of groups.values()) {
		if (g.length < minN) continue;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const s of g) for (const q of [s.a, s.b]) {
			if (q.x < minX) minX = q.x;
			if (q.x > maxX) maxX = q.x;
			if (q.y < minY) minY = q.y;
			if (q.y > maxY) maxY = q.y;
		}
		out.push({
			segs: g,
			minX,
			minY,
			maxX,
			maxY
		});
	}
	return out;
}
var within = (v, lo, hi) => v >= lo && v <= hi;
/** 線のまとまりを記号として分類する（部屋の情報は使わず形だけで） */
function detectSymbols(segs) {
	const clusters = clusterSegments(segs, 3400, 4);
	const out = [];
	for (const c of clusters) {
		const w = c.maxX - c.minX;
		const h = c.maxY - c.minY;
		const L = Math.max(w, h);
		const S = Math.min(w, h);
		if (L < 40 || L > 6e3) continue;
		const n = c.segs.length;
		if (n < 12) {
			if (n > 24 || !within(L, 1800, 3400) || !within(S, 550, 1050)) continue;
			let onBorder = 0;
			let total = 0;
			for (const s of c.segs) {
				const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
				total += len;
				const horiz = Math.abs(s.b.y - s.a.y) < 5;
				const vert = Math.abs(s.b.x - s.a.x) < 5;
				if (horiz && (Math.abs(s.a.y - c.minY) < 20 || Math.abs(s.a.y - c.maxY) < 20)) onBorder += len;
				else if (vert && (Math.abs(s.a.x - c.minX) < 20 || Math.abs(s.a.x - c.maxX) < 20)) onBorder += len;
			}
			if (total > 0 && onBorder / total >= .9 && onBorder >= (w + h) * 2 * .9) out.push({
				kind: "counter",
				x: (c.minX + c.maxX) / 2,
				y: (c.minY + c.maxY) / 2,
				w,
				h,
				n
			});
			continue;
		}
		const lens = c.segs.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
		const shortFrac = lens.filter((l) => l < 60).length / n;
		const longest = c.segs[lens.indexOf(Math.max(...lens))];
		const longLen = Math.max(...lens);
		lens.filter((l) => l >= L * .72).length;
		const cx = (c.minX + c.maxX) / 2;
		const cy = (c.minY + c.maxY) / 2;
		const rs = c.segs.map((s) => Math.hypot(s.a.x - cx, s.a.y - cy));
		const rMean = rs.reduce((a, r) => a + r, 0) / rs.length;
		const bump = Math.sqrt(rs.reduce((a, r) => a + (r - rMean) ** 2, 0) / rs.length) / (rMean || 1);
		const base = {
			x: cx,
			y: cy,
			w,
			h,
			n,
			flat: {
				a: longest.a,
				b: longest.b
			}
		};
		let kind = null;
		if (within(L, 4300, 5300) && within(S, 1600, 2350) && n >= 50) kind = "car";
		else if (within(L, 270, 310) && within(S, 40, 70) && n >= 14 && shortFrac > .8) kind = "chairBack";
		else if (within(L, 400, 720) && within(S, 330, 720) && n >= 55 && shortFrac > .55 && bump > .08) kind = "chair";
		else if (within(L, 1900, 2150) && (within(S, 940, 1120) || within(S, 1350, 1800)) && n >= 16 && longLen >= L * .3) kind = "bed";
		else if (within(L, 1300, 1750) && within(S, 640, 860) && n >= 16 && n <= 60 && longLen >= L * .5) kind = "bath";
		else if (within(L, 580, 740) && within(S, 350, 430) && n >= 16 && longLen >= S * .8) kind = "toilet";
		else if (within(L, 540, 740) && within(S, 440, 560) && n >= 12 && n <= 60 && shortFrac > .3) kind = "sink";
		else if (within(L, 1800, 4600) && within(S, 720, 2300) && n >= 40 && n <= 200 && shortFrac > .6 && within(bump, .1, .3)) kind = "sofa";
		else if (n >= 80 && within(L, 300, 2800) && S / L >= .7 && shortFrac > .7 && within(bump, .03, .5)) kind = "plant";
		if (!kind) continue;
		out.push({
			kind,
			...base,
			bump: +bump.toFixed(3),
			shortFrac: +shortFrac.toFixed(2),
			longLen: Math.round(longLen)
		});
	}
	const backs = out.filter((s) => s.kind === "chairBack");
	const seats = out.filter((s) => s.kind === "chair");
	for (const s of seats) {
		const back = backs.find((b) => Math.hypot(b.x - s.x, b.y - s.y) < 280);
		if (back) {
			s.flat = {
				a: {
					x: s.x,
					y: s.y
				},
				b: {
					x: back.x,
					y: back.y
				}
			};
			continue;
		}
		if (s.n >= 200) continue;
		const size = Math.max(s.w, s.h);
		const same = seats.filter((o) => o !== s && Math.abs(Math.max(o.w, o.h) - size) < 40 && Math.abs(Math.min(o.w, o.h) - Math.min(s.w, s.h)) < 40);
		const adjacent = same.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < size + 120);
		const grouped = same.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 1500);
		if (adjacent) s.kind = "sofaModule";
		else if (!grouped) s.kind = s.n >= 130 ? "plant" : "chairBack";
	}
	for (const s of out) if (s.kind === "plant" && (s.bump ?? 0) < .03) s.kind = "chairBack";
	const cars = out.filter((s) => s.kind === "car");
	return out.filter((s) => s.kind === "car" || !cars.some((car) => Math.abs(s.x - car.x) < car.w / 2 && Math.abs(s.y - car.y) < car.h / 2));
}
var DEG$2 = 180 / Math.PI;
/**
* 記号 → 家具（図面どおりの位置と向き）と外構。
* 家具の基準点は「壁側の辺の中央」（FurnitureItem の決まり）なので、記号の中心から奥行き分だけ戻して求める。
*/
function symbolsToItems(symbols, rooms, walls, outline, level, trace) {
	const items = [];
	const exterior = {
		cars: [],
		trees: []
	};
	let seq = 0;
	const id = () => `ps${level}_${++seq}`;
	const roomAt = (p) => rooms.find((r) => pointInPolygon(p, r.polygon));
	const inside = (p) => outline.some((l) => pointInPolygon(p, l));
	const wallDist = (p) => walls.length ? Math.min(...walls.map((w) => distPointSegment(p, w.a, w.b))) : Infinity;
	const unit = (x, y) => {
		const l = Math.hypot(x, y) || 1;
		return {
			x: x / l,
			y: y / l
		};
	};
	/** 単位ベクトル n の向きで、中心から dist 離れた点が壁に近い方（n か -n）を選ぶ */
	const towardWall = (c, n, dist) => {
		const p1 = {
			x: c.x + n.x * dist,
			y: c.y + n.y * dist
		};
		const p2 = {
			x: c.x - n.x * dist,
			y: c.y - n.y * dist
		};
		return wallDist(p1) <= wallDist(p2) ? n : {
			x: -n.x,
			y: -n.y
		};
	};
	/** 並び方向 along と部屋側 inward から rot（度）。along = (cos r, sin r), inward = (-sin r, cos r) */
	const rotOf = (along, inward) => {
		let r = Math.atan2(along.y, along.x) * DEG$2;
		if (along.x * inward.y - along.y * inward.x < 0) r += 180;
		return Math.round((r % 360 + 360) % 360);
	};
	/** その種類の家具があり得る部屋か（車庫の車の部品・玄関の靴箱などの誤認を避ける） */
	const ALLOWED = {
		toilet: [
			"toilet",
			"washroom",
			"other"
		],
		bath: [
			"bath",
			"washroom",
			"other"
		],
		washstand: [
			"washroom",
			"toilet",
			"bath",
			"hall",
			"other",
			"entrance"
		],
		bed: [
			"bedroom",
			"kids",
			"japanese",
			"study",
			"other"
		],
		sofa: [
			"ldk",
			"living",
			"dining",
			"japanese",
			"bedroom",
			"study",
			"other"
		],
		dining: [
			"ldk",
			"living",
			"dining",
			"kitchen",
			"japanese",
			"study",
			"other"
		],
		kitchen: [
			"ldk",
			"kitchen",
			"dining",
			"living",
			"japanese",
			"study",
			"storage",
			"other"
		]
	};
	const push = (kind, c, along, inward, back, extra = {}, roomPoint) => {
		const room = roomAt(roomPoint ?? c);
		if (!room) {
			trace?.push(`drop ${kind}@${Math.round(c.x)},${Math.round(c.y)}: no room`);
			return null;
		}
		const ok = ALLOWED[kind];
		if (ok && !ok.includes(room.type)) {
			trace?.push(`drop ${kind}@${Math.round(c.x)},${Math.round(c.y)}: room ${room.name}/${room.type}`);
			return null;
		}
		const origin = {
			x: c.x - inward.x * back,
			y: c.y - inward.y * back
		};
		const it = {
			id: id(),
			kind,
			x: Math.round(origin.x),
			y: Math.round(origin.y),
			rot: rotOf(along, inward),
			roomId: room.id,
			...extra
		};
		items.push(it);
		return it;
	};
	const perp = (v) => ({
		x: -v.y,
		y: v.x
	});
	const axisLong = (s) => s.w >= s.h ? {
		x: 1,
		y: 0
	} : {
		x: 0,
		y: 1
	};
	for (const s of symbols) if (s.kind === "car") {
		const a = axisLong(s);
		const room = roomAt({
			x: s.x,
			y: s.y
		});
		if (!inside({
			x: s.x,
			y: s.y
		}) || room?.type === "garage") {
			if (level === 1) exterior.cars.push({
				x: Math.round(s.x),
				y: Math.round(s.y),
				rot: Math.round(Math.atan2(a.y, a.x) * DEG$2)
			});
		} else if (room && Math.max(s.w, s.h) <= 4600) s.kind = "sofa";
	} else if (s.kind === "plant") {
		const c = {
			x: s.x,
			y: s.y
		};
		const r = Math.round(Math.max(s.w, s.h) / 2);
		if (!inside(c)) {
			if (level === 1) exterior.trees.push({
				x: Math.round(c.x),
				y: Math.round(c.y),
				r
			});
		} else {
			const room = roomAt(c);
			if (room && r <= 700) items.push({
				id: id(),
				kind: "plant",
				x: Math.round(c.x),
				y: Math.round(c.y),
				rot: 0,
				roomId: room.id,
				w: +Math.min(1.3, Math.max(.5, r / 350)).toFixed(2)
			});
		}
	}
	const chairs = symbols.filter((s) => s.kind === "chair");
	const usedChair = /* @__PURE__ */ new Set();
	for (const ch of chairs) {
		if (usedChair.has(ch)) continue;
		const group = [ch];
		usedChair.add(ch);
		for (let i = 0; i < group.length; i++) for (const o of chairs) if (!usedChair.has(o) && Math.hypot(o.x - group[i].x, o.y - group[i].y) < 1400) {
			usedChair.add(o);
			group.push(o);
		}
		if (group.length < 2) continue;
		const cx = group.reduce((a, g) => a + g.x, 0) / group.length;
		const cy = group.reduce((a, g) => a + g.y, 0) / group.length;
		if (group.length < 3 && ![
			"ldk",
			"dining",
			"kitchen",
			"living"
		].includes(roomAt({
			x: cx,
			y: cy
		})?.type ?? "other")) continue;
		const table = symbols.find((s) => s.kind === "counter" && Math.abs(s.x - cx) < 700 && Math.abs(s.y - cy) < 700 && Math.min(s.w, s.h) < 1100);
		if (table) {
			const a = axisLong(table);
			push("dining", {
				x: table.x,
				y: table.y
			}, a, perp(a), 0, { w: +Math.min(2.6, Math.max(1.4, Math.max(table.w, table.h) / 1e3)).toFixed(2) });
			usedChair.add(table);
			continue;
		}
		let sxx = 0, syy = 0, sxy = 0;
		for (const g of group) {
			sxx += (g.x - cx) ** 2;
			syy += (g.y - cy) ** 2;
			sxy += (g.x - cx) * (g.y - cy);
		}
		const th = .5 * Math.atan2(2 * sxy, sxx - syy);
		let along = unit(Math.cos(th), Math.sin(th));
		if (Math.abs(along.x) > Math.abs(along.y)) along = {
			x: 1,
			y: 0
		};
		else along = {
			x: 0,
			y: 1
		};
		const perSide = Math.max(2, Math.ceil(group.length / 2));
		push("dining", {
			x: cx,
			y: cy
		}, along, perp(along), 0, { w: +Math.min(2.4, Math.max(1.5, perSide * .65 + .3)).toFixed(2) });
	}
	const mods = symbols.filter((s) => s.kind === "sofaModule");
	const usedMod = /* @__PURE__ */ new Set();
	for (const m of mods) {
		if (usedMod.has(m)) continue;
		const group = [m];
		usedMod.add(m);
		for (let i = 0; i < group.length; i++) for (const o of mods) if (!usedMod.has(o) && Math.hypot(o.x - group[i].x, o.y - group[i].y) < 760) {
			usedMod.add(o);
			group.push(o);
		}
		if (group.length < 2) continue;
		const xs = group.map((g) => g.x), ys = group.map((g) => g.y);
		const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
		const along = spanX >= spanY ? {
			x: 1,
			y: 0
		} : {
			x: 0,
			y: 1
		};
		const c = {
			x: (Math.max(...xs) + Math.min(...xs)) / 2,
			y: (Math.max(...ys) + Math.min(...ys)) / 2
		};
		const back = towardWall(c, perp(along), 450);
		const inward = {
			x: -back.x,
			y: -back.y
		};
		const w = Math.max(spanX, spanY) + 600;
		push("sofa", c, along, inward, 450, { w: +Math.min(3.6, Math.max(1.6, w / 1e3)).toFixed(2) });
	}
	for (const s of symbols) {
		const c = {
			x: s.x,
			y: s.y
		};
		switch (s.kind) {
			case "sofa": {
				if (roomAt(c)?.type === "garage" || !inside(c)) {
					trace?.push(`skip sofa@${Math.round(c.x)},${Math.round(c.y)} ${Math.round(s.w)}x${Math.round(s.h)}: outside`);
					break;
				}
				const along = axisLong(s);
				const back = towardWall(c, perp(along), 450);
				push("sofa", c, along, {
					x: -back.x,
					y: -back.y
				}, 450, { w: +Math.min(3.6, Math.max(1.6, Math.max(s.w, s.h) / 1e3)).toFixed(2) });
				break;
			}
			case "bed": {
				const head = towardWall(c, axisLong(s), 1e3);
				const inward = {
					x: -head.x,
					y: -head.y
				};
				push("bed", c, perp(inward), inward, 1e3, { w: +(Math.min(s.w, s.h) / 1e3).toFixed(2) });
				break;
			}
			case "toilet": {
				const long = axisLong(s);
				let tank = towardWall(c, long, 350);
				const f = s.flat;
				if (f && Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y) >= Math.min(s.w, s.h) * .8) {
					const mid = {
						x: (f.a.x + f.b.x) / 2,
						y: (f.a.y + f.b.y) / 2
					};
					const d = unit(mid.x - c.x, mid.y - c.y);
					if (Math.abs(d.x * long.x + d.y * long.y) > .7) tank = d;
				}
				const inward = {
					x: -tank.x,
					y: -tank.y
				};
				push("toilet", c, perp(inward), inward, 375);
				break;
			}
			case "bath": {
				const along = axisLong(s);
				const wallSide = towardWall(c, perp(along), 400);
				push("bath", c, along, {
					x: -wallSide.x,
					y: -wallSide.y
				}, 400, { len: +(Math.max(s.w, s.h) / 1e3).toFixed(2) });
				break;
			}
		}
	}
	const counters = symbols.filter((s) => s.kind === "counter" && !usedChair.has(s));
	const usedCounter = /* @__PURE__ */ new Set();
	const KITCHEN_NG = [
		"toilet",
		"bath",
		"washroom",
		"garage",
		"balcony",
		"porch",
		"void",
		"stairs",
		"closet",
		"entrance",
		"hall"
	];
	for (const sink of symbols.filter((s) => s.kind === "sink")) {
		const c = {
			x: sink.x,
			y: sink.y
		};
		const room = roomAt(c);
		if (!room || KITCHEN_NG.includes(room.type)) continue;
		if (items.some((it) => it.kind === "kitchen" && Math.hypot(it.x - c.x, it.y - c.y) < 2600)) continue;
		const onCounter = counters.find((k) => !usedCounter.has(k) && Math.abs(sink.x - k.x) <= k.w / 2 + 80 && Math.abs(sink.y - k.y) <= k.h / 2 + 80);
		const nearWalls = walls.map((w) => ({
			w,
			d: distPointSegment(c, w.a, w.b)
		})).filter((o) => o.d <= 700).sort((a, b) => a.d - b.d).slice(0, 3);
		trace?.push(`sink@${Math.round(c.x)},${Math.round(c.y)} room=${room.name} walls=${nearWalls.map((o) => Math.round(o.d)).join("/")} onCounter=${onCounter ? `${Math.round(onCounter.w)}x${Math.round(onCounter.h)}` : "no"}`);
		const plans = nearWalls.map((near) => {
			const w = near.w;
			let along = unit(w.b.x - w.a.x, w.b.y - w.a.y);
			if (Math.abs(along.x) > Math.abs(along.y)) along = {
				x: Math.sign(along.x),
				y: 0
			};
			else along = {
				x: 0,
				y: Math.sign(along.y)
			};
			const pn = perp(along);
			let inward = (c.x - w.a.x) * pn.x + (c.y - w.a.y) * pn.y >= 0 ? pn : {
				x: -pn.x,
				y: -pn.y
			};
			const t = (c.x - w.a.x) * along.x + (c.y - w.a.y) * along.y;
			const foot = {
				x: w.a.x + along.x * t + inward.x * (w.thickness / 2),
				y: w.a.y + along.y * t + inward.y * (w.thickness / 2)
			};
			const island = counters.find((k) => {
				if (usedCounter.has(k) || k === onCounter) return false;
				const depth = Math.min(k.w, k.h);
				const length = Math.max(k.w, k.h);
				if (depth < 750 || depth > 1150 || length < 1600) return false;
				const alongK = k.w >= k.h ? {
					x: 1,
					y: 0
				} : {
					x: 0,
					y: 1
				};
				if (Math.abs(alongK.x * along.x + alongK.y * along.y) < .9) return false;
				const dv = (k.x - foot.x) * inward.x + (k.y - foot.y) * inward.y;
				const du = (k.x - foot.x) * along.x + (k.y - foot.y) * along.y;
				return dv > 900 && dv < 2500 && Math.abs(du) < length / 2 + 400;
			});
			return {
				w,
				along,
				inward,
				foot,
				island
			};
		});
		const chosen = plans.find((p) => p.island) ?? plans[0];
		if (chosen) {
			let { along } = chosen;
			const { inward, foot, island } = chosen;
			const free = (sg) => wallDist({
				x: foot.x + along.x * sg * 1300 + inward.x * 300,
				y: foot.y + along.y * sg * 1300 + inward.y * 300
			});
			const stoveSign = free(1) >= free(-1) ? 1 : -1;
			const cross = along.x * inward.y - along.y * inward.x;
			let sg = stoveSign;
			if (cross < 0) {
				along = {
					x: -along.x,
					y: -along.y
				};
				sg = -sg;
			}
			const stoveSide = sg > 0 ? "right" : "left";
			if (island) {
				usedCounter.add(island);
				if (onCounter) usedCounter.add(onCounter);
				const length = Math.max(island.w, island.h);
				const len = +Math.min(3.4, Math.max(2.2, (length + 400) / 1e3)).toFixed(2);
				const du = (island.x - foot.x) * along.x + (island.y - foot.y) * along.y;
				const dv = (island.x - foot.x) * inward.x + (island.y - foot.y) * inward.y;
				push("kitchen", {
					x: foot.x + along.x * du,
					y: foot.y + along.y * du
				}, along, inward, 0, {
					len,
					kitchenType: "peninsula",
					stoveSide,
					fridge: "none",
					d: +(dv / 1e3).toFixed(2)
				}, c);
			} else {
				if (onCounter) usedCounter.add(onCounter);
				const length = onCounter ? Math.max(onCounter.w, onCounter.h) : 2150;
				const len = +Math.min(3.4, Math.max(2.2, (length + 400) / 1e3)).toFixed(2);
				const cw = Math.min(len - .3, 3);
				const du = onCounter ? (onCounter.x - foot.x) * along.x + (onCounter.y - foot.y) * along.y : sg * (cw / 2 - .6) * 1e3;
				const origin = {
					x: foot.x + along.x * du,
					y: foot.y + along.y * du
				};
				const it = push("kitchen", origin, along, inward, 0, {
					len,
					kitchenType: "wall",
					stoveSide,
					fridge: "none"
				}, c);
				trace?.push(`kitchen wall → ${it ? "ok" : "rejected"} origin=${Math.round(origin.x)},${Math.round(origin.y)}`);
			}
			continue;
		}
		if (!onCounter) continue;
		usedCounter.add(onCounter);
		const ct = onCounter;
		let along = axisLong(ct);
		const pn = perp(along);
		const rc = room.labelPos;
		const inward = (rc.x - ct.x) * pn.x + (rc.y - ct.y) * pn.y >= 0 ? pn : {
			x: -pn.x,
			y: -pn.y
		};
		if (along.x * inward.y - along.y * inward.x < 0) along = {
			x: -along.x,
			y: -along.y
		};
		const stoveSide = (sink.x - ct.x) * along.x + (sink.y - ct.y) * along.y > 0 ? "left" : "right";
		const len = +Math.min(3.4, Math.max(2.2, (Math.max(ct.w, ct.h) + 400) / 1e3)).toFixed(2);
		let back = 1520;
		let found = false;
		for (let t = 1e3; t <= 2600; t += 50) if (wallDist({
			x: ct.x - inward.x * t,
			y: ct.y - inward.y * t
		}) < 110) {
			back = t;
			found = true;
			break;
		}
		push("kitchen", {
			x: ct.x,
			y: ct.y
		}, along, inward, back, {
			len,
			kitchenType: found ? "peninsula" : "island",
			stoveSide,
			fridge: "none",
			d: +(back / 1e3).toFixed(2)
		}, c);
	}
	return {
		items,
		exterior
	};
}
var NOTE_NG = /境界線|帖|㎡|m2|面積|平面図|立面図|断面図|四捨五入|図面|工事|様邸|様 邸|事務所|縮尺|S\s*[:：]|TEL|FAX|更新日|管理者|設計者|担当者|建築士|丸め|配線|ﾘﾓｽﾃ|リモコン|要床補強|№|No\.|^\s*[A-Z]{1,3}\s*$/i;
/**
* 室名より小さい文字で書かれた「文（ひらがなを含む）」をメモとして拾い、行が続くものはつなぐ。
* roomLabelSize は室名の文字の大きさ（mm）。
*/
function detectNotes(texts, roomLabelSize, rooms) {
	const hira = /[ぁ-ゟ]/;
	const cands = texts.filter((t) => t.str.trim().length >= 4 && hira.test(t.str) && !NOTE_NG.test(t.str) && t.size <= roomLabelSize * .92 && Math.abs((t.angle % 360 + 360) % 360) < 2).map((t) => ({
		...t,
		str: t.str.trim().normalize("NFKC")
	})).sort((a, b) => a.y - b.y || a.x - b.x);
	const used = /* @__PURE__ */ new Set();
	const notes = [];
	for (let i = 0; i < cands.length; i++) {
		if (used.has(i)) continue;
		used.add(i);
		const lines = [cands[i]];
		let last = cands[i];
		for (let j = i + 1; j < cands.length; j++) {
			if (used.has(j)) continue;
			const t = cands[j];
			if (Math.abs(t.size - last.size) > last.size * .15) continue;
			const dy = t.y - last.y;
			if (dy < last.size * .6 || dy > last.size * 1.7) continue;
			if (Math.abs(t.x - last.x) > last.size * Math.max(4, last.str.length * .6)) continue;
			used.add(j);
			lines.push(t);
			last = t;
		}
		const text = lines.map((l) => l.str).join("");
		if (text.length < 5) continue;
		const x = lines.reduce((a, l) => a + l.x, 0) / lines.length;
		const y = lines.reduce((a, l) => a + l.y, 0) / lines.length;
		const room = rooms.find((r) => pointInPolygon({
			x,
			y
		}, r.polygon));
		notes.push({
			text,
			x: Math.round(x),
			y: Math.round(y),
			roomId: room?.id
		});
	}
	return notes;
}
//#endregion
//#region src/parser/symbolDict.ts
var q50 = (v) => Math.round(v / 50) * 50;
var innerClassOf = (n) => n <= 0 ? 0 : n <= 3 ? 1 : n <= 9 ? 2 : 3;
function signatureOf(room, w, h, inner) {
	return {
		room,
		L: q50(Math.max(w, h)),
		S: q50(Math.min(w, h)),
		innerClass: innerClassOf(inner)
	};
}
var sourceOf = (e) => e.source ?? "user";
/**
* 辞書に同じ形（±50mm）があればその種類。
* which = 'user' なら修正で覚えた答えだけ、'fallback' なら一括学習・初期辞書だけ、省略時は user を優先して全部
*/
function lookupSymbol(dict, sig, which = "any") {
	let best = null;
	const rank = (e) => sourceOf(e) === "user" ? 1 : 0;
	for (const e of dict) {
		const src = sourceOf(e);
		if (which === "user" && src !== "user") continue;
		if (which === "fallback" && src === "user") continue;
		if (e.room !== sig.room || e.innerClass !== sig.innerClass) continue;
		if (Math.abs(e.L - sig.L) > 50 || Math.abs(e.S - sig.S) > 50) continue;
		if (!best || rank(e) > rank(best) || rank(e) === rank(best) && e.n > best.n) best = e;
	}
	return best?.kind ?? null;
}
//#endregion
//#region src/parser/context.ts
var EPS = 25;
/** 軸平行の線 4 本で閉じた長方形を拾う */
function findRectangles(segs, minSize = 280, maxSize = 9500) {
	const hs = [];
	const vs = [];
	for (const s of segs) {
		const dx = Math.abs(s.b.x - s.a.x);
		const dy = Math.abs(s.b.y - s.a.y);
		if (dy < 3 && dx >= minSize && dx <= maxSize) hs.push({
			y: (s.a.y + s.b.y) / 2,
			x0: Math.min(s.a.x, s.b.x),
			x1: Math.max(s.a.x, s.b.x),
			w: s.width,
			dashed: s.dashed
		});
		else if (dx < 3 && dy >= minSize && dy <= maxSize) vs.push({
			x: (s.a.x + s.b.x) / 2,
			y0: Math.min(s.a.y, s.b.y),
			y1: Math.max(s.a.y, s.b.y),
			w: s.width,
			dashed: s.dashed
		});
	}
	vs.sort((a, b) => a.x - b.x);
	const vxs = vs.map((v) => v.x);
	const lower = (x) => {
		let lo = 0;
		let hi = vxs.length;
		while (lo < hi) {
			const m = lo + hi >> 1;
			if (vxs[m] < x) lo = m + 1;
			else hi = m;
		}
		return lo;
	};
	const vertAt = (x, y0, y1) => {
		for (let i = lower(x - EPS); i < vs.length && vs[i].x <= x + EPS; i++) {
			const v = vs[i];
			if (Math.abs(v.y0 - y0) <= EPS && Math.abs(v.y1 - y1) <= EPS) return v;
		}
		return null;
	};
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	hs.sort((a, b) => a.y - b.y);
	for (let i = 0; i < hs.length; i++) {
		const top = hs[i];
		for (let j = i + 1; j < hs.length; j++) {
			const bot = hs[j];
			const h = bot.y - top.y;
			if (h > maxSize) break;
			if (h < minSize) continue;
			if (Math.abs(bot.x0 - top.x0) > EPS || Math.abs(bot.x1 - top.x1) > EPS) continue;
			const l = vertAt(top.x0, top.y, bot.y);
			const r = vertAt(top.x1, top.y, bot.y);
			if (!l || !r) continue;
			const key = `${Math.round(top.x0 / 10)},${Math.round(top.y / 10)},${Math.round(top.x1 / 10)},${Math.round(bot.y / 10)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				id: out.length,
				minX: top.x0,
				minY: top.y,
				maxX: top.x1,
				maxY: bot.y,
				inner: 0,
				innerRects: 0,
				arcs: 0,
				width: (top.w + bot.w + l.w + r.w) / 4,
				dashed: top.dashed && bot.dashed
			});
		}
	}
	return out;
}
/** 長方形の中身（線・小さな長方形・円弧）を数える */
function fillRectContents(rects, segs, arcs) {
	const inside = (r, p, m = -25) => p.x > r.minX - m && p.x < r.maxX + m && p.y > r.minY - m && p.y < r.maxY + m;
	for (const r of rects) {
		let n = 0;
		for (const s of segs) {
			if (!inside(r, s.a) || !inside(r, s.b)) continue;
			const onEdge = (p) => Math.abs(p.x - r.minX) < EPS || Math.abs(p.x - r.maxX) < EPS || Math.abs(p.y - r.minY) < EPS || Math.abs(p.y - r.maxY) < EPS;
			if (onEdge(s.a) && onEdge(s.b)) continue;
			n++;
		}
		r.inner = n;
		r.innerRects = rects.filter((o) => o !== r && o.minX >= r.minX - EPS && o.maxX <= r.maxX + EPS && o.minY >= r.minY - EPS && o.maxY <= r.maxY + EPS && (o.maxX - o.minX) * (o.maxY - o.minY) < (r.maxX - r.minX) * (r.maxY - r.minY) * .8).length;
		r.arcs = arcs.filter((a) => inside(r, a.p0) && inside(r, a.p3)).length;
	}
}
/** 丸テーブル・丸いシンクなど、円弧が輪になっているもの（中心と半径） */
function findCircles(arcs, rMin = 250, rMax = 900) {
	const out = [];
	const used = /* @__PURE__ */ new Set();
	for (let i = 0; i < arcs.length; i++) {
		if (used.has(i)) continue;
		const a = arcs[i];
		const mid = {
			x: (a.p1.x + a.p2.x) / 2,
			y: (a.p1.y + a.p2.y) / 2
		};
		const chord = {
			x: (a.p0.x + a.p3.x) / 2,
			y: (a.p0.y + a.p3.y) / 2
		};
		const r0 = Math.hypot(a.p0.x - chord.x, a.p0.y - chord.y);
		const sag = Math.hypot(mid.x - chord.x, mid.y - chord.y) * .75;
		if (sag < 10 || r0 < 10) continue;
		const R = (r0 * r0 + sag * sag) / (2 * sag);
		if (R < rMin || R > rMax) continue;
		const dir = {
			x: (mid.x - chord.x) / (sag / .75 || 1),
			y: (mid.y - chord.y) / (sag / .75 || 1)
		};
		const c = {
			x: chord.x + dir.x * (sag - R) / 1,
			y: chord.y + dir.y * (sag - R) / 1
		};
		const group = [i];
		for (let j = i + 1; j < arcs.length; j++) {
			if (used.has(j)) continue;
			const b = arcs[j];
			const d0 = Math.abs(Math.hypot(b.p0.x - c.x, b.p0.y - c.y) - R);
			const d3 = Math.abs(Math.hypot(b.p3.x - c.x, b.p3.y - c.y) - R);
			if (d0 < R * .12 && d3 < R * .12) group.push(j);
		}
		if (group.length >= 3) {
			group.forEach((k) => used.add(k));
			out.push({
				x: c.x,
				y: c.y,
				r: R
			});
		}
	}
	return out;
}
/**
* L 字の閉じた折れ線（軸平行の線 6 本）: L 型ソファ・L 型キッチン。外形の矩形と「L」の印を返す
*/
function findLShapes(segs, minSize = 1200, maxSize = 4200) {
	const ax = segs.filter((s) => {
		const dx = Math.abs(s.b.x - s.a.x);
		const dy = Math.abs(s.b.y - s.a.y);
		return (dx < 3 || dy < 3) && Math.max(dx, dy) >= 250 && Math.max(dx, dy) <= maxSize;
	});
	const key = (p) => `${Math.round(p.x / 20)},${Math.round(p.y / 20)}`;
	const byEnd = /* @__PURE__ */ new Map();
	ax.forEach((s, i) => {
		for (const p of [s.a, s.b]) {
			const k = key(p);
			const l = byEnd.get(k) ?? [];
			l.push(i);
			byEnd.set(k, l);
		}
	});
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const near = (p, q) => Math.abs(p.x - q.x) <= EPS && Math.abs(p.y - q.y) <= EPS;
	for (let i = 0; i < ax.length; i++) {
		const walk = (cur, from, path) => {
			if (path.length === 6) return near(from, ax[path[0]].a) ? path : null;
			const cands = byEnd.get(key(from)) ?? [];
			for (const j of cands) {
				if (path.includes(j)) continue;
				const sj = ax[j];
				const next = near(sj.a, from) ? sj.b : near(sj.b, from) ? sj.a : null;
				if (!next) continue;
				const r = walk(j, next, [...path, j]);
				if (r) return r;
			}
			return null;
		};
		const loop = walk(i, ax[i].b, [i]);
		if (!loop) continue;
		const pts = loop.flatMap((j) => [ax[j].a, ax[j].b]);
		const minX = Math.min(...pts.map((p) => p.x));
		const maxX = Math.max(...pts.map((p) => p.x));
		const minY = Math.min(...pts.map((p) => p.y));
		const maxY = Math.max(...pts.map((p) => p.y));
		if (maxX - minX < minSize || maxY - minY < minSize) continue;
		const k = `${Math.round(minX / 10)},${Math.round(minY / 10)},${Math.round(maxX / 10)},${Math.round(maxY / 10)}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({
			id: -1,
			minX,
			minY,
			maxX,
			maxY,
			inner: 0,
			innerRects: 0,
			arcs: 0,
			width: ax[i].width,
			dashed: false,
			lshape: true
		});
	}
	return out;
}
/**
* 短い線がつながって閉じた「輪」（丸い記号: コンロの輪・シンクの排水口・丸い椅子・便器など）。
* CAD の PDF は円を短い折れ線で描くことが多く、円弧として取れないので線の連なりから拾う
*/
function findLoops(segs, minSize = 120, maxSize = 700, maxSeg = 400) {
	const sh = segs.filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) <= maxSeg);
	const key = (p) => `${Math.round(p.x / 8)},${Math.round(p.y / 8)}`;
	const byEnd = /* @__PURE__ */ new Map();
	sh.forEach((s, i) => {
		for (const p of [s.a, s.b]) {
			const k = key(p);
			const l = byEnd.get(k) ?? [];
			l.push(i);
			byEnd.set(k, l);
		}
	});
	const seen = new Uint8Array(sh.length);
	const out = [];
	for (let i = 0; i < sh.length; i++) {
		if (seen[i]) continue;
		const comp = [];
		const stack = [i];
		seen[i] = 1;
		while (stack.length) {
			const j = stack.pop();
			comp.push(j);
			for (const p of [sh[j].a, sh[j].b]) for (const k of byEnd.get(key(p)) ?? []) if (!seen[k]) {
				seen[k] = 1;
				stack.push(k);
			}
		}
		if (comp.length < 6 || comp.length > 400) continue;
		const pts = comp.flatMap((j) => [sh[j].a, sh[j].b]);
		const minX = Math.min(...pts.map((p) => p.x));
		const maxX = Math.max(...pts.map((p) => p.x));
		const minY = Math.min(...pts.map((p) => p.y));
		const maxY = Math.max(...pts.map((p) => p.y));
		const w = maxX - minX;
		const h = maxY - minY;
		if (Math.max(w, h) < minSize || Math.max(w, h) > maxSize || Math.min(w, h) < Math.max(w, h) * .45) continue;
		let open = 0;
		for (const j of comp) for (const p of [sh[j].a, sh[j].b]) if ((byEnd.get(key(p)) ?? []).length < 2) open++;
		if (open > 2) continue;
		out.push({
			minX,
			minY,
			maxX,
			maxY,
			n: comp.length
		});
	}
	return out;
}
var DEG$1 = 180 / Math.PI;
/**
* 部屋ごとに長方形を文脈で分類して家具にする。
* walls は壁の芯（向き・距離の判定に使う）、outline は建物外形。
*/
function readContextItems(segs, arcs, rooms, walls, level, dict, prior = []) {
	const items = [];
	const trace = [];
	const candidates = [];
	let seq = 0;
	const id = () => `pc${level}_${++seq}`;
	const rects = findRectangles(segs);
	fillRectContents(rects, segs, arcs);
	for (const l of findLShapes(segs)) {
		if (rects.some((r) => Math.abs(r.minX - l.minX) < EPS && Math.abs(r.maxX - l.maxX) < EPS && Math.abs(r.minY - l.minY) < EPS && Math.abs(r.maxY - l.maxY) < EPS)) continue;
		l.id = rects.length;
		rects.push(l);
	}
	const circles = findCircles(arcs);
	const rings = findLoops(segs, 120, 700);
	const ringsIn = (r, grow = 0) => rings.filter((g) => (g.minX + g.maxX) / 2 > r.minX - grow && (g.minX + g.maxX) / 2 < r.maxX + grow && (g.minY + g.maxY) / 2 > r.minY - grow && (g.minY + g.maxY) / 2 < r.maxY + grow);
	const roomBBox = (r) => {
		const xs = r.polygon.map((p) => p.x);
		const ys = r.polygon.map((p) => p.y);
		return {
			minX: Math.min(...xs),
			minY: Math.min(...ys),
			maxX: Math.max(...xs),
			maxY: Math.max(...ys)
		};
	};
	/** 点から部屋の輪郭（壁芯）までの距離 */
	const edgeDist = (room, p) => {
		let d = Infinity;
		const poly = room.polygon;
		for (let i = 0; i < poly.length; i++) d = Math.min(d, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]));
		return d;
	};
	const wallHalf = (walls.length ? walls.reduce((a, w) => a + w.thickness, 0) / walls.length : 130) / 2;
	const TOUCH = wallHalf + 120;
	const byRoom = /* @__PURE__ */ new Map();
	for (const room of rooms) {
		if ([
			"void",
			"stairs",
			"garage"
		].includes(room.type)) continue;
		const bb = roomBBox(room);
		const roomArea = Math.abs(polygonArea(room.polygon));
		const cands = [];
		for (const r of rects) {
			const cx = (r.minX + r.maxX) / 2;
			const cy = (r.minY + r.maxY) / 2;
			if (!pointInPolygon({
				x: cx,
				y: cy
			}, room.polygon)) continue;
			const w = r.maxX - r.minX;
			const h = r.maxY - r.minY;
			if (w * h > roomArea * .75) continue;
			if (r.minX < bb.minX - TOUCH || r.maxX > bb.maxX + TOUCH || r.minY < bb.minY - TOUCH || r.maxY > bb.maxY + TOUCH) continue;
			if ([
				{
					x: r.minX + 30,
					y: r.minY + 30
				},
				{
					x: r.maxX - 30,
					y: r.minY + 30
				},
				{
					x: r.minX + 30,
					y: r.maxY - 30
				},
				{
					x: r.maxX - 30,
					y: r.maxY - 30
				}
			].filter((c) => pointInPolygon(c, room.polygon)).length < 3) continue;
			const touch = {
				top: edgeDist(room, {
					x: cx,
					y: r.minY
				}) <= TOUCH,
				bottom: edgeDist(room, {
					x: cx,
					y: r.maxY
				}) <= TOUCH,
				left: edgeDist(room, {
					x: r.minX,
					y: cy
				}) <= TOUCH,
				right: edgeDist(room, {
					x: r.maxX,
					y: cy
				}) <= TOUCH
			};
			cands.push({
				rect: r,
				room,
				cx,
				cy,
				w,
				h,
				L: Math.max(w, h),
				S: Math.min(w, h),
				longX: w >= h,
				touch
			});
		}
		for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
			const a = cands[i];
			const b = cands[j];
			if (a.longX !== b.longX || Math.abs(a.S - b.S) > 40 || a.S < 450 || a.S > 1200) continue;
			if (!(a.longX ? Math.abs(a.rect.minY - b.rect.minY) <= 40 && Math.abs(a.rect.maxY - b.rect.maxY) <= 40 : Math.abs(a.rect.minX - b.rect.minX) <= 40 && Math.abs(a.rect.maxX - b.rect.maxX) <= 40)) continue;
			const gap = a.longX ? Math.max(a.rect.minX - b.rect.maxX, b.rect.minX - a.rect.maxX) : Math.max(a.rect.minY - b.rect.maxY, b.rect.minY - a.rect.maxY);
			if (gap > 40 || gap < -40) continue;
			const r = {
				id: a.rect.id,
				minX: Math.min(a.rect.minX, b.rect.minX),
				minY: Math.min(a.rect.minY, b.rect.minY),
				maxX: Math.max(a.rect.maxX, b.rect.maxX),
				maxY: Math.max(a.rect.maxY, b.rect.maxY),
				inner: a.rect.inner + b.rect.inner + 1,
				innerRects: a.rect.innerRects + b.rect.innerRects,
				arcs: a.rect.arcs + b.rect.arcs,
				width: a.rect.width,
				dashed: false
			};
			const w = r.maxX - r.minX;
			const h = r.maxY - r.minY;
			const cx = (r.minX + r.maxX) / 2;
			const cy = (r.minY + r.maxY) / 2;
			const merged = {
				rect: r,
				room,
				cx,
				cy,
				w,
				h,
				L: Math.max(w, h),
				S: Math.min(w, h),
				longX: w >= h,
				touch: {
					top: a.touch.top || b.touch.top,
					bottom: a.touch.bottom || b.touch.bottom,
					left: a.touch.left || b.touch.left,
					right: a.touch.right || b.touch.right
				},
				note: "2 つを結合"
			};
			merged.touch = {
				top: edgeDist(room, {
					x: cx,
					y: r.minY
				}) <= TOUCH,
				bottom: edgeDist(room, {
					x: cx,
					y: r.maxY
				}) <= TOUCH,
				left: edgeDist(room, {
					x: r.minX,
					y: cy
				}) <= TOUCH,
				right: edgeDist(room, {
					x: r.maxX,
					y: cy
				}) <= TOUCH
			};
			cands.splice(j, 1);
			cands.splice(i, 1, merged);
			j = i;
		}
		byRoom.set(room, cands);
	}
	const within = (v, lo, hi) => v >= lo && v <= hi;
	/** 長手の辺が壁に接している（壁沿いに置かれた家具） */
	const longAgainstWall = (c) => c.longX ? c.touch.top || c.touch.bottom : c.touch.left || c.touch.right;
	/** 短手の端が壁に接している（ペニンシュラのように壁から突き出す） */
	const endAgainstWall = (c) => c.longX ? c.touch.left || c.touch.right : c.touch.top || c.touch.bottom;
	const anyWall = (c) => c.touch.top || c.touch.bottom || c.touch.left || c.touch.right;
	/** 2 つの長方形が平行に並ぶ（長手が同じ向き、長手方向の重なりが半分以上）ときの、間の隙間（mm） */
	const parallelGap = (a, b) => {
		if (a.longX !== b.longX) return null;
		if (a.longX) {
			if (Math.min(a.rect.maxX, b.rect.maxX) - Math.max(a.rect.minX, b.rect.minX) < Math.min(a.w, b.w) * .5) return null;
			return Math.max(a.rect.minY - b.rect.maxY, b.rect.minY - a.rect.maxY);
		}
		if (Math.min(a.rect.maxY, b.rect.maxY) - Math.max(a.rect.minY, b.rect.minY) < Math.min(a.h, b.h) * .5) return null;
		return Math.max(a.rect.minX - b.rect.maxX, b.rect.minX - a.rect.maxX);
	};
	const contains = (a, b) => b.rect.minX >= a.rect.minX - EPS && b.rect.maxX <= a.rect.maxX + EPS && b.rect.minY >= a.rect.minY - EPS && b.rect.maxY <= a.rect.maxY + EPS;
	const roomOf = (c) => c.room;
	/** 長方形の「壁側」の向き: 接している辺（複数なら部屋の中心から遠い方）。接していなければ部屋の中心から遠い辺 */
	const wallSideOf = (c, alongLong) => {
		const bb = roomBBox(c.room);
		const rcx = (bb.minX + bb.maxX) / 2;
		const rcy = (bb.minY + bb.maxY) / 2;
		const opts = [
			{
				inward: {
					x: 0,
					y: 1
				},
				touch: c.touch.top,
				far: rcy - c.cy
			},
			{
				inward: {
					x: 0,
					y: -1
				},
				touch: c.touch.bottom,
				far: c.cy - rcy
			},
			{
				inward: {
					x: 1,
					y: 0
				},
				touch: c.touch.left,
				far: rcx - c.cx
			},
			{
				inward: {
					x: -1,
					y: 0
				},
				touch: c.touch.right,
				far: c.cx - rcx
			}
		].filter((o) => alongLong ? c.longX ? o.inward.y !== 0 : o.inward.x !== 0 : c.longX ? o.inward.x !== 0 : o.inward.y !== 0);
		opts.sort((a, b) => Number(b.touch) - Number(a.touch) || b.far - a.far);
		const inward = opts[0].inward;
		return {
			along: {
				x: inward.y,
				y: -inward.x
			},
			inward,
			back: alongLong ? c.S / 2 : c.L / 2
		};
	};
	/** 判定した長方形と大きく重なる他の候補（結合前の断片・内側の飾り線）は使わない */
	const consume = (c) => {
		const cands = byRoom.get(c.room) ?? [];
		for (const o of cands) {
			if (o === c || o.kind) continue;
			if (Math.max(0, Math.min(o.rect.maxX, c.rect.maxX) - Math.max(o.rect.minX, c.rect.minX)) * Math.max(0, Math.min(o.rect.maxY, c.rect.maxY) - Math.max(o.rect.minY, c.rect.minY)) >= o.w * o.h * .6) o.kind = "consumed";
		}
	};
	const push = (c, kind, extra = {}, alongLong = true) => {
		consume(c);
		const { along, inward, back } = wallSideOf(c, alongLong);
		const origin = {
			x: c.cx - inward.x * back,
			y: c.cy - inward.y * back
		};
		let rot = Math.atan2(along.y, along.x) * DEG$1;
		rot = Math.round((rot % 360 + 360) % 360);
		const it = {
			id: id(),
			kind,
			x: Math.round(origin.x),
			y: Math.round(origin.y),
			rot,
			roomId: roomOf(c).id,
			...extra
		};
		items.push(it);
		c.kind = kind;
		trace?.push(`${kind} ${Math.round(c.w)}x${Math.round(c.h)} @${Math.round(c.cx)},${Math.round(c.cy)} in ${c.room.name} (${c.note ?? ""})`);
		return it;
	};
	for (const [room, cands] of byRoom) {
		const t = room.type;
		const used = /* @__PURE__ */ new Set();
		const applyDict = (c, hit, note) => {
			c.note = note;
			used.add(c);
			if (hit === "kitchen") pushKitchen(c, cands, used);
			else if (hit === "bed") pushBed(c);
			else if (hit === "rug") push(c, "rug", {
				w: +(c.L / 1e3).toFixed(2),
				d: +(c.S / 1e3).toFixed(2)
			});
			else push(c, hit, { w: +(c.L / 1e3).toFixed(2) });
		};
		for (const c of cands) {
			const hit = dict ? lookupSymbol(dict, signatureOf(t, c.w, c.h, c.rect.inner), "user") : null;
			if (hit) applyDict(c, hit, "辞書");
		}
		const free = () => cands.filter((c) => !used.has(c) && !c.kind);
		if (t === "ldk" || t === "living" || t === "dining" || t === "kitchen" || t === "japanese" || t === "other" && Math.abs(polygonArea(room.polygon)) >= 8e6) {
			const counters = free().filter((c) => within(c.S, 550, 1100) && within(c.L, 1600, 9e3) && c.rect.innerRects <= 8);
			let kitchenDone = false;
			if (t !== "japanese" && t !== "other") {
				for (const back of counters.filter((c) => longAgainstWall(c) && c.S <= 760)) {
					const front = counters.find((c) => c !== back && !longAgainstWall(c) && c.S >= 600 && (parallelGap(back, c) ?? -1) >= 600 && (parallelGap(back, c) ?? 9e9) <= 1600);
					if (!front) continue;
					const frontRings = ringsIn(front.rect).length;
					const backRings = ringsIn(back.rect).length;
					const frontSink = frontRings >= 1 || front.rect.inner >= 8;
					const frontChairs = dinnerChairs(front, cands).length + ringsIn(front.rect, 700).filter((g) => Math.max(g.maxX - g.minX, g.maxY - g.minY) >= 300 && !((g.minX + g.maxX) / 2 > front.rect.minX && (g.minX + g.maxX) / 2 < front.rect.maxX && (g.minY + g.maxY) / 2 > front.rect.minY && (g.minY + g.maxY) / 2 < front.rect.maxY)).length;
					used.add(back);
					used.add(front);
					if (frontChairs >= 2 && frontRings === 0) {
						back.note = `壁付け（手前は食卓・椅子 ${frontChairs}）`;
						pushKitchen(back, cands, used);
						front.note = `椅子 ${frontChairs}`;
						push(front, "dining", { w: +(Math.min(front.L, 2600) / 1e3).toFixed(2) });
					} else if (backRings >= 1 && !frontSink) {
						back.note = `壁付け（丸い記号 ${backRings}）`;
						pushKitchen(back, cands, used);
						if (front.S >= 750) {
							front.note = "キッチン前のカウンター";
							push(front, "dining", { w: +(Math.min(front.L, 2600) / 1e3).toFixed(2) });
						}
					} else {
						const two = backRings >= 1 && frontSink;
						back.note = two ? "Ⅱ型の壁側（コンロ）" : "カップボード（対面の背面）";
						front.note = two ? "Ⅱ型のシンク側" : endAgainstWall(front) ? "ペニンシュラ" : "アイランド";
						pushKitchen(front, cands, used, back, two);
					}
					kitchenDone = true;
					break;
				}
				if (!kitchenDone) {
					const pen = counters.find((c) => !longAgainstWall(c) && endAgainstWall(c) && c.S >= 650 && (ringsIn(c.rect).length > 0 || c.rect.innerRects > 0 || t === "kitchen" || t === "ldk"));
					const wallK = counters.find((c) => longAgainstWall(c) && (ringsIn(c.rect).length > 0 || c.rect.inner >= 6 || c.rect.innerRects > 0 || t === "kitchen"));
					if (pen) {
						pen.note = "ペニンシュラ";
						used.add(pen);
						pushKitchen(pen, cands, used);
						kitchenDone = true;
					} else if (wallK) {
						wallK.note = "壁付け I 型";
						used.add(wallK);
						pushKitchen(wallK, cands, used);
						kitchenDone = true;
					}
				}
			}
			const sofasL = [];
			for (const c of free()) {
				if (!(within(c.S, 1300, 3200) && within(c.L, 1800, 4200))) continue;
				const inside = free().filter((o) => o !== c && contains(c, o) && o.L >= 600);
				if (inside.length >= 1 && !anyWall(c)) {
					c.note = `中に ${inside.length}`;
					used.add(c);
					push(c, "rug", {
						w: +(c.L / 1e3).toFixed(2),
						d: +(c.S / 1e3).toFixed(2)
					});
				}
			}
			for (const c of free()) {
				if (!c.rect.lshape || !within(c.L, 1600, 3800) || !within(c.S, 1200, 3600)) continue;
				c.note = "L 字の折れ線";
				used.add(c);
				push(c, "sofa", { w: +(c.L / 1e3).toFixed(2) });
				sofasL.push(c);
			}
			const sofaish = free().filter((c) => within(c.S, 700, 1150) && within(c.L, 1400, 3400) && !(within(c.S, 700, 1e3) && within(c.L, 1200, 2400) && c.rect.innerRects === 0 && !longAgainstWall(c) && dinnerChairs(c, cands).length >= 2));
			const sofas = [...sofasL];
			for (const c of sofaish) {
				if (used.has(c)) continue;
				const leg = sofaish.find((o) => o !== c && !used.has(o) && o.longX !== c.longX && Math.abs(Math.min(Math.abs(o.rect.minX - c.rect.minX), Math.abs(o.rect.maxX - c.rect.maxX))) < 50 && Math.abs(Math.min(Math.abs(o.rect.minY - c.rect.minY), Math.abs(o.rect.maxY - c.rect.maxY))) < 50);
				if (leg) {
					const main = c.L >= leg.L ? c : leg;
					main.note = "L 型ソファ";
					used.add(c);
					used.add(leg);
					push(main, "sofa", { w: +(main.L / 1e3).toFixed(2) });
					sofas.push(main);
				} else if (longAgainstWall(c) || c.rect.innerRects >= 2 || tvFacing(c, cands)) {
					c.note = longAgainstWall(c) ? "壁沿い" : "テレビ向き";
					used.add(c);
					push(c, "sofa", { w: +(c.L / 1e3).toFixed(2) });
					sofas.push(c);
				}
			}
			for (const c of free()) {
				if (!(within(c.S, 300, 560) && within(c.L, 1e3, 2400) && longAgainstWall(c))) continue;
				const facing = sofas.some((s) => s.longX === c.longX && (parallelGap(s, c) ?? 9e9) <= 4500);
				if (facing || (t === "living" || t === "ldk") && free().filter((o) => within(o.S, 300, 560) && within(o.L, 1e3, 2400) && longAgainstWall(o)).length === 1) {
					c.note = facing ? "ソファの正面" : "壁沿いの薄い台";
					used.add(c);
					push(c, "tv", { w: +(c.L / 1e3).toFixed(2) });
				}
			}
			for (const c of free()) {
				if (!(within(c.S, 700, 1100) && within(c.L, 1200, 2600))) continue;
				const chairs = dinnerChairs(c, cands);
				const chairArcs = arcs.filter((a) => a.p0.x > c.rect.minX - 700 && a.p0.x < c.rect.maxX + 700 && a.p0.y > c.rect.minY - 700 && a.p0.y < c.rect.maxY + 700).length + ringsIn(c.rect, 700).filter((g) => Math.max(g.maxX - g.minX, g.maxY - g.minY) >= 300 && !((g.minX + g.maxX) / 2 > c.rect.minX && (g.minX + g.maxX) / 2 < c.rect.maxX && (g.minY + g.maxY) / 2 > c.rect.minY && (g.minY + g.maxY) / 2 < c.rect.maxY)).length * 4;
				if (chairs.length >= 2 || chairArcs >= 4 || t === "dining" && !longAgainstWall(c) || !longAgainstWall(c) && c.rect.innerRects === 0 && !anyWall(c) && t !== "japanese") {
					c.note = `椅子 ${chairs.length}・弧 ${chairArcs}`;
					used.add(c);
					chairs.forEach((ch) => used.add(ch));
					push(c, t === "japanese" ? "lowTable" : "dining", { w: +(c.L / 1e3).toFixed(2) });
				}
			}
			for (const ci of circles) {
				if (!pointInPolygon({
					x: ci.x,
					y: ci.y
				}, room.polygon) || t === "japanese") continue;
				if (items.some((it) => it.roomId === room.id && it.kind === "dining")) continue;
				if (ci.r < 450 || ci.r > 800) continue;
				const bb = roomBBox(room);
				push({
					rect: {
						id: -1,
						minX: ci.x - ci.r,
						maxX: ci.x + ci.r,
						minY: ci.y - ci.r,
						maxY: ci.y + ci.r,
						inner: 0,
						innerRects: 0,
						arcs: 0,
						width: 0,
						dashed: false
					},
					room,
					cx: ci.x,
					cy: ci.y,
					w: ci.r * 2,
					h: ci.r * 2,
					L: ci.r * 2,
					S: ci.r * 2,
					longX: bb.maxX - bb.minX >= bb.maxY - bb.minY,
					touch: {
						top: false,
						bottom: false,
						left: false,
						right: false
					},
					note: "丸テーブル"
				}, "dining", { w: +(ci.r * 2 / 1e3).toFixed(2) });
			}
			for (const c of free()) {
				if (!(within(c.S, 550, 900) && within(c.L, 1100, 1700) && longAgainstWall(c))) continue;
				if (dinnerChairs(c, cands).length + ringsIn(c.rect, 600).filter((g) => Math.max(g.maxX - g.minX, g.maxY - g.minY) >= 300 && !((g.minX + g.maxX) / 2 > c.rect.minX && (g.minX + g.maxX) / 2 < c.rect.maxX && (g.minY + g.maxY) / 2 > c.rect.minY && (g.minY + g.maxY) / 2 < c.rect.maxY)).length === 1) {
					c.note = "壁沿いのカウンターに椅子 1 脚";
					used.add(c);
					push(c, "desk", { w: +(c.L / 1e3).toFixed(2) });
				}
			}
			for (const g of findLoops(segs, 600, 1100, 400)) {
				const gc = {
					x: (g.minX + g.maxX) / 2,
					y: (g.minY + g.maxY) / 2
				};
				if (!pointInPolygon(gc, room.polygon)) continue;
				if (!(sofas.some((sf) => Math.hypot(sf.cx - gc.x, sf.cy - gc.y) < 2600) || prior.some((p) => p.kind === "sofa" && p.roomId === room.id && Math.hypot(p.x - gc.x, p.y - gc.y) < 2600)) || items.some((it) => it.roomId === room.id && it.kind === "coffeeTable")) continue;
				const dia = Math.max(g.maxX - g.minX, g.maxY - g.minY);
				const bb = roomBBox(room);
				push({
					rect: {
						id: -1,
						minX: g.minX,
						maxX: g.maxX,
						minY: g.minY,
						maxY: g.maxY,
						inner: 0,
						innerRects: 0,
						arcs: 0,
						width: 0,
						dashed: false
					},
					room,
					cx: gc.x,
					cy: gc.y,
					w: dia,
					h: dia,
					L: dia,
					S: dia,
					longX: bb.maxX - bb.minX >= bb.maxY - bb.minY,
					touch: {
						top: false,
						bottom: false,
						left: false,
						right: false
					},
					note: "丸テーブル（ソファのそば）"
				}, "coffeeTable", { w: +(dia / 1e3).toFixed(2) });
			}
			for (const c of free()) {
				const squareish = within(c.S, 700, 1100) && within(c.L, 700, 1200);
				if (!(within(c.S, 380, 720) && within(c.L, 700, 1400)) && !squareish) continue;
				if (c.rect.inner > 2) continue;
				const near = sofas.find((s) => Math.hypot(s.cx - c.cx, s.cy - c.cy) < (s.rect.lshape ? 2600 : 2200) && (s.rect.lshape || (parallelGap(s, c) ?? -1) >= 200));
				const nearPrior = !near && prior.some((p) => p.kind === "sofa" && p.roomId === room.id && Math.hypot(p.x - c.cx, p.y - c.cy) < 2600);
				if (near || nearPrior) {
					c.note = "ソファの前";
					used.add(c);
					push(c, "coffeeTable", { w: +(c.L / 1e3).toFixed(2) });
				}
			}
		}
		if (t === "bedroom" || t === "kids" || t === "study" || t === "japanese" || t === "other") {
			for (const c of free()) if (within(c.S, 850, 1900) && within(c.L, 1850, 2250) && (t !== "other" || c.rect.innerRects >= 1)) {
				c.note = c.rect.innerRects ? `枕 ${c.rect.innerRects}` : "ベッド";
				used.add(c);
				pushBed(c);
			}
			for (const c of free()) if (within(c.S, 450, 800) && within(c.L, 900, 1800) && longAgainstWall(c) && (t === "study" || t === "kids" || t === "bedroom")) {
				c.note = "壁沿いの机";
				used.add(c);
				push(c, "desk", { w: +(c.L / 1e3).toFixed(2) });
			}
		}
		if (t === "washroom") {
			for (const c of free()) if (within(c.S, 420, 700) && within(c.L, 700, 1700) && longAgainstWall(c)) {
				c.note = "壁沿いの洗面台";
				used.add(c);
				push(c, "washstand", { w: +(c.L / 1e3).toFixed(2) });
			} else if (within(c.S, 520, 720) && within(c.L, 520, 760) && anyWall(c)) {
				c.note = "洗濯機";
				used.add(c);
				push(c, "washer");
			}
		}
		if (t === "bath") {
			for (const c of free()) if (within(c.S, 620, 900) && within(c.L, 1250, 1850)) {
				c.note = "浴槽";
				used.add(c);
				push(c, "bath", { len: +(c.L / 1e3).toFixed(2) });
				break;
			}
		}
		if (t === "toilet" || t === "washroom") {
			for (const c of free()) if (within(c.S, 340, 540) && within(c.L, 580, 900) && (t === "toilet" || c.rect.arcs > 0)) {
				c.note = "便器";
				used.add(c);
				push(c, "toilet", {}, false);
				break;
			}
		}
		if (t === "entrance") {
			for (const c of free()) if (within(c.S, 280, 480) && within(c.L, 700, 2400) && longAgainstWall(c)) {
				c.note = "壁沿いの靴箱";
				used.add(c);
				push(c, "shoeCabinet", { w: +(c.L / 1e3).toFixed(2) });
			}
		}
		if (t === "hall" || t === "toilet") {
			for (const c of free()) if (within(c.S, 380, 650) && within(c.L, 600, 1300) && longAgainstWall(c) && (c.rect.inner >= 3 || c.rect.arcs >= 1)) {
				c.note = "手洗い";
				used.add(c);
				push(c, "washstand", { w: +(c.L / 1e3).toFixed(2) });
			}
		}
		if (dict) for (const c of free()) {
			const hit = lookupSymbol(dict, signatureOf(t, c.w, c.h, c.rect.inner), "fallback");
			if (hit) applyDict(c, hit, "辞書（過去の図面）");
		}
		for (const c of cands) candidates.push({
			id: c.rect.id,
			cx: Math.round(c.cx),
			cy: Math.round(c.cy),
			w: Math.round(c.w),
			h: Math.round(c.h),
			inner: c.rect.inner,
			arcs: ringsIn(c.rect).length,
			roomId: room.id,
			kind: c.kind === "consumed" ? void 0 : c.kind
		});
	}
	return {
		items,
		candidates,
		trace
	};
	/** 食卓の周りの椅子（350〜600 角の小さな長方形が、テーブルの辺から 350mm 以内） */
	function dinnerChairs(table, cands) {
		return cands.filter((o) => o !== table && within(o.S, 300, 620) && within(o.L, 300, 700) && o.rect.minX > table.rect.minX - 700 && o.rect.maxX < table.rect.maxX + 700 && o.rect.minY > table.rect.minY - 700 && o.rect.maxY < table.rect.maxY + 700 && !contains(table, o));
	}
	/** ソファ候補の正面（平行・1.5〜4.5m）に薄い長方形（テレビ台）があるか */
	function tvFacing(sofa, cands) {
		return cands.some((o) => o !== sofa && within(o.S, 300, 560) && within(o.L, 1e3, 2400) && o.longX === sofa.longX && (parallelGap(sofa, o) ?? 9e9) <= 4500 && longAgainstWall(o));
	}
	/** ベッド: 頭側は枕（中の小さな長方形）のある端、無ければ壁に接する端 */
	function pushBed(c) {
		const long = c.longX ? {
			x: 1,
			y: 0
		} : {
			x: 0,
			y: 1
		};
		let head = null;
		const pillows = rects.filter((o) => o !== c.rect && o.minX >= c.rect.minX - EPS && o.maxX <= c.rect.maxX + EPS && o.minY >= c.rect.minY - EPS && o.maxY <= c.rect.maxY + EPS && Math.max(o.maxX - o.minX, o.maxY - o.minY) < c.L * .6);
		if (pillows.length) {
			const p = pillows[0];
			const pc = {
				x: (p.minX + p.maxX) / 2,
				y: (p.minY + p.maxY) / 2
			};
			head = (pc.x - c.cx) * long.x + (pc.y - c.cy) * long.y >= 0 ? long : {
				x: -long.x,
				y: -long.y
			};
		} else {
			const endA = c.longX ? c.touch.left : c.touch.top;
			const endB = c.longX ? c.touch.right : c.touch.bottom;
			if (endA && !endB) head = {
				x: -long.x,
				y: -long.y
			};
			else if (endB && !endA) head = long;
			else {
				const bb = roomBBox(c.room);
				const rc = {
					x: (bb.minX + bb.maxX) / 2,
					y: (bb.minY + bb.maxY) / 2
				};
				head = (rc.x - c.cx) * long.x + (rc.y - c.cy) * long.y >= 0 ? {
					x: -long.x,
					y: -long.y
				} : long;
			}
		}
		const inward = {
			x: -head.x,
			y: -head.y
		};
		const along = {
			x: inward.y,
			y: -inward.x
		};
		const origin = {
			x: c.cx - inward.x * (c.L / 2),
			y: c.cy - inward.y * (c.L / 2)
		};
		const rot = Math.round((Math.atan2(along.y, along.x) * DEG$1 % 360 + 360) % 360);
		items.push({
			id: id(),
			kind: "bed",
			x: Math.round(origin.x),
			y: Math.round(origin.y),
			rot,
			roomId: c.room.id,
			w: +(c.S / 1e3).toFixed(2)
		});
		c.kind = "bed";
		consume(c);
		trace.push(`bed ${Math.round(c.w)}x${Math.round(c.h)} @${Math.round(c.cx)},${Math.round(c.cy)} in ${c.room.name} (${c.note ?? ""})`);
	}
	/**
	* キッチン: カウンターの長手が並び方向。壁付けは壁側が背、対面は背面収納（back）か壁から離れた側がダイニング側。
	* コンロは円弧（コンロの輪）のある側、無ければ壁から遠い側
	*/
	function pushKitchen(c, cands, used, back, twoType = false) {
		const along0 = c.longX ? {
			x: 1,
			y: 0
		} : {
			x: 0,
			y: 1
		};
		const bb = roomBBox(c.room);
		const rc = {
			x: (bb.minX + bb.maxX) / 2,
			y: (bb.minY + bb.maxY) / 2
		};
		const pn = {
			x: -along0.y,
			y: along0.x
		};
		let inward;
		let type;
		let d;
		let origin;
		const burnersOnBack = twoType;
		if (longAgainstWall(c) && !back) {
			const side = c.longX ? c.touch.top ? 1 : -1 : c.touch.left ? 1 : -1;
			inward = {
				x: pn.x * side,
				y: pn.y * side
			};
			type = "wall";
			origin = {
				x: c.cx - inward.x * (c.S / 2),
				y: c.cy - inward.y * (c.S / 2)
			};
		} else {
			const toBack = back ? {
				x: back.cx - c.cx,
				y: back.cy - c.cy
			} : {
				x: c.cx - rc.x,
				y: c.cy - rc.y
			};
			const backDir = toBack.x * pn.x + toBack.y * pn.y >= 0 ? pn : {
				x: -pn.x,
				y: -pn.y
			};
			inward = {
				x: -backDir.x,
				y: -backDir.y
			};
			type = burnersOnBack ? "two" : endAgainstWall(c) ? "peninsula" : "island";
			let dist = 1500;
			for (let tt = 400; tt <= 3200; tt += 50) {
				const p = {
					x: c.cx + backDir.x * tt,
					y: c.cy + backDir.y * tt
				};
				if (walls.some((w) => distPointSegment(p, w.a, w.b) < wallHalf + 20)) {
					dist = tt - wallHalf;
					break;
				}
			}
			d = +(dist / 1e3).toFixed(2);
			origin = {
				x: c.cx + backDir.x * dist,
				y: c.cy + backDir.y * dist
			};
		}
		let along = {
			x: inward.y,
			y: -inward.x
		};
		const ringSrc = twoType && back ? back : c;
		let stoveSign = 0;
		for (const g of ringsIn(ringSrc.rect)) {
			if (Math.max(g.maxX - g.minX, g.maxY - g.minY) > 320) continue;
			stoveSign += Math.sign(((g.minX + g.maxX) / 2 - ringSrc.cx) * along.x + ((g.minY + g.maxY) / 2 - ringSrc.cy) * along.y);
		}
		if (stoveSign === 0) {
			const endPlus = {
				x: c.cx + along.x * (c.L / 2 + 600),
				y: c.cy + along.y * (c.L / 2 + 600)
			};
			const endMinus = {
				x: c.cx - along.x * (c.L / 2 + 600),
				y: c.cy - along.y * (c.L / 2 + 600)
			};
			stoveSign = edgeDist(c.room, endPlus) >= edgeDist(c.room, endMinus) ? 1 : -1;
		}
		const stoveSide = stoveSign > 0 ? "right" : "left";
		const rot = Math.round((Math.atan2(along.y, along.x) * DEG$1 % 360 + 360) % 360);
		const len = +Math.min(3.4, Math.max(2.3, (c.L + 500) / 1e3)).toFixed(2);
		items.push({
			id: id(),
			kind: "kitchen",
			x: Math.round(origin.x),
			y: Math.round(origin.y),
			rot,
			roomId: c.room.id,
			len,
			kitchenType: type,
			stoveSide,
			fridge: "none",
			d
		});
		c.kind = "kitchen";
		consume(c);
		if (back) {
			back.kind = "cupboard";
			consume(back);
		}
		trace.push(`kitchen(${type}) ${Math.round(c.w)}x${Math.round(c.h)} @${Math.round(c.cx)},${Math.round(c.cy)} in ${c.room.name} (${c.note ?? ""}) stove=${stoveSide}`);
	}
}
//#endregion
//#region src/parser/module.ts
/** 壁芯を格子に寄せる許容ずれ（これ以上ずれた壁は格子に乗っていないとみなしてそのまま） */
function snapTolerance(grid) {
	return Math.min(110, grid * .25);
}
/** 壁の端（他の壁の芯 ± 柱半分の位置で止まっている）を寄せる許容ずれ */
function endTolerance(grid) {
	return Math.min(200, grid * .44);
}
function snapCoord(v, phase, grid) {
	return phase + Math.round((v - phase) / grid) * grid;
}
/** 位置の集まり（重み付き）から格子の位相と適合度を求める */
function fitAxis(items, grid) {
	let S = 0;
	let C = 0;
	let W = 0;
	for (const it of items) {
		const a = 2 * Math.PI * it.v / grid;
		S += it.w * Math.sin(a);
		C += it.w * Math.cos(a);
		W += it.w;
	}
	if (W <= 0) return {
		phase: 0,
		fit: 0,
		onGrid: 0,
		weight: 0
	};
	let phase = Math.atan2(S, C) * grid / (2 * Math.PI);
	phase = (phase % grid + grid) % grid;
	const tol = snapTolerance(grid);
	let on = 0;
	for (const it of items) if (Math.abs(snapCoord(it.v, phase, grid) - it.v) <= tol) on += it.w;
	return {
		phase,
		fit: Math.hypot(S, C) / W,
		onGrid: on / W,
		weight: W
	};
}
var AXIS_EPS = .02;
/** 縦横の壁の芯の位置から、モジュール（半間 455 / 500 の格子）の位相と適合度を求める */
function fitModule(walls, size) {
	const grid = size / 2;
	const xs = [];
	const ys = [];
	let n = 0;
	for (const w of walls) {
		const dx = w.b.x - w.a.x;
		const dy = w.b.y - w.a.y;
		const L = Math.hypot(dx, dy);
		if (L < 300) continue;
		if (Math.abs(dy) < L * AXIS_EPS) {
			ys.push({
				v: (w.a.y + w.b.y) / 2,
				w: L
			});
			n++;
		} else if (Math.abs(dx) < L * AXIS_EPS) {
			xs.push({
				v: (w.a.x + w.b.x) / 2,
				w: L
			});
			n++;
		}
	}
	const fx = fitAxis(xs, grid);
	const fy = fitAxis(ys, grid);
	const W = fx.weight + fy.weight;
	return {
		size,
		grid,
		phaseX: fx.phase,
		phaseY: fy.phase,
		onGrid: W ? (fx.onGrid * fx.weight + fy.onGrid * fy.weight) / W : 0,
		fit: W ? (fx.fit * fx.weight + fy.fit * fy.weight) / W : 0,
		walls: n
	};
}
/** 格子へ寄せてよいと判断する基準 */
function moduleAcceptable(m) {
	return m.walls >= 6 && m.onGrid >= .7 && m.fit >= .55;
}
/**
* モジュールの判定。auto は尺・メーターのうち適合の良い方（どちらも乗っていなければ null）、
* shaku / meter はその格子を使う（乗っていない壁はそのまま）、none は寄せない
*/
function chooseModule(walls, mode) {
	if (mode === "none") return null;
	if (mode === "shaku") return fitModule(walls, 910);
	if (mode === "meter") return fitModule(walls, 1e3);
	const s = fitModule(walls, 910);
	const m = fitModule(walls, 1e3);
	const okS = moduleAcceptable(s);
	const okM = moduleAcceptable(m);
	if (!okS && !okM) return null;
	if (okS && !okM) return s;
	if (okM && !okS) return m;
	return s.onGrid + s.fit * .5 >= m.onGrid + m.fit * .5 ? s : m;
}
function moduleInfoOf(m, source, snapped) {
	return {
		size: m.size,
		grid: m.grid,
		phaseX: m.phaseX,
		phaseY: m.phaseY,
		fit: Math.round(m.onGrid * 1e3) / 1e3,
		snapped,
		source
	};
}
/** 位相を平行移動（原点を移した後に呼ぶ） */
function translateModule(mi, dx, dy) {
	mi.phaseX = ((mi.phaseX + dx) % mi.grid + mi.grid) % mi.grid;
	mi.phaseY = ((mi.phaseY + dy) % mi.grid + mi.grid) % mi.grid;
}
/** 軸平行の矩形（吹抜の×印・階段など）の辺を格子へ寄せる。寄せて小さくなりすぎる（minSize 未満）ときはそのまま */
function snapRect(r, m, tol, minSize) {
	const sx0 = snapCoord(r.minX, m.phaseX, m.grid);
	const sx1 = snapCoord(r.maxX, m.phaseX, m.grid);
	const sy0 = snapCoord(r.minY, m.phaseY, m.grid);
	const sy1 = snapCoord(r.maxY, m.phaseY, m.grid);
	if (Math.abs(sx0 - r.minX) <= tol && Math.abs(sx1 - r.maxX) <= tol && sx1 - sx0 >= minSize) {
		r.minX = sx0;
		r.maxX = sx1;
	}
	if (Math.abs(sy0 - r.minY) <= tol && Math.abs(sy1 - r.maxY) <= tol && sy1 - sy0 >= minSize) {
		r.minY = sy0;
		r.maxY = sy1;
	}
	return r;
}
/** 階段の矩形を格子へ寄せる（階段は柱間に納まる） */
function snapStairs(f, m) {
	const tol = endTolerance(m.grid);
	for (const s of f.stairs) snapRect(s, m, tol, 700);
}
/** 在来木造の標準の壁厚（柱 105 角）: 外壁 = 柱 + 外装下地・通気層 + 石膏ボード、内壁 = 柱 + 石膏ボード両面 */
var WOOD_WALL = {
	exterior: 160,
	interior: 130,
	thin: 75
};
/** 木造として壁厚を標準化する（図面の線の太さの違いで階ごとに壁厚が変わらないように） */
function woodWallThickness(w) {
	if (w.exterior) return WOOD_WALL.exterior;
	return w.thickness < 95 ? WOOD_WALL.thin : WOOD_WALL.interior;
}
//#endregion
//#region src/parser/assemble.ts
function pageToMm(p, k) {
	const sc = (q) => ({
		x: q.x * k,
		y: q.y * k
	});
	const segs = p.segments.filter((s) => !(s.source === "fill" && /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(s.color))).map((s) => ({
		a: sc(s.a),
		b: sc(s.b),
		width: s.width,
		dashed: s.dashed,
		source: s.source
	}));
	const curves = p.curves.filter((c) => !c.dashed).map((c) => ({
		p0: sc(c.p0),
		p1: sc(c.p1),
		p2: sc(c.p2),
		p3: sc(c.p3),
		width: c.width
	}));
	return {
		pageIndex: p.pageIndex,
		segs,
		arcs: curves.length < 8 ? [...curves, ...polylineArcs(segs.filter((s) => s.source !== "fill"))] : curves,
		texts: p.texts.map((t) => ({
			str: t.str,
			x: t.cx * k,
			y: t.cy * k,
			size: t.size * k,
			angle: t.angle
		})),
		fills: p.fills.map((f) => ({ polygon: f.polygon.map(sc) })),
		masks: p.fills.filter((f) => /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.polygon.length >= 4 && f.polygon.length <= 8).map((f) => f.polygon.map(sc)),
		colorFills: p.fills.filter((f) => f.polygon.length >= 3 && !/^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.color.toLowerCase() !== "#000000").map((f) => ({
			poly: f.polygon.map(sc),
			color: f.color.toLowerCase()
		})),
		rasterMask: p.raster ? {
			data: p.raster.mask,
			w: p.raster.w,
			h: p.raster.h,
			res: k / p.raster.scale,
			ox: 0,
			oy: 0
		} : void 0
	};
}
/**
* 図面の傾き（図面全体が回転して配置されている PDF）を求める。
* 長い線の角度を 90° で折り返して集計し、最も多い向きが水平・垂直からずれている分を返す（度、-45〜45）。
*/
function dominantTilt(p) {
	const bins = /* @__PURE__ */ new Float64Array(180);
	let total = 0;
	for (const s of p.segs) {
		if (s.dashed) continue;
		const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
		if (L < 300) continue;
		let a = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * 180 / Math.PI;
		a = (a % 90 + 90) % 90;
		bins[Math.min(179, Math.floor(a * 2))] += L;
		total += L;
	}
	if (!total) return 0;
	let best = 0;
	let bestW = -1;
	for (let i = 0; i < 180; i++) {
		const w = bins[(i + 179) % 180] + bins[i] + bins[(i + 1) % 180];
		if (w > bestW) {
			bestW = w;
			best = i;
		}
	}
	let sw = 0;
	let sa = 0;
	for (let k = -2; k <= 2; k++) {
		const j = (best + k + 180) % 180;
		let a = (j + .5) / 2;
		if (best + k < 0) a -= 90;
		if (best + k >= 180) a += 90;
		sw += bins[j];
		sa += bins[j] * a;
	}
	let t = sw ? sa / sw : 0;
	if (t > 45) t -= 90;
	return bestW / total > .3 ? t : 0;
}
/** 図面を角度 deg（度）だけ回転（図面の傾きを戻す） */
function rotatePageMm(p, deg) {
	const xs = p.segs.flatMap((s) => [s.a.x, s.b.x]);
	const ys = p.segs.flatMap((s) => [s.a.y, s.b.y]);
	const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
	const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
	const th = deg * Math.PI / 180;
	const c = Math.cos(th);
	const sn = Math.sin(th);
	const R = (q) => ({
		x: cx + (q.x - cx) * c - (q.y - cy) * sn,
		y: cy + (q.x - cx) * sn + (q.y - cy) * c
	});
	return {
		...p,
		segs: p.segs.map((s) => ({
			...s,
			a: R(s.a),
			b: R(s.b)
		})),
		arcs: p.arcs.map((a) => ({
			...a,
			p0: R(a.p0),
			p1: R(a.p1),
			p2: R(a.p2),
			p3: R(a.p3)
		})),
		texts: p.texts.map((t) => ({
			...t,
			...R({
				x: t.x,
				y: t.y
			}),
			angle: t.angle + th
		})),
		fills: p.fills.map((f) => ({ polygon: f.polygon.map(R) })),
		masks: p.masks.map((m) => m.map(R)),
		colorFills: p.colorFills.map((f) => ({
			...f,
			poly: f.poly.map(R)
		}))
	};
}
function makeWalls(det) {
	const walls = [];
	const axes = [];
	const findAxis = (g, o) => {
		let a = axes.find((x) => x.g === g && Math.abs(x.o - o) < 20);
		if (!a) {
			a = {
				g,
				o,
				items: []
			};
			axes.push(a);
		}
		return a;
	};
	for (const p of det.pieces) findAxis(p.g, p.o).items.push({
		t0: p.t0,
		t1: p.t1,
		d: p.d
	});
	for (const op of det.openings) findAxis(op.g, op.o).items.push({
		t0: op.t0,
		t1: op.t1,
		d: op.d,
		op
	});
	for (const ax of axes) {
		const grp = det.groups[ax.g];
		ax.items.sort((a, b) => a.t0 - b.t0);
		const runs = [];
		for (const it of ax.items) {
			const last = runs[runs.length - 1];
			const L = it.t1 - it.t0;
			if (last && it.t0 <= last.t1 + 30) {
				last.t1 = Math.max(last.t1, it.t1);
				if (it.op) last.ops.push(it.op);
				else {
					last.dsum += it.d * L;
					last.lsum += L;
				}
			} else runs.push({
				t0: it.t0,
				t1: it.t1,
				ops: it.op ? [it.op] : [],
				dsum: it.op ? 0 : it.d * L,
				lsum: it.op ? 0 : L
			});
		}
		for (const r of runs) {
			const d = r.lsum > 0 ? r.dsum / r.lsum : r.ops[0]?.d || 120;
			const a = {
				x: grp.u.x * r.t0 + grp.n.x * ax.o,
				y: grp.u.y * r.t0 + grp.n.y * ax.o
			};
			const b = {
				x: grp.u.x * r.t1 + grp.n.x * ax.o,
				y: grp.u.y * r.t1 + grp.n.y * ax.o
			};
			walls.push({
				a,
				b,
				u: grp.u,
				n: grp.n,
				d,
				t0: r.t0,
				t1: r.t1,
				o: ax.o,
				g: ax.g,
				openings: r.ops,
				joinedA: false,
				joinedB: false
			});
		}
	}
	return walls;
}
/** 壁端を他の壁へ延長して接合する */
function joinWalls(walls) {
	const ext = walls.map((w) => ({
		t0: w.t0,
		t1: w.t1
	}));
	walls.forEach((w, i) => {
		for (const end of [0, 1]) {
			const tEnd = end === 0 ? w.t0 : w.t1;
			const dir = end === 0 ? -1 : 1;
			let best = null;
			for (const v of walls) {
				if (v === w || v.g === w.g) continue;
				const den = w.u.x * v.n.x + w.u.y * v.n.y;
				if (Math.abs(den) < .2) continue;
				const nwv = w.n.x * v.n.x + w.n.y * v.n.y;
				const t = (v.o - nwv * w.o) / den;
				const beyond = (t - tEnd) * dir;
				const reach = v.d / 2 + w.d + 60;
				if (beyond < -(v.d / 2 + 5) || beyond > reach) continue;
				const p = {
					x: w.u.x * t + w.n.x * w.o,
					y: w.u.y * t + w.n.y * w.o
				};
				const tv = p.x * v.u.x + p.y * v.u.y;
				const tol = w.d / 2 + 40;
				if (tv < v.t0 - tol || tv > v.t1 + tol) continue;
				const corner = tv < v.t0 + tol || tv > v.t1 - tol;
				const dt = t - tEnd;
				if (!best || Math.abs(dt) < Math.abs(best.dt)) best = {
					dt,
					corner,
					other: v
				};
			}
			if (best) {
				const add = best.corner ? best.other.d / 2 : 0;
				const newT = tEnd + best.dt + dir * add;
				if (end === 0) {
					ext[i].t0 = Math.min(w.t0, newT);
					w.joinedA = true;
				} else {
					ext[i].t1 = Math.max(w.t1, newT);
					w.joinedB = true;
				}
			}
		}
	});
	walls.forEach((w, i) => {
		w.t0 = ext[i].t0;
		w.t1 = ext[i].t1;
		w.a = {
			x: w.u.x * w.t0 + w.n.x * w.o,
			y: w.u.y * w.t0 + w.n.y * w.o
		};
		w.b = {
			x: w.u.x * w.t1 + w.n.x * w.o,
			y: w.u.y * w.t1 + w.n.y * w.o
		};
	});
}
function wallBBox(w) {
	return {
		minX: Math.min(w.a.x, w.b.x) - w.d / 2,
		minY: Math.min(w.a.y, w.b.y) - w.d / 2,
		maxX: Math.max(w.a.x, w.b.x) + w.d / 2,
		maxY: Math.max(w.a.y, w.b.y) + w.d / 2
	};
}
/** 接続関係から壁群をクラスタリングし、図面（階）ごとに分ける */
function clusterPlans(walls, ext, mergeGap = 600, minPart = 2500, windowSegs) {
	const parent = walls.map((_, i) => i);
	const find = (i) => parent[i] === i ? i : parent[i] = find(parent[i]);
	const unite = (a, b) => {
		parent[find(a)] = find(b);
	};
	for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) {
		const A = walls[i];
		const B = walls[j];
		if (bboxGap(wallBBox(A), wallBBox(B)) > 40) continue;
		if (distPointSegment(A.a, B.a, B.b) <= B.d / 2 + 40 || distPointSegment(A.b, B.a, B.b) <= B.d / 2 + 40 || distPointSegment(B.a, A.a, A.b) <= A.d / 2 + 40 || distPointSegment(B.b, A.a, A.b) <= A.d / 2 + 40) unite(i, j);
	}
	if (windowSegs) for (let i = 0; i < walls.length; i++) for (let j = 0; j < walls.length; j++) {
		const A = walls[i];
		const B = walls[j];
		if (i === j || find(i) === find(j)) continue;
		if (Math.abs(A.u.x * B.u.x + A.u.y * B.u.y) < .998) continue;
		const tb0 = Math.min(B.a.x * A.u.x + B.a.y * A.u.y, B.b.x * A.u.x + B.b.y * A.u.y);
		const ob = (B.a.x + B.b.x) / 2 * A.n.x + (B.a.y + B.b.y) / 2 * A.n.y;
		const oa = (A.a.x + A.b.x) / 2 * A.n.x + (A.a.y + A.b.y) / 2 * A.n.y;
		const ta1 = Math.max(A.a.x * A.u.x + A.a.y * A.u.y, A.b.x * A.u.x + A.b.y * A.u.y);
		if (Math.abs(ob - oa) > 80) continue;
		const gap = tb0 - ta1;
		if (gap < 300 || gap > 5e3) continue;
		const band = Math.max(A.d, B.d) / 2 + 40;
		let cov = 0;
		const iv = [];
		for (const sg of windowSegs) {
			const oa0 = sg.a.x * A.n.x + sg.a.y * A.n.y - oa;
			const ob0 = sg.b.x * A.n.x + sg.b.y * A.n.y - oa;
			if (Math.abs(oa0) > band || Math.abs(ob0) > band) continue;
			const s0 = Math.max(ta1, Math.min(sg.a.x * A.u.x + sg.a.y * A.u.y, sg.b.x * A.u.x + sg.b.y * A.u.y));
			const s1 = Math.min(tb0, Math.max(sg.a.x * A.u.x + sg.a.y * A.u.y, sg.b.x * A.u.x + sg.b.y * A.u.y));
			if (s1 > s0) iv.push([s0, s1]);
		}
		iv.sort((p, q) => p[0] - q[0]);
		let cur = null;
		for (const v of iv) if (cur && v[0] <= cur[1]) cur[1] = Math.max(cur[1], v[1]);
		else {
			if (cur) cov += cur[1] - cur[0];
			cur = [v[0], v[1]];
		}
		if (cur) cov += cur[1] - cur[0];
		if (cov >= gap * .6) unite(i, j);
	}
	const comps = /* @__PURE__ */ new Map();
	walls.forEach((w, i) => {
		const r = find(i);
		if (!comps.has(r)) comps.set(r, []);
		comps.get(r).push(w);
	});
	const lenOf = (ws) => ws.reduce((s, w) => s + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), 0);
	let groups = [...comps.values()].filter((c) => lenOf(c) >= minPart);
	if (ext) {
		const W = ext.maxX - ext.minX;
		const H = ext.maxY - ext.minY;
		groups = groups.filter((g) => {
			const b = g.map(wallBBox).reduce((a, c) => ({
				minX: Math.min(a.minX, c.minX),
				minY: Math.min(a.minY, c.minY),
				maxX: Math.max(a.maxX, c.maxX),
				maxY: Math.max(a.maxY, c.maxY)
			}));
			return !(b.maxX - b.minX > W * .8 && b.maxY - b.minY > H * .8);
		});
	}
	const bb = (ws) => ws.map(wallBBox).reduce((a, b) => ({
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY)
	}));
	let merged = true;
	while (merged) {
		merged = false;
		outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) if (bboxGap(bb(groups[i]), bb(groups[j])) < mergeGap) {
			groups[i] = groups[i].concat(groups[j]);
			groups.splice(j, 1);
			merged = true;
			break outer;
		}
	}
	groups = groups.filter((g) => lenOf(g) >= 8e3);
	return groups;
}
function windowStyleFor(room, widthMm, facingSouth) {
	switch (room) {
		case "ldk":
		case "living":
		case "dining":
		case "japanese":
			if (widthMm >= 1500) return {
				style: "hakidashi",
				sill: 0,
				height: 2200
			};
			return {
				style: "koshi",
				sill: 900,
				height: 1100
			};
		case "bath": return {
			style: "small",
			sill: 1100,
			height: 900
		};
		case "toilet":
		case "washroom":
		case "closet":
		case "storage": return {
			style: "small",
			sill: 1400,
			height: 600
		};
		case "stairs":
		case "hall": return {
			style: "high",
			sill: 1500,
			height: 700
		};
		case "kitchen": return {
			style: "small",
			sill: 1200,
			height: 700
		};
		default:
			if (widthMm >= 1400) return {
				style: "high",
				sill: 1300,
				height: 700
			};
			return {
				style: "koshi",
				sill: 900,
				height: 1100
			};
	}
}
/**
* ホームランディックの窓の語彙: 掃き出し窓は LDK（庭側）に 1 ヵ所だけ。残りの大きな窓は天井付けの横長 FIX、細い窓は縦すべり出しにする。
* 図面にサッシ記号・FL 注記で寸法が書かれた窓はそのまま。
*/
function applyWindowVocabulary(openings, info) {
	const living = /* @__PURE__ */ new Set([
		"ldk",
		"living",
		"dining",
		"japanese"
	]);
	const cands = openings.map((o, i) => ({
		o,
		i,
		inf: info.get(i)
	})).filter((x) => x.o.kind === "window" && x.o.windowStyle === "hakidashi" && x.inf && !x.inf.drawn && living.has(x.inf.room));
	if (cands.length <= 1) return;
	cands.sort((a, b) => b.o.t1 - b.o.t0 + b.inf.south * 1500 - (a.o.t1 - a.o.t0 + a.inf.south * 1500));
	for (const x of cands.slice(1)) if (x.o.t1 - x.o.t0 >= 1400) {
		x.o.windowStyle = "high";
		x.o.sill = 1300;
		x.o.height = 700;
	} else {
		x.o.windowStyle = "koshi";
		x.o.sill = 900;
		x.o.height = 1100;
	}
}
var MAIN_PRIORITY = [
	"ldk",
	"living",
	"dining",
	"kitchen",
	"japanese",
	"bedroom",
	"kids",
	"study",
	"entrance",
	"washroom",
	"bath",
	"toilet",
	"balcony",
	"garage",
	"hall",
	"stairs",
	"closet",
	"storage",
	"porch",
	"void",
	"other"
];
/** 1つの領域の室名のうち代表となるもの（居室を優先、同格なら大きい文字） */
function mainName(names) {
	return names.slice().sort((p, q) => MAIN_PRIORITY.indexOf(p.type) - MAIN_PRIORITY.indexOf(q.type) || q.size - p.size)[0];
}
/**
* 文字を室名として使える形に整える。説明文（「上部寝室から使う」など）は null。
* 「※」以降の注記・括弧の帖数は除く。
*/
function cleanRoomName(raw) {
	let s0 = raw.trim().replace(/[※＊*].*$/, "").replace(/[（(][^）)]*[）)]?$/, "").trim();
	if (!s0) return null;
	const n = normalizeText(s0);
	const sentence = /(から|まで|ため|する|して|できる|ように|ません|ます|です|だけ|の空|を|が見|に使|予定|検討|想定|可能)/.test(n);
	if (n.length > 12 || sentence && n.length > 5) return /中庭|坪庭/.test(n) ? "中庭" : null;
	if (/【|】|申請|開口\d|\d(M|MM|ｍ)$|^PS$|^MB$|洗濯機|冷蔵庫|ベンチ|テーブル|カウンター|ドラム|上部|下部|鉄骨|造作|^OPEN$|吊戸|棚$|ガラス/.test(n)) return null;
	return s0;
}
/** 室名らしい短い語（説明文・寸法・記号は除く） */
function looksLikeRoomName(raw) {
	const s = normalizeText(raw);
	if (s.length < 2 || s.length > 10) return false;
	if (/[。、，,：:！!？?「」『』]/.test(s)) return false;
	if (/^[\d.,+\-×XW*＊()（）]+$/.test(s)) return false;
	if (/\d{3,}/.test(s)) return false;
	if (/^(UP|DN|FIX|FL|GL|CH|H=|W=|PS|MB|SK|冷|W\d)/.test(s)) return false;
	if (/境界|道路|隣地|通り芯|芯|^GL|天井|床補強|予定|参考/.test(s)) return false;
	if (/^※/.test(raw.trim())) return false;
	return /[\u3040-\u30ff\u3400-\u9fff]/.test(s) || /^[A-Z]{2,5}$/.test(s);
}
/**
* 吹抜の範囲: 「吹抜」の文字を含み、対角線（×印）が引かれた長方形。
* 吹抜は手すり・腰壁の細い線で描かれ壁として拾えないため、×印から範囲を求める。
*/
function voidRectangles(plan) {
	const voidTexts = plan.texts.filter((t) => /吹抜|吹き抜け|VOID/i.test(t.str));
	if (!voidTexts.length) return [];
	const raw = plan.segs.filter((sg) => {
		if (Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 30) return false;
		const a = Math.abs(Math.atan2(sg.b.y - sg.a.y, sg.b.x - sg.a.x)) % (Math.PI / 2);
		return a > .25 && a < Math.PI / 2 - .25;
	});
	const used = new Uint8Array(raw.length);
	const order = raw.map((_, i) => i).sort((i, j) => Math.hypot(raw[j].b.x - raw[j].a.x, raw[j].b.y - raw[j].a.y) - Math.hypot(raw[i].b.x - raw[i].a.x, raw[i].b.y - raw[i].a.y));
	const diag = [];
	for (const i of order) {
		if (used[i]) continue;
		const S = raw[i];
		const L = Math.hypot(S.b.x - S.a.x, S.b.y - S.a.y);
		if (L < 250) break;
		const u = {
			x: (S.b.x - S.a.x) / L,
			y: (S.b.y - S.a.y) / L
		};
		const off = (q) => Math.abs((q.x - S.a.x) * -u.y + (q.y - S.a.y) * u.x);
		const tt = (q) => (q.x - S.a.x) * u.x + (q.y - S.a.y) * u.y;
		const ivs = [];
		raw.forEach((q, j) => {
			if (off(q.a) < 40 && off(q.b) < 40) ivs.push([
				Math.min(tt(q.a), tt(q.b)),
				Math.max(tt(q.a), tt(q.b)),
				j
			]);
		});
		ivs.sort((p, q) => p[0] - q[0]);
		let lo = 0;
		let hi = L;
		let grew = true;
		while (grew) {
			grew = false;
			for (const [a, b] of ivs) {
				if (b > hi && a <= hi + 700) hi = b, grew = true;
				if (a < lo && b >= lo - 700) lo = a, grew = true;
			}
		}
		for (const [a, b, j] of ivs) if (a >= lo - 1 && b <= hi + 1) used[j] = 1;
		if (hi - lo >= 1500) diag.push({
			a: {
				x: S.a.x + u.x * lo,
				y: S.a.y + u.y * lo
			},
			b: {
				x: S.a.x + u.x * hi,
				y: S.a.y + u.y * hi
			}
		});
	}
	const out = [];
	for (let i = 0; i < diag.length; i++) for (let j = i + 1; j < diag.length; j++) {
		const A = diag[i];
		const B = diag[j];
		const pts = [
			A.a,
			A.b,
			B.a,
			B.b
		];
		const bb = bboxOf$2(pts);
		if (bb.maxX - bb.minX < 1200 || bb.maxY - bb.minY < 1200) continue;
		const tol = 200;
		if ([
			{
				x: bb.minX,
				y: bb.minY
			},
			{
				x: bb.maxX,
				y: bb.minY
			},
			{
				x: bb.maxX,
				y: bb.maxY
			},
			{
				x: bb.minX,
				y: bb.maxY
			}
		].filter((c) => pts.some((q) => Math.abs(q.x - c.x) < tol && Math.abs(q.y - c.y) < tol)).length < 3) continue;
		const cr = (p0, p1, q0, q1) => {
			const d = (p1.x - p0.x) * (q1.y - q0.y) - (p1.y - p0.y) * (q1.x - q0.x);
			if (Math.abs(d) < 1e-9) return false;
			const t = ((q0.x - p0.x) * (q1.y - q0.y) - (q0.y - p0.y) * (q1.x - q0.x)) / d;
			const v = ((q0.x - p0.x) * (p1.y - p0.y) - (q0.y - p0.y) * (p1.x - p0.x)) / d;
			return t > .05 && t < .95 && v > .05 && v < .95;
		};
		if (!cr(A.a, A.b, B.a, B.b)) continue;
		if (!voidTexts.some((t) => t.x > bb.minX && t.x < bb.maxX && t.y > bb.minY && t.y < bb.maxY)) continue;
		if (out.some((o) => Math.abs(o.minX - bb.minX) < 200 && Math.abs(o.minY - bb.minY) < 200)) continue;
		out.push(bb);
	}
	return out;
}
/** 線分が通るセル（太さ1セル） */
function lineCells(grid, a, b) {
	const [x0, y0] = grid.cellOf(a);
	const [x1, y1] = grid.cellOf(b);
	const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
	const out = [];
	for (let i = 0; i <= n; i++) {
		const x = Math.round(x0 + (x1 - x0) * i / n);
		const y = Math.round(y0 + (y1 - y0) * i / n);
		if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
		out.push(y * grid.w + x);
		if (x + 1 < grid.w) out.push(y * grid.w + x + 1);
	}
	return out;
}
/**
* 室名が2つ以上入った区画を、壁から壁へ渡る線（収納の戸・間仕切り・出入口の線）で分ける。
* 線で区切ると室名が別々になる場合だけ採用するので、カウンターなどで部屋を誤って割ることはない。
*/
function splitMergedRegions(grid, plan) {
	const names = plan.texts.map((t) => ({
		t,
		nm: cleanRoomName(t.str)
	})).filter((o) => o.nm && classifyRoomName(o.nm) != null).map((o) => ({
		x: o.t.x,
		y: o.t.y,
		nm: o.nm,
		type: classifyRoomName(o.nm)
	}));
	if (names.length < 2) return false;
	let changed = false;
	for (let iter = 0; iter < 3; iter++) {
		const { labels } = grid.labelComponents();
		const byLabel = /* @__PURE__ */ new Map();
		for (const n of names) {
			const [cx, cy] = grid.cellOf(n);
			if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) continue;
			const l = labels[cy * grid.w + cx];
			if (!l) continue;
			if (!byLabel.has(l)) byLabel.set(l, []);
			byLabel.get(l).push(n);
		}
		let any = false;
		for (const [l, ns] of byLabel) {
			const distinct = ns.filter((n, i) => ns.findIndex((m) => m.nm === n.nm) === i);
			if (distinct.length < 2) continue;
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (let i = 0; i < labels.length; i++) if (labels[i] === l) {
				const x = i % grid.w;
				const y = i / grid.w | 0;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			const p0 = grid.centerOf(minX, minY);
			const p1 = grid.centerOf(maxX, maxY);
			const nearWall = (q) => {
				const [x, y] = grid.cellOf(q);
				for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (grid.get(x + dx, y + dy) === 1) return true;
				return false;
			};
			const cands = plan.segs.filter((sg) => {
				const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
				if (L < 350 || L > 5e3) return false;
				const m = {
					x: (sg.a.x + sg.b.x) / 2,
					y: (sg.a.y + sg.b.y) / 2
				};
				if (m.x < p0.x || m.x > p1.x || m.y < p0.y || m.y > p1.y) return false;
				const [mx, my] = grid.cellOf(m);
				if (labels[my * grid.w + mx] !== l) return false;
				return nearWall(sg.a) && nearWall(sg.b);
			});
			let best = null;
			const A = distinct[0];
			for (const B of distinct.slice(1)) {
				for (const sg of cands) {
					const cells = lineCells(grid, sg.a, sg.b);
					const blocked = new Set(cells);
					const [ax, ay] = grid.cellOf(A);
					const [bx, by] = grid.cellOf(B);
					const start = ay * grid.w + ax;
					const goal = by * grid.w + bx;
					if (blocked.has(start) || blocked.has(goal)) continue;
					const seen = new Uint8Array(labels.length);
					const q = [start];
					seen[start] = 1;
					let reached = false;
					let count = 0;
					while (q.length) {
						const i = q.pop();
						count++;
						if (i === goal) {
							reached = true;
							break;
						}
						const x = i % grid.w;
						for (const j of [
							x > 0 ? i - 1 : -1,
							x < grid.w - 1 ? i + 1 : -1,
							i - grid.w,
							i + grid.w
						]) {
							if (j < 0 || j >= labels.length || seen[j] || labels[j] !== l || blocked.has(j)) continue;
							seen[j] = 1;
							q.push(j);
						}
					}
					if (reached) continue;
					if (count * grid.res * grid.res / 1e6 < .6) continue;
					const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
					if (!best || L < best.L) best = {
						cells,
						L
					};
				}
				if (best) break;
			}
			if (best) {
				for (const i of best.cells) grid.data[i] = 1;
				any = true;
				changed = true;
			}
		}
		if (!any) break;
	}
	return changed;
}
/** 太線を画像にして壁を検出する（手描き風の図面用） */
function rasterWallDetection(page) {
	const segs = page.segs.filter((sg) => !sg.dashed && sg.source === "stroke");
	if (segs.length < 200) return null;
	const hT = heavyWidthThreshold(segs);
	const heavy = hT == null ? segs : segs.filter((sg) => sg.width >= hT);
	if (heavy.length < 100) return null;
	const bb = bboxOf$2(heavy.flatMap((sg) => [sg.a, sg.b]));
	const res = 20;
	const cells = (bb.maxX - bb.minX) / res * ((bb.maxY - bb.minY) / res);
	const r = cells > 6e6 ? res * Math.sqrt(cells / 6e6) : res;
	const img = rasterizeSegments(heavy, bb, r);
	const ang = dominantAngles(heavy);
	if (!ang.length) return null;
	return detectWallsRaster(img, ang, { closeRadius: Math.max(2, Math.round(80 / r)) });
}
/** 壁の芯の間隔を 910mm モジュール（半間 455mm）に合わせる縮尺の補正係数 */
function moduleScaleFromWalls(walls) {
	const ax = walls.map((w) => {
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		if (L < 300) return null;
		let th = Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
		if (th < 0) th += Math.PI;
		if (th >= Math.PI) th -= Math.PI;
		const n = {
			x: -Math.sin(th),
			y: Math.cos(th)
		};
		return {
			th,
			o: (w.a.x + w.b.x) / 2 * n.x + (w.a.y + w.b.y) / 2 * n.y,
			L
		};
	}).filter((x) => !!x);
	const ds = [];
	for (let i = 0; i < ax.length; i++) for (let j = i + 1; j < ax.length; j++) {
		const dth = Math.abs(ax[i].th - ax[j].th);
		if (Math.min(dth, Math.PI - dth) > .03) continue;
		const d = Math.abs(ax[i].o - ax[j].o);
		if (d < 400 || d > 12e3) continue;
		ds.push({
			d,
			w: Math.min(ax[i].L, ax[j].L)
		});
	}
	if (ds.length < 10) return {
		factor: 1,
		confidence: 0
	};
	const W = ds.reduce((s0, q) => s0 + q.w, 0);
	const fit = (f) => ds.reduce((s0, q) => s0 + q.w * Math.cos(2 * Math.PI * q.d * f / 455), 0) / W;
	const th = walls.map((w) => w.thickness ?? 0).filter((t) => t > 0).sort((a, b) => a - b);
	const medT = th.length ? th[Math.floor(th.length * .75)] : 0;
	const thickPenalty = (f) => medT ? Math.abs(Math.log(medT * f / 130)) : 0;
	let best = 1;
	let bs = -Infinity;
	let bfit = 0;
	for (const base of [
		.5,
		.6,
		2 / 3,
		Math.SQRT1_2,
		.75,
		1,
		4 / 3,
		Math.SQRT2,
		1.5,
		2
	]) for (let f = base * .96; f <= base * 1.04; f += base * .0025) {
		const v = fit(f);
		const sc0 = v - thickPenalty(f) * 1.2;
		if (sc0 > bs) {
			bs = sc0;
			best = f;
			bfit = v;
		}
	}
	const thickBad = medT > 0 && thickPenalty(1) > .6 && thickPenalty(best) < .3;
	return {
		factor: best,
		confidence: thickBad ? Math.max(bfit, .3) : bfit
	};
}
/** 文字 t と同じ行で、読む向きに続く文字（近い順、最大 maxSizes 文字分の距離）。縦書き・回転した図面にも対応 */
function followingOnLine(t, texts, maxSizes) {
	const u = {
		x: Math.cos(t.angle),
		y: Math.sin(t.angle)
	};
	return texts.map((q) => {
		const dx = q.x - t.x;
		const dy = q.y - t.y;
		return {
			q,
			along: dx * u.x + dy * u.y,
			perp: Math.abs(-dx * u.y + dy * u.x)
		};
	}).filter((o) => o.q !== t && o.perp < t.size * .6 && o.along > 0 && o.along < t.size * maxSizes).sort((a, b) => a.along - b.along).map((o) => o.q);
}
/** 面積表（「1階 100.20」「2階 34.15」）を読む。階 → ㎡ */
function readAreaTable(pages) {
	const out = {};
	for (const p of pages) for (const t of p.texts) {
		const m = /^([1-9])階$/.exec(normalizeText(t.str).replace(/\s/g, ""));
		if (!m) continue;
		const cands = followingOnLine(t, p.texts, 20).map((q) => ({
			q,
			v: /^(\d{1,3}\.\d{1,2})(㎡|m2|m²)?$/.exec(normalizeText(q.str).replace(/\s/g, ""))
		})).filter((o) => o.v);
		if (cands.length && out[+m[1]] == null) out[+m[1]] = parseFloat(cands[0].v[1]);
	}
	return out;
}
/** 文字の位置の区画。文字の中心が区切り線の上に乗っている場合は、周囲（±3セル）で最も多い区画 */
function labelNear(grid, lb, p) {
	const [cx, cy] = grid.cellOf(p);
	if (cx >= 0 && cy >= 0 && cx < grid.w && cy < grid.h && lb[cy * grid.w + cx]) return lb[cy * grid.w + cx];
	const cnt = /* @__PURE__ */ new Map();
	for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
		const x = cx + dx;
		const y = cy + dy;
		if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
		const l = lb[y * grid.w + x];
		if (l) cnt.set(l, (cnt.get(l) ?? 0) + 1);
	}
	let best = 0;
	let bn = 0;
	for (const [l, n] of cnt) if (n > bn) [best, bn] = [l, n];
	return best;
}
/** 同じ直線上に並ぶ壁の間の隙間（最大 maxGap） */
function collinearGaps(walls, maxGap, axisTol = 30) {
	const out = [];
	const byAxis = [];
	for (const w of walls) {
		const ax = byAxis.find((ws) => ws[0].g === w.g && Math.abs(ws[0].o - w.o) < axisTol);
		if (ax) ax.push(w);
		else byAxis.push([w]);
	}
	for (const ws of byAxis) {
		ws.sort((p, q) => p.t0 - q.t0);
		let end = ws[0].t1;
		let endO = ws[0].o;
		for (let k = 1; k < ws.length; k++) {
			const w = ws[k];
			const gap = w.t0 - end;
			if (gap > 30 && gap <= maxGap) {
				const P = (t, o) => ({
					x: w.u.x * t + w.n.x * o,
					y: w.u.y * t + w.n.y * o
				});
				out.push({
					a: P(end, endO),
					b: P(w.t0, w.o),
					d: w.d
				});
			}
			if (w.t1 > end) {
				end = w.t1;
				endO = w.o;
			}
		}
	}
	return out;
}
/** 同じ線（平面の線と周囲の線で重複したもの）を 1 本にする */
function uniqueSegs(segs) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const s of segs) {
		const k = `${Math.round(s.a.x)},${Math.round(s.a.y)},${Math.round(s.b.x)},${Math.round(s.b.y)}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(s);
	}
	return out;
}
function buildFloor(plan, level, northAngleDeg, warnings, expectedArea, hints) {
	const walls = plan.walls;
	const res = 20;
	const grid = Grid.around(plan.bbox.minX, plan.bbox.minY, plan.bbox.maxX, plan.bbox.maxY, res, 1200);
	const voidRects = voidRectangles(plan);
	const drawBarriers = () => {
		for (const w of walls) grid.fillThickSegment(w.a, w.b, w.d, 1);
		for (const poly of plan.wallPolys) grid.fillPolygon(poly, 1);
		for (const poly of plan.sashPolys) grid.fillPolygon(poly, 1);
		for (const r of voidRects) {
			const c = [
				{
					x: r.minX,
					y: r.minY
				},
				{
					x: r.maxX,
					y: r.minY
				},
				{
					x: r.maxX,
					y: r.maxY
				},
				{
					x: r.minX,
					y: r.maxY
				}
			];
			for (let i = 0; i < 4; i++) grid.fillThickSegment(c[i], c[(i + 1) % 4], 40, 1);
		}
	};
	drawBarriers();
	for (const c of collinearGaps(walls, 2e3)) grid.fillThickSegment(c.a, c.b, Math.min(c.d, 60), 1);
	const GAP = 3;
	const closers = plan.loose ? collinearGaps(walls, 6500, 90) : collinearGaps(walls, 4600);
	for (const c of closers) grid.fillThickSegment(c.a, c.b, c.d, GAP);
	if (plan.loose) {
		const ends = [];
		for (const w of walls) {
			if (!w.joinedA) ends.push({
				p: w.a,
				w
			});
			if (!w.joinedB) ends.push({
				p: w.b,
				w
			});
		}
		for (const e of ends) {
			let best = null;
			for (const f of ends) {
				if (f.w === e.w) continue;
				const d = Math.hypot(f.p.x - e.p.x, f.p.y - e.p.y);
				if (d <= 700 && (!best || d < best.d)) best = {
					p: f.p,
					d
				};
			}
			if (best) grid.fillThickSegment(e.p, best.p, Math.max(60, e.w.d), GAP);
		}
	}
	if (plan.sketchLines) for (const sg of plan.sketchLines) grid.fillThickSegment(sg.a, sg.b, 40, GAP);
	drawBarriers();
	grid.floodOutside();
	/** 内外判定のために塞いだ切れ目（ポーチなど、屋外に開いた区画の判定に使う） */
	const gapMask = new Uint8Array(grid.data.length);
	for (let i = 0; i < grid.data.length; i++) if (grid.data[i] === GAP) {
		grid.data[i] = 0;
		gapMask[i] = 1;
	}
	const fillCells = [];
	if (plan.roomFills.length) {
		const tmp = new Grid(grid.w, grid.h, grid.res, grid.ox, grid.oy);
		for (const poly of plan.roomFills) for (let i = 0; i < poly.length; i++) tmp.fillThickSegment(poly[i], poly[(i + 1) % poly.length], 30, 1);
		for (let i = 0; i < tmp.data.length; i++) if (tmp.data[i] === 1 && grid.data[i] === 0) {
			grid.data[i] = 1;
			fillCells.push(i);
		}
	}
	if (globalThis.__DBG_STAGE === 1) globalThis.__DBG_GRID?.(grid, plan, level, grid.labelComponents().labels);
	splitMergedRegions(grid, plan);
	if (globalThis.__DBG_STAGE === 2) globalThis.__DBG_GRID?.(grid, plan, level, grid.labelComponents().labels);
	if (fillCells.length) {
		const named = plan.texts.filter((t) => {
			const nm = cleanRoomName(t.str);
			return nm && (classifyRoomName(nm) != null || looksLikeRoomName(nm)) || parseAreaLabel(t.str) != null || parseStairMark(t.str) != null;
		});
		{
			const { labels: lb, sizes: sz } = grid.labelComponents();
			const sliverCells = 3e5 / (grid.res * grid.res);
			const touchesFill = /* @__PURE__ */ new Set();
			for (const i of fillCells) {
				const x = i % grid.w;
				for (const j of [
					x > 0 ? i - 1 : -1,
					x < grid.w - 1 ? i + 1 : -1,
					i - grid.w,
					i + grid.w
				]) if (j >= 0 && j < lb.length && lb[j]) touchesFill.add(lb[j]);
			}
			for (let i = 0; i < lb.length; i++) if (lb[i] && sz[lb[i]] < sliverCells && touchesFill.has(lb[i])) grid.data[i] = 1;
		}
		for (let iter = 0; iter < 3; iter++) {
			const { labels: lb } = grid.labelComponents();
			const hasName = /* @__PURE__ */ new Set();
			for (const t of named) {
				const l = labelNear(grid, lb, t);
				if (l) hasName.add(l);
			}
			const sides = (i) => {
				const x = i % grid.w;
				const out = /* @__PURE__ */ new Set();
				for (const [dx, dy] of [
					[1, 0],
					[-1, 0],
					[0, 1],
					[0, -1]
				]) for (let k = 1; k <= 3; k++) {
					const xx = x + dx * k;
					const j = i + dx * k + dy * k * grid.w;
					if (xx < 0 || xx >= grid.w || j < 0 || j >= lb.length) break;
					if (lb[j]) {
						out.add(lb[j]);
						break;
					}
					if (grid.data[j] !== 1) break;
				}
				return [...out];
			};
			const contact = /* @__PURE__ */ new Map();
			const cellSides = /* @__PURE__ */ new Map();
			for (const i of fillCells) {
				if (grid.data[i] !== 1) continue;
				const sd = sides(i);
				if (sd.length !== 2) continue;
				cellSides.set(i, sd);
				for (const [u, v] of [sd, [sd[1], sd[0]]]) {
					if (hasName.has(u)) continue;
					const m = contact.get(u) ?? /* @__PURE__ */ new Map();
					m.set(v, (m.get(v) ?? 0) + 1);
					contact.set(u, m);
				}
			}
			const mergeTo = /* @__PURE__ */ new Map();
			for (const [u, m] of contact) mergeTo.set(u, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
			let changedAny = false;
			for (const [i, sd] of cellSides) {
				const [u, v] = sd;
				if (mergeTo.get(u) === v || mergeTo.get(v) === u) {
					grid.data[i] = 0;
					changedAny = true;
				}
			}
			if (!changedAny) break;
		}
	}
	const { labels, sizes } = grid.labelComponents();
	globalThis.__DBG_GRID?.(grid, plan, level, labels);
	const acc = /* @__PURE__ */ new Map();
	const labelAt = (p) => {
		const near = labelNear(grid, labels, p);
		if (near) return near;
		const [cx, cy] = grid.cellOf(p);
		for (let r = 0; r <= 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
			const x = cx + dx;
			const y = cy + dy;
			if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
			const l = labels[y * grid.w + x];
			if (l) return l;
		}
		return 0;
	};
	for (const t of plan.texts) {
		const l = labelAt({
			x: t.x,
			y: t.y
		});
		if (!l) continue;
		if (!acc.has(l)) acc.set(l, {
			id: l,
			names: [],
			others: [],
			areas: []
		});
		const a = acc.get(l);
		const area = parseAreaLabel(t.str);
		const tatami = area?.tatami ?? (area?.m2 ? area.m2 / 1.62 : void 0);
		if (tatami) a.areas.push({
			tatami,
			x: t.x,
			y: t.y
		});
		const st = parseStairMark(t.str);
		if (st) a.stair = st;
		const nm = cleanRoomName(t.str);
		const type = nm ? classifyRoomName(nm) : null;
		if (type) a.names.push({
			str: nm,
			type,
			size: t.size,
			x: t.x,
			y: t.y
		});
		else if (nm && !area && !st && looksLikeRoomName(nm)) a.others.push({
			str: nm,
			size: t.size,
			x: t.x,
			y: t.y
		});
	}
	for (const a of acc.values()) {
		if (!a.areas.length) continue;
		const ref = mainName(a.names) ?? a.others[0];
		a.tatami = (ref ? a.areas.slice().sort((p, q) => Math.hypot(p.x - ref.x, p.y - ref.y) - Math.hypot(q.x - ref.x, q.y - ref.y))[0] : a.areas[0]).tatami;
	}
	/** 中庭など、壁に囲まれていても屋外の領域（外形・屋根から除く） */
	const courtLabels = /* @__PURE__ */ new Set();
	const labelOfRoom = /* @__PURE__ */ new Map();
	const thick = walls.map((w) => w.d).sort((a, b) => a - b);
	const medianD = thick.length ? thick[Math.floor(thick.length / 2)] : 120;
	const k = Math.max(1, Math.round(medianD / 2 / res));
	const rooms = [];
	const minCells = 1e3;
	for (let l = 1; l < sizes.length; l++) {
		if (sizes[l] < minCells) continue;
		const mask = new Uint8Array(grid.w * grid.h);
		for (let i = 0; i < mask.length; i++) if (labels[i] === l) mask[i] = 1;
		const loops = traceMask(dilateMask(mask, grid.w, grid.h, k, (i) => grid.data[i] === 1), grid);
		if (!loops.length) continue;
		const poly = loops[0];
		const area = Math.abs(polygonArea(poly)) / 1e6;
		const a = acc.get(l);
		let name = "";
		let type = "other";
		let labelPos = null;
		if (!a?.names.length && a?.others.length) {
			const main = a.others.slice().sort((p, q) => q.size - p.size)[0];
			name = [...new Set(a.others.map((n) => n.str))].slice(0, 2).join("・");
			type = "other";
			labelPos = {
				x: main.x,
				y: main.y
			};
		} else if (a?.names.length) {
			const main = mainName(a.names);
			name = [.../* @__PURE__ */ new Set([main.str, ...a.names.map((n) => n.str)])].join("・");
			type = main.type;
			labelPos = {
				x: main.x,
				y: main.y
			};
			if (type === "balcony" && /庭|COURT/i.test(main.str)) courtLabels.add(l);
		} else if (a?.stair) {
			name = "階段";
			type = "stairs";
		} else if (area < 2) {
			name = "収納";
			type = "storage";
		} else {
			name = "室";
			type = "other";
		}
		if (!labelPos) {
			let sx = 0;
			let sy = 0;
			let n = 0;
			for (let i = 0; i < mask.length; i++) if (mask[i]) {
				sx += i % grid.w;
				sy += i / grid.w | 0;
				n++;
			}
			labelPos = grid.centerOf(sx / n, sy / n);
		}
		labelOfRoom.set(rooms.length, l);
		rooms.push({
			id: `F${level}-R${rooms.length + 1}`,
			name,
			type,
			polygon: poly,
			area,
			labelPos,
			labeledTatami: a?.tatami,
			stairDir: a?.stair
		});
	}
	if (courtLabels.size) rooms.forEach((rm, idx) => {
		if (rm.name !== "室" || rm.area > 20) return;
		const l = labelOfRoom.get(idx);
		if (l == null) return;
		const R = 10;
		let touches = false;
		for (let i = 0; i < labels.length && !touches; i++) {
			if (labels[i] !== l) continue;
			const x = i % grid.w;
			const y = i / grid.w | 0;
			for (const [dx, dy] of [
				[R, 0],
				[-10, 0],
				[0, R],
				[0, -10]
			]) {
				const xx = x + dx;
				const yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= grid.w || yy >= grid.h) continue;
				if (courtLabels.has(labels[yy * grid.w + xx])) {
					touches = true;
					break;
				}
			}
		}
		if (touches) {
			rm.name = "中庭";
			rm.type = "balcony";
			courtLabels.add(l);
		}
	});
	for (const vr of voidRects) {
		const ra = (vr.maxX - vr.minX) * (vr.maxY - vr.minY) / 1e6;
		const r = rooms.find((rm) => {
			const c = rm.polygon.reduce((a0, q) => ({
				x: a0.x + q.x / rm.polygon.length,
				y: a0.y + q.y / rm.polygon.length
			}), {
				x: 0,
				y: 0
			});
			return c.x > vr.minX && c.x < vr.maxX && c.y > vr.minY && c.y < vr.maxY && rm.area > ra * .6 && rm.area < ra * 1.4;
		});
		if (!r) continue;
		r.name = "吹抜";
		r.type = "void";
		for (const o of rooms) {
			if (o === r || !/吹抜/.test(o.name)) continue;
			const rest = o.name.split("・").filter((n) => !/吹抜/.test(n));
			if (rest.length) o.name = rest.join("・");
			if (o.type === "void") o.type = rest.length ? classifyRoomName(rest[0]) ?? "other" : "other";
		}
	}
	if (expectedArea && expectedArea > 5) {
		const extD0 = walls.length ? Math.max(...walls.map((w) => w.d)) : 150;
		const bm = new Uint8Array(grid.w * grid.h);
		for (let i = 0; i < bm.length; i++) bm[i] = grid.data[i] !== 2 && !courtLabels.has(labels[i]) ? 1 : 0;
		const er = erodeMask(bm, grid.w, grid.h, Math.max(1, Math.round(extD0 / 2 / res)));
		let cells = 0;
		for (let i = 0; i < er.length; i++) cells += er[i];
		const excluded = rooms.filter((r) => r.type === "void" || r.type === "garage" || r.type === "balcony" && !/庭/.test(r.name)).reduce((s0, r) => s0 + r.area, 0);
		const A = cells * res * res / 1e6 - excluded;
		const err0 = (A - expectedArea) / expectedArea;
		if (err0 > .04) {
			const cand = rooms.map((r, idx) => ({
				r,
				idx
			})).filter(({ r }) => r.name === "室" && r.area >= 1.5).slice(0, 12);
			let best = null;
			const n = cand.length;
			for (let mask = 1; mask < 1 << n; mask++) {
				const set = [];
				for (let b = 0; b < n; b++) if (mask & 1 << b) set.push(b);
				if (set.length > 3) continue;
				const sub = set.reduce((s0, b) => s0 + cand[b].r.area, 0);
				const err = Math.abs(A - sub - expectedArea) / expectedArea;
				if (!best || err < best.err) best = {
					set,
					err
				};
			}
			if (best && best.err < .025 && best.err < err0 / 2) for (const b of best.set) {
				const { r, idx } = cand[b];
				const l = labelOfRoom.get(idx);
				if (l == null) continue;
				let open = false;
				for (let i = 0; i < labels.length && !open; i++) {
					if (labels[i] !== l) continue;
					const x = i % grid.w;
					for (let d = 1; d <= 4 && !open; d++) for (const j of [
						x >= d ? i - d : -1,
						x + d < grid.w ? i + d : -1,
						i - d * grid.w,
						i + d * grid.w
					]) if (j >= 0 && j < gapMask.length && gapMask[j]) {
						open = true;
						break;
					}
				}
				if (level <= 1) {
					r.name = open ? "ポーチ" : "中庭";
					r.type = open ? "porch" : "balcony";
					courtLabels.add(l);
				} else if (open) {
					r.name = "バルコニー";
					r.type = "balcony";
					courtLabels.add(l);
				} else {
					r.name = "吹抜";
					r.type = "void";
				}
			}
		}
	}
	for (const pt of hints?.courtyards ?? []) {
		const idx = rooms.findIndex((r) => r.name === "室" && pointInPolygon(pt, r.polygon));
		if (idx < 0) continue;
		const l = labelOfRoom.get(idx);
		if (l == null) continue;
		rooms[idx].name = "中庭";
		rooms[idx].type = "balcony";
		courtLabels.add(l);
	}
	const building = new Uint8Array(grid.w * grid.h);
	for (let i = 0; i < building.length; i++) building[i] = grid.data[i] !== 2 && !courtLabels.has(labels[i]) ? 1 : 0;
	const extD = walls.length ? Math.max(...walls.map((w) => w.d)) : 150;
	const outline = traceMask(erodeMask(building, grid.w, grid.h, Math.max(1, Math.round(extD / 2 / res))), grid, res * 1.5).filter((l) => Math.abs(polygonArea(l)) > 2e6);
	const sideState = (p) => {
		const [x, y] = grid.cellOf(p);
		if (x >= 0 && y >= 0 && x < grid.w && y < grid.h && courtLabels.has(labels[y * grid.w + x])) return 2;
		return grid.get(x, y);
	};
	const outWalls = [];
	const openings = [];
	const winInfo = /* @__PURE__ */ new Map();
	const roomAt = (p) => {
		const [x, y] = grid.cellOf(p);
		const l = x >= 0 && y >= 0 && x < grid.w && y < grid.h ? labels[y * grid.w + x] : 0;
		if (!l) return null;
		return roomByLabel.get(l) ?? null;
	};
	const roomByLabel = /* @__PURE__ */ new Map();
	{
		let ri = 0;
		for (let l = 1; l < sizes.length; l++) {
			if (sizes[l] < minCells) continue;
			const r = rooms[ri];
			if (!r) break;
			roomByLabel.set(l, r);
			ri++;
		}
	}
	roomByLabel.clear();
	for (const r of rooms) {
		const [x, y] = grid.cellOf(r.labelPos);
		let l = labels[y * grid.w + x];
		if (!l) l = labelAt(r.labelPos);
		if (l) roomByLabel.set(l, r);
	}
	const southVec = (() => {
		const a = northAngleDeg * Math.PI / 180;
		const nx = Math.sin(a);
		const ny = -Math.cos(a);
		return {
			x: -nx,
			y: -ny
		};
	})();
	walls.forEach((w, wi) => {
		(w.a.x + w.b.x) / 2, (w.a.y + w.b.y) / 2;
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		let outPlus = 0;
		let outMinus = 0;
		const off = w.d / 2 + 60;
		for (let s = .1; s <= .9; s += .2) {
			const p = {
				x: w.a.x + (w.b.x - w.a.x) * s,
				y: w.a.y + (w.b.y - w.a.y) * s
			};
			if (sideState({
				x: p.x + w.n.x * off,
				y: p.y + w.n.y * off
			}) === 2) outPlus++;
			if (sideState({
				x: p.x - w.n.x * off,
				y: p.y - w.n.y * off
			}) === 2) outMinus++;
		}
		const exterior = Math.max(outPlus, outMinus) >= 3;
		const outsideSign = exterior ? outPlus >= outMinus ? 1 : -1 : void 0;
		const id = `F${level}-W${wi + 1}`;
		outWalls.push({
			id,
			a: w.a,
			b: w.b,
			thickness: Math.round(w.d),
			exterior,
			outsideSign,
			joinedA: w.joinedA,
			joinedB: w.joinedB
		});
		for (const op of w.openings) {
			const t0 = Math.max(0, op.t0 - w.t0);
			const t1 = Math.min(L, op.t1 - w.t0);
			if (t1 - t0 < 200) continue;
			const center = {
				x: w.a.x + w.u.x * ((t0 + t1) / 2),
				y: w.a.y + w.u.y * ((t0 + t1) / 2)
			};
			const notes = plan.texts.map((t) => {
				const dx = t.x - center.x;
				const dy = t.y - center.y;
				return {
					t,
					along: Math.abs(dx * w.u.x + dy * w.u.y),
					across: Math.abs(dx * w.n.x + dy * w.n.y)
				};
			}).filter((q) => q.along <= (t1 - t0) / 2 + 350 && q.across <= 900).sort((a, b) => a.across + a.along * .3 - (b.across + b.along * .3));
			const noteSash = notes.map((q) => ({
				q,
				v: parseSashCode(q.t.str)
			})).find((q) => q.v)?.v ?? null;
			const noteFl = notes.map((q) => parseFlOffset(q.t.str)).find((v) => v != null) ?? null;
			const noteOpen = notes.some((q) => isOpenMark(q.t.str));
			const noteKind = notes.map((q) => parseSashKind(q.t.str)).find((v) => v != null) ?? null;
			const inSign = exterior ? -(outsideSign ?? 1) : 1;
			const inRoom = roomAt({
				x: center.x + w.n.x * inSign * (w.d / 2 + 60),
				y: center.y + w.n.y * inSign * (w.d / 2 + 60)
			});
			const otherRoom = roomAt({
				x: center.x - w.n.x * inSign * (w.d / 2 + 60),
				y: center.y - w.n.y * inSign * (w.d / 2 + 60)
			});
			const width = t1 - t0;
			let kind;
			let sill = 0;
			let height = 2e3;
			let windowStyle;
			const outdoorType = (t) => !t || t === "balcony" || t === "porch" || t === "garage";
			const bothInside = !!inRoom && !!otherRoom && !outdoorType(inRoom.type) && !outdoorType(otherRoom.type);
			if (exterior && !bothInside) {
				if (level === 1 && (op.kind === "door" || inRoom?.type === "entrance" && op.kind !== "window")) {
					kind = "entrance";
					height = 2200;
				} else if (op.kind === "door") {
					kind = "door";
					height = 2e3;
				} else {
					kind = "window";
					const outN = {
						x: w.n.x * (outsideSign ?? 1),
						y: w.n.y * (outsideSign ?? 1)
					};
					const southDot = outN.x * southVec.x + outN.y * southVec.y;
					const facingSouth = southDot > .7;
					const ws = windowStyleFor(inRoom?.type ?? null, width, facingSouth);
					sill = ws.sill;
					height = ws.height;
					windowStyle = ws.style;
					winInfo.set(openings.length, {
						room: inRoom?.type ?? null,
						south: Math.max(0, southDot),
						drawn: !!(noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * .35)) || noteFl != null && noteFl < 1600
					});
					if (noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * .35)) {
						height = noteSash.height;
						if (noteFl != null && noteFl < 1600) sill = noteFl;
						else if (height >= 1800) sill = 0;
						else sill = Math.max(0, 2e3 - height);
						windowStyle = height >= 1800 ? "hakidashi" : height <= 600 ? sill >= 1300 ? "high" : "small" : "koshi";
					} else if (noteFl != null && noteFl < 1600) {
						sill = noteFl;
						height = Math.min(height, 2e3 - sill);
						windowStyle = sill === 0 ? "hakidashi" : sill >= 1300 ? "high" : "koshi";
					}
				}
			} else {
				if (op.kind === "door") kind = "door";
				else if (op.kind === "window") kind = "sliding";
				else kind = "open";
				if (noteOpen) kind = "open";
				else if (noteKind === "sliding" && kind !== "door") kind = "sliding";
				height = 2e3;
				if (noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * .35)) height = noteSash.height >= 1800 ? noteSash.height : 2e3;
			}
			openings.push({
				id: `${id}-O${openings.length + 1}`,
				wallId: id,
				kind,
				t0,
				t1,
				sill,
				height,
				windowStyle,
				hingeAtStart: op.hingeAtStart,
				swingSide: op.swingSign,
				confidence: op.confidence
			});
		}
	});
	applyWindowVocabulary(openings, winInfo);
	const stairs = [];
	const nonWallSegs = plan.segs.filter((s) => {
		const m = {
			x: (s.a.x + s.b.x) / 2,
			y: (s.a.y + s.b.y) / 2
		};
		const [x, y] = grid.cellOf(m);
		return grid.get(x, y) === 0;
	});
	const stairMarks = plan.texts.filter((t) => parseStairMark(t.str) != null || /階段/.test(t.str));
	for (const c of detectStairs(nonWallSegs, plan.bbox)) {
		if (stairMarks.length && !stairMarks.some((t) => t.x > c.minX - 900 && t.x < c.maxX + 900 && t.y > c.minY - 900 && t.y < c.maxY + 900)) continue;
		{
			const cc = {
				x: (c.minX + c.maxX) / 2,
				y: (c.minY + c.maxY) / 2
			};
			const rr = roomAt(cc);
			if (rr && (rr.type === "balcony" || rr.type === "garage" || rr.type === "porch")) continue;
			if (!rr && !outline.some((l) => pointInPolygon(cc, l))) continue;
		}
		const r = { ...c };
		const grow = (dx, dy) => {
			for (let step = 0; step < 20; step++) {
				const probe = dx !== 0 ? {
					x: (dx > 0 ? r.maxX : r.minX) + dx * res,
					y: (r.minY + r.maxY) / 2
				} : {
					x: (r.minX + r.maxX) / 2,
					y: (dy > 0 ? r.maxY : r.minY) + dy * res
				};
				if (sideState(probe) !== 0) break;
				if (dx > 0) r.maxX += res;
				if (dx < 0) r.minX -= res;
				if (dy > 0) r.maxY += res;
				if (dy < 0) r.minY -= res;
			}
		};
		grow(1, 0);
		grow(-1, 0);
		grow(0, 1);
		grow(0, -1);
		const sideWallRatio = (side) => {
			let wall = 0;
			let n = 0;
			const N = 12;
			for (let i = 1; i < N; i++) {
				const f = i / N;
				let p;
				if (side === "n") p = {
					x: r.minX + (r.maxX - r.minX) * f,
					y: r.minY - 80
				};
				else if (side === "s") p = {
					x: r.minX + (r.maxX - r.minX) * f,
					y: r.maxY + 80
				};
				else if (side === "w") p = {
					x: r.minX - 80,
					y: r.minY + (r.maxY - r.minY) * f
				};
				else p = {
					x: r.maxX + 80,
					y: r.minY + (r.maxY - r.minY) * f
				};
				n++;
				if (sideState(p) !== 0) wall++;
			}
			return wall / n;
		};
		const sides = [
			"n",
			"s",
			"e",
			"w"
		].map((s) => ({
			s,
			r: sideWallRatio(s)
		})).sort((a, b) => a.r - b.r);
		const w = r.maxX - r.minX;
		const h = r.maxY - r.minY;
		const kind = c.flights >= 2 || Math.max(w, h) / Math.min(w, h) < 1.5 ? "u" : "straight";
		const hasDn = plan.texts.some((t) => parseStairMark(t.str) === "down" && t.x > r.minX - 300 && t.x < r.maxX + 300 && t.y > r.minY - 300 && t.y < r.maxY + 300);
		const arrowSide = stairEntryFromArrow(r, nonWallSegs, plan.texts.filter((t) => parseStairMark(t.str) != null).map((t) => ({
			x: t.x,
			y: t.y
		})));
		const entry = arrowSide && sideWallRatio(arrowSide) < .9 ? arrowSide : sides[0].s;
		const stepNote = plan.texts.map((t) => ({
			n: parseStepCount(t.str),
			d: Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY))
		})).filter((q) => q.n != null && q.d <= 1200).sort((a, b) => a.d - b.d)[0];
		stairs.push({
			id: `F${level}-S${stairs.length + 1}`,
			minX: r.minX,
			minY: r.minY,
			maxX: r.maxX,
			maxY: r.maxY,
			kind,
			entry,
			goesUp: !hasDn,
			...stepNote ? { steps: stepNote.n } : {}
		});
	}
	for (const st of stairs) {
		const r = roomAt({
			x: (st.minX + st.maxX) / 2,
			y: (st.minY + st.maxY) / 2
		});
		if (r && r.type === "other") {
			r.type = "stairs";
			r.name = "階段";
		}
	}
	if (!rooms.length) warnings.push(`${level}階: 部屋を検出できませんでした`);
	const labelSizes = rooms.map((r) => plan.texts.find((t) => Math.abs(t.x - r.labelPos.x) < 50 && Math.abs(t.y - r.labelPos.y) < 50)?.size ?? 0).filter((s) => s > 0).sort((a, b) => a - b);
	const labelSize = labelSizes.length ? labelSizes[Math.floor(labelSizes.length / 2)] : 280;
	const nearTexts = plan.siteTexts.filter((t) => t.x > plan.bbox.minX - 3e3 && t.x < plan.bbox.maxX + 3e3 && t.y > plan.bbox.minY - 3e3 && t.y < plan.bbox.maxY + 3e3 && !plan.texts.some((u) => u.x === t.x && u.y === t.y));
	const notes = plan.scan ? [] : detectNotes([...plan.texts, ...nearTexts], labelSize, rooms);
	const sym = plan.scan || plan.loose ? {
		items: [],
		exterior: {
			cars: [],
			trees: []
		}
	} : symbolsToItems(detectSymbols(uniqueSegs([...plan.segs, ...plan.siteSegs])), rooms, outWalls, outline, level, globalThis.__symTrace);
	const g = globalThis;
	const ctx = plan.scan || plan.loose ? null : readContextItems(uniqueSegs(plan.segs), plan.arcs, rooms, outWalls, level, g.__symbolDict, sym.items);
	if (ctx && g.__ctxTrace) g.__ctxTrace.push(...ctx.trace.map((t) => `${level}F ${t}`));
	const taken = new Set((ctx?.items ?? []).flatMap((it) => it.kind === "kitchen" ? [`${it.roomId}:kitchen`, `${it.roomId}:dining`] : [`${it.roomId}:${it.kind}`]));
	const mergedItems = [...ctx?.items ?? [], ...sym.items.filter((it) => !(it.roomId && taken.has(`${it.roomId}:${it.kind}`)))];
	return {
		level,
		elevation: 0,
		height: 2900,
		ceilingHeight: 2400,
		walls: outWalls,
		openings,
		rooms,
		stairs,
		outline,
		planItems: mergedItems.length ? mergedItems : void 0,
		symbolCandidates: ctx?.candidates.length ? ctx.candidates : void 0,
		exterior: sym.exterior.cars.length || sym.exterior.trees.length ? sym.exterior : void 0,
		notes: notes.length ? notes : void 0
	};
}
/** 方位記号「N」の周囲の図形から真北方向を推定 */
function bezierMid(a) {
	return {
		x: .125 * a.p0.x + .375 * a.p1.x + .375 * a.p2.x + .125 * a.p3.x,
		y: .125 * a.p0.y + .375 * a.p1.y + .375 * a.p2.y + .125 * a.p3.y
	};
}
function circumcenter(a, b, c) {
	const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
	if (Math.abs(d) < 1e-9) return null;
	const a2 = a.x * a.x + a.y * a.y;
	const b2 = b.x * b.x + b.y * b.y;
	const c2 = c.x * c.x + c.y * c.y;
	return {
		x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
		y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
	};
}
/**
* 方位記号の図形から真北を求める（ARCHITREND などの「円＋星形＋北を指す長い線と片羽の矢」）。
* 円の中心を通る長い線のうち、端に矢羽（短い線）が付いている側、または「真北」「N」の文字に近い側を北とする。
*/
function detectCompass(p) {
	const segs = p.segs;
	const cell = 300;
	const grid = /* @__PURE__ */ new Map();
	const add = (q) => {
		const k = `${Math.floor(q.x / cell)},${Math.floor(q.y / cell)}`;
		let a = grid.get(k);
		if (!a) grid.set(k, a = []);
		a.push(q);
	};
	for (const sg of segs) if (Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 400) add(sg.a), add(sg.b);
	for (const a of p.arcs) add(a.p0), add(a.p3), add(bezierMid(a));
	const around = (c, r) => {
		const out = [];
		for (let gx = Math.floor((c.x - r) / cell); gx <= Math.floor((c.x + r) / cell); gx++) for (let gy = Math.floor((c.y - r) / cell); gy <= Math.floor((c.y + r) / cell); gy++) for (const q of grid.get(`${gx},${gy}`) ?? []) out.push(q);
		return out;
	};
	const labels = p.texts.filter((t) => /^(真北|N|Ｎ|北|NORTH)$/i.test(t.str.trim()));
	let best = null;
	for (const L of segs) {
		const len = Math.hypot(L.b.x - L.a.x, L.b.y - L.a.y);
		if (len < 1500 || len > 15e3) continue;
		const C = {
			x: (L.a.x + L.b.x) / 2,
			y: (L.a.y + L.b.y) / 2
		};
		const half = len / 2;
		const pts = around(C, half * .9).map((q) => ({
			q,
			d: Math.hypot(q.x - C.x, q.y - C.y)
		})).filter((o) => o.d > half * .15 && o.d < half * .9);
		if (pts.length < 24) continue;
		const bins = /* @__PURE__ */ new Map();
		for (const o of pts) {
			const k = Math.round(o.d / (half * .04));
			if (!bins.has(k)) bins.set(k, []);
			bins.get(k).push(o);
		}
		let ring = [];
		for (const [k, v] of bins) {
			const all = v.concat(bins.get(k + 1) ?? []);
			if (all.length > ring.length) ring = all;
		}
		if (ring.length < 20) continue;
		if (new Set(ring.map((o) => Math.floor((Math.atan2(o.q.y - C.y, o.q.x - C.x) + Math.PI) / (Math.PI * 2) * 8) % 8)).size < 7) continue;
		const r = ring.reduce((s0, o) => s0 + o.d, 0) / ring.length;
		if (half < r * 1.4) continue;
		const ends = [L.a, L.b];
		const ux = (L.b.x - L.a.x) / len;
		const uy = (L.b.y - L.a.y) / len;
		const endScore = ends.map((E) => {
			let sc = 0;
			for (const sg of segs) {
				if (sg === L) continue;
				const sl = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
				if (sl > r * 1.2) continue;
				if (Math.min(Math.hypot(sg.a.x - E.x, sg.a.y - E.y), Math.hypot(sg.b.x - E.x, sg.b.y - E.y)) > r * .7) continue;
				if (Math.abs(((sg.b.x - sg.a.x) * ux + (sg.b.y - sg.a.y) * uy) / Math.max(1e-6, sl)) < .97) sc += 1;
			}
			return sc;
		});
		if (Math.max(...endScore) > 6) continue;
		for (let k = 0; k < 2; k++) for (const t of labels) if (Math.hypot(t.x - ends[k].x, t.y - ends[k].y) < r * 2.5) endScore[k] += 5;
		if (endScore[0] === endScore[1]) continue;
		const E = endScore[0] > endScore[1] ? ends[0] : ends[1];
		const score = Math.max(...endScore) + ring.length / 10;
		const deg = Math.round(Math.atan2(E.x - C.x, -(E.y - C.y)) * 180 / Math.PI) || 0;
		if (!best || score > best.score) best = {
			deg,
			score
		};
	}
	return best ? best.deg : null;
}
function detectNorth(pages) {
	for (const p of pages) {
		const c = detectCompass(p);
		if (c != null) return c;
	}
	for (const p of pages) {
		const ns = p.texts.filter((t) => /^(真北|N|Ｎ|北|NORTH)$/i.test(t.str.trim()));
		for (const t of ns) {
			const R = t.size * 5;
			const pts = [];
			for (const s of p.segs) for (const q of [s.a, s.b]) if (Math.hypot(q.x - t.x, q.y - t.y) < R) pts.push(q);
			for (const a of p.arcs) for (const q of [a.p0, a.p3]) if (Math.hypot(q.x - t.x, q.y - t.y) < R) pts.push(q);
			for (const f of p.fills) for (const q of f.polygon) if (Math.hypot(q.x - t.x, q.y - t.y) < R) pts.push(q);
			if (pts.length < 3) continue;
			let cx = pts.reduce((s0, q) => s0 + q.x, 0) / pts.length;
			let cy = pts.reduce((s0, q) => s0 + q.y, 0) / pts.length;
			const centers = [];
			for (const a of p.arcs) {
				if (Math.hypot(a.p0.x - t.x, a.p0.y - t.y) > R) continue;
				const c = circumcenter(a.p0, bezierMid(a), a.p3);
				if (c) centers.push(c);
			}
			if (centers.length >= 2) {
				cx = centers.reduce((s0, q) => s0 + q.x, 0) / centers.length;
				cy = centers.reduce((s0, q) => s0 + q.y, 0) / centers.length;
			}
			const vx = t.x - cx;
			const vy = t.y - cy;
			if (Math.hypot(vx, vy) < t.size * .5) continue;
			let deg = Math.atan2(vx, -vy) * 180 / Math.PI;
			deg = Math.round(deg) || 0;
			return deg;
		}
	}
	return null;
}
/**
* 部屋の形をした塗り: 頂点が少なく、辺が 45° の倍数の向き。
* カラー平面図の床のグラデーション（同心円の塗り）や家具の曲線は除く。
*/
function isRoomShaped(poly) {
	const pts = poly.filter((q, i) => i === 0 || Math.hypot(q.x - poly[i - 1].x, q.y - poly[i - 1].y) > 30);
	if (pts.length < 3 || pts.length > 14) return false;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		if (Math.hypot(b.x - a.x, b.y - a.y) < 30) continue;
		const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI % 45 + 45) % 45;
		if (Math.min(deg, 45 - deg) > 3) return false;
	}
	return true;
}
/** 細長い帯状の塗り（手すり壁・腰壁・曲面の壁など）: 幅 40〜180mm、長さ 600mm 以上 */
function isStripFill(poly) {
	const area = Math.abs(polygonArea(poly));
	let per = 0;
	for (let i = 0; i < poly.length; i++) per += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
	if (per < 1200) return false;
	const width = 2 * area / per;
	return width >= 40 && width <= 180 && per / 2 >= 600;
}
/** 壁の塗りの色: その色の塗りの頂点の大半が、検出した壁の上にある色 */
function wallFillColors(fills, walls) {
	const stat = /* @__PURE__ */ new Map();
	for (const f of fills) {
		const st = stat.get(f.color) ?? {
			n: 0,
			on: 0,
			polys: 0,
			thin: 0
		};
		st.polys++;
		let per = 0;
		for (let i = 0; i < f.poly.length; i++) per += Math.hypot(f.poly[(i + 1) % f.poly.length].x - f.poly[i].x, f.poly[(i + 1) % f.poly.length].y - f.poly[i].y);
		if (per > 0 && 2 * Math.abs(polygonArea(f.poly)) / per <= 400) st.thin++;
		for (const q of f.poly) {
			st.n++;
			if (walls.some((w) => distPointSegment(q, w.a, w.b) <= w.d / 2 + 40)) st.on++;
		}
		stat.set(f.color, st);
	}
	const out = /* @__PURE__ */ new Set();
	for (const [c, st] of stat) if (st.polys >= 5 && st.on / st.n >= .6 && st.thin / st.polys >= .6) out.add(c);
	return out;
}
function detectPlans(pages, warnings) {
	const plans = [];
	for (const page of pages) {
		const pageExt = page.segs.length >= 50 || !page.rasterMask ? bboxOf$2(page.segs.flatMap((sg) => [sg.a, sg.b])) : {
			minX: 0,
			minY: 0,
			maxX: page.rasterMask.w * page.rasterMask.res,
			maxY: page.rasterMask.h * page.rasterMask.res
		};
		let ww = makeWalls(detectWalls(page.segs, page.arcs, {}, page.masks));
		joinWalls(ww);
		let groups = clusterPlans(ww, pageExt);
		let sketchHeavy = null;
		let loose = false;
		let scan = false;
		if (!groups.length && page.rasterMask) {
			const det2 = detectWallsRasterAuto(page.rasterMask, {
				closeRadius: 1,
				minThickness: page.rasterMask.res * 2.5,
				maxThickness: 400
			});
			if (det2) {
				const w2 = makeWalls(det2);
				joinWalls(w2);
				const g2 = clusterPlans(w2, pageExt, 1200, 600);
				if (g2.length) {
					ww = w2;
					groups = g2;
					loose = true;
					scan = true;
				}
			}
		}
		if (!groups.length) {
			const det2 = rasterWallDetection(page);
			if (det2) {
				const w2 = makeWalls(det2);
				joinWalls(w2);
				const g2 = clusterPlans(w2, pageExt, 1200, 600, page.segs.filter((sg) => sg.source === "stroke"));
				if (g2.length) {
					ww = w2;
					groups = g2;
					loose = true;
					const st = page.segs.filter((sg) => !sg.dashed && sg.source === "stroke");
					const hT = heavyWidthThreshold(st);
					sketchHeavy = hT == null ? st : st.filter((sg) => sg.width >= hT);
				}
			}
		}
		if (globalThis.__DBG_PLANS) (globalThis.__DBG_CLUSTERS ??= []).push(...groups.map((g) => ({
			page: page.pageIndex,
			walls: g
		})));
		const wallColors = wallFillColors(page.colorFills, ww);
		if (!groups.length && !page.rasterMask) warnings.push(`${page.pageIndex + 1}ページ目: 平面図の壁を検出できませんでした`);
		const isRoomText = (t) => classifyRoomName(t.str) != null || parseAreaLabel(t.str) != null;
		const pageHasRooms = page.texts.some(isRoomText);
		const boxes = groups.map((g) => bboxOf$2(g.flatMap((w) => [w.a, w.b])));
		const ext = pageExt;
		const inside = (a, b) => a.minX >= b.minX - 50 && a.maxX <= b.maxX + 50 && a.minY >= b.minY - 50 && a.maxY <= b.maxY + 50;
		for (let gi = 0; gi < groups.length; gi++) {
			const g = groups[gi];
			const bbox = boxes[gi];
			if (globalThis.__DBG_PLANS) console.log("cluster", gi, g.length, Math.round(bbox.maxX - bbox.minX), Math.round(bbox.maxY - bbox.minY), "ext", Math.round(ext.maxX - ext.minX), Math.round(ext.maxY - ext.minY), "contains", boxes.some((b, j) => j !== gi && inside(b, bbox)));
			if (boxes.some((b, j) => j !== gi && inside(b, bbox))) continue;
			if (bbox.maxX - bbox.minX > (ext.maxX - ext.minX) * .8 && bbox.maxY - bbox.minY > (ext.maxY - ext.minY) * .8) continue;
			const roomTexts = page.texts.filter((t) => t.x > bbox.minX && t.x < bbox.maxX && t.y > bbox.minY && t.y < bbox.maxY && isRoomText(t)).length;
			if (pageHasRooms && roomTexts === 0) continue;
			const margin = 400;
			const inBox = (x, y, m) => x > bbox.minX - m && x < bbox.maxX + m && y > bbox.minY - m && y < bbox.maxY + m;
			const texts = page.texts.filter((t) => inBox(t.x, t.y, margin));
			const segs = page.segs.filter((s) => inBox((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, margin));
			const siteTexts = page.texts.filter((t) => inBox(t.x, t.y, 3e4));
			const siteSegs = page.segs.filter((s) => inBox(s.a.x, s.a.y, 3e4) || inBox(s.b.x, s.b.y, 3e4));
			const wallPolys = page.colorFills.filter((f) => f.poly.every((q) => inBox(q.x, q.y, margin)) && (wallColors.has(f.color) || isStripFill(f.poly))).map((f) => f.poly);
			const sashPolys = page.masks.filter((poly) => {
				if (!poly.every((q) => inBox(q.x, q.y, margin))) return false;
				const b = bboxOf$2(poly);
				const w = b.maxX - b.minX;
				const h = b.maxY - b.minY;
				const thin = Math.min(w, h);
				return thin >= 40 && thin <= 220 && Math.max(w, h) >= 500;
			});
			const labelTexts = texts.filter((t) => {
				const nm = cleanRoomName(t.str);
				return nm && classifyRoomName(nm) != null || parseAreaLabel(t.str) != null || /階段/.test(t.str);
			});
			const roomFills = [];
			const cand = page.colorFills.filter((f) => !wallColors.has(f.color) && !isStripFill(f.poly) && f.poly.every((q) => inBox(q.x, q.y, margin))).map((f) => ({
				poly: f.poly,
				area: Math.abs(polygonArea(f.poly)) / 1e6,
				bb: bboxOf$2(f.poly)
			})).filter((c) => c.area >= .6 && c.area <= 80 && isRoomShaped(c.poly)).map((c) => ({
				...c,
				labels: labelTexts.filter((t) => pointInPolygon({
					x: t.x,
					y: t.y
				}, c.poly))
			})).filter((c) => c.labels.length).sort((a, b) => b.area - a.area);
			const kept = [];
			for (const c of cand) {
				if (kept.some((k) => c.bb.minX >= k.bb.minX - 60 && c.bb.maxX <= k.bb.maxX + 60 && c.bb.minY >= k.bb.minY - 60 && c.bb.maxY <= k.bb.maxY + 60 && c.labels.every((t) => k.labels.includes(t)))) continue;
				kept.push(c);
				roomFills.push(c.poly);
			}
			const sketchLines = sketchHeavy ? sketchHeavy.filter((sg) => inBox(sg.a.x, sg.a.y, margin) && inBox(sg.b.x, sg.b.y, margin)) : void 0;
			plans.push({
				pageIndex: page.pageIndex,
				bbox,
				floorHint: null,
				walls: g,
				texts,
				segs,
				arcs: page.arcs,
				siteTexts,
				siteSegs,
				wallPolys,
				sashPolys,
				roomFills,
				sketchLines,
				loose,
				scan
			});
		}
	}
	assignFloorTitles(plans, pages);
	for (const p of plans.slice()) {
		if (p.floorHint != null) continue;
		const near = plans.filter((q) => q !== p && q.pageIndex === p.pageIndex && q.floorHint != null).map((q) => ({
			q,
			gap: bboxGap(p.bbox, q.bbox)
		})).filter((o) => o.gap < 3e3).sort((a, b) => a.gap - b.gap)[0];
		if (!near) continue;
		const q = near.q;
		q.walls.push(...p.walls);
		const seen = new Set(q.texts);
		q.texts.push(...p.texts.filter((t) => !seen.has(t)));
		q.segs.push(...p.segs);
		q.arcs.push(...p.arcs);
		q.wallPolys.push(...p.wallPolys);
		q.sashPolys.push(...p.sashPolys);
		q.roomFills.push(...p.roomFills);
		if (p.sketchLines) q.sketchLines = [...q.sketchLines ?? [], ...p.sketchLines];
		if (p.loose) q.loose = true;
		q.bbox = {
			minX: Math.min(q.bbox.minX, p.bbox.minX),
			minY: Math.min(q.bbox.minY, p.bbox.minY),
			maxX: Math.max(q.bbox.maxX, p.bbox.maxX),
			maxY: Math.max(q.bbox.maxY, p.bbox.maxY)
		};
		plans.splice(plans.indexOf(p), 1);
	}
	for (const p of plans) {
		const others = plans.filter((q) => q !== p && q.pageIndex === p.pageIndex);
		if (!others.length) continue;
		const inOther = (q) => others.some((o) => q.x > o.bbox.minX - 400 && q.x < o.bbox.maxX + 400 && q.y > o.bbox.minY - 400 && q.y < o.bbox.maxY + 400);
		p.siteSegs = p.siteSegs.filter((s) => !(inOther(s.a) && inOther(s.b)));
		p.siteTexts = p.siteTexts.filter((t) => !inOther(t));
	}
	return plans;
}
/**
* 「1階平面図」などの見出しを図面に1対1で割り当てる。
* 見出しは図面の真下（または真上）に置かれることが多いので、横方向のずれを重く評価する。
*/
function assignFloorTitles(plans, pages) {
	const cands = [];
	for (const page of pages) {
		const onPage = plans.filter((p) => p.pageIndex === page.pageIndex);
		const isTitle = (t) => {
			const s0 = normalizeText(t.str);
			if (/平面|PLAN/.test(s0)) return true;
			return followingOnLine(t, page.texts, 12).some((q) => /^平面/.test(normalizeText(q.str).replace(/\s/g, "")));
		};
		for (const t of page.texts) {
			const f = parseFloorTitle(t.str);
			if (f == null || !isTitle(t)) continue;
			for (const p of onPage) {
				const b = p.bbox;
				const dx = Math.max(0, b.minX - t.x, t.x - b.maxX);
				const dy = Math.max(0, b.minY - t.y, t.y - b.maxY);
				const h = b.maxY - b.minY;
				const w = b.maxX - b.minX;
				if (onPage.length > 1 && (dy > h * .9 || dx > w * .6)) continue;
				cands.push({
					plan: p,
					title: t,
					floor: f,
					score: dx * 3 + dy
				});
			}
		}
	}
	cands.sort((a, b) => a.score - b.score);
	const usedPlan = /* @__PURE__ */ new Set();
	const usedTitle = /* @__PURE__ */ new Set();
	const usedFloor = /* @__PURE__ */ new Set();
	for (const c of cands) {
		const fk = `${c.plan.pageIndex}:${c.floor}`;
		if (usedPlan.has(c.plan) || usedTitle.has(c.title) || usedFloor.has(fk)) continue;
		c.plan.floorHint = c.floor;
		usedPlan.add(c.plan);
		usedTitle.add(c.title);
		usedFloor.add(fk);
	}
}
/** 上階の図面を下階に位置合わせするための平行移動量（壁の重なり・階段位置・外形の包含で評価） */
function alignOffset(base, other) {
	const axesOf = (p, vertical) => p.walls.filter((w) => vertical ? Math.abs(w.u.y) > .99 : Math.abs(w.u.x) > .99).map((w) => vertical ? {
		c: w.a.x,
		t0: Math.min(w.a.y, w.b.y),
		t1: Math.max(w.a.y, w.b.y)
	} : {
		c: w.a.y,
		t0: Math.min(w.a.x, w.b.x),
		t1: Math.max(w.a.x, w.b.x)
	});
	const AV = axesOf(base, true);
	const AH = axesOf(base, false);
	const BV = axesOf(other, true);
	const BH = axesOf(other, false);
	const overlapScore = (A, B, dc, dt) => {
		let s = 0;
		for (const b of B) for (const a of A) {
			if (Math.abs(a.c - (b.c + dc)) > 25) continue;
			s += Math.max(0, Math.min(a.t1, b.t1 + dt) - Math.max(a.t0, b.t0 + dt));
		}
		return s;
	};
	const cands1d = (A, B) => {
		const m = /* @__PURE__ */ new Map();
		for (const a of A) for (const b of B) {
			const c = Math.round(a.c - b.c);
			m.set(c, (m.get(c) ?? 0) + Math.min(a.t1 - a.t0, b.t1 - b.t0));
		}
		return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([c]) => c);
	};
	const dxs = new Set(cands1d(AV, BV));
	const dys = new Set(cands1d(AH, BH));
	dxs.add(Math.round(base.bbox.minX - other.bbox.minX));
	dys.add(Math.round(base.bbox.minY - other.bbox.minY));
	const sa = detectStairs(base.segs, base.bbox);
	const sb = detectStairs(other.segs, other.bbox);
	for (const a of sa) for (const b of sb) {
		dxs.add(Math.round((a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2));
		dys.add(Math.round((a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2));
	}
	const areaB = (other.bbox.maxX - other.bbox.minX) * (other.bbox.maxY - other.bbox.minY);
	let best = {
		x: 0,
		y: 0
	};
	let bestScore = -Infinity;
	for (const dx of dxs) for (const dy of dys) {
		let score = overlapScore(AV, BV, dx, dy) + overlapScore(AH, BH, dy, dx);
		for (const a of sa) for (const b of sb) {
			const inter = Math.max(0, Math.min(a.maxX, b.maxX + dx) - Math.max(a.minX, b.minX + dx)) * Math.max(0, Math.min(a.maxY, b.maxY + dy) - Math.max(a.minY, b.minY + dy));
			const ar = (a.maxX - a.minX) * (a.maxY - a.minY);
			if (ar > 0) score += 2e4 * (inter / ar);
		}
		const ix = Math.max(0, Math.min(base.bbox.maxX, other.bbox.maxX + dx) - Math.max(base.bbox.minX, other.bbox.minX + dx));
		const iy = Math.max(0, Math.min(base.bbox.maxY, other.bbox.maxY + dy) - Math.max(base.bbox.minY, other.bbox.minY + dy));
		score -= 1e4 * (1 - ix * iy / Math.max(1, areaB));
		if (score > bestScore) {
			bestScore = score;
			best = {
				x: dx,
				y: dy
			};
		}
	}
	return best;
}
function translatePlan(p, d) {
	const tr = (q) => ({
		x: q.x + d.x,
		y: q.y + d.y
	});
	for (const w of p.walls) {
		w.a = tr(w.a);
		w.b = tr(w.b);
		const dt = d.x * w.u.x + d.y * w.u.y;
		const dO = d.x * w.n.x + d.y * w.n.y;
		w.t0 += dt;
		w.t1 += dt;
		w.o += dO;
		for (const op of w.openings) {
			op.t0 += dt;
			op.t1 += dt;
			op.o += dO;
		}
	}
	p.texts = p.texts.map((t) => ({
		...t,
		x: t.x + d.x,
		y: t.y + d.y
	}));
	p.segs = p.segs.map((s) => ({
		...s,
		a: tr(s.a),
		b: tr(s.b)
	}));
	p.arcs = p.arcs.map((a) => ({
		...a,
		p0: tr(a.p0),
		p1: tr(a.p1),
		p2: tr(a.p2),
		p3: tr(a.p3)
	}));
	p.siteTexts = p.siteTexts.map((t) => ({
		...t,
		x: t.x + d.x,
		y: t.y + d.y
	}));
	p.siteSegs = p.siteSegs.map((s) => ({
		...s,
		a: tr(s.a),
		b: tr(s.b)
	}));
	p.wallPolys = p.wallPolys.map((poly) => poly.map(tr));
	p.sashPolys = p.sashPolys.map((poly) => poly.map(tr));
	p.roomFills = p.roomFills.map((poly) => poly.map(tr));
	if (p.sketchLines) p.sketchLines = p.sketchLines.map((sg) => ({
		...sg,
		a: tr(sg.a),
		b: tr(sg.b)
	}));
	p.bbox = {
		minX: p.bbox.minX + d.x,
		maxX: p.bbox.maxX + d.x,
		minY: p.bbox.minY + d.y,
		maxY: p.bbox.maxY + d.y
	};
}
/**
* 組み立てた階を木造のモジュール格子（半間 455 / 500）へ寄せる。
* 部屋の区切りは図面の線のまま解析し、結果（壁芯・開口・部屋・外形・階段）だけを格子へ寄せる。
* 縦横の壁の芯を格子へ寄せ、壁の端は接していた直交する壁の芯へ付け直し、部屋・外形の頂点は元の壁を追って動かす。
* 斜めの壁・格子から大きく外れた壁はそのまま
*/
function snapFloorWalls(f, m) {
	const tol = snapTolerance(m.grid);
	const tolEnd = endTolerance(m.grid);
	const axes = [];
	for (const w of f.walls) {
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		if (L < 1) continue;
		const horiz = Math.abs(w.b.y - w.a.y) < L * .02;
		const vert = Math.abs(w.b.x - w.a.x) < L * .02;
		if (!horiz && !vert) continue;
		const oldAxis = horiz ? (w.a.y + w.b.y) / 2 : (w.a.x + w.b.x) / 2;
		const sn = snapCoord(oldAxis, horiz ? m.phaseY : m.phaseX, m.grid);
		axes.push({
			wall: w,
			horiz,
			oldAxis,
			newAxis: Math.abs(sn - oldAxis) <= tol ? sn : oldAxis
		});
	}
	/** 元の位置 v に最も近かった（横 or 縦の）壁の芯の、寄せた後の位置 */
	const follow = (v, horiz, within) => {
		let best = null;
		for (const ax of axes) {
			if (ax.horiz !== horiz) continue;
			const d = Math.abs(ax.oldAxis - v);
			if (d <= within && (!best || d < Math.abs(best.oldAxis - v))) best = ax;
		}
		return best ? best.newAxis : null;
	};
	const shiftA = /* @__PURE__ */ new Map();
	for (const ax of axes) {
		const w = ax.wall;
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		const u = {
			x: (w.b.x - w.a.x) / L,
			y: (w.b.y - w.a.y) / L
		};
		const endPos = (p) => ax.horiz ? p.x : p.y;
		const newEnd = (p) => {
			const v = endPos(p);
			const f0 = follow(v, !ax.horiz, 250);
			if (f0 != null) return f0;
			const sn = snapCoord(v, ax.horiz ? m.phaseX : m.phaseY, m.grid);
			return Math.abs(sn - v) <= tolEnd ? sn : v;
		};
		let ea = newEnd(w.a);
		let eb = newEnd(w.b);
		if (Math.abs(ea - eb) < 200) {
			const gridEnd = (p) => {
				const v = endPos(p);
				const sn = snapCoord(v, ax.horiz ? m.phaseX : m.phaseY, m.grid);
				return Math.abs(sn - v) <= tolEnd ? sn : v;
			};
			ea = gridEnd(w.a);
			eb = gridEnd(w.b);
			if (Math.abs(ea - eb) < 100) {
				ea = endPos(w.a);
				eb = endPos(w.b);
			}
		}
		const na = ax.horiz ? {
			x: ea,
			y: ax.newAxis
		} : {
			x: ax.newAxis,
			y: ea
		};
		const nb = ax.horiz ? {
			x: eb,
			y: ax.newAxis
		} : {
			x: ax.newAxis,
			y: eb
		};
		const da = (na.x - w.a.x) * u.x + (na.y - w.a.y) * u.y;
		shiftA.set(w.id, da);
		w.a = na;
		w.b = nb;
	}
	for (const op of f.openings) {
		const da = shiftA.get(op.wallId);
		if (da == null) continue;
		const w = f.walls.find((q) => q.id === op.wallId);
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		const wd = op.t1 - op.t0;
		op.t0 = Math.max(0, Math.min(L - wd, op.t0 - da));
		op.t1 = Math.min(L, op.t0 + wd);
	}
	rejoinFloorWalls(f);
	const movePoly = (poly) => {
		const n = poly.length;
		const out = [];
		for (let i = 0; i < n; i++) {
			const p = poly[i];
			const prev = poly[(i + n - 1) % n];
			const next = poly[(i + 1) % n];
			const vertEdge = (q) => Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) >= 1;
			const horizEdge = (q) => Math.abs(q.y - p.y) < 1 && Math.abs(q.x - p.x) >= 1;
			let x = p.x;
			let y = p.y;
			const gridOr = (v, phase) => {
				const sn = snapCoord(v, phase, m.grid);
				return Math.abs(sn - v) <= tol ? sn : v;
			};
			if (vertEdge(prev) || vertEdge(next)) x = follow(p.x, false, 160) ?? gridOr(p.x, m.phaseX);
			if (horizEdge(prev) || horizEdge(next)) y = follow(p.y, true, 160) ?? gridOr(p.y, m.phaseY);
			out.push({
				x,
				y
			});
		}
		return cleanPolygon(out, poly);
	};
	for (const r of f.rooms) {
		r.polygon = movePoly(r.polygon);
		r.area = Math.round(Math.abs(polygonArea(r.polygon)) / 1e6 * 100) / 100;
	}
	f.outline = f.outline.map(movePoly);
}
/** 同じ点になった頂点・一直線上の中間点を除く（3 点未満になったら元のまま） */
function cleanPolygon(out, fallback) {
	const dedup = [];
	for (const p of out) {
		const last = dedup[dedup.length - 1];
		if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) continue;
		dedup.push(p);
	}
	while (dedup.length > 1 && Math.abs(dedup[0].x - dedup[dedup.length - 1].x) < 1 && Math.abs(dedup[0].y - dedup[dedup.length - 1].y) < 1) dedup.pop();
	const clean = [];
	for (let i = 0; i < dedup.length; i++) {
		const a = dedup[(i + dedup.length - 1) % dedup.length];
		const p = dedup[i];
		const b = dedup[(i + 1) % dedup.length];
		const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
		if (Math.abs(cross) < 1 && (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y) > 0) continue;
		clean.push(p);
	}
	return clean.length >= 3 ? clean : fallback;
}
/** 階の壁を軸線の形に直して角の接合をやり直し、壁の端点・開口の位置・接合フラグを書き戻す */
function rejoinFloorWalls(f) {
	const groups = [];
	const groupOf = (u) => {
		let gi = groups.findIndex((g) => Math.abs(g.u.x * u.y - g.u.y * u.x) < .02 && g.u.x * u.x + g.u.y * u.y > 0);
		if (gi < 0) {
			groups.push({ u });
			gi = groups.length - 1;
		}
		return gi;
	};
	const ww = [];
	for (const w of f.walls) {
		let a = w.a;
		let b = w.b;
		const L = Math.hypot(b.x - a.x, b.y - a.y);
		if (L < 30) continue;
		let u = {
			x: (b.x - a.x) / L,
			y: (b.y - a.y) / L
		};
		const swapped = u.x < -1e-6 || Math.abs(u.x) <= 1e-6 && u.y < 0;
		if (swapped) {
			[a, b] = [b, a];
			u = {
				x: -u.x,
				y: -u.y
			};
		}
		const n = {
			x: -u.y,
			y: u.x
		};
		const t0 = a.x * u.x + a.y * u.y;
		const o = a.x * n.x + a.y * n.y;
		ww.push({
			w,
			swapped,
			ax: {
				a,
				b,
				u,
				n,
				d: w.thickness,
				t0,
				t1: t0 + L,
				o,
				g: groupOf(u),
				openings: [],
				joinedA: false,
				joinedB: false
			}
		});
	}
	joinWalls(ww.map((q) => q.ax));
	for (const { w, ax, swapped } of ww) {
		const oldA = swapped ? w.b : w.a;
		Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		const na = swapped ? ax.b : ax.a;
		const nb = swapped ? ax.a : ax.b;
		const newL = Math.hypot(nb.x - na.x, nb.y - na.y);
		const ext0 = swapped ? Math.hypot(ax.b.x - oldA.x, ax.b.y - oldA.y) : Math.hypot(ax.a.x - oldA.x, ax.a.y - oldA.y);
		for (const op of f.openings) {
			if (op.wallId !== w.id) continue;
			const wd = op.t1 - op.t0;
			op.t0 = Math.max(0, Math.min(newL - wd, op.t0 + ext0));
			op.t1 = Math.min(newL, op.t0 + wd);
		}
		w.a = {
			x: Math.round(na.x * 10) / 10,
			y: Math.round(na.y * 10) / 10
		};
		w.b = {
			x: Math.round(nb.x * 10) / 10,
			y: Math.round(nb.y * 10) / 10
		};
		w.joinedA = w.joinedA || (swapped ? ax.joinedB : ax.joinedA);
		w.joinedB = w.joinedB || (swapped ? ax.joinedA : ax.joinedB);
	}
}
function assembleModel(pages, name, warnings, opts = {}) {
	let plans = detectPlans(pages, warnings);
	if (plans.length && plans.every((p) => p.scan && p.floorHint == null)) {
		const first = Math.min(...plans.map((p) => p.pageIndex));
		if (plans.some((p) => p.pageIndex !== first)) {
			plans = plans.filter((p) => p.pageIndex === first);
			warnings.push(`スキャン図面が複数ページあり階を判別できないため、${first + 1}ページ目の図面だけを解析しました（他のページは別案の可能性があります）`);
		}
	}
	const hinted = plans.filter((p) => p.floorHint != null);
	const ordered = plans.slice().sort((a, b) => {
		const fa = a.floorHint ?? 99;
		const fb = b.floorHint ?? 99;
		if (fa !== fb) return fa - fb;
		if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
		return a.bbox.minX - b.bbox.minX;
	});
	const used = /* @__PURE__ */ new Set();
	const levelOf = /* @__PURE__ */ new Map();
	let nextLevel = 1;
	for (const p of ordered) {
		let lv = p.floorHint ?? 0;
		if (!lv || used.has(lv)) {
			while (used.has(nextLevel)) nextLevel++;
			lv = nextLevel;
		}
		used.add(lv);
		levelOf.set(p, lv);
	}
	if (plans.length > 1 && hinted.length < plans.length) warnings.push("階の見出しが見つからない図面があり、配置順で階を割り当てました");
	const northDeg = detectNorth(pages);
	if (northDeg == null) warnings.push("方位記号が見つかりませんでした（図面の上を北として扱います）");
	const north = northDeg ?? 0;
	const sorted = ordered.slice().sort((a, b) => levelOf.get(a) - levelOf.get(b));
	const base = sorted[0];
	if (base) {
		for (const p of sorted.slice(1)) translatePlan(p, alignOffset(base, p));
		const o = {
			x: -base.bbox.minX,
			y: -base.bbox.minY
		};
		for (const p of sorted) translatePlan(p, o);
	}
	const moduleMode = opts.module ?? "auto";
	const mfit = chooseModule(sorted.flatMap((p) => p.walls.map((w) => ({
		a: w.a,
		b: w.b
	}))), moduleMode);
	const moduleInfo = mfit ? moduleInfoOf(mfit, moduleMode === "auto" ? "auto" : "manual", true) : void 0;
	if (mfit) {
		if (mfit.onGrid < .7) warnings.push(`壁芯の ${Math.round(mfit.onGrid * 100)}% しか ${mfit.size === 910 ? "尺（910）" : "メーター（1000）"}モジュールの格子に乗っていません（乗っていない壁はそのまま）`);
	} else if (moduleMode === "auto") warnings.push("壁芯が 910／1000 のモジュール格子にそろっていないため、図面の寸法のまま読み取りました（読み込みのやり直しでモジュールを指定できます）");
	const areaTable = readAreaTable(pages);
	const floors = [];
	const thicknesses = /* @__PURE__ */ new Set();
	let elev = 500;
	const planOf = /* @__PURE__ */ new Map();
	for (const p of sorted) {
		const f = buildFloor(p, levelOf.get(p), north, warnings, areaTable[levelOf.get(p)]);
		planOf.set(f, p);
		const roomArea = f.rooms.reduce((s0, r) => s0 + r.area, 0);
		if (f.rooms.length === 0 || roomArea < 4) continue;
		if (f.rooms.length <= 2 && roomArea > 100) continue;
		f.elevation = elev;
		elev += f.height;
		f.walls.forEach((w) => thicknesses.add(w.thickness));
		floors.push(f);
	}
	if (floors.length >= 2) {
		const f1 = floors[0];
		const f2 = floors[1];
		const pts = [];
		for (const r of f1.rooms) {
			if (r.name !== "室" || r.area < 6 || r.area > 40) continue;
			const c = polygonCentroid(r.polygon);
			if (f2.outline.some((l) => pointInPolygon(c, l))) continue;
			let perim = 0;
			let glass = 0;
			for (let i = 0; i < r.polygon.length; i++) {
				const a = r.polygon[i];
				const b = r.polygon[(i + 1) % r.polygon.length];
				const L = Math.hypot(b.x - a.x, b.y - a.y);
				perim += L;
				for (const o of f1.openings) {
					if (o.kind === "door" || o.kind === "entrance") continue;
					const w = f1.walls.find((q) => q.id === o.wallId);
					if (!w) continue;
					const oa = {
						x: w.a.x + (w.b.x - w.a.x) * o.t0 / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y),
						y: w.a.y + (w.b.y - w.a.y) * o.t0 / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
					};
					const ob = {
						x: w.a.x + (w.b.x - w.a.x) * o.t1 / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y),
						y: w.a.y + (w.b.y - w.a.y) * o.t1 / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
					};
					const dist = (p) => {
						const dx = b.x - a.x;
						const dy = b.y - a.y;
						const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (L * L || 1)));
						return Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u);
					};
					if (dist(oa) < 150 && dist(ob) < 150) glass += o.t1 - o.t0;
				}
			}
			if (perim > 0 && glass / perim >= .4) pts.push(c);
		}
		if (pts.length) {
			const nf = buildFloor(planOf.get(f1), f1.level, north, warnings, areaTable[f1.level], { courtyards: pts });
			nf.elevation = f1.elevation;
			floors[0] = nf;
		}
	}
	for (const f of floors) {
		const implausible = (s) => {
			const w = s.maxX - s.minX;
			const h = s.maxY - s.minY;
			return Math.min(w, h) > 2800 || Math.max(w, h) > 5200;
		};
		f.stairs = f.stairs.flatMap((s) => {
			if (!implausible(s)) return [s];
			const idx = floors.indexOf(f);
			const near = [floors[idx - 1], floors[idx + 1]].filter(Boolean).flatMap((g) => g.stairs).filter((t) => !implausible(t) && t.minX >= s.minX - 300 && t.maxX <= s.maxX + 300 && t.minY >= s.minY - 300 && t.maxY <= s.maxY + 300);
			if (!near.length) return [];
			return [{
				...near[0],
				id: s.id,
				goesUp: s.goesUp
			}];
		});
	}
	if (mfit && moduleInfo) {
		thicknesses.clear();
		for (const f of floors) {
			for (const w of f.walls) {
				w.thickness = woodWallThickness(w);
				thicknesses.add(w.thickness);
			}
			snapFloorWalls(f, mfit);
			snapStairs(f, moduleInfo);
		}
	}
	const site = base ? detectSite(base.siteTexts, base.siteSegs, base.bbox, north) : null;
	const o1 = floors[0]?.outline.flat() ?? [];
	if (o1.length) {
		const dx = -Math.min(...o1.map((p) => p.x));
		const dy = -Math.min(...o1.map((p) => p.y));
		for (const f of floors) translateFloor(f, dx, dy);
		if (site) translateSite(site, dx, dy);
		if (moduleInfo) translateModule(moduleInfo, dx, dy);
	}
	return {
		name,
		floors,
		northAngleDeg: north,
		site: site ?? void 0,
		module: moduleInfo,
		thicknesses: [...thicknesses].sort((a, b) => a - b),
		northDetected: northDeg != null
	};
}
function translateFloor(f, dx, dy) {
	const tr = (p) => ({
		x: Math.round((p.x + dx) * 10) / 10,
		y: Math.round((p.y + dy) * 10) / 10
	});
	for (const w of f.walls) {
		w.a = tr(w.a);
		w.b = tr(w.b);
	}
	for (const r of f.rooms) {
		r.polygon = r.polygon.map(tr);
		r.labelPos = tr(r.labelPos);
	}
	for (const s of f.stairs) {
		s.minX += dx;
		s.maxX += dx;
		s.minY += dy;
		s.maxY += dy;
	}
	f.outline = f.outline.map((l) => l.map(tr));
	if (f.planItems) for (const it of f.planItems) {
		it.x = Math.round(it.x + dx);
		it.y = Math.round(it.y + dy);
	}
	if (f.notes) for (const n of f.notes) {
		n.x = Math.round(n.x + dx);
		n.y = Math.round(n.y + dy);
	}
	if (f.exterior) {
		f.exterior.cars = f.exterior.cars.map((c) => ({
			...c,
			x: Math.round(c.x + dx),
			y: Math.round(c.y + dy)
		}));
		f.exterior.trees = f.exterior.trees.map((t) => ({
			...t,
			x: Math.round(t.x + dx),
			y: Math.round(t.y + dy)
		}));
	}
}
//#endregion
//#region src/parser/dxf.ts
var num$1 = (e, code, def = 0, nth = 0) => {
	let k = 0;
	for (const [c, v] of e.g) if (c === code) {
		if (k++ === nth) {
			const x = parseFloat(v);
			return Number.isFinite(x) ? x : def;
		}
	}
	return def;
};
var str = (e, code) => e.g.find(([c]) => c === code)?.[1] ?? "";
function groups(text) {
	const lines = text.split(/\r?\n/);
	const out = [];
	for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i].trim(), 10), lines[i + 1].replace(/\s+$/, "")]);
	return out;
}
function parseSections(text) {
	const g = groups(text);
	const blocks = /* @__PURE__ */ new Map();
	const entities = [];
	let section = "";
	let cur = null;
	let block = null;
	for (let i = 0; i < g.length; i++) {
		const [c, v] = g[i];
		if (c === 0 && v === "SECTION") {
			section = g[i + 1]?.[1] ?? "";
			i++;
			cur = null;
			continue;
		}
		if (c === 0 && v === "ENDSEC") {
			section = "";
			cur = null;
			continue;
		}
		if (section === "BLOCKS") {
			if (c === 0 && v === "BLOCK") {
				block = {
					name: "",
					base: {
						x: 0,
						y: 0
					},
					ents: [],
					header: true
				};
				cur = null;
				continue;
			}
			if (c === 0 && v === "ENDBLK") {
				if (block) blocks.set(block.name, {
					base: block.base,
					ents: block.ents
				});
				block = null;
				cur = null;
				continue;
			}
			if (!block) continue;
			if (block.header) {
				if (c === 2 && !block.name) block.name = v;
				if (c === 10) block.base.x = parseFloat(v);
				if (c === 20) block.base.y = parseFloat(v);
				if (c === 0) block.header = false;
				else continue;
			}
			if (c === 0) {
				cur = {
					type: v,
					g: []
				};
				block.ents.push(cur);
			} else cur?.g.push([c, v]);
		} else if (section === "ENTITIES") {
			if (c === 0) {
				cur = {
					type: v,
					g: []
				};
				entities.push(cur);
			} else cur?.g.push([c, v]);
		}
	}
	return {
		blocks,
		entities
	};
}
var apply = (t, p) => {
	const x = p.x * t.sx;
	const y = p.y * t.sy;
	const c = Math.cos(t.rot);
	const s = Math.sin(t.rot);
	return {
		x: t.ox + x * c - y * s,
		y: t.oy + x * s + y * c
	};
};
/** ブロックの中身を展開（入れ子の INSERT も） */
function flatten(ents, xf, blocks, out, depth = 0) {
	for (const e of ents) {
		const color = num$1(e, 62, 7);
		const lt = str(e, 6).toLowerCase();
		const dashed = /dot|dash|hidden|center|chain/.test(lt);
		switch (e.type) {
			case "LINE":
				out.push({
					kind: "line",
					color,
					a: apply(xf, {
						x: num$1(e, 10),
						y: num$1(e, 20)
					}),
					b: apply(xf, {
						x: num$1(e, 11),
						y: num$1(e, 21)
					}),
					dashed
				});
				break;
			case "ARC":
			case "CIRCLE": {
				const c = apply(xf, {
					x: num$1(e, 10),
					y: num$1(e, 20)
				});
				const r = num$1(e, 40) * Math.abs(xf.sx);
				const a0 = e.type === "CIRCLE" ? 0 : num$1(e, 50) * Math.PI / 180 + xf.rot;
				const a1 = e.type === "CIRCLE" ? Math.PI * 2 : num$1(e, 51) * Math.PI / 180 + xf.rot;
				out.push({
					kind: "arc",
					color,
					c,
					r,
					a0,
					a1,
					dashed
				});
				break;
			}
			case "LWPOLYLINE": {
				const pts = [];
				for (let i = 0; i < e.g.length; i++) if (e.g[i][0] === 10) pts.push({
					x: parseFloat(e.g[i][1]),
					y: parseFloat(e.g[i + 1]?.[0] === 20 ? e.g[i + 1][1] : "0")
				});
				const closed = (num$1(e, 70) & 1) === 1;
				for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) out.push({
					kind: "line",
					color,
					a: apply(xf, pts[i]),
					b: apply(xf, pts[(i + 1) % pts.length]),
					dashed
				});
				break;
			}
			case "TEXT":
			case "MTEXT": {
				let t = str(e, 1);
				if (e.type === "MTEXT") t = t.replace(/\\P/g, " ").replace(/\\[A-Za-z][^;]*;/g, "").replace(/[{}]/g, "");
				if (!t.trim()) break;
				const h = num$1(e, 40) * Math.abs(xf.sy);
				const ang = num$1(e, 50) * Math.PI / 180 + xf.rot;
				const hasAlign = (num$1(e, 72) || num$1(e, 73)) && e.g.some(([c]) => c === 11);
				const p = apply(xf, hasAlign ? {
					x: num$1(e, 11),
					y: num$1(e, 21)
				} : {
					x: num$1(e, 10),
					y: num$1(e, 20)
				});
				out.push({
					kind: "text",
					color,
					a: p,
					text: t,
					h,
					ang,
					b: hasAlign ? {
						x: num$1(e, 72),
						y: num$1(e, 73)
					} : void 0
				});
				break;
			}
			case "INSERT": {
				if (depth > 6) break;
				const blk = blocks.get(str(e, 2));
				if (!blk) break;
				const ip = apply(xf, {
					x: num$1(e, 10),
					y: num$1(e, 20)
				});
				const sx = num$1(e, 41, 1) * xf.sx;
				const sy = num$1(e, 42, 1) * xf.sy;
				const rot = num$1(e, 50) * Math.PI / 180 + xf.rot;
				const inner = {
					ox: ip.x - (blk.base.x * sx * Math.cos(rot) - blk.base.y * sy * Math.sin(rot)),
					oy: ip.y - (blk.base.x * sx * Math.sin(rot) + blk.base.y * sy * Math.cos(rot)),
					sx,
					sy,
					rot
				};
				flatten(blk.ents, inner, blocks, out, depth + 1);
				break;
			}
		}
	}
}
/** 平行な2本線が壁厚（75〜260mm）の間隔で並ぶ長さを色ごとに数え、壁の色を決める */
function wallColor(prims) {
	const byColor = /* @__PURE__ */ new Map();
	for (const p of prims) if (p.kind === "line") (byColor.get(p.color) ?? byColor.set(p.color, []).get(p.color)).push(p);
	let best = null;
	for (const [color, ls] of byColor) {
		const axis = ls.filter((l) => {
			const dx = l.b.x - l.a.x;
			const dy = l.b.y - l.a.y;
			const L = Math.hypot(dx, dy);
			return L > 300 && (Math.abs(dx) < .001 * L || Math.abs(dy) < .001 * L);
		});
		let score = 0;
		const horiz = axis.filter((l) => Math.abs(l.b.y - l.a.y) < 1);
		const vert = axis.filter((l) => Math.abs(l.b.x - l.a.x) < 1);
		const bins = /* @__PURE__ */ new Map();
		const pairLen = (arr, key, along) => {
			for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
				const d = Math.abs(arr[i].a[key] - arr[j].a[key]);
				if (d < 75 || d > 260) continue;
				const lo = Math.max(Math.min(arr[i].a[along], arr[i].b[along]), Math.min(arr[j].a[along], arr[j].b[along]));
				const hi = Math.min(Math.max(arr[i].a[along], arr[i].b[along]), Math.max(arr[j].a[along], arr[j].b[along]));
				if (hi - lo > 200) {
					const k = Math.round(d / 10);
					bins.set(k, (bins.get(k) ?? 0) + hi - lo);
				}
			}
		};
		if (horiz.length < 2e3 && vert.length < 2e3) {
			pairLen(horiz, "y", "x");
			pairLen(vert, "x", "y");
			for (const [k, v] of bins) score = Math.max(score, v + (bins.get(k - 1) ?? 0) * .5 + (bins.get(k + 1) ?? 0) * .5);
		}
		if (!best || score > best.score) best = {
			color,
			score
		};
	}
	return best && best.score > 5e3 ? best.color : null;
}
function arcToBeziers(c, r, a0, a1) {
	let span = a1 - a0;
	while (span <= 0) span += Math.PI * 2;
	const n = Math.max(1, Math.ceil(span / (Math.PI / 2)));
	const out = [];
	const d = span / n;
	const k = 4 / 3 * Math.tan(d / 4);
	for (let i = 0; i < n; i++) {
		const t0 = a0 + d * i;
		const t1 = t0 + d;
		const p0 = {
			x: c.x + r * Math.cos(t0),
			y: c.y + r * Math.sin(t0)
		};
		const p3 = {
			x: c.x + r * Math.cos(t1),
			y: c.y + r * Math.sin(t1)
		};
		const p1 = {
			x: p0.x - k * r * Math.sin(t0),
			y: p0.y + k * r * Math.cos(t0)
		};
		const p2 = {
			x: p3.x + k * r * Math.sin(t1),
			y: p3.y - k * r * Math.cos(t1)
		};
		out.push([
			p0,
			p1,
			p2,
			p3
		]);
	}
	return out;
}
/** 部材の多い図（平面図）ごとに1ページ。座標は mm、y は下向きに直す */
function dxfToPages(text) {
	const parsed = parseSections(text);
	const id = {
		ox: 0,
		oy: 0,
		sx: 1,
		sy: 1,
		rot: 0
	};
	const groupsOut = [];
	const loose = [];
	for (const e of parsed.entities) {
		if (e.type === "INSERT") {
			const prims = [];
			flatten([e], id, parsed.blocks, prims);
			if (prims.filter((p) => p.kind === "line").length >= 100) {
				groupsOut.push(prims);
				continue;
			}
		}
		loose.push(e);
	}
	const loosePrims = [];
	flatten(loose, id, parsed.blocks, loosePrims);
	if (!groupsOut.length) groupsOut.push(loosePrims);
	else for (const p of loosePrims) {
		if (p.kind !== "text") continue;
		let best = groupsOut[0];
		let bd = Infinity;
		for (const g of groupsOut) {
			const xs = g.filter((q) => q.a).map((q) => q.a.x);
			const ys = g.filter((q) => q.a).map((q) => q.a.y);
			const dx = Math.max(0, Math.min(...xs) - p.a.x, p.a.x - Math.max(...xs));
			const dy = Math.max(0, Math.min(...ys) - p.a.y, p.a.y - Math.max(...ys));
			const d = Math.hypot(dx, dy);
			if (d < bd) {
				bd = d;
				best = g;
			}
		}
		if (bd < 3e3) best.push(p);
	}
	const wc = wallColor(groupsOut.flat());
	return groupsOut.map((prims, pageIndex) => {
		const pts = prims.flatMap((p) => p.kind === "line" ? [p.a, p.b] : p.kind === "arc" ? [{
			x: p.c.x - p.r,
			y: p.c.y - p.r
		}, {
			x: p.c.x + p.r,
			y: p.c.y + p.r
		}] : [p.a]);
		const minX = Math.min(...pts.map((p) => p.x)) - 1e3;
		const maxX = Math.max(...pts.map((p) => p.x)) + 1e3;
		const minY = Math.min(...pts.map((p) => p.y)) - 1e3;
		const maxY = Math.max(...pts.map((p) => p.y)) + 1e3;
		const T = (p) => ({
			x: p.x - minX,
			y: maxY - p.y
		});
		const segments = [];
		const curves = [];
		const texts = [];
		for (const p of prims) {
			const width = wc != null && p.color === wc ? .5 : .13;
			if (p.kind === "line") segments.push({
				a: T(p.a),
				b: T(p.b),
				width,
				dashed: !!p.dashed,
				source: "stroke",
				color: "#000000"
			});
			else if (p.kind === "arc") for (const [p0, p1, p2, p3] of arcToBeziers(p.c, p.r, p.a0, p.a1)) curves.push({
				p0: T(p0),
				p1: T(p1),
				p2: T(p2),
				p3: T(p3),
				width,
				dashed: !!p.dashed
			});
			else {
				const h = p.h || 200;
				const t = p.text.trim();
				const wEst = [...t].reduce((s, ch) => s + (/[\x20-\x7e｡-ﾟ]/.test(ch) ? .6 : 1), 0) * h;
				const hj = p.b ? p.b.x : 0;
				const vj = p.b ? p.b.y : 0;
				const fx = hj === 1 || hj === 4 ? 0 : hj === 2 ? -.5 : .5;
				const fy = vj === 2 ? 0 : vj === 3 ? -.5 : .5;
				const ca = Math.cos(p.ang ?? 0);
				const sa = Math.sin(p.ang ?? 0);
				const c = T({
					x: p.a.x + ca * wEst * fx - sa * h * fy,
					y: p.a.y + sa * wEst * fx + ca * h * fy
				});
				texts.push({
					str: t,
					cx: c.x,
					cy: c.y,
					size: h,
					width: wEst,
					angle: -(p.ang ?? 0)
				});
			}
		}
		return {
			pageIndex,
			width: maxX - minX,
			height: maxY - minY,
			segments,
			curves,
			fills: [],
			texts: mergeTextFragments(texts)
		};
	});
}
//#endregion
//#region src/parser/index.ts
async function loadPdfVectors(data, pdfjs, opts = {}) {
	const doc = await pdfjs.getDocument({
		data,
		cMapUrl: opts.cMapUrl,
		cMapPacked: true,
		standardFontDataUrl: opts.standardFontDataUrl,
		wasmUrl: opts.wasmUrl,
		...opts.BinaryDataFactory ? {
			BinaryDataFactory: opts.BinaryDataFactory,
			useWorkerFetch: false
		} : {},
		isEvalSupported: false,
		useSystemFonts: false
	}).promise;
	const pages = [];
	const n = Math.min(doc.numPages, 12);
	for (let i = 1; i <= n; i++) {
		opts.onProgress?.(`${i}/${n} ページを読み込み中`, (i - 1) / n * .5);
		const page = await doc.getPage(i);
		const pv = await extractPageVectors(page, pdfjs.OPS, i - 1);
		const bigImages = (pv.images ?? []).filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) > pv.width * pv.height * .04);
		const imagePlan = opts.rasterImages && bigImages.length > 0;
		if (pv.segments.length < 50 && (pv.imageCount ?? 0) > 0 || imagePlan) try {
			opts.onProgress?.(`${i}/${n} ページ: スキャン画像を解析中`, (i - .5) / n * .5);
			pv.raster = await renderThickMask(page, doc.canvasFactory, pv.width, pv.height, imagePlan ? bigImages : void 0);
		} catch {}
		pages.push(pv);
	}
	return pages;
}
/** ページを約150dpi（最大 600万画素）で描画し、太い線だけの2値画像にする */
async function renderThickMask(page, factory, wPt, hPt, only) {
	const scale = Math.min(150 / 72, Math.sqrt(6e6 / (wPt * hPt)));
	const vp = page.getViewport({ scale });
	const w = Math.ceil(vp.width);
	const h = Math.ceil(vp.height);
	let canvas;
	let ctx;
	if (factory?.create) {
		const cc = factory.create(w, h);
		canvas = cc.canvas;
		ctx = cc.context;
	} else if (typeof OffscreenCanvas !== "undefined") {
		canvas = new OffscreenCanvas(w, h);
		ctx = canvas.getContext("2d");
	} else {
		canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		ctx = canvas.getContext("2d");
	}
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, w, h);
	await page.render({
		canvasContext: ctx,
		viewport: vp,
		canvas
	}).promise;
	const rgba = ctx.getImageData(0, 0, w, h).data;
	const gray = new Uint8Array(w * h);
	for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4] * .3 + rgba[i * 4 + 1] * .59 + rgba[i * 4 + 2] * .11 | 0;
	const k = Math.max(1, Math.round(2 * (scale / (150 / 72))));
	if (only?.length) {
		const keep = new Uint8Array(w * h);
		for (const r of only) {
			const x0 = Math.max(0, Math.floor(r.x0 * scale));
			const x1 = Math.min(w, Math.ceil(r.x1 * scale));
			const y0 = Math.max(0, Math.floor(r.y0 * scale));
			const y1 = Math.min(h, Math.ceil(r.y1 * scale));
			for (let y = y0; y < y1; y++) keep.fill(1, y * w + x0, y * w + x1);
		}
		for (let i = 0; i < gray.length; i++) if (!keep[i]) gray[i] = 255;
	}
	return {
		mask: thickStrokeMask(gray, w, h, k, void 0, k),
		w,
		h,
		scale
	};
}
function modelFromVectors(pages, opts = {}) {
	const t0 = performance.now();
	const warnings = [];
	let sc = detectScale(pages);
	let scaleSource = sc.source;
	if (opts.scaleDenominator) {
		sc = {
			mmPerPt: opts.scaleDenominator * PT_TO_MM,
			denominator: opts.scaleDenominator,
			source: "text",
			matches: 0
		};
		scaleSource = "manual";
	}
	if (opts.mmPerPt) {
		sc = {
			mmPerPt: opts.mmPerPt,
			denominator: null,
			source: "text",
			matches: 0
		};
		scaleSource = "manual";
	}
	const segCount = pages.reduce((s, p) => s + p.segments.length, 0);
	const scanned = pages.some((p) => p.raster);
	if (segCount < 50 && !scanned) warnings.push("ベクター線がほとんどありません。スキャン画像のPDFの可能性があります（CAD から出力した PDF を推奨）");
	const straighten = (mm) => mm.map((p) => {
		if (p.rasterMask || !opts.straighten) return p;
		const tilt = dominantTilt(p);
		if (Math.abs(tilt) < 1.5) return p;
		warnings.push(`図面が ${Math.abs(tilt).toFixed(1)}° 傾いていたため、水平に戻して読み取りました`);
		return rotatePageMm(p, -tilt);
	});
	let mmPages = straighten(pages.map((p) => pageToMm(p, sc.mmPerPt)));
	let res = assembleModel(mmPages, opts.name ?? "新築計画", warnings, { module: opts.module });
	if (scanned && res.floors.length) {
		warnings.push("スキャン画像の図面のため、画像から壁を読み取りました。室名は読み取れないため、下の一覧で部屋名と用途を指定してください");
		if (sc.source === "default" && !opts.scaleDenominator) {
			const m = moduleScaleFromWalls(res.floors.flatMap((f) => f.walls));
			if (m.confidence > .25 && Math.abs(m.factor - 1) > .04) {
				const den = Math.round(sc.mmPerPt * m.factor / PT_TO_MM);
				sc = {
					...sc,
					mmPerPt: sc.mmPerPt * m.factor,
					denominator: STANDARD.includes(den) ? den : null
				};
				scaleSource = "module";
				warnings.push(`壁の間隔（910mm モジュール）から縮尺を推定しました（約1/${Math.round(sc.mmPerPt / PT_TO_MM)}）`);
				mmPages = straighten(pages.map((p) => pageToMm(p, sc.mmPerPt)));
				res = assembleModel(mmPages, opts.name ?? "新築計画", warnings, { module: opts.module });
			}
		}
	}
	const ratios = [];
	for (const f of res.floors) for (const r of f.rooms) if (r.labeledTatami && r.area > .5) ratios.push(r.labeledTatami * 1.62 / r.area);
	if (ratios.length >= 2) {
		ratios.sort((a, b) => a - b);
		const med = ratios[Math.floor(ratios.length / 2)];
		const within = ratios.filter((x) => Math.abs(x / med - 1) < .12).length;
		const trustLabels = sc.source === "default" || sc.source === "text" || sc.source === "dimension" && sc.matches < 5;
		if (Math.abs(med - 1) > .2 && within >= ratios.length * .6 && trustLabels && !opts.scaleDenominator) {
			const k = Math.sqrt(med);
			const before = sc.source;
			let den = sc.mmPerPt * k / PT_TO_MM;
			const cands = [...STANDARD];
			if (sc.denominator) for (const f of [
				Math.SQRT2,
				Math.SQRT1_2,
				2,
				.5
			]) cands.push(sc.denominator * f);
			const snap = cands.find((c) => Math.abs(c / den - 1) < .025);
			den = snap ?? null;
			sc = {
				...sc,
				mmPerPt: snap ? snap * PT_TO_MM : sc.mmPerPt * k,
				denominator: snap && Number.isInteger(snap) ? snap : null
			};
			scaleSource = "area";
			const shown = Math.round(sc.mmPerPt / PT_TO_MM);
			warnings.push(before === "default" ? `縮尺表記が見つからないため、帖数表記から縮尺を推定しました (約1/${shown})` : `図面の縮尺表記と帖数が合わないため、帖数から縮尺を補正しました（縮小印刷の可能性・約1/${shown}）`);
			mmPages = pages.map((p) => pageToMm(p, sc.mmPerPt));
			res = assembleModel(mmPages, opts.name ?? "新築計画", warnings, { module: opts.module });
		} else if (Math.abs(med - 1) > .15) warnings.push("図面の帖数と解析した面積に差があります。縮尺をご確認ください");
	}
	if (scanned) for (const f of res.floors) for (const w of f.walls) w.thickness = Math.min(200, Math.max(90, w.thickness));
	const allRooms = res.floors.flatMap((f) => f.rooms);
	if (!scanned && allRooms.length >= 4 && !allRooms.some((r) => ![
		"室",
		"収納",
		"階段"
	].includes(r.name))) warnings.push("室名の文字を読み取れませんでした（PDF にフォントが埋め込まれていない・文字が図形化されている可能性）。部屋名と用途を下の一覧で指定してください");
	if (sc.source === "default" && scaleSource === "default" && !scanned) warnings.push("縮尺を特定できなかったため 1/100 として解析しました");
	const { thicknesses, ...model } = res;
	return {
		...model,
		report: {
			pages: pages.length,
			scaleDenominator: sc.denominator,
			mmPerPt: sc.mmPerPt,
			scaleSource,
			wallThicknesses: scanned ? [...new Set(res.floors.flatMap((f) => f.walls.map((w) => Math.round(w.thickness))))].sort((a, b) => a - b) : thicknesses,
			warnings: [...new Set(warnings)],
			timingsMs: { analyze: Math.round(performance.now() - t0) },
			northDetected: res.northDetected
		}
	};
}
async function parseFloorPlanPdf(data, pdfjs, opts = {}) {
	const t0 = performance.now();
	const spare = data.slice();
	let pages = await loadPdfVectors(data, pdfjs, opts);
	const t1 = performance.now();
	opts.onProgress?.("壁・開口部・部屋を解析中", .6);
	let model = modelFromVectors(pages, opts);
	if ((!model.floors.length || model.floors.every((f) => f.walls.length < 4)) && !opts.rasterImages && pages.some((p) => (p.images ?? []).some((r) => (r.x1 - r.x0) * (r.y1 - r.y0) > p.width * p.height * .04))) {
		opts.onProgress?.("平面図の画像から壁を読み取っています", .65);
		pages = await loadPdfVectors(spare, pdfjs, {
			...opts,
			rasterImages: true
		});
		const m2 = modelFromVectors(pages, opts);
		if (m2.floors.some((f) => f.walls.length >= 4)) {
			model = m2;
			model.report.warnings.unshift("平面図が画像で貼られた資料のため、画像から壁を読み取りました");
		}
	}
	model.report.timingsMs.load = Math.round(t1 - t0);
	opts.onProgress?.("完了", 1);
	return model;
}
/** DXF（CAD データ, 実寸 mm）→ 建物モデル */
function parseDxf(text, opts = {}) {
	const model = modelFromVectors(dxfToPages(text), {
		...opts,
		mmPerPt: 1
	});
	model.report.scaleDenominator = null;
	model.report.warnings = model.report.warnings.filter((w) => !/縮尺/.test(w));
	return model;
}
//#endregion
//#region src/core/rects.ts
var rectW = (r) => r.maxX - r.minX;
var rectH = (r) => r.maxY - r.minY;
var rectArea = (r) => rectW(r) * rectH(r);
function isRectilinear(poly, tol = 1) {
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		if (Math.abs(a.x - b.x) > tol && Math.abs(a.y - b.y) > tol) return false;
	}
	return true;
}
function uniqSorted(vals, tol) {
	const s = vals.slice().sort((a, b) => a - b);
	const out = [];
	for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
	return out;
}
/** 座標圧縮したセルの内外判定 */
function cellGrid(polys, tol) {
	const xs = uniqSorted(polys.flat().map((p) => p.x), tol);
	const ys = uniqSorted(polys.flat().map((p) => p.y), tol);
	const nx = xs.length - 1;
	const ny = ys.length - 1;
	const inside = new Uint8Array(Math.max(0, nx * ny));
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const c = {
			x: (xs[i] + xs[i + 1]) / 2,
			y: (ys[j] + ys[j + 1]) / 2
		};
		let k = 0;
		for (const p of polys) if (pointInPolygon(c, p)) k++;
		inside[j * nx + i] = k % 2;
	}
	return {
		xs,
		ys,
		nx,
		ny,
		inside
	};
}
/** 互いに重ならない矩形へ分解（床・天井用） */
function polygonToRects(polys, tol = 5) {
	const { xs, ys, nx, ny, inside } = cellGrid(polys, tol);
	const used = new Uint8Array(inside.length);
	const out = [];
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const k = j * nx + i;
		if (!inside[k] || used[k]) continue;
		let i2 = i;
		while (i2 + 1 < nx && inside[j * nx + i2 + 1] && !used[j * nx + i2 + 1]) i2++;
		let j2 = j;
		outer: while (j2 + 1 < ny) {
			for (let ii = i; ii <= i2; ii++) if (!inside[(j2 + 1) * nx + ii] || used[(j2 + 1) * nx + ii]) break outer;
			j2++;
		}
		for (let jj = j; jj <= j2; jj++) for (let ii = i; ii <= i2; ii++) used[jj * nx + ii] = 1;
		out.push({
			minX: xs[i],
			maxX: xs[i2 + 1],
			minY: ys[j],
			maxY: ys[j2 + 1]
		});
	}
	return out;
}
/**
* 極大矩形による被覆（重なりあり）。屋根の分割に使う（L字は2つの矩形が重なる）
*/
function maximalRectCover(polys, tol = 5, minSize = 0) {
	const { xs, ys, inside } = cellGrid(polys, tol);
	return maximalRectCoverMask(xs, ys, inside, minSize);
}
/** 座標圧縮済みのマスクに対する極大矩形被覆 */
function maximalRectCoverMask(xs, ys, inside, minSize = 0) {
	const nx = xs.length - 1;
	const ny = ys.length - 1;
	const covered = new Uint8Array(inside.length);
	const out = [];
	const cellsIn = (i0, j0, i1, j1) => {
		for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!inside[j * nx + i]) return false;
		return true;
	};
	const cands = [];
	for (let j0 = 0; j0 < ny; j0++) for (let i0 = 0; i0 < nx; i0++) {
		if (!inside[j0 * nx + i0]) continue;
		for (let j1 = j0; j1 < ny; j1++) {
			if (!inside[j1 * nx + i0]) break;
			for (let i1 = i0; i1 < nx; i1++) {
				if (!cellsIn(i0, j0, i1, j1)) break;
				const canL = i0 > 0 && cellsIn(i0 - 1, j0, i0 - 1, j1);
				const canR = i1 + 1 < nx && cellsIn(i1 + 1, j0, i1 + 1, j1);
				const canU = j0 > 0 && cellsIn(i0, j0 - 1, i1, j0 - 1);
				const canD = j1 + 1 < ny && cellsIn(i0, j1 + 1, i1, j1 + 1);
				if (canL || canR || canU || canD) continue;
				const area = (xs[i1 + 1] - xs[i0]) * (ys[j1 + 1] - ys[j0]);
				cands.push({
					i0,
					j0,
					i1,
					j1,
					area
				});
			}
		}
	}
	cands.sort((a, b) => b.area - a.area);
	for (const c of cands) {
		let adds = false;
		for (let j = c.j0; j <= c.j1 && !adds; j++) for (let i = c.i0; i <= c.i1; i++) if (!covered[j * nx + i]) adds = true;
		if (!adds) continue;
		const r = {
			minX: xs[c.i0],
			maxX: xs[c.i1 + 1],
			minY: ys[c.j0],
			maxY: ys[c.j1 + 1]
		};
		if (Math.min(rectW(r), rectH(r)) < minSize && out.length) {}
		out.push(r);
		for (let j = c.j0; j <= c.j1; j++) for (let i = c.i0; i <= c.i1; i++) covered[j * nx + i] = 1;
	}
	return out;
}
/** 矩形 a から b を引いた残り（最大4つ） */
function rectMinus(a, b) {
	const ix0 = Math.max(a.minX, b.minX);
	const ix1 = Math.min(a.maxX, b.maxX);
	const iy0 = Math.max(a.minY, b.minY);
	const iy1 = Math.min(a.maxY, b.maxY);
	if (ix0 >= ix1 || iy0 >= iy1) return [a];
	const out = [];
	if (a.minY < iy0) out.push({
		minX: a.minX,
		maxX: a.maxX,
		minY: a.minY,
		maxY: iy0
	});
	if (iy1 < a.maxY) out.push({
		minX: a.minX,
		maxX: a.maxX,
		minY: iy1,
		maxY: a.maxY
	});
	if (a.minX < ix0) out.push({
		minX: a.minX,
		maxX: ix0,
		minY: iy0,
		maxY: iy1
	});
	if (ix1 < a.maxX) out.push({
		minX: ix1,
		maxX: a.maxX,
		minY: iy0,
		maxY: iy1
	});
	return out.filter((r) => rectW(r) > 1 && rectH(r) > 1);
}
function rectsMinus(rs, holes) {
	let cur = rs;
	for (const h of holes) cur = cur.flatMap((r) => rectMinus(r, h));
	return cur;
}
/** 多角形内の最大の軸平行矩形（家具配置用、座標圧縮で近似） */
function largestInnerRect(poly, tol = 5) {
	const rects = maximalRectCover([poly], tol);
	if (!rects.length) return null;
	return rects.sort((a, b) => rectArea(b) - rectArea(a))[0];
}
/** 多角形のオフセット（マイタ結合、外向き正） */
function offsetPolygon(poly, d) {
	const n = poly.length;
	const sign = polygonArea(poly) > 0 ? 1 : -1;
	const out = [];
	for (let i = 0; i < n; i++) {
		const p0 = poly[(i - 1 + n) % n];
		const p1 = poly[i];
		const p2 = poly[(i + 1) % n];
		const e1 = norm(p1.x - p0.x, p1.y - p0.y);
		const e2 = norm(p2.x - p1.x, p2.y - p1.y);
		const n1 = {
			x: e1.y * sign,
			y: -e1.x * sign
		};
		const n2 = {
			x: e2.y * sign,
			y: -e2.x * sign
		};
		const bis = norm(n1.x + n2.x, n1.y + n2.y);
		const cos = bis.x * n1.x + bis.y * n1.y;
		const k = d / Math.max(.3, cos);
		out.push({
			x: p1.x + bis.x * k,
			y: p1.y + bis.y * k
		});
	}
	return out;
}
function norm(x, y) {
	const l = Math.hypot(x, y) || 1;
	return {
		x: x / l,
		y: y / l
	};
}
//#endregion
//#region src/core/stairs.ts
/** 昇り口の辺から奥へ進む向き・右向き・原点（昇る人の左手側の角） */
function stairFrame(s) {
	const W = s.maxX - s.minX;
	const H = s.maxY - s.minY;
	switch (s.entry) {
		case "n": return {
			u: {
				x: 0,
				y: 1
			},
			r: {
				x: -1,
				y: 0
			},
			o: {
				x: s.maxX,
				y: s.minY
			},
			Ls: H,
			Lt: W
		};
		case "s": return {
			u: {
				x: 0,
				y: -1
			},
			r: {
				x: 1,
				y: 0
			},
			o: {
				x: s.minX,
				y: s.maxY
			},
			Ls: H,
			Lt: W
		};
		case "w": return {
			u: {
				x: 1,
				y: 0
			},
			r: {
				x: 0,
				y: 1
			},
			o: {
				x: s.minX,
				y: s.minY
			},
			Ls: W,
			Lt: H
		};
		default: return {
			u: {
				x: -1,
				y: 0
			},
			r: {
				x: 0,
				y: -1
			},
			o: {
				x: s.maxX,
				y: s.maxY
			},
			Ls: W,
			Lt: H
		};
	}
}
/** 段数の目安（階高から。1 段 200mm 前後、最低 10 段） */
/** 段数: 図面に書かれた段数があればそれを、無ければ階高 ÷ 200mm 前後で推定 */
function stairStepCount(riseMm, s) {
	if (s?.steps && s.steps >= 6 && s.steps <= 30) return s.steps;
	return Math.max(10, Math.round(riseMm / 200));
}
/**
* 図面の階段の矩形が短く、段割りすると踏面が浅く（勾配が急に）なる場合は、昇り口側へ矩形を延ばす。
* 実際の階段も下の数段はホール側へ出ることが多い。返す矩形は延ばした後のもの（平面図・3D で共通）。
*/
function stairRunExtended(s, n) {
	const { Ls, Lt } = stairFrame(s);
	let need = 0;
	if (s.kind === "straight") need = 240 * n - Ls;
	else if (s.kind === "u") {
		const land = Math.min(Ls * .4, Lt / 2);
		const n1 = Math.floor(n / 2);
		const n2 = n - n1 - 1;
		const run = Ls - land;
		const want = 240 * Math.max(n1, n2);
		need = want > run ? (want - run) / (Ls * .4 < Lt / 2 ? .6 : 1) : 0;
	} else {
		const fw = Math.min(1e3, Math.max(Ls, Lt) / 2, Math.min(Ls, Lt));
		const len1 = Math.max(0, Ls - fw);
		const len2 = Math.max(0, Lt - fw);
		need = 240 * (len2 <= 1 ? n - 1 : Math.max(1, Math.min(n - 2, Math.round((n - 1) * len1 / Math.max(1, len1 + len2))))) - len1;
	}
	if (need <= 10) return s;
	const ext = Math.min(need, 1500);
	const o = { ...s };
	switch (s.entry) {
		case "n":
			o.minY -= ext;
			break;
		case "s":
			o.maxY += ext;
			break;
		case "w":
			o.minX -= ext;
			break;
		default: o.maxX += ext;
	}
	return o;
}
function stairLayout(s0, n = 14) {
	const s = stairRunExtended(s0, n);
	const F = stairFrame(s);
	const P = (sv, tv) => ({
		x: F.o.x + F.u.x * sv + F.r.x * tv,
		y: F.o.y + F.u.y * sv + F.r.y * tv
	});
	const rect = (s0, s1, t0, t1) => {
		const a = P(s0, t0);
		const b = P(s1, t1);
		return {
			minX: Math.min(a.x, b.x),
			minY: Math.min(a.y, b.y),
			maxX: Math.max(a.x, b.x),
			maxY: Math.max(a.y, b.y)
		};
	};
	const pieces = [];
	const { Ls, Lt } = F;
	const neg = (v) => ({
		x: -v.x,
		y: -v.y
	});
	if (s.kind === "straight") {
		const st = Ls / n;
		for (let i = 1; i <= n; i++) pieces.push({
			kind: "tread",
			...rect(st * (i - 1), st * i, 0, Lt),
			i,
			dir: F.u
		});
		return {
			n,
			pieces
		};
	}
	if (s.kind === "u") {
		const turn = s.turn ?? "left";
		const first = turn === "left" ? [Lt / 2, Lt] : [0, Lt / 2];
		const second = turn === "left" ? [0, Lt / 2] : [Lt / 2, Lt];
		const run = Ls - Math.min(Ls * .4, Lt / 2);
		const n1 = Math.floor(n / 2);
		const n2 = n - n1 - 1;
		const st1 = run / n1;
		const st2 = run / Math.max(1, n2);
		for (let i = 1; i <= n1; i++) pieces.push({
			kind: "tread",
			...rect(st1 * (i - 1), st1 * i, first[0], first[1]),
			i,
			dir: F.u
		});
		pieces.push({
			kind: "landing",
			...rect(run, Ls, 0, Lt),
			i: n1 + 1,
			dir: F.u
		});
		for (let j = 1; j <= n2; j++) pieces.push({
			kind: "tread",
			...rect(run - st2 * (j - 1), run - st2 * j, second[0], second[1]),
			i: n1 + 1 + j,
			dir: neg(F.u)
		});
		return {
			n,
			pieces,
			wall: rect(0, run, Lt / 2 - 50, Lt / 2 + 50)
		};
	}
	const turn = s.turn ?? "right";
	const fw = Math.min(1e3, Math.max(Ls, Lt) / 2, Math.min(Ls, Lt));
	const strip = turn === "right" ? [0, fw] : [Lt - fw, Lt];
	const len1 = Math.max(0, Ls - fw);
	const len2 = Math.max(0, Lt - fw);
	const n1 = len2 <= 1 ? n - 1 : Math.max(1, Math.min(n - 2, Math.round((n - 1) * len1 / Math.max(1, len1 + len2))));
	const n2 = n - 1 - n1;
	const st1 = len1 / Math.max(1, n1);
	for (let i = 1; i <= n1; i++) pieces.push({
		kind: "tread",
		...rect(st1 * (i - 1), st1 * i, strip[0], strip[1]),
		i,
		dir: F.u
	});
	pieces.push({
		kind: "landing",
		...rect(len1, Ls, strip[0], strip[1]),
		i: n1 + 1,
		dir: F.u
	});
	const st2 = len2 / Math.max(1, n2);
	const dir2 = turn === "right" ? F.r : neg(F.r);
	for (let j = 1; j <= n2; j++) {
		const t0 = turn === "right" ? fw + st2 * (j - 1) : Lt - fw - st2 * (j - 1);
		const t1 = turn === "right" ? fw + st2 * j : Lt - fw - st2 * j;
		pieces.push({
			kind: "tread",
			...rect(len1, Ls, t0, t1),
			i: n1 + 1 + j,
			dir: dir2
		});
	}
	return {
		n,
		pieces
	};
}
//#endregion
//#region src/parser/woodCheck.ts
var len = (w) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
var m = (mm) => (mm / 1e3).toFixed(2);
/** 点 o から向き d に伸ばした半直線が線分 ab に当たるまでの距離（当たらなければ null） */
function raySeg(o, d, a, b) {
	const ex = b.x - a.x;
	const ey = b.y - a.y;
	const den = d.x * ey - d.y * ex;
	if (Math.abs(den) < 1e-9) return null;
	const ox = a.x - o.x;
	const oy = a.y - o.y;
	const t = (ox * ey - oy * ex) / den;
	const u = (ox * d.y - oy * d.x) / den;
	return t >= 0 && u >= -1e-6 && u <= 1 + 1e-6 ? t : null;
}
/** 壁の線分のうち、下階の壁の上に乗っている長さ（200mm ごとに判定） */
function supportedLength(w, below) {
	const L = len(w);
	const n = Math.max(1, Math.round(L / 200));
	let ok = 0;
	for (let i = 0; i < n; i++) {
		const t = (i + .5) / n;
		const p = {
			x: w.a.x + (w.b.x - w.a.x) * t,
			y: w.a.y + (w.b.y - w.a.y) * t
		};
		if (below.some((b) => distPointSegment(p, b.a, b.b) <= 90)) ok++;
	}
	return ok / n * L;
}
/** 下階の壁に乗っていない区間（200mm 刻みの判定をつなげた線分）。短い区間（< 300）は省く */
function unsupportedSegments(w, below) {
	const L = len(w);
	const n = Math.max(1, Math.round(L / 200));
	const at = (t) => ({
		x: w.a.x + (w.b.x - w.a.x) * t,
		y: w.a.y + (w.b.y - w.a.y) * t
	});
	const out = [];
	let start = null;
	for (let i = 0; i <= n; i++) {
		const free = i < n && !below.some((b) => distPointSegment(at((i + .5) / n), b.a, b.b) <= 90);
		if (free && start == null) start = i / n;
		if (!free && start != null) {
			if ((i / n - start) * L >= 300) out.push({
				a: at(start),
				b: at(i / n)
			});
			start = null;
		}
	}
	return out;
}
/**
* 部屋の一番狭い幅（芯々 mm）: 向かい合う平行な辺の距離の最小。L 字の廊下でも細い所を拾う。
* 戻り値はその幅と、位置を示す線（狭い辺）
*/
function narrowestWidth(poly) {
	let best = null;
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % n];
		const L = Math.hypot(b.x - a.x, b.y - a.y);
		if (L < 400) continue;
		const ux = (b.x - a.x) / L;
		const uy = (b.y - a.y) / L;
		const mx = (a.x + b.x) / 2;
		const my = (a.y + b.y) / 2;
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			const c = poly[j];
			const d = poly[(j + 1) % n];
			const M = Math.hypot(d.x - c.x, d.y - c.y);
			if (M < 400) continue;
			const vx = (d.x - c.x) / M;
			const vy = (d.y - c.y) / M;
			if (ux * vx + uy * vy > -.98) continue;
			const t = ((mx - c.x) * vx + (my - c.y) * vy) / M;
			if (t < 0 || t > 1) continue;
			const ta = (a.x - c.x) * vx + (a.y - c.y) * vy;
			const tb = (b.x - c.x) * vx + (b.y - c.y) * vy;
			if (Math.min(M, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) < 600) continue;
			const dist = Math.abs((mx - c.x) * -vy + (my - c.y) * vx);
			if (dist < 300) continue;
			const px = c.x + vx * M * t;
			const py = c.y + vy * M * t;
			if (!pointInPolygon({
				x: (mx + px) / 2,
				y: (my + py) / 2
			}, poly)) continue;
			if (!best || dist < best.width) best = {
				width: dist,
				a,
				b
			};
		}
	}
	return best;
}
function bboxOf$1(poly) {
	const xs = poly.map((p) => p.x);
	const ys = poly.map((p) => p.y);
	return {
		minX: Math.min(...xs),
		minY: Math.min(...ys),
		maxX: Math.max(...xs),
		maxY: Math.max(...ys)
	};
}
/** 部屋の輪郭の辺ごとに、壁で塞がれている割合と、その辺にある出入口 */
function roomAccess(r, f) {
	const poly = r.polygon;
	let hasDoor = false;
	let hasOpenEdge = false;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const L = Math.hypot(b.x - a.x, b.y - a.y);
		if (L < 300) continue;
		const along = f.walls.filter((w) => distPointSegment(w.a, a, b) <= 160 && distPointSegment(w.b, a, b) <= 160);
		if (along.reduce((s, w) => s + len(w), 0) < L * .5) {
			hasOpenEdge = true;
			continue;
		}
		for (const w of along) {
			const wl = len(w);
			for (const o of f.openings) {
				if (o.wallId !== w.id || o.kind === "window") continue;
				const t = (o.t0 + o.t1) / 2 / (wl || 1);
				if (distPointSegment({
					x: w.a.x + (w.b.x - w.a.x) * t,
					y: w.a.y + (w.b.y - w.a.y) * t
				}, a, b) <= 200) hasDoor = true;
			}
		}
	}
	return {
		hasDoor,
		hasOpenEdge
	};
}
function woodCheck(model) {
	const out = [];
	const floors = model.floors;
	const grid = model.module?.grid ?? 455;
	const phaseX = model.module?.phaseX ?? 0;
	const phaseY = model.module?.phaseY ?? 0;
	const onGrid = (v, phase) => Math.abs(phase + Math.round((v - phase) / grid) * grid - v) <= 100;
	for (const f of floors) {
		const stubs = f.walls.filter((w) => len(w) < 455 && !w.joinedA && !w.joinedB && !f.openings.some((o) => o.wallId === w.id));
		if (stubs.length) {
			const ids = new Set(stubs.map((w) => w.id));
			out.push({
				id: `stub-${f.level}`,
				level: f.level,
				severity: "warn",
				title: `${f.level}階: どこにもつながらない短い壁が ${stubs.length} 本`,
				detail: "木造の壁は柱から柱へ通るので、半間に満たない独立した壁は図面の線（家具・寸法補助線）を壁と読んだ疑いがあります",
				marks: [{
					level: f.level,
					lines: stubs.map((w) => ({
						a: w.a,
						b: w.b
					})),
					label: "壁の断片"
				}],
				fix: {
					label: "消す",
					apply: (mm) => {
						const fl = mm.floors.find((x) => x.level === f.level);
						if (!fl) return;
						fl.walls = fl.walls.filter((w) => !ids.has(w.id));
						fl.openings = fl.openings.filter((o) => !ids.has(o.wallId));
					}
				}
			});
		}
	}
	if (model.module?.snapped) for (const f of floors) {
		const off = f.walls.filter((w) => {
			const horiz = Math.abs(w.a.y - w.b.y) < 1;
			const vert = Math.abs(w.a.x - w.b.x) < 1;
			if (!horiz && !vert) return false;
			return [!w.joinedA ? w.a : null, !w.joinedB ? w.b : null].filter((p) => !!p).some((p) => horiz ? !onGrid(p.x, phaseX) : !onGrid(p.y, phaseY));
		});
		if (off.length >= 2) {
			const ends = off.flatMap((w) => [!w.joinedA ? w.a : null, !w.joinedB ? w.b : null].filter((p) => !!p));
			out.push({
				id: `offgrid-${f.level}`,
				level: f.level,
				severity: "info",
				title: `${f.level}階: 端が格子（半間）に乗らない壁が ${off.length} 本`,
				detail: "壁の端には柱が立つので、ふつう半間の格子点で止まります。腰壁・造作の可能性もありますが、読み取りの端のずれなら修正画面で直せます",
				marks: [{
					level: f.level,
					rects: ends.map((p) => ({
						minX: p.x - 160,
						minY: p.y - 160,
						maxX: p.x + 160,
						maxY: p.y + 160
					})),
					label: "格子外の端"
				}]
			});
		}
	}
	for (let i = 1; i < floors.length; i++) {
		const up = floors[i];
		const lo = floors[i - 1];
		let total = 0;
		let sup = 0;
		let extTotal = 0;
		let extSup = 0;
		const hanging = [];
		const freeAll = [];
		const freeExt = [];
		for (const w of up.walls) {
			const L = len(w);
			if (L < 300) continue;
			const s = supportedLength(w, lo.walls);
			total += L;
			sup += s;
			const segs = unsupportedSegments(w, lo.walls);
			freeAll.push(...segs);
			if (w.exterior) {
				extTotal += L;
				extSup += s;
				if (L - s >= 910) {
					hanging.push({
						w,
						free: L - s
					});
					freeExt.push(...segs);
				}
			}
		}
		if (total > 0) {
			const ratio = sup / total;
			out.push({
				id: `shita-${up.level}`,
				level: up.level,
				severity: ratio < .5 ? "warn" : ratio < .6 ? "info" : "ok",
				title: `${up.level}階の壁の直下率 ${Math.round(ratio * 100)}%`,
				detail: ratio >= .6 ? `${up.level}階の壁の ${Math.round(ratio * 100)}% が ${lo.level}階の壁の上に乗っています（目安 60% 以上）` : `${up.level}階の壁のうち ${lo.level}階の壁に乗っているのは ${Math.round(ratio * 100)}% です。乗っていない壁の下には梁が必要になり、梁せいが大きくなります（目安 60% 以上）`,
				marks: freeAll.length ? [{
					level: up.level,
					lines: freeAll,
					label: `${lo.level}階に壁なし（梁で受ける）`
				}] : void 0
			});
		}
		if (hanging.length) {
			const hl = hanging.reduce((s, h) => s + h.free, 0);
			const sideName = (w) => {
				const L = len(w);
				const ux = (w.b.x - w.a.x) / L;
				const uy = (w.b.y - w.a.y) / L;
				const nx = Math.round(-uy * (w.outsideSign ?? 1));
				const ny = Math.round(ux * (w.outsideSign ?? 1));
				return ny < 0 ? "上" : ny > 0 ? "下" : nx < 0 ? "左" : "右";
			};
			const sides = [...new Set(hanging.map((h) => sideName(h.w)))].map((n) => `図面の${n}側`).join("・");
			const share = extTotal > 0 ? hl / extTotal : 0;
			out.push({
				id: `overhang-${up.level}`,
				level: up.level,
				severity: share > .4 ? "warn" : "info",
				title: `${up.level}階の外壁 ${m(hl)} m（${sides}）の下に ${lo.level}階の壁がありません`,
				detail: share > .4 ? `${up.level}階の外壁の ${Math.round(share * 100)}% が ${lo.level}階の壁に乗っていません。大きな LDK の上に 2 階を載せる場合は、その位置に梁（集成材の大梁）か柱が必要です。${lo.level}階の壁の読み落としの可能性もあるので、修正画面で確認してください` : `その区間は ${lo.level}階に受ける壁が無いので、梁で受けるか張り出し（オーバーハング、910 まで）になります`,
				marks: [{
					level: up.level,
					lines: freeExt,
					label: `${lo.level}階に壁なし`
				}, {
					level: lo.level,
					lines: freeExt,
					label: `${up.level}階の外壁がここに乗る（壁か梁が必要）`
				}]
			});
		}
	}
	for (const f of floors) for (const r of f.rooms) {
		if ([
			"void",
			"balcony",
			"porch",
			"garage",
			"closet",
			"storage",
			"stairs"
		].includes(r.type)) continue;
		const inner = largestInnerRect(r.polygon, 5);
		if (!inner) continue;
		const short = Math.min(inner.maxX - inner.minX, inner.maxY - inner.minY) + (model.module ? 130 : 0);
		const marks = [{
			level: f.level,
			rects: [{
				minX: inner.minX,
				minY: inner.minY,
				maxX: inner.maxX,
				maxY: inner.maxY
			}],
			label: `スパン ${m(short)} m`
		}];
		if (short > 5e3) out.push({
			id: `span-${f.level}-${r.id}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階 ${r.name}: 柱の無い空間が ${m(short)} m`,
			detail: "短辺が 2.75 間（5,005）を超えています。在来の梁では厳しい大きさなので、途中に柱を立てるか、集成材の大梁・鉄骨梁の検討になります",
			marks
		});
		else if (short > 3700) out.push({
			id: `span-${f.level}-${r.id}`,
			level: f.level,
			severity: "info",
			title: `${f.level}階 ${r.name}: 梁のスパン ${m(short)} m（2 間超）`,
			detail: "2 間（3,640）を超えるので、せいの大きな梁（集成材 300〜360）か途中の柱が必要です。吹抜・大きな LDK ではよくある納まりです",
			marks
		});
	}
	for (const f of floors) {
		const dirs = {};
		const name = {
			"0,-1": "図面の上",
			"0,1": "図面の下",
			"-1,0": "図面の左",
			"1,0": "図面の右"
		};
		for (const w of f.walls) {
			if (!w.exterior || !w.outsideSign) continue;
			const L = len(w);
			if (L < 300) continue;
			const ux = (w.b.x - w.a.x) / L;
			const uy = (w.b.y - w.a.y) / L;
			const key = `${Math.round(-uy * w.outsideSign)},${Math.round(ux * w.outsideSign)}`;
			const d = dirs[key] ??= {
				total: 0,
				open: 0,
				walls: []
			};
			d.total += L;
			d.walls.push(w);
			for (const o of f.openings) if (o.wallId === w.id) d.open += o.t1 - o.t0;
		}
		for (const [key, d] of Object.entries(dirs)) {
			if (d.total < 3e3) continue;
			const ratio = d.open / d.total;
			if (ratio > .65) out.push({
				id: `shear-${f.level}-${key}`,
				level: f.level,
				severity: "warn",
				title: `${f.level}階 ${name[key] ?? key}側の外壁は開口が ${Math.round(ratio * 100)}%`,
				detail: "一面の大半が窓・戸だと、その方向の耐力壁が取りにくくなります。窓の間に 910 の壁を残すか、反対側の壁で補う設計になります",
				marks: [{
					level: f.level,
					lines: d.walls.map((w) => ({
						a: w.a,
						b: w.b
					})),
					label: `開口 ${Math.round(ratio * 100)}%（耐力壁が取りにくい）`
				}]
			});
		}
	}
	for (const f of floors) for (const r of f.rooms) {
		if ([
			"void",
			"balcony",
			"porch",
			"garage",
			"stairs",
			"hall",
			"other"
		].includes(r.type)) continue;
		if (r.area < 1.2) continue;
		const { hasDoor, hasOpenEdge } = roomAccess(r, f);
		if (!hasDoor && !hasOpenEdge) out.push({
			id: `nodoor-${f.level}-${r.id}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階 ${r.name}: 出入口が読めていません`,
			detail: "壁に囲まれていて戸が見つかりません。引戸・開き戸の記号が読めなかったか、壁を読みすぎています。修正画面で戸を置くか壁を消してください",
			marks: [{
				level: f.level,
				rects: [bboxOf$1(r.polygon)],
				label: "出入口なし"
			}]
		});
	}
	for (let i = 0; i + 1 < floors.length; i++) {
		const lo = floors[i];
		const up = floors[i + 1];
		for (const s of lo.stairs.filter((x) => x.goesUp)) {
			const best = up.stairs.reduce((b, t) => {
				const a = Math.max(0, Math.min(s.maxX, t.maxX) - Math.max(s.minX, t.minX)) * Math.max(0, Math.min(s.maxY, t.maxY) - Math.max(s.minY, t.minY)) / Math.min((s.maxX - s.minX) * (s.maxY - s.minY), (t.maxX - t.minX) * (t.maxY - t.minY));
				return Math.max(b, a);
			}, 0);
			const sRect = {
				minX: s.minX,
				minY: s.minY,
				maxX: s.maxX,
				maxY: s.maxY
			};
			if (up.stairs.length && best < .3) out.push({
				id: `stair-${lo.level}`,
				level: lo.level,
				severity: "warn",
				title: `${lo.level}階と ${up.level}階の階段の位置が合っていません`,
				detail: `重なりが ${Math.round(best * 100)}% です。どちらかの階段の読み取り位置がずれているか、別の階段です。修正画面の階段ツールで合わせてください`,
				marks: [{
					level: lo.level,
					rects: [sRect],
					label: `${lo.level}階の階段`
				}, {
					level: up.level,
					rects: up.stairs.map((t) => ({
						minX: t.minX,
						minY: t.minY,
						maxX: t.maxX,
						maxY: t.maxY
					})),
					label: `${up.level}階の階段（${lo.level}階とずれ）`
				}]
			});
			else if (!up.stairs.length) out.push({
				id: `stair-${lo.level}`,
				level: lo.level,
				severity: "info",
				title: `${up.level}階に階段の降り口が読めていません`,
				detail: `${lo.level}階の階段の上に ${up.level}階の階段（DN）がありません。吹抜・ホールとして読まれた可能性があります`,
				marks: [{
					level: lo.level,
					rects: [sRect],
					label: "階段"
				}, {
					level: up.level,
					rects: [sRect],
					label: `${lo.level}階の階段の真上（降り口が無い）`
				}]
			});
		}
	}
	for (const f of floors) for (const r of f.rooms) {
		const xs = r.polygon.map((p) => p.x);
		const ys = r.polygon.map((p) => p.y);
		const w = Math.max(...xs) - Math.min(...xs);
		const h = Math.max(...ys) - Math.min(...ys);
		const short = Math.min(w, h);
		const marks = [{
			level: f.level,
			rects: [{
				minX: Math.min(...xs),
				minY: Math.min(...ys),
				maxX: Math.max(...xs),
				maxY: Math.max(...ys)
			}],
			label: `短辺 ${m(short)} m`
		}];
		if (r.type === "bath" && short < 1700 && short > 0) out.push({
			id: `ub-${f.level}-${r.id}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階 ${r.name}: 短辺 ${m(short)} m では UB 1616 が入りません`,
			detail: "ユニットバス 1616 は柱芯 1,820×1,820（内法 1,600）が必要です。1 坪より小さい区画は読み取りの壁のずれか、1216・1317 などの小さいサイズになります",
			marks
		});
		if (r.type === "toilet" && short < 800 && short > 0) out.push({
			id: `wc-${f.level}-${r.id}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階 ${r.name}: 幅 ${m(short)} m は便所として狭すぎます`,
			detail: "便所は柱芯 910（内法 780 前後）が最小です。壁の読み取りがずれている可能性があります",
			marks
		});
	}
	for (const f of floors) for (const r of f.rooms) {
		if ([
			"void",
			"balcony",
			"porch",
			"garage",
			"closet",
			"storage",
			"toilet",
			"bath"
		].includes(r.type)) continue;
		const nw = narrowestWidth(r.polygon);
		if (!nw) continue;
		const clear = nw.width - 130;
		const passage = r.type === "hall" || r.type === "entrance" || r.type === "stairs";
		const mark = {
			level: f.level,
			lines: [{
				a: nw.a,
				b: nw.b
			}],
			label: `幅 ${m(nw.width)} m（内法 約 ${m(Math.max(0, clear))} m）`
		};
		if (passage && nw.width < 700) out.push({
			id: `narrow-${f.level}-${r.id}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階 ${r.name}: 幅 ${m(nw.width)} m では通れません`,
			detail: `柱芯 ${Math.round(nw.width)} だと内法は約 ${Math.round(Math.max(0, clear))} です。廊下は柱芯 910（内法 780）が最小で、車いすや家具の搬入を考えると 1,000 以上が目安です。壁の読み取りがずれているか、本当に狭い場合は間取りの見直しになります`,
			marks: [mark]
		});
		else if (passage && nw.width < 880) out.push({
			id: `narrow-${f.level}-${r.id}`,
			level: f.level,
			severity: "info",
			title: `${f.level}階 ${r.name}: 幅 ${m(nw.width)} m は少し狭い通路です`,
			detail: `内法が約 ${Math.round(clear)} で、910 モジュール（内法 780）より狭くなっています。格子（455）に乗らない幅なので、壁の読み取りのずれの可能性もあります。手すりを付けると更に 50 狭くなります`,
			marks: [mark]
		});
		else if (!passage && nw.width < 600 && r.area >= 1.2) out.push({
			id: `narrow-${f.level}-${r.id}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階 ${r.name}: 幅 ${m(nw.width)} m の部分は使えません`,
			detail: `柱芯 ${Math.round(nw.width)}（内法 約 ${Math.round(Math.max(0, clear))}）の細い部分があります。壁の読み取りがずれているか、余分な壁を読んでいる可能性があります。修正画面で確認してください`,
			marks: [mark]
		});
	}
	for (const f of floors) {
		const storages = f.rooms.filter((r) => r.type === "closet" || r.type === "storage");
		const segOf = (o) => {
			const w = f.walls.find((x) => x.id === o.wallId);
			if (!w) return null;
			const L = len(w) || 1;
			const at = (t) => ({
				x: w.a.x + (w.b.x - w.a.x) * t / L,
				y: w.a.y + (w.b.y - w.a.y) * t / L
			});
			return {
				a: at(o.t0),
				b: at(o.t1)
			};
		};
		const intoStorage = (seg) => {
			const c = {
				x: (seg.a.x + seg.b.x) / 2,
				y: (seg.a.y + seg.b.y) / 2
			};
			return storages.some((r) => r.polygon.some((p, i) => distPointSegment(c, p, r.polygon[(i + 1) % r.polygon.length]) <= 250));
		};
		const narrow = f.openings.filter((o) => {
			if (o.kind === "window" || o.kind === "open" || o.t1 - o.t0 >= 550) return false;
			const seg = segOf(o);
			return !!seg && !intoStorage(seg);
		});
		if (!narrow.length) continue;
		const lines = narrow.map(segOf).filter((x) => !!x);
		out.push({
			id: `door-${f.level}`,
			level: f.level,
			severity: "warn",
			title: `${f.level}階: 幅 0.55 m 未満の戸が ${narrow.length} か所`,
			detail: `${narrow.map((o) => `${Math.round(o.t1 - o.t0)}`).join("・")} mm の戸があります。戸は便所でも 650 以上、居室は 750〜800 が標準です。戸の記号（円弧・引戸の線）を小さく読んだ可能性があります。修正画面で戸を置き直してください`,
			marks: [{
				level: f.level,
				lines,
				label: "狭い戸"
			}]
		});
	}
	for (const f of floors) {
		const dup = [];
		const seen = /* @__PURE__ */ new Set();
		for (const w of f.walls) {
			const L = len(w);
			if (L < 600) continue;
			const ux = (w.b.x - w.a.x) / L;
			const uy = (w.b.y - w.a.y) / L;
			for (const v of f.walls) {
				if (v === w || seen.has(`${v.id}|${w.id}`)) continue;
				const M = len(v);
				if (M < 600) continue;
				const vx = (v.b.x - v.a.x) / M;
				const vy = (v.b.y - v.a.y) / M;
				if (Math.abs(ux * vx + uy * vy) < .995) continue;
				const mx = (v.a.x + v.b.x) / 2 - w.a.x;
				const my = (v.a.y + v.b.y) / 2 - w.a.y;
				const gap = Math.abs(mx * -uy + my * ux);
				if (gap < 60 || gap > 230) continue;
				const t0 = Math.min((v.a.x - w.a.x) * ux + (v.a.y - w.a.y) * uy, (v.b.x - w.a.x) * ux + (v.b.y - w.a.y) * uy);
				const t1 = Math.max((v.a.x - w.a.x) * ux + (v.a.y - w.a.y) * uy, (v.b.x - w.a.x) * ux + (v.b.y - w.a.y) * uy);
				const ov = Math.min(L, t1) - Math.max(0, t0);
				if (ov < 600 || ov < Math.min(L, M) * .6) continue;
				if (w.exterior && v.exterior) continue;
				seen.add(`${w.id}|${v.id}`);
				const drop = w.exterior ? v : v.exterior ? w : L >= M ? v : w;
				dup.push({
					keep: drop === v ? w : v,
					drop
				});
			}
		}
		if (dup.length) {
			const ids = new Set(dup.map((d) => d.drop.id));
			out.push({
				id: `dup-${f.level}`,
				level: f.level,
				severity: "warn",
				title: `${f.level}階: 重なった壁が ${dup.length} 組`,
				detail: "同じ場所に平行な壁が 2 本あります（芯々 60〜230）。壁の両面の線を別々の壁と読んだか、仕上げ線・巾木の線を壁と読んだ疑いがあります。3D では壁が厚く見えたり、隙間ができたりします",
				marks: [{
					level: f.level,
					lines: dup.map((d) => ({
						a: d.drop.a,
						b: d.drop.b
					})),
					label: "重なった壁"
				}],
				fix: {
					label: "片方を消す",
					apply: (mm) => {
						const fl = mm.floors.find((x) => x.level === f.level);
						if (!fl) return;
						fl.walls = fl.walls.filter((w) => !ids.has(w.id));
						fl.openings = fl.openings.filter((o) => !ids.has(o.wallId));
					}
				}
			});
		}
	}
	for (let fi = 0; fi + 1 < floors.length; fi++) {
		const f = floors[fi];
		for (const st of f.stairs.filter((x) => x.goesUp)) {
			const rise = f.height || 2900;
			const n = stairStepCount(rise, st);
			const riser = rise / n;
			const F = stairFrame(st);
			let tread;
			if (st.kind === "straight") tread = F.Ls / Math.max(1, n - 1);
			else if (st.kind === "u") {
				const land = Math.min(F.Ls * .4, F.Lt / 2);
				tread = (F.Ls - land) / Math.max(1, Math.floor(n / 2));
			} else tread = (F.Ls + F.Lt - Math.min(F.Lt, F.Ls / 2) * 2) / Math.max(1, n - 2);
			const rect = {
				minX: st.minX,
				minY: st.minY,
				maxX: st.maxX,
				maxY: st.maxY
			};
			const label = `蹴上 ${Math.round(riser)}・踏面 約 ${Math.round(tread)}（${n} 段）`;
			if (riser > 230) out.push({
				id: `steep-${f.level}-${st.id}`,
				level: f.level,
				severity: "warn",
				title: `${f.level}階 階段: 蹴上 ${Math.round(riser)} は急すぎます（${n} 段）`,
				detail: `階高 ${rise} を ${n} 段で上がると蹴上が ${Math.round(riser)} になります。住宅の上限は蹴上 230（踏面 150）で、ゆとりの目安は 200 以下です。段数を ${Math.ceil(rise / 230)} 段以上（できれば ${Math.ceil(rise / 200)} 段）にしてください。図面の段数の読み取りがずれている可能性もあります`,
				marks: [{
					level: f.level,
					rects: [rect],
					label
				}]
			});
			else if (tread < 200) out.push({
				id: `steep-${f.level}-${st.id}`,
				level: f.level,
				severity: "info",
				title: `${f.level}階 階段: 図面の長さだと踏面が約 ${Math.round(tread)} です`,
				detail: `${n} 段（蹴上 ${Math.round(riser)}）を図面の階段の長さに割ると踏面が ${Math.round(tread)} になります。ゆとりの目安は踏面 240 以上（${Math.round(240 * (n - 1))} 程度の長さ）です。下の数段をホール側へ出す描き方なら問題ありません（3D では昇り口側へ延ばして勾配を補っています）`,
				marks: [{
					level: f.level,
					rects: [rect],
					label
				}]
			});
			else if (riser > 205) out.push({
				id: `steep-${f.level}-${st.id}`,
				level: f.level,
				severity: "info",
				title: `${f.level}階 階段: 蹴上 ${Math.round(riser)} はやや急です（${n} 段）`,
				detail: `ゆとりの目安は蹴上 200 以下です。1 段増やすと ${Math.round(rise / (n + 1))} になります`,
				marks: [{
					level: f.level,
					rects: [rect],
					label
				}]
			});
		}
	}
	for (const f of floors) {
		const storages = f.rooms.filter((r) => r.type === "closet" || r.type === "storage");
		const hits = [];
		for (const o of f.openings) {
			if (o.kind !== "door" && o.kind !== "entrance") continue;
			const w = f.walls.find((x) => x.id === o.wallId);
			if (!w) continue;
			const L = len(w) || 1;
			const dx = (w.b.x - w.a.x) / L;
			const dy = (w.b.y - w.a.y) / L;
			const width = o.t1 - o.t0;
			if (width < 500) continue;
			const tm = (o.t0 + o.t1) / 2;
			const c = {
				x: w.a.x + dx * tm,
				y: w.a.y + dy * tm
			};
			const clearance = (sign) => {
				const d = {
					x: -dy * sign,
					y: dx * sign
				};
				const probe = {
					x: c.x + d.x * 200,
					y: c.y + d.y * 200
				};
				if (storages.some((r) => pointInPolygon(probe, r.polygon))) return Infinity;
				let best = Infinity;
				for (const v of f.walls) {
					if (v.id === w.id) continue;
					const t = raySeg(c, d, v.a, v.b);
					if (t != null && t > 0) best = Math.min(best, t - v.thickness / 2);
				}
				return best;
			};
			const sides = o.swingSide ? [o.swingSide] : [1, -1];
			const clear = Math.max(...sides.map(clearance));
			if (clear < width - 30) hits.push({
				seg: {
					a: {
						x: w.a.x + dx * o.t0,
						y: w.a.y + dy * o.t0
					},
					b: {
						x: w.a.x + dx * o.t1,
						y: w.a.y + dy * o.t1
					}
				},
				clear,
				width
			});
		}
		if (!hits.length) continue;
		const bad = hits.some((h) => h.clear < h.width * .75);
		out.push({
			id: `doorwall-${f.level}`,
			level: f.level,
			severity: bad ? "warn" : "info",
			title: `${f.level}階: 開いた先に壁がある戸が ${hits.length} か所`,
			detail: `${hits.map((h) => `幅 ${Math.round(h.width)} の戸の前が ${Math.round(Math.max(0, h.clear))}`).join("・")} mm です。開き戸は開く側に戸の幅ぶん（${hits.map((h) => Math.round(h.width)).join("・")}）の空きが要ります。壁に当たる戸は引戸にするか、開く向きを変えてください。戸の記号（円弧の向き）を読み違えている可能性もあります`,
			marks: [{
				level: f.level,
				lines: hits.map((h) => h.seg),
				label: "戸の前に壁"
			}]
		});
	}
	for (const f of floors) {
		const short = [];
		for (const poly of f.outline) {
			const n = poly.length;
			if (n < 4) continue;
			const dir = (i) => {
				const a = poly[(i + n) % n];
				const b = poly[(i + 1 + n) % n];
				const L = len({
					a,
					b
				}) || 1;
				return {
					x: (b.x - a.x) / L,
					y: (b.y - a.y) / L,
					L
				};
			};
			for (let i = 0; i < n; i++) {
				const d = dir(i);
				if (d.L < 30 || d.L >= 440) continue;
				const p = dir(i - 1);
				const q = dir(i + 1);
				const turnP = Math.abs(p.x * d.y - p.y * d.x);
				const turnQ = Math.abs(q.x * d.y - q.y * d.x);
				if (turnP < .3 || turnQ < .3) continue;
				short.push({
					a: poly[i],
					b: poly[(i + 1) % n],
					L: d.L
				});
			}
		}
		if (!short.length) continue;
		const lens = short.map((x) => Math.round(x.L));
		const jagged = short.length > 8;
		const tiny = short.every((x) => x.L < 200);
		out.push({
			id: `jog-${f.level}`,
			level: f.level,
			severity: jagged ? "warn" : tiny ? "info" : "warn",
			title: jagged ? `${f.level}階: 外形がギザギザです（半間未満の段差が ${short.length} か所）` : tiny ? `${f.level}階: 外形に細かな段差が ${short.length} か所（読み取りの揺れの疑い）` : `${f.level}階: 外壁に半間未満の出入りが ${short.length} か所`,
			detail: jagged ? `${lens.slice(0, 12).join("・")}… mm の段差があります。壁を二重に読んだか、梁・庇の線を外壁と取り違えた可能性が高いので、修正画面で外形を確かめてください` : tiny ? `${lens.join("・")} mm の段差があります。外壁と内壁の厚みの差や、線を二重に読んだ揺れのことが多く、設計上の出入りではありません。気になるときは修正画面で壁を揃えてください` : `${lens.join("・")} mm の出入りがあります。木造では外壁の出入りごとに柱が 2 本と基礎の角が増え、屋根・樋の納まりも複雑になります。意図した出入りなら 455 か 910 に、読み取りの揺れ（二重の壁・梁の線）なら修正画面で外形を直してください`,
			marks: [{
				level: f.level,
				lines: short.map((x) => ({
					a: x.a,
					b: x.b
				})),
				label: jagged ? "ギザギザ" : "細かい段差"
			}]
		});
	}
	return out;
}
//#endregion
//#region src/estimate/areas.ts
/** 画面で編集できる項目の説明（順番どおりに並べる） */
var AREA_FIELDS = [
	{
		key: "floor1",
		label: "1階床面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "floor2",
		label: "2階床面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "floor3",
		label: "3階床面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "porchOut",
		label: "外部ポーチ・テラス面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "porchIn",
		label: "内部ポーチ・テラス面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "extraArea",
		label: "施工面積（追加分）",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "balconyArea",
		label: "バルコニー面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "voidArea",
		label: "吹き抜け",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "loftArea",
		label: "ロフト ※半分換算",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "buildArea",
		label: "建築面積",
		unit: "㎡",
		group: "面積"
	},
	{
		key: "extWall",
		label: "外壁面積",
		unit: "㎡",
		group: "外部"
	},
	{
		key: "foundPerim",
		label: "基礎外周",
		unit: "m",
		group: "外部"
	},
	{
		key: "soffitArea",
		label: "軒天面積",
		unit: "㎡",
		group: "外部"
	},
	{
		key: "roofArea",
		label: "屋根面積",
		unit: "㎡",
		group: "外部"
	},
	{
		key: "eaveLen",
		label: "軒先（鼻隠し）",
		unit: "m",
		group: "外部"
	},
	{
		key: "ridgeLen",
		label: "棟長さ",
		unit: "m",
		group: "外部"
	},
	{
		key: "corners",
		label: "建物角 1階・2階・3階",
		unit: "ヵ所",
		group: "外部"
	},
	{
		key: "insulArea",
		label: "断熱面積 室内天井＆外部床",
		unit: "㎡",
		group: "外部"
	},
	{
		key: "siteEdge",
		label: "敷地外周",
		unit: "m",
		group: "外部"
	},
	{
		key: "downspouts1",
		label: "竪樋 1階",
		unit: "本",
		group: "外部"
	},
	{
		key: "downspouts2",
		label: "竪樋 2階",
		unit: "本",
		group: "外部"
	},
	{
		key: "solidoArea",
		label: "SOLIDO 面積",
		unit: "㎡",
		group: "外部"
	},
	{
		key: "solidoCorners",
		label: "SOLIDO 角数",
		unit: "ヵ所",
		group: "外部"
	},
	{
		key: "highCeil",
		label: "高天井（H2500からの差）",
		unit: "㎥",
		group: "内部"
	},
	{
		key: "slopeCeil",
		label: "勾配天井",
		unit: "㎡",
		group: "内部"
	},
	{
		key: "doors",
		label: "建具個数",
		unit: "箇所",
		group: "内部"
	},
	{
		key: "flooringArea",
		label: "フローリング面積",
		unit: "㎡",
		group: "内部"
	},
	{
		key: "floorTileArea",
		label: "フロアタイル面積",
		unit: "㎡",
		group: "内部"
	},
	{
		key: "toilets",
		label: "トイレ数",
		unit: "ヵ所",
		group: "内部"
	},
	{
		key: "stairs",
		label: "階段数",
		unit: "ヵ所",
		group: "内部"
	},
	{
		key: "tatami1",
		label: "畳（1帖）",
		unit: "枚",
		group: "内部"
	},
	{
		key: "tatamiHalf",
		label: "畳（半帖）",
		unit: "枚",
		group: "内部"
	},
	{
		key: "fanDucts",
		label: "換気扇ダクト",
		unit: "ヵ所",
		group: "設備"
	},
	{
		key: "pipeFans",
		label: "パイプファン",
		unit: "ヵ所",
		group: "設備"
	},
	{
		key: "deepFound100",
		label: "深基礎 H-100",
		unit: "m",
		group: "任意"
	},
	{
		key: "deepFound200",
		label: "深基礎 H-200",
		unit: "m",
		group: "任意"
	},
	{
		key: "deepFound300",
		label: "深基礎 H-300",
		unit: "m",
		group: "任意"
	},
	{
		key: "deepFound400",
		label: "深基礎 H-400",
		unit: "m",
		group: "任意"
	},
	{
		key: "soundArea",
		label: "室内防音材",
		unit: "㎡",
		group: "任意"
	},
	{
		key: "innerTileArea",
		label: "室内タイル床",
		unit: "㎡",
		group: "任意"
	},
	{
		key: "innerSolidoArea",
		label: "室内 SOLIDO 壁",
		unit: "㎡",
		group: "任意"
	},
	{
		key: "paintWallArea",
		label: "室内塗り壁",
		unit: "㎡",
		group: "任意"
	},
	{
		key: "woodCeilArea",
		label: "木板天井",
		unit: "㎡",
		group: "任意"
	},
	{
		key: "handrailLen",
		label: "St 手摺",
		unit: "m",
		group: "任意"
	},
	{
		key: "doorCloth",
		label: "建具クロス張り",
		unit: "ヵ所",
		group: "任意"
	},
	{
		key: "soStyle",
		label: "So スタイル スイッチ",
		unit: "ヵ所",
		group: "任意"
	},
	{
		key: "travelKm",
		label: "交通費（15km 超）",
		unit: "km",
		group: "任意"
	}
];
var T$1 = .3025;
var r2$1 = (v) => Math.round(v * 100) / 100;
function perimeter(poly) {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i];
		const q = poly[(i + 1) % poly.length];
		s += Math.hypot(q.x - p.x, q.y - p.y);
	}
	return s;
}
function roomsArea(f, types) {
	return f.rooms.filter((r) => types.includes(r.type)).reduce((s, r) => s + r.area, 0);
}
function outlineArea$1(f) {
	return f.outline.reduce((s, l) => s + Math.abs(polygonArea(l)) / 1e6, 0);
}
/** 間取りから数量を拾う */
function takeoff(model, opts) {
	const floors = model.floors.slice().sort((a, b) => a.level - b.level);
	const fl = (lv) => floors.find((f) => f.level === lv);
	const floorArea = (f) => f ? Math.max(0, outlineArea$1(f) - roomsArea(f, ["void", "balcony"])) : 0;
	const floor1 = r2$1(floorArea(fl(1)));
	const floor2 = r2$1(floorArea(fl(2)));
	const floor3 = r2$1(floorArea(fl(3)));
	const totalArea = r2$1(floor1 + floor2 + floor3);
	const porch = r2$1(floors.reduce((s, f) => s + roomsArea(f, ["porch"]), 0));
	const balconyArea = r2$1(floors.reduce((s, f) => s + roomsArea(f, ["balcony"]), 0));
	const voidArea = r2$1(floors.filter((f) => f.level >= 2).reduce((s, f) => s + roomsArea(f, ["void"]), 0));
	const extraArea = porch;
	const loftArea = 0;
	const constArea = r2$1(totalArea + extraArea + balconyArea + loftArea + voidArea);
	const buildArea = r2$1(Math.max(floor1, floor2, floor3, floorArea(fl(1))));
	let extWall = 0;
	let corners = 0;
	for (const f of floors) {
		const per = f.outline.reduce((s, l) => s + perimeter(l), 0) / 1e3;
		extWall += per * (f.height / 1e3);
		corners += f.outline.reduce((s, l) => s + l.length, 0);
	}
	const f1 = fl(1);
	const foundPerim = r2$1(f1 ? f1.outline.reduce((s, l) => s + perimeter(l), 0) / 1e3 : 0);
	const top = floors[floors.length - 1];
	const topPerim = top ? top.outline.reduce((s, l) => s + perimeter(l), 0) / 1e3 : 0;
	if (opts.roofType === "flat" || opts.roofType === "shed") extWall += topPerim * .6;
	extWall = r2$1(Math.max(0, extWall));
	const eaveOut = opts.roofType === "flat" ? 0 : opts.eavesMm / 1e3;
	let roofPlan = floorArea(top);
	for (let i = 0; i < floors.length - 1; i++) roofPlan += Math.max(0, floorArea(floors[i]) - floorArea(floors[i + 1]));
	const slope = opts.roofType === "flat" ? 1 : Math.sqrt(1 + (opts.pitch / 10) ** 2);
	const roofArea = r2$1((roofPlan + topPerim * eaveOut) * slope * 1.05);
	const lowerRoofPerim = floors.length >= 2 ? Math.max(0, foundPerim - topPerim) : 0;
	const overhang = Math.max(0, floor2 - floor1) + Math.max(0, floor3 - floor2);
	const soffitArea = r2$1((topPerim + lowerRoofPerim) * eaveOut + overhang);
	const bb = top ? bboxOf(top.outline.flat()) : null;
	const longSide = bb ? Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) / 1e3 : 0;
	const eaveLen = r2$1(opts.roofType === "gable" ? longSide * 2 + 2 * eaveOut * 2 : opts.roofType === "shed" ? longSide + 2 * eaveOut : topPerim + 8 * eaveOut);
	const ridgeLen = r2$1(opts.roofType === "flat" ? 0 : longSide);
	const insulArea = r2$1(floorArea(top) + overhang);
	const siteEdge = r2$1(model.site?.polygon?.length ? perimeter(model.site.polygon) / 1e3 : Math.max(40, 4 * Math.sqrt(buildArea * 2.4)));
	const doors = floors.reduce((s, f) => s + f.openings.filter((o) => (o.kind === "door" || o.kind === "sliding") && !f.walls.find((w) => w.id === o.wallId)?.exterior).length, 0);
	const flooringArea = r2$1(floors.reduce((s, f) => s + roomsArea(f, [
		"ldk",
		"living",
		"dining",
		"kitchen",
		"bedroom",
		"kids",
		"study",
		"hall",
		"closet",
		"storage",
		"other"
	]), 0));
	const floorTileArea = r2$1(floors.reduce((s, f) => s + roomsArea(f, ["washroom"]), 0));
	const toilets = Math.max(1, floors.reduce((s, f) => s + f.rooms.filter((r) => r.type === "toilet").length, 0));
	const stairs = Math.max(0, floors.length - 1);
	const tatami = floors.reduce((s, f) => s + roomsArea(f, ["japanese"]), 0) / 1.62;
	const totalTsubo = Math.floor(totalArea * T$1 * 100) / 100;
	const constTsubo = Math.floor(constArea * T$1 * 100) / 100;
	const f2 = fl(2);
	const wet2f = f2?.rooms.some((r) => r.type === "ldk" || r.type === "kitchen") ? "ldk" : f2?.rooms.some((r) => [
		"toilet",
		"washroom",
		"bath"
	].includes(r.type)) ? "some" : "none";
	const solido = opts.solido ?? "none";
	const upperWall = f2 ? f2.outline.reduce((s, l) => s + perimeter(l), 0) / 1e3 * (f2.height / 1e3) * .85 : 0;
	const solidoArea = r2$1(solido === "upper" ? upperWall : solido === "lower" ? extWall - upperWall : solido === "entrance" ? 15 : 0);
	const solidoCorners = solido === "upper" ? f2?.outline.reduce((s, l) => s + l.length, 0) ?? 0 : solido === "lower" ? f1?.outline.reduce((s, l) => s + l.length, 0) ?? 0 : solido === "entrance" ? 2 : 0;
	return {
		grade: opts.grade,
		floor1,
		floor2,
		floor3,
		totalArea,
		totalTsubo,
		porchOut: porch,
		porchIn: porch,
		extraArea,
		balconyArea,
		voidArea,
		loftArea,
		constArea,
		constTsubo,
		buildArea,
		extWall,
		foundPerim,
		soffitArea,
		roofArea,
		eaveLen,
		ridgeLen,
		corners,
		insulArea,
		highCeil: 0,
		slopeCeil: 0,
		siteEdge,
		doors,
		flooringArea,
		floorTileArea,
		toilets,
		stairs,
		downspouts1: floors.length >= 2 ? 3 : 4,
		downspouts2: floors.length >= 2 ? 3 : 0,
		tatami1: Math.round(tatami),
		tatamiHalf: 0,
		scale: totalTsubo / 30,
		fanDucts: opts.grade === "P" ? 3 : 6,
		pipeFans: opts.grade === "P" ? 3 : 5,
		wet2f,
		waterHeater: "ecocute",
		solidoArea,
		solidoCorners,
		deepFound100: 0,
		deepFound200: 0,
		deepFound300: 0,
		deepFound400: 0,
		fireZone: false,
		evoltz: false,
		soffitWood: false,
		addInsul: false,
		pocketKey: false,
		solidFloor: false,
		doorPaint: false,
		balconyTile: false,
		handwash: false,
		kanta: false,
		slopSink: false,
		septic: false,
		structCalc: false,
		evOutlet: false,
		soundArea: 0,
		innerTileArea: 0,
		innerSolidoArea: 0,
		paintWallArea: 0,
		woodCeilArea: 0,
		handrailLen: 0,
		doorCloth: 0,
		soStyle: 0,
		travelKm: 0
	};
}
function bboxOf(pts) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	return {
		minX,
		minY,
		maxX,
		maxY
	};
}
//#endregion
//#region src/scene/meshBuilder.ts
/**
* マテリアルキーごとに三角形を蓄積し、まとめて Mesh を作るビルダー。
* UV はメートル単位（テクスチャ側で repeat = 1/tile）。
*/
/** 水平に切る（この高さより上を取り除く） */
function topClip(y, capKey = "cut.face") {
	return {
		n: new THREE.Vector3(0, 1, 0),
		d: y,
		capKey
	};
}
var BOX_EDGES = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 0],
	[4, 5],
	[5, 6],
	[6, 7],
	[7, 4],
	[0, 4],
	[1, 5],
	[2, 6],
	[3, 7]
];
var MeshBuilder = class {
	buckets = /* @__PURE__ */ new Map();
	/** 切断面（null = 切らない） */
	clip = null;
	/** 切断面からの符号付き距離（正 = 取り除く側） */
	cf(p) {
		return p.dot(this.clip.n) - this.clip.d;
	}
	pushTri(key, pts, n, uAxis, vAxis) {
		const bk = this.bucket(key);
		for (const p of pts) {
			bk.pos.push(p.x, p.y, p.z);
			bk.nor.push(n.x, n.y, n.z);
			bk.uv.push(p.dot(uAxis), p.dot(vAxis));
		}
	}
	/** 多角形を切断面で切って、残った部分を押し込む */
	pushClipped(key, pts, n, uAxis, vAxis) {
		const out = [];
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % pts.length];
			const fa = this.cf(a);
			const fb = this.cf(b);
			const ia = fa <= 1e-6;
			const ib = fb <= 1e-6;
			if (ia) out.push(a);
			if (ia !== ib) out.push(a.clone().lerp(b, fa / (fa - fb)));
		}
		if (out.length < 3) return;
		for (let i = 1; i + 1 < out.length; i++) this.pushTri(key, [
			out[0],
			out[i],
			out[i + 1]
		], n, uAxis, vAxis);
	}
	/** 凸な立体（頂点と辺）の切り口を多角形で閉じる */
	capPolygon(corners, edges) {
		const clip = this.clip;
		const fs = corners.map((c) => this.cf(c));
		const pts = [];
		for (const [i, j] of edges) {
			const fi = fs[i];
			const fj = fs[j];
			if (fi < 0 && fj > 0 || fi > 0 && fj < 0) pts.push(corners[i].clone().lerp(corners[j], fi / (fi - fj)));
		}
		if (pts.length < 3) return;
		const n = clip.n;
		const a = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
		const b = new THREE.Vector3().crossVectors(n, a).normalize();
		const cen = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
		const ang = (p) => {
			const r = p.clone().sub(cen);
			return Math.atan2(r.dot(b), r.dot(a));
		};
		pts.sort((p, q) => ang(p) - ang(q));
		for (let i = 1; i + 1 < pts.length; i++) this.pushTri(clip.capKey, [
			pts[0],
			pts[i],
			pts[i + 1]
		], n, a, b);
	}
	bucket(key) {
		let b = this.buckets.get(key);
		if (!b) {
			b = {
				pos: [],
				nor: [],
				uv: []
			};
			this.buckets.set(key, b);
		}
		return b;
	}
	/** 三角形（反時計回りが表） */
	tri(key, a, b, c, uAxis, vAxis, normal) {
		const n = normal ?? new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
		if (this.clip) {
			const fa = this.cf(a);
			const fb = this.cf(b);
			const fc = this.cf(c);
			if (Math.min(fa, fb, fc) >= -1e-6) return;
			if (Math.max(fa, fb, fc) > 1e-6) {
				this.pushClipped(key, [
					a,
					b,
					c
				], n, uAxis, vAxis);
				return;
			}
		}
		this.pushTri(key, [
			a,
			b,
			c
		], n, uAxis, vAxis);
	}
	/** 四角形 p0→p1→p2→p3（反時計回りが表） */
	quad(key, p0, p1, p2, p3, uAxis, vAxis) {
		const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).normalize();
		if (n.lengthSq() < .5) n.subVectors(p2, p1).cross(new THREE.Vector3().subVectors(p3, p1)).normalize();
		const [u, v] = uAxis && vAxis ? [uAxis, vAxis] : autoAxes(n);
		this.tri(key, p0, p1, p2, u, v, n);
		this.tri(key, p0, p2, p3, u, v, n);
	}
	/** 平面多角形（穴なし・凸/凹どちらも可）。pts は表から見て反時計回り */
	polygon(key, pts, normal, uAxis, vAxis, holes = []) {
		const [u, v] = uAxis && vAxis ? [uAxis, vAxis] : autoAxes(normal);
		const a = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
		const b = new THREE.Vector3().crossVectors(normal, a).normalize();
		const to2 = (p) => new THREE.Vector2(p.dot(a), p.dot(b));
		const contour = pts.map(to2);
		const hs = holes.map((h) => h.map(to2));
		const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
		const all = pts.concat(...holes);
		for (const [i, j, k] of tris) {
			const p = all[i];
			const q = all[j];
			const r = all[k];
			if (new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p)).dot(normal) < 0) this.tri(key, p, r, q, u, v, normal);
			else this.tri(key, p, q, r, u, v, normal);
		}
	}
	/**
	* 向き付きの直方体。center は底面中心、dir は長手方向（水平）、size = [長さ, 高さ, 奥行]
	* faceKeys: [+n側, -n側, 上, 下, 始端, 終端]
	*/
	box(keys, base, dir, len, height, depth) {
		const k = typeof keys === "string" ? [
			keys,
			keys,
			keys,
			keys,
			keys,
			keys
		] : [...keys];
		const u = dir.clone().setY(0).normalize();
		const up = new THREE.Vector3(0, 1, 0);
		const n = new THREE.Vector3().crossVectors(u, up).normalize();
		const hl = len / 2;
		const hd = depth / 2;
		const P = (s, h, t) => base.clone().addScaledVector(u, s).addScaledVector(up, h).addScaledVector(n, t);
		const c = [
			P(-hl, 0, -hd),
			P(hl, 0, -hd),
			P(hl, 0, hd),
			P(-hl, 0, hd),
			P(-hl, height, -hd),
			P(hl, height, -hd),
			P(hl, height, hd),
			P(-hl, height, hd)
		];
		let straddles = false;
		if (this.clip) {
			const fs = c.map((p) => this.cf(p));
			if (Math.min(...fs) >= -1e-6) return;
			straddles = Math.max(...fs) > 1e-6;
		}
		if (k[0]) this.quad(k[0], c[3], c[2], c[6], c[7], u, up);
		if (k[1]) this.quad(k[1], c[1], c[0], c[4], c[5], u, up);
		if (k[2]) this.quad(k[2], c[4], c[7], c[6], c[5]);
		if (k[3]) this.quad(k[3], c[0], c[1], c[2], c[3]);
		if (k[4]) this.quad(k[4], c[0], c[3], c[7], c[4], n, up);
		if (k[5]) this.quad(k[5], c[2], c[1], c[5], c[6], n, up);
		if (straddles) this.capPolygon(c, BOX_EDGES);
	}
	/** 軸平行の直方体（min/max 指定） */
	aabb(key, min, max) {
		const len = max.x - min.x;
		const depth = max.z - min.z;
		const base = new THREE.Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
		this.box(key, base, new THREE.Vector3(1, 0, 0), len, max.y - min.y, depth);
	}
	/** 円柱（側面＋上下） */
	cylinder(key, base, radius, height, seg = 16, caps = true) {
		const up = new THREE.Vector3(0, 1, 0);
		const ring = (y) => Array.from({ length: seg }, (_, i) => {
			const a = i / seg * Math.PI * 2;
			return new THREE.Vector3(base.x + Math.cos(a) * radius, y, base.z + Math.sin(a) * radius);
		});
		const bot = ring(base.y);
		const top = ring(base.y + height);
		let straddles = false;
		if (this.clip) {
			const fs = [...bot, ...top].map((p) => this.cf(p));
			if (Math.min(...fs) >= -1e-6) return;
			straddles = Math.max(...fs) > 1e-6;
		}
		for (let i = 0; i < seg; i++) {
			const j = (i + 1) % seg;
			const a0 = i / seg * Math.PI * 2;
			const a1 = (i + 1) / seg * Math.PI * 2;
			const n0 = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
			const n1 = new THREE.Vector3(Math.cos(a1), 0, Math.sin(a1));
			const u0 = a0 * radius;
			const u1 = a1 * radius;
			const p0 = bot[i];
			const p1 = bot[j];
			const p2 = top[j];
			const p3 = top[i];
			if (this.clip && straddles) {
				const nm = n0.clone().add(n1).normalize();
				this.pushClipped(key, [
					p0,
					p3,
					p2
				], nm, new THREE.Vector3(1, 0, 0), up);
				this.pushClipped(key, [
					p0,
					p2,
					p1
				], nm, new THREE.Vector3(1, 0, 0), up);
			} else {
				const bk = this.bucket(key);
				const push = (p, n, uu, vv) => {
					bk.pos.push(p.x, p.y, p.z);
					bk.nor.push(n.x, n.y, n.z);
					bk.uv.push(uu, vv);
				};
				push(p0, n0, u0, base.y);
				push(p3, n0, u0, base.y + height);
				push(p2, n1, u1, base.y + height);
				push(p0, n0, u0, base.y);
				push(p2, n1, u1, base.y + height);
				push(p1, n1, u1, base.y);
			}
			if (caps) {
				const ct = base.clone().setY(base.y + height);
				this.tri(key, ct, p2, p3, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), up);
				const cb = base.clone();
				this.tri(key, cb, p0, p1, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), up.clone().negate());
			}
		}
		if (straddles) {
			const edges = [];
			for (let i = 0; i < seg; i++) {
				const j = (i + 1) % seg;
				edges.push([i, j], [seg + i, seg + j], [i, seg + i]);
			}
			this.capPolygon([...bot, ...top], edges);
		}
	}
	/** 低ポリゴンの球（植栽・照明用） */
	sphere(key, c, r, seg = 10, sy = 1) {
		const rings = Math.max(4, Math.floor(seg / 2));
		const pt = (i, j) => {
			const th = j / rings * Math.PI;
			const ph = i / seg * Math.PI * 2;
			return new THREE.Vector3(c.x + r * Math.sin(th) * Math.cos(ph), c.y + r * sy * Math.cos(th), c.z + r * Math.sin(th) * Math.sin(ph));
		};
		const ua = new THREE.Vector3(1, 0, 0);
		const va = new THREE.Vector3(0, 1, 0);
		for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
			const a = pt(i, j);
			const b = pt(i + 1, j);
			const cc = pt(i + 1, j + 1);
			const d = pt(i, j + 1);
			if (this.clip) {
				const fs = [
					a,
					b,
					cc,
					d
				].map((p) => this.cf(p));
				if (Math.min(...fs) >= -1e-6) continue;
				if (Math.max(...fs) > 1e-6) {
					const n = a.clone().add(cc).multiplyScalar(.5).sub(c).normalize();
					this.pushClipped(key, [
						a,
						b,
						cc
					], n, ua, va);
					this.pushClipped(key, [
						a,
						cc,
						d
					], n, ua, va);
					continue;
				}
			}
			const bk = this.bucket(key);
			for (const p of [
				a,
				b,
				cc,
				a,
				cc,
				d
			]) {
				const n = p.clone().sub(c).normalize();
				bk.pos.push(p.x, p.y, p.z);
				bk.nor.push(n.x, n.y, n.z);
				bk.uv.push(p.dot(ua), p.dot(va));
			}
		}
	}
	/** 任意のジオメトリを変換して追加（UV はメートル単位で再計算） */
	addGeometry(key, geo, matrix, keepUV = false) {
		const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
		const pos = g.getAttribute("position");
		const nor = g.getAttribute("normal");
		const uvA = g.getAttribute("uv");
		const bk = this.bucket(key);
		const p = new THREE.Vector3();
		const n = new THREE.Vector3();
		if (this.clip) {
			const tri = [
				new THREE.Vector3(),
				new THREE.Vector3(),
				new THREE.Vector3()
			];
			for (let i = 0; i + 2 < pos.count; i += 3) {
				for (let k = 0; k < 3; k++) tri[k].fromBufferAttribute(pos, i + k);
				const fs = tri.map((t) => this.cf(t));
				if (Math.min(...fs) >= -1e-6) continue;
				n.fromBufferAttribute(nor, i);
				const ax = Math.abs(n.x);
				const ay = Math.abs(n.y);
				const az = Math.abs(n.z);
				const [ua, va] = ay >= ax && ay >= az ? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)] : ax >= az ? [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)] : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
				if (Math.max(...fs) > 1e-6) {
					this.pushClipped(key, tri.map((t) => t.clone()), n.clone(), ua, va);
					continue;
				}
				for (const t of tri) {
					bk.pos.push(t.x, t.y, t.z);
					bk.nor.push(n.x, n.y, n.z);
					bk.uv.push(t.dot(ua), t.dot(va));
				}
			}
			g.dispose();
			return;
		}
		for (let i = 0; i < pos.count; i++) {
			p.fromBufferAttribute(pos, i);
			n.fromBufferAttribute(nor, i);
			bk.pos.push(p.x, p.y, p.z);
			bk.nor.push(n.x, n.y, n.z);
			if (keepUV && uvA) {
				bk.uv.push(uvA.getX(i), uvA.getY(i));
				continue;
			}
			const ax = Math.abs(n.x);
			const ay = Math.abs(n.y);
			const az = Math.abs(n.z);
			if (ay >= ax && ay >= az) bk.uv.push(p.x, p.z);
			else if (ax >= az) bk.uv.push(p.z, p.y);
			else bk.uv.push(p.x, p.y);
		}
		g.dispose();
	}
	/** 角の丸い直方体（box と同じ向き・基準: base は底面中心） */
	roundedBox(key, base, dir, len, height, depth, radius, segments = 3) {
		const r = Math.min(radius, len / 2 - .001, height / 2 - .001, depth / 2 - .001);
		if (r <= .002) return this.box(key, base, dir, len, height, depth);
		const geo = new RoundedBoxGeometry(len, height, depth, segments, r);
		const u = dir.clone().setY(0).normalize();
		const up = new THREE.Vector3(0, 1, 0);
		const n = new THREE.Vector3().crossVectors(u, up).normalize();
		const m = new THREE.Matrix4().makeBasis(u, up, n);
		m.setPosition(base.clone().addScaledVector(up, height / 2));
		this.addGeometry(key, geo, m);
		geo.dispose();
	}
	/** 2点間の円柱（幹・枝） */
	tube(key, a, b, r0, r1 = r0, seg = 7) {
		const len = a.distanceTo(b);
		if (len < 1e-4) return;
		const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
		const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
		const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5), q, new THREE.Vector3(1, 1, 1));
		this.addGeometry(key, geo, m);
		geo.dispose();
	}
	/** 葉のカード（アルファ付きテクスチャを貼る両面の板） */
	card(key, c, size, rot) {
		const geo = new THREE.PlaneGeometry(size, size);
		const m = new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromEuler(rot), new THREE.Vector3(1, 1, 1));
		this.addGeometry(key, geo, m, true);
		geo.dispose();
	}
	isEmpty() {
		return this.buckets.size === 0;
	}
	/** Mesh 群を生成。マテリアルはキーから解決（userData.matKey に保存） */
	build(resolve, opts = {}) {
		const g = new THREE.Group();
		g.name = opts.name ?? "built";
		for (const [key, b] of this.buckets) {
			if (!b.pos.length) continue;
			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
			geo.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
			geo.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
			geo.computeBoundingBox();
			geo.computeBoundingSphere();
			const m = new THREE.Mesh(geo, resolve(key));
			m.name = key;
			m.userData.matKey = key;
			m.castShadow = opts.castShadow ?? true;
			m.receiveShadow = opts.receiveShadow ?? true;
			g.add(m);
		}
		return g;
	}
};
function autoAxes(n) {
	if (Math.abs(n.y) > .7) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
	return [new THREE.Vector3(-n.z, 0, n.x).normalize(), new THREE.Vector3(0, 1, 0)];
}
var V = (x, y, z) => new THREE.Vector3(x, y, z);
//#endregion
//#region src/styles/spec.ts
var BUILDER_SPECS = [{
	id: "minimal-lines",
	name: "線の少ない空間（標準）",
	description: "KAMIYA フルハイトドア（ステルス枠・扉厚40mm）、サッシ高さ＝天井高、窓は塗り回し、カーテンボックス、ダウンライト。線を減らした統一感のある空間。",
	doors: {
		fullHeight: true,
		frame: "stealth",
		thickness: 40,
		topGap: 6,
		handle: "slim-lever",
		handleColor: "#2a2a2a"
	},
	windows: {
		headAtCeiling: true,
		interiorReveal: "plaster",
		sillBoard: false
	},
	curtains: "pocket",
	lighting: "downlight",
	indirectLighting: true,
	baseboard: "recessed"
}, {
	id: "standard",
	name: "一般的な仕様（比較用）",
	description: "高さ2mの扉と三方枠、下がり壁、額縁・窓台、カーテンレール、シーリングライト。",
	doors: {
		fullHeight: false,
		frame: "casing",
		thickness: 36,
		topGap: 0,
		handle: "lever",
		handleColor: "#b9b9b9"
	},
	windows: {
		headAtCeiling: false,
		interiorReveal: "trim",
		sillBoard: true
	},
	curtains: "rail",
	lighting: "ceiling",
	indirectLighting: false,
	baseboard: "standard"
}];
/** 仕様を反映した開口部の高さ (mm) */
function effectiveOpening(o, ceilingHeight, spec) {
	if (o.kind === "window") {
		if (!spec.windows.headAtCeiling) return {
			sill: o.sill,
			height: o.height
		};
		if (o.windowStyle === "small" || o.windowStyle === "high") {
			const h = Math.min(o.height, ceilingHeight - 300);
			return {
				sill: ceilingHeight - h,
				height: h
			};
		}
		const sill = Math.min(o.sill, ceilingHeight - 400);
		return {
			sill,
			height: ceilingHeight - sill
		};
	}
	if (o.kind === "entrance") return {
		sill: 0,
		height: Math.max(o.height, spec.doors.fullHeight ? 2400 : o.height)
	};
	if (spec.doors.fullHeight) return {
		sill: 0,
		height: ceilingHeight
	};
	return {
		sill: o.sill,
		height: o.height
	};
}
//#endregion
//#region src/scene/building.ts
/**
* 建物モデル → 3D ジオメトリ
* 単位: m。平面 (x, y[下向き]) → ワールド (X = x, Z = y)、Y が上。
*/
var MM = .001;
/** 建具など別部品の MeshBuilder にも同じ切断面を掛ける */
var partClip = null;
/** 部品の局所座標（原点 origin・Y 軸まわり yaw）に切断面を変換する */
function localClip(origin, yaw) {
	if (!partClip) return null;
	return {
		n: partClip.n.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw),
		d: partClip.d - partClip.n.dot(origin),
		capKey: partClip.capKey
	};
}
var up = new THREE.Vector3(0, 1, 0);
function wallTopOf(model, f, opts) {
	const idx = model.floors.indexOf(f);
	const next = model.floors[idx + 1];
	if (next) return next.elevation;
	return f.elevation + (opts?.topWallHeight ?? 2750);
}
function roomAt(f, x, y) {
	for (const r of f.rooms) if (pointInPolygon({
		x,
		y
	}, r.polygon)) return r;
	return null;
}
/** 上下階の階段（上階の床に穴をあける） */
function stairVoidsFor(model, f) {
	const idx = model.floors.indexOf(f);
	const below = model.floors[idx - 1];
	const out = [];
	if (below) {
		for (const s of below.stairs) if (s.goesUp) out.push(s);
	}
	for (const s of f.stairs) if (!s.goesUp && below && !below.stairs.some((b) => Math.abs(b.minX - s.minX) < 300 && Math.abs(b.minY - s.minY) < 300)) out.push(s);
	for (const r of f.rooms) if (r.type === "void") {
		const xs = r.polygon.map((p) => p.x);
		const ys = r.polygon.map((p) => p.y);
		out.push({
			minX: Math.min(...xs),
			maxX: Math.max(...xs),
			minY: Math.min(...ys),
			maxY: Math.max(...ys)
		});
	}
	return out;
}
/**
* 上下階の外壁の面を揃える（図面の読み取りで芯が数 cm ずれると、外壁に段差の帯ができるため）。
* 上階の外壁が、下階の外壁とほぼ同じ線（面のずれ 18cm 以内・平行・重なりあり）にあれば、外面を下階に合わせて平行移動する。
* その線上にある他の壁の端点も一緒に動かし、開口の位置は壁の始点の移動分だけ補正する。
*/
/**
* 間仕切り壁の端が外壁の中まで食い込み、外壁の外の面のすぐ裏まで来ていると、外から見て細い縦の点線が透ける。
* 外壁に突き当たる間仕切り壁の端は、外壁の芯（壁の中央）で止める
*/
function trimInteriorEnds(model) {
	const floors = model.floors.map((f) => {
		const ext = f.walls.filter((w) => w.exterior);
		const walls = f.walls.map((w) => {
			if (w.exterior) return w;
			const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
			if (L < 1) return w;
			const ux = (w.b.x - w.a.x) / L;
			const uy = (w.b.y - w.a.y) / L;
			let { a, b } = w;
			for (const v of ext) {
				const vl = Math.hypot(v.b.x - v.a.x, v.b.y - v.a.y);
				if (vl < 1) continue;
				const vx = (v.b.x - v.a.x) / vl;
				const vy = (v.b.y - v.a.y) / vl;
				if (Math.abs(ux * vx + uy * vy) > .2) continue;
				const nx = -vy;
				const ny = vx;
				for (const end of ["a", "b"]) {
					const e = end === "a" ? a : b;
					const along = (e.x - v.a.x) * vx + (e.y - v.a.y) * vy;
					if (along < -v.thickness || along > vl + v.thickness) continue;
					const off = (e.x - v.a.x) * nx + (e.y - v.a.y) * ny;
					if (Math.abs(off) > v.thickness / 2 + 5 || Math.abs(off) < 1) continue;
					const dirDot = ux * nx + uy * ny;
					if (Math.abs(dirDot) < .5) continue;
					const back = off / dirDot;
					const p = {
						x: e.x - ux * back,
						y: e.y - uy * back
					};
					if (end === "a") a = p;
					else b = p;
				}
			}
			if (a === w.a && b === w.b) return w;
			return {
				...w,
				a,
				b
			};
		});
		const openings = f.openings.map((o) => {
			const w0 = f.walls.find((x) => x.id === o.wallId);
			const w1 = walls.find((x) => x.id === o.wallId);
			if (!w0 || !w1 || w0 === w1 || w0.a.x === w1.a.x && w0.a.y === w1.a.y) return o;
			const L = Math.hypot(w0.b.x - w0.a.x, w0.b.y - w0.a.y) || 1;
			const d = ((w1.a.x - w0.a.x) * (w0.b.x - w0.a.x) + (w1.a.y - w0.a.y) * (w0.b.y - w0.a.y)) / L;
			return {
				...o,
				t0: o.t0 - d,
				t1: o.t1 - d
			};
		});
		return {
			...f,
			walls,
			openings
		};
	});
	return {
		...model,
		floors
	};
}
function alignUpperWalls(model) {
	const floors = model.floors.map((f) => ({
		...f,
		walls: f.walls.map((w) => ({
			...w,
			a: { ...w.a },
			b: { ...w.b }
		})),
		openings: f.openings.map((o) => ({ ...o })),
		outline: f.outline.map((l) => l.map((p) => ({ ...p })))
	}));
	for (let i = 1; i < floors.length; i++) {
		const up = floors[i];
		const low = floors[i - 1].walls.filter((w) => w.exterior);
		for (const w of up.walls) {
			if (!w.exterior || w.outsideSign == null) continue;
			const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
			if (L < 300) continue;
			const ux = (w.b.x - w.a.x) / L;
			const uy = (w.b.y - w.a.y) / L;
			const nx = -uy * w.outsideSign;
			const ny = ux * w.outsideSign;
			const face = (w.a.x + w.b.x) / 2 * nx + (w.a.y + w.b.y) / 2 * ny + w.thickness / 2;
			let best = null;
			for (const q of low) {
				const ql = Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
				if (ql < 300 || q.outsideSign == null) continue;
				const qx = (q.b.x - q.a.x) / ql;
				const qy = (q.b.y - q.a.y) / ql;
				if (Math.abs(qx * uy - qy * ux) > .02) continue;
				const qnx = -qy * q.outsideSign;
				const qny = qx * q.outsideSign;
				if (qnx * nx + qny * ny < .9) continue;
				const t = (p) => p.x * ux + p.y * uy;
				if (Math.min(Math.max(t(w.a), t(w.b)), Math.max(t(q.a), t(q.b))) - Math.max(Math.min(t(w.a), t(w.b)), Math.min(t(q.a), t(q.b))) < 300) continue;
				const d = (q.a.x + q.b.x) / 2 * nx + (q.a.y + q.b.y) / 2 * ny + q.thickness / 2 - face;
				if (Math.abs(d) < 3 || Math.abs(d) > 180) continue;
				if (best == null || Math.abs(d) < Math.abs(best)) best = d;
			}
			if (best == null) continue;
			const dx = nx * best;
			const dy = ny * best;
			const onLine = (p) => {
				const rx = p.x - w.a.x;
				const ry = p.y - w.a.y;
				const along = rx * ux + ry * uy;
				return Math.abs(rx * -uy + ry * ux) < w.thickness / 2 + 30 && along > -w.thickness && along < L + w.thickness;
			};
			const onFace = (p) => {
				const rx = p.x - w.a.x;
				const ry = p.y - w.a.y;
				const along = rx * ux + ry * uy;
				const off = rx * nx + ry * ny;
				return Math.abs(off - w.thickness / 2) < 40 || Math.abs(off) < 40 ? along > -w.thickness - 50 && along < L + w.thickness + 50 : false;
			};
			for (const loop of up.outline) for (const p of loop) if (onFace(p)) {
				p.x += dx;
				p.y += dy;
			}
			for (const o of up.walls) {
				const moveA = o === w || onLine(o.a);
				const moveB = o === w || onLine(o.b);
				if (!moveA && !moveB) continue;
				if (moveA && o !== w) {
					const ol = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) || 1;
					const shiftT = (dx * (o.b.x - o.a.x) + dy * (o.b.y - o.a.y)) / ol;
					for (const op of up.openings) if (op.wallId === o.id) {
						op.t0 -= shiftT;
						op.t1 -= shiftT;
					}
				}
				if (moveA) {
					o.a.x += dx;
					o.a.y += dy;
				}
				if (moveB) {
					o.b.x += dx;
					o.b.y += dy;
				}
			}
		}
	}
	return {
		...model,
		floors
	};
}
function buildBuilding(model, opts) {
	model = trimInteriorEnds(alignUpperWalls(model));
	const mb = new MeshBuilder();
	const meta = {
		bbox: new THREE.Box3(),
		rooms: [],
		wallTop: [],
		outlines: [],
		topY: 0,
		doorLeaves: [],
		doors: []
	};
	const ext = opts.exterior;
	const spec = opts.spec ?? BUILDER_SPECS[0];
	const cutF = opts.cut ? model.floors.find((f) => f.level === opts.cut.level) : void 0;
	mb.clip = opts.clip ?? (cutF ? topClip(cutF.elevation * .001 + (opts.cut.height ?? 1.35)) : null);
	partClip = mb.clip;
	const entranceWalls = /* @__PURE__ */ new Set();
	const entranceRanges = [];
	for (const f of model.floors) for (const o of f.openings) if (o.kind === "entrance") {
		const w = f.walls.find((w) => w.id === o.wallId);
		if (w) {
			entranceWalls.add(w.id);
			entranceRanges.push({
				a: new THREE.Vector2(w.a.x, w.a.y),
				b: new THREE.Vector2(w.b.x, w.b.y)
			});
		}
	}
	for (const f of model.floors) {
		if (cutF && f.level > cutF.level) continue;
		const isTop = model.floors.indexOf(f) === model.floors.length - 1;
		const fl = f.elevation * MM;
		const top = wallTopOf(model, f, opts) * MM;
		meta.wallTop.push(top);
		meta.outlines.push({
			level: f.level,
			y: fl,
			polys: f.outline.map((l) => l.map((p) => new THREE.Vector2(p.x * MM, p.y * MM)))
		});
		for (const r of f.rooms) {
			const poly = r.polygon.map((p) => new THREE.Vector2(p.x * MM, p.y * MM));
			meta.rooms.push({
				room: r,
				floor: f,
				poly,
				center: V(r.labelPos.x * MM, fl, r.labelPos.y * MM),
				floorY: fl
			});
		}
		const outlineDist = (p) => {
			let d = Infinity;
			for (const l of f.outline) for (let i = 0; i < l.length; i++) {
				const a = l[i];
				const b = l[(i + 1) % l.length];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const L2 = dx * dx + dy * dy || 1;
				const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
				d = Math.min(d, Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u));
			}
			return d;
		};
		const stub = (w) => {
			if (Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) > Math.max(160, w.thickness * 1.6) || !f.outline.length) return false;
			const m = {
				x: (w.a.x + w.b.x) / 2,
				y: (w.a.y + w.b.y) / 2
			};
			return !f.outline.some((l) => pointInPolygon(m, l)) && outlineDist(m) < 200;
		};
		for (const w of f.walls) {
			if (stub(w)) continue;
			const ops = f.openings.filter((o) => o.wallId === w.id).map((o) => ({
				...o,
				...effectiveOpening(o, f.ceilingHeight, spec)
			})).sort((a, b) => a.t0 - b.t0);
			buildWall(mb, f, w, ops, fl, top, !!ext.accent && (ext.accentRule === "upper" && f.level >= 2 || ext.accentRule === "lower" && f.level === 1 || ext.accentRule === "entrance" && w.exterior && isEntranceColumn(w, entranceRanges)) ? "ext.accent" : "ext.wall", isTop, spec);
			for (const o of ops) buildOpening(mb, f, w, o, fl, meta, spec);
		}
		for (const j of diagonalJoints(f.walls.filter((w) => !stub(w)))) {
			const w = j.w;
			const outdoorAt = (x, y) => {
				const r = roomAt(f, x, y);
				return !r || r.type === "balcony" || r.type === "porch";
			};
			const bothOutdoor = w.exterior && [1, -1].every((sg) => outdoorAt(j.p.x + (w.b.y - w.a.y) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * -sg * (w.thickness + 80), j.p.y + (w.b.x - w.a.x) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * sg * (w.thickness + 80)));
			const bottom = w.exterior && f.level === 1 ? bothOutdoor ? -.05 : fl - .1 : fl;
			const wallTop = w.exterior ? top : fl + f.ceilingHeight * MM;
			const key = w.exterior ? ext.accent && (ext.accentRule === "upper" && f.level >= 2 || ext.accentRule === "lower" && f.level === 1) ? "ext.accent" : "ext.wall" : "int.wall";
			mb.cylinder(key, V(j.p.x * MM, bottom, j.p.y * MM), j.t * MM / 2 - .002, wallTop - bottom, 24, false);
		}
		const voids = stairVoidsFor(model, f);
		for (const r of f.rooms) {
			if (r.type === "void") continue;
			const key = floorKeyFor(r);
			const y = fl + (r.type === "entrance" ? -0 : 0);
			emitFlat(mb, key, r.polygon, voids, y, true);
		}
		const holes = f.outline.filter((l) => isHoleLoop(l, f.outline));
		const holeRects = holes.length ? polygonToRects(holes) : [];
		const lower = model.floors[model.floors.indexOf(f) - 1];
		const lowerRects = lower ? polygonToRects(lower.outline.filter((l) => !isHoleLoop(l, lower.outline))) : [];
		for (const poly of f.outline) {
			if (holes.includes(poly)) continue;
			emitSlab(mb, "int.slab", poly, [...voids, ...holeRects], fl - .24, fl - .005, "ext.wall");
			if (lower) emitFlat(mb, "ext.soffit", poly, [
				...voids,
				...holeRects,
				...lowerRects
			], fl - .25, false);
		}
		const upper = model.floors[model.floors.indexOf(f) + 1];
		const ceilVoids = upper ? stairVoidsFor(model, upper) : [];
		for (const r of f.rooms) {
			if (r.type === "void") continue;
			if (r.type === "balcony" || r.type === "porch") {
				if (/庭|COURT/i.test(r.name)) continue;
				emitFlat(mb, "ext.soffit", r.polygon, [], top - (upper ? .25 : .02), false);
				continue;
			}
			emitFlat(mb, "int.ceiling", r.polygon, ceilVoids, fl + f.ceilingHeight * MM, false);
		}
		buildCeilingDetails(mb, f, fl, spec);
		for (const s of f.stairs) {
			if (!s.goesUp || !upper) continue;
			buildStairs(mb, s, fl, upper.elevation * MM, f);
		}
	}
	const f1 = model.floors[0];
	if (f1) {
		for (const w of f1.walls) {
			if (!w.exterior) continue;
			const A = V(w.a.x * MM, 0, w.a.y * MM);
			const B = V(w.b.x * MM, 0, w.b.y * MM);
			const L = A.distanceTo(B);
			if (L < .05) continue;
			const dir = new THREE.Vector3().subVectors(B, A).normalize();
			const c = A.clone().addScaledVector(dir, L / 2).setY(-.06);
			mb.box("ext.foundation", c, dir, L - .03, f1.elevation * MM - .1 + .06, w.thickness * MM - .03);
		}
		for (const j of diagonalJoints(f1.walls, true)) mb.cylinder("ext.foundation", V(j.p.x * MM, -.06, j.p.y * MM), (j.t * MM - .03) / 2 - .001, f1.elevation * MM - .1 + .06, 24, false);
		const extT = Math.max(150, ...f1.walls.filter((w) => w.exterior).map((w) => w.thickness)) * MM;
		for (const poly of f1.outline) {
			const off = offsetPolygon(poly.map((p) => ({
				x: p.x * MM,
				y: p.y * MM
			})), extT / 2 - .012);
			for (let i = 0; i < off.length; i++) {
				const a = off[i];
				const b = off[(i + 1) % off.length];
				const pa = V(a.x, -.05, a.y);
				const pb = V(b.x, -.05, b.y);
				const ta = V(a.x, f1.elevation * MM - .1, a.y);
				const tb = V(b.x, f1.elevation * MM - .1, b.y);
				const n = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x));
				const center = new THREE.Vector3((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
				if (pointInPolygon({
					x: center.x + n.x * .01,
					y: center.z + n.z * .01
				}, off)) mb.quad("ext.foundation", pa, pb, tb, ta);
				else mb.quad("ext.foundation", pb, pa, ta, tb);
			}
			const w2 = offsetPolygon(poly.map((p) => ({
				x: p.x * MM,
				y: p.y * MM
			})), extT / 2 + .01);
			const y = f1.elevation * MM - .1;
			for (let i = 0; i < w2.length; i++) {
				const a = w2[i];
				const b = w2[(i + 1) % w2.length];
				const n = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x));
				const center = new THREE.Vector3((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
				const inside = pointInPolygon({
					x: center.x + n.x * .01,
					y: center.z + n.z * .01
				}, w2);
				const pa = V(a.x, y - .03, a.y);
				const pb = V(b.x, y - .03, b.y);
				const ta = V(a.x, y + .005, a.y);
				const tb = V(b.x, y + .005, b.y);
				if (inside) mb.quad("ext.frame", pa, pb, tb, ta);
				else mb.quad("ext.frame", pb, pa, ta, tb);
			}
		}
	}
	for (const f of model.floors) for (const w of f.walls) {
		meta.bbox.expandByPoint(V(w.a.x * MM, 0, w.a.y * MM));
		meta.bbox.expandByPoint(V(w.b.x * MM, 0, w.b.y * MM));
	}
	meta.topY = Math.max(...meta.wallTop);
	meta.bbox.max.y = meta.topY;
	return {
		mb,
		meta
	};
}
function isEntranceColumn(w, ranges) {
	for (const r of ranges) {
		const d1 = distToLine(w.a, r.a, r.b);
		const d2 = distToLine(w.b, r.a, r.b);
		if (d1 > 120 || d2 > 120) continue;
		const dir = new THREE.Vector2().subVectors(r.b, r.a).normalize();
		const t = (p) => (p.x - r.a.x) * dir.x + (p.y - r.a.y) * dir.y;
		const L = r.a.distanceTo(r.b);
		const w0 = Math.min(t(w.a), t(w.b));
		const w1 = Math.max(t(w.a), t(w.b));
		if (Math.min(w1, L) - Math.max(w0, 0) > 300) return true;
	}
	return false;
}
function distToLine(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const L = Math.hypot(dx, dy) || 1;
	return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
}
function floorKeyFor(r) {
	switch (r.type) {
		case "bath":
		case "washroom":
		case "toilet": return "int.wetFloor";
		case "entrance":
		case "porch":
		case "garage": return "int.entranceFloor";
		case "japanese": return "int.tatami";
		case "balcony": return "ext.balcony";
		default: return "int.floor";
	}
}
/** 水平な面（床・天井）。直交多角形なら穴（階段・吹抜）を矩形で抜く */
function emitFlat(mb, key, polyMm, voidsMm, y, faceUp) {
	const n = faceUp ? up : up.clone().negate();
	const uA = V(1, 0, 0);
	const vA = V(0, 0, 1);
	if (isRectilinear(polyMm, 2)) {
		let rects = polygonToRects([polyMm], 3);
		rects = rectsMinus(rects, voidsMm);
		for (const r of rects) {
			const a = V(r.minX * MM, y, r.minY * MM);
			const b = V(r.maxX * MM, y, r.minY * MM);
			const c = V(r.maxX * MM, y, r.maxY * MM);
			const d = V(r.minX * MM, y, r.maxY * MM);
			if (faceUp) mb.quad(key, a, d, c, b, uA, vA);
			else mb.quad(key, a, b, c, d, uA, vA);
		}
	} else {
		const pts = polyMm.map((p) => V(p.x * MM, y, p.y * MM));
		mb.polygon(key, pts, n, uA, vA);
	}
}
function emitSlab(mb, key, polyMm, voidsMm, y0, y1, edgeKey = key) {
	emitFlat(mb, key, polyMm, voidsMm, y0, false);
	const pts = polyMm.map((p) => ({
		x: p.x * MM,
		y: p.y * MM
	}));
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		const nrm = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x)).normalize();
		const inside = pointInPolygon({
			x: (a.x + b.x) / 2 + nrm.x * .01,
			y: (a.y + b.y) / 2 + nrm.z * .01
		}, pts);
		const pa = V(a.x, y0, a.y);
		const pb = V(b.x, y0, b.y);
		const ta = V(a.x, y1, a.y);
		const tb = V(b.x, y1, b.y);
		if (inside) mb.quad(edgeKey, pa, pb, tb, ta);
		else mb.quad(edgeKey, pb, pa, ta, tb);
	}
}
/**
* 斜めの壁（直交しない壁同士）の継ぎ目。角が直角でないと、矩形の壁同士では外側の角にくさび状の隙間が残るので、
* 壁の軸線の交点に壁厚の丸柱を立てて埋める。戻り値は交点と、その継ぎ目の最大壁厚（mm）。
*/
function diagonalJoints(walls, onlyExterior = false) {
	const out = [];
	const angOf = (w) => Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
	const distToSeg = (p, w) => {
		const dx = w.b.x - w.a.x;
		const dy = w.b.y - w.a.y;
		const L2 = dx * dx + dy * dy || 1;
		const u = Math.max(0, Math.min(1, ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / L2));
		return Math.hypot(p.x - w.a.x - dx * u, p.y - w.a.y - dy * u);
	};
	for (let i = 0; i < walls.length; i++) {
		const w = walls[i];
		if (onlyExterior && !w.exterior) continue;
		for (let j = 0; j < walls.length; j++) {
			if (i === j) continue;
			const v = walls[j];
			if (onlyExterior && !v.exterior) continue;
			let d = Math.abs(angOf(w) - angOf(v)) % (Math.PI / 2);
			d = Math.min(d, Math.PI / 2 - d);
			if (d < 3 * Math.PI / 180) continue;
			for (const e of [w.a, w.b]) {
				if (distToSeg(e, v) > w.thickness + v.thickness) continue;
				const r = {
					x: w.b.x - w.a.x,
					y: w.b.y - w.a.y
				};
				const q = {
					x: v.b.x - v.a.x,
					y: v.b.y - v.a.y
				};
				const den = r.x * q.y - r.y * q.x;
				let p = e;
				if (Math.abs(den) > 1e-6) {
					const tt = ((v.a.x - w.a.x) * q.y - (v.a.y - w.a.y) * q.x) / den;
					const ip = {
						x: w.a.x + r.x * tt,
						y: w.a.y + r.y * tt
					};
					if (Math.hypot(ip.x - e.x, ip.y - e.y) < w.thickness + v.thickness) p = ip;
				}
				const t = Math.max(w.thickness, v.thickness);
				if (out.some((o) => Math.hypot(o.p.x - p.x, o.p.y - p.y) < t)) continue;
				out.push({
					p,
					t,
					w
				});
			}
		}
	}
	return out;
}
/** 壁を開口部で分割して生成 */
function buildWall(mb, f, w, ops, fl, top, extKey, isTop, spec) {
	const A = V(w.a.x * MM, 0, w.a.y * MM);
	const B = V(w.b.x * MM, 0, w.b.y * MM);
	const L = A.distanceTo(B);
	if (L < .02) return;
	const dir = new THREE.Vector3().subVectors(B, A).normalize();
	const t = w.thickness * MM;
	const nPlan = {
		x: -(w.b.y - w.a.y),
		y: w.b.x - w.a.x
	};
	const nl = Math.hypot(nPlan.x, nPlan.y) || 1;
	nPlan.x /= nl;
	nPlan.y /= nl;
	const sideRoom = (sign) => {
		const mid = {
			x: (w.a.x + w.b.x) / 2 + nPlan.x * sign * (w.thickness / 2 + 80),
			y: (w.a.y + w.b.y) / 2 + nPlan.y * sign * (w.thickness / 2 + 80)
		};
		return roomAt(f, mid.x, mid.y);
	};
	const isOutdoor = (r) => !!r && (r.type === "balcony" || r.type === "porch");
	const rPlus = sideRoom(1);
	const rMinus = sideRoom(-1);
	const openPlus = w.exterior && w.outsideSign === 1 || !rPlus || isOutdoor(rPlus);
	const openMinus = w.exterior && w.outsideSign === -1 || !rMinus || isOutdoor(rMinus);
	const parapet = openPlus && openMinus && (rPlus?.type === "balcony" || rMinus?.type === "balcony");
	const facesOutdoor = isOutdoor(rPlus) || isOutdoor(rMinus);
	const sideKey = (sign) => {
		if (w.exterior && w.outsideSign === sign) return extKey;
		const r = sign === 1 ? rPlus : rMinus;
		if (isOutdoor(r) || !r) return extKey;
		if (r?.type === "bath") return "int.bathWall";
		if (r && (r.type === "ldk" || r.type === "living") && !w.exterior && ops.length === 0 && L > 2.2) return "int.accent";
		return "int.wall";
	};
	const kPlus = sideKey(1);
	const kMinus = sideKey(-1);
	const bothOutdoor = (!rPlus || isOutdoor(rPlus)) && (!rMinus || isOutdoor(rMinus));
	const bottom = w.exterior && f.level === 1 ? bothOutdoor ? -.05 : fl - .1 : fl;
	const wallTop = parapet ? Math.min(top, fl + 1.1) : w.exterior || facesOutdoor ? top : fl + f.ceilingHeight * MM;
	const topKey = w.exterior || facesOutdoor ? "ext.wallTop" : "int.wallTop";
	const jambKey = w.exterior ? spec.windows.interiorReveal === "plaster" ? "int.wall" : "int.trim" : spec.doors.frame === "casing" ? "int.trim" : "int.wall";
	const seg = (s0, s1, y0, y1, startCap, endCap) => {
		if (s1 - s0 < .005 || y1 - y0 < .005) return;
		const base = A.clone().addScaledVector(dir, (s0 + s1) / 2).setY(y0);
		mb.box([
			kPlus,
			kMinus,
			topKey,
			spec.windows.interiorReveal === "plaster" ? "int.wall" : "int.wallTop",
			startCap,
			endCap
		], base, dir, s1 - s0, y1 - y0, t);
	};
	let cursor = 0;
	const firstCap = w.joinedA ? null : jambKey;
	for (let i = 0; i < ops.length; i++) {
		const o = ops[i];
		const s0 = Math.max(0, o.t0 * MM);
		const s1 = Math.min(L, o.t1 * MM);
		seg(cursor, s0, bottom, wallTop, cursor === 0 ? firstCap : jambKey, jambKey);
		const sill = fl + o.sill * MM;
		const head = Math.min(wallTop, fl + (o.sill + o.height) * MM);
		if (o.sill > 0) seg(s0, s1, bottom, sill, null, null);
		if (head < wallTop - .005) seg(s0, s1, head, wallTop, null, null);
		cursor = s1;
	}
	seg(cursor, L, bottom, wallTop, ops.length === 0 ? firstCap : jambKey, w.joinedB ? null : jambKey);
}
function buildOpening(mb, f, w, o, fl, meta, spec) {
	const A = V(w.a.x * MM, 0, w.a.y * MM);
	const B = V(w.b.x * MM, 0, w.b.y * MM);
	const dir = new THREE.Vector3().subVectors(B, A).normalize();
	const nW = new THREE.Vector3(-dir.z, 0, dir.x);
	const t = w.thickness * MM;
	const s0 = o.t0 * MM;
	const s1 = o.t1 * MM;
	const width = s1 - s0;
	const mid = A.clone().addScaledVector(dir, (s0 + s1) / 2);
	const sill = fl + o.sill * MM;
	const head = fl + (o.sill + o.height) * MM;
	const H = head - sill;
	let outSign = w.exterior ? w.outsideSign ?? 1 : 1;
	if (w.exterior && f.outline.length) {
		const probe = (sg) => {
			const q = mid.clone().addScaledVector(nW, sg * (t / 2 + .35));
			return f.outline.some((l) => pointInPolygon({
				x: q.x / MM,
				y: q.z / MM
			}, l));
		};
		const plusIn = probe(1);
		if (plusIn !== probe(-1)) outSign = plusIn ? -1 : 1;
	}
	const outN = nW.clone().multiplyScalar(outSign);
	if (o.kind === "window") {
		const plane = mid.clone().addScaledVector(outN, t / 2 - .05);
		const fw = .03;
		const fd = .07;
		const frame = "ext.frame";
		mb.box(frame, plane.clone().setY(sill), dir, width, fw, fd);
		mb.box(frame, plane.clone().setY(head - fw), dir, width, fw, fd);
		mb.box(frame, plane.clone().addScaledVector(dir, -width / 2 + fw / 2).setY(sill), dir, fw, H, fd);
		mb.box(frame, plane.clone().addScaledVector(dir, width / 2 - fw / 2).setY(sill), dir, fw, H, fd);
		const glassKey = o.windowStyle === "small" ? "ext.glassFrosted" : "ext.glass";
		const innerW = width - fw * 2;
		const innerH = H - fw * 2;
		const y0 = sill + fw;
		const mull = .03;
		const cells = [];
		if (H < .7 || o.windowStyle === "high") cells.push({
			w: innerW,
			vent: "top"
		});
		else if (innerW <= .75) cells.push({
			w: innerW,
			vent: "side"
		});
		else {
			const ventW = Math.min(.5, innerW * .35);
			const fixW = innerW - ventW - mull;
			const nFix = Math.max(1, Math.ceil(fixW / 1.8));
			const fw1 = (fixW - mull * (nFix - 1)) / nFix;
			for (let k = 0; k < nFix; k++) cells.push({
				w: fw1,
				vent: "none"
			});
			if (o.hingeAtStart === false) cells.push({
				w: ventW,
				vent: "side"
			});
			else cells.unshift({
				w: ventW,
				vent: "side"
			});
		}
		let u = -innerW / 2;
		cells.forEach((cell, k) => {
			if (k > 0) {
				mb.box(frame, plane.clone().addScaledVector(dir, u + mull / 2).setY(y0), dir, mull, innerH, fd * .8);
				u += mull;
			}
			const c = plane.clone().addScaledVector(dir, u + cell.w / 2);
			let gx0 = -cell.w / 2;
			let gx1 = cell.w / 2;
			let gy0 = y0;
			let gy1 = y0 + innerH;
			if (cell.vent !== "none") {
				const sw = .028;
				mb.box(frame, c.clone().setY(y0), dir, cell.w, sw, .03);
				mb.box(frame, c.clone().setY(y0 + innerH - sw), dir, cell.w, sw, .03);
				mb.box(frame, c.clone().addScaledVector(dir, -cell.w / 2 + sw / 2).setY(y0), dir, sw, innerH, .03);
				mb.box(frame, c.clone().addScaledVector(dir, cell.w / 2 - sw / 2).setY(y0), dir, sw, innerH, .03);
				gx0 += sw;
				gx1 -= sw;
				gy0 += sw;
				gy1 -= sw;
			}
			const g0 = c.clone().addScaledVector(dir, gx0).setY(gy0);
			const g1 = c.clone().addScaledVector(dir, gx1).setY(gy0);
			const g2 = g1.clone().setY(gy1);
			const g3 = g0.clone().setY(gy1);
			mb.quad(glassKey, g0, g1, g2, g3);
			mb.quad(glassKey, g1, g0, g3, g2);
			u += cell.w;
		});
		mb.box(frame, mid.clone().addScaledVector(outN, t / 2 + .01).setY(sill - .02), dir, width + .04, .02, .05);
		if (o.sill > 0 && spec.windows.sillBoard) mb.box("int.trim", mid.clone().addScaledVector(outN, -t / 2 + .01).setY(sill - .02), dir, width + .06, .02, .06);
		const inRoom = roomAt(f, (mid.x - outN.x * (t / 2 + .2)) / MM, (mid.z - outN.z * (t / 2 + .2)) / MM);
		if (spec.curtains !== "none" && inRoom && [
			"ldk",
			"living",
			"dining",
			"bedroom",
			"kids",
			"study"
		].includes(inRoom.type) && width > .7) {
			const ceil = fl + f.ceilingHeight * MM;
			const inner = mid.clone().addScaledVector(outN, -t / 2 - .12);
			const fitsAt = (u) => {
				const q = inner.clone().addScaledVector(dir, u);
				return f.outline.some((l) => pointInPolygon({
					x: q.x / .001,
					y: q.z / .001
				}, l)) && !!roomAt(f, q.x / .001, q.z / .001);
			};
			if (spec.curtains === "pocket") {
				const pocket = inner.clone().setY(ceil - .004);
				const pL = fitsAt(-(width / 2 + .36)) ? .35 : 0;
				const pR = fitsAt(width / 2 + .36) ? .35 : 0;
				mb.box("int.shadowGap", pocket.clone().addScaledVector(dir, (pR - pL) / 2), dir, width + pL + pR, .004, .16);
				for (const side of [-1, 1]) {
					const bundle = .34;
					const outside = fitsAt(side * (width / 2 + .03 + bundle + .04));
					const u0 = outside ? side * (width / 2 + .03) : side * (width / 2 - .04 - bundle);
					const uStart = side > 0 || !outside ? Math.min(u0, u0 + side * bundle) : u0 - bundle;
					curtainWave(mb, inner.clone().addScaledVector(dir, Math.min(uStart, uStart + bundle)), dir, outN, bundle, fl + .015, ceil - .012);
				}
				return;
			}
			const cy = fl + Math.min(2.35, (o.sill + o.height) * MM + .1);
			for (const side of [-1, 1]) {
				const c = inner.clone().addScaledVector(dir, fitsAt(side * (width / 2 + .2)) ? side * (width / 2 + .05) : side * (width / 2 - .15));
				mb.box("f.curtain", c.setY(fl + (o.sill > 0 ? o.sill * MM - .1 : .01)), dir, .28, cy - (fl + (o.sill > 0 ? o.sill * MM - .1 : .01)), .1);
			}
			const extL = fitsAt(-(width / 2 + .26)) ? .25 : 0;
			const extR = fitsAt(width / 2 + .26) ? .25 : 0;
			mb.box("f.metal", inner.clone().addScaledVector(dir, (extR - extL) / 2).setY(cy), dir, width + extL + extR, .025, .025);
		}
		return;
	}
	if (o.kind === "entrance") {
		const plane = mid.clone().addScaledVector(outN, t / 2 - .06);
		const fw = .05;
		mb.box("ext.frame", plane.clone().setY(head - fw), dir, width, fw, .08);
		mb.box("ext.frame", plane.clone().addScaledVector(dir, -width / 2 + fw / 2).setY(sill), dir, fw, H, .08);
		mb.box("ext.frame", plane.clone().addScaledVector(dir, width / 2 - fw / 2).setY(sill), dir, fw, H, .08);
		const dw = width - fw * 2;
		const hingeStart = o.hingeAtStart !== false;
		const closedDir = dir.clone().multiplyScalar(hingeStart ? 1 : -1);
		const hinge = plane.clone().addScaledVector(dir, hingeStart ? -dw / 2 : dw / 2).setY(0);
		const dmb = new MeshBuilder();
		dmb.clip = localClip(hinge, Math.atan2(-closedDir.z, closedDir.x));
		dmb.box("ext.door", V(dw / 2, sill, 0), V(1, 0, 0), dw, H - fw, .045);
		const zOut = outN.dot(nW);
		dmb.box("f.metal", V(dw - .12, sill + .75, zOut * .05), V(1, 0, 0), .02, .8, .02);
		dmb.box("ext.glassFrosted", V(.12, sill + .3, zOut * .024), V(1, 0, 0), .08, H - .6, .004);
		const inward = outN.clone().negate();
		meta.doors.push({
			id: o.id,
			kind: "swing",
			level: f.level,
			origin: hinge,
			yaw0: Math.atan2(-closedDir.z, closedDir.x),
			openAngle: Math.atan2(closedDir.z * inward.x - closedDir.x * inward.z, closedDir.dot(inward)),
			slideDir: new THREE.Vector3(),
			slideDist: 0,
			staticOpen: 0,
			mb: dmb,
			width: dw
		});
		const porchW = Math.max(1.6, width + .8);
		const porchD = 1.3;
		const pc = mid.clone().addScaledVector(outN, t / 2 + porchD / 2);
		mb.box("l.porch", pc.clone().setY(0), dir, porchW, fl - .02, porchD);
		const step = mid.clone().addScaledVector(outN, t / 2 + porchD + .2);
		mb.box("l.porch", step.clone().setY(0), dir, porchW, (fl - .02) / 2, .4);
		const canopy = mid.clone().addScaledVector(outN, t / 2 + .5);
		mb.box("ext.canopy", canopy.setY(head + .25), dir, porchW, .06, 1);
		if (!meta.entrance || f.level < meta.entrance.level) meta.entrance = {
			pos: mid.clone().setY(fl),
			outward: outN.clone(),
			width,
			level: f.level,
			openingId: o.id
		};
		return;
	}
	const trim = "int.trim";
	const cw = .03;
	const doorT = spec.doors.thickness * MM;
	const topGap = spec.doors.topGap * MM;
	if (spec.doors.frame === "casing") {
		mb.box(trim, mid.clone().setY(head), dir, width + cw * 2, cw, t + .012);
		mb.box(trim, mid.clone().addScaledVector(dir, -width / 2 - cw / 2).setY(fl), dir, cw, H + cw, t + .012);
		mb.box(trim, mid.clone().addScaledVector(dir, width / 2 + cw / 2).setY(fl), dir, cw, H + cw, t + .012);
	} else if (spec.doors.frame === "inset") {
		const iw = .012;
		mb.box("int.door", mid.clone().addScaledVector(dir, -width / 2 + iw / 2).setY(fl), dir, iw, H, t * .6);
		mb.box("int.door", mid.clone().addScaledVector(dir, width / 2 - iw / 2).setY(fl), dir, iw, H, t * .6);
	}
	const handle = (mbx, base, along, nrm) => {
		if (spec.doors.handle === "slim-lever") for (const sgn of [1, -1]) {
			const p = base.clone().addScaledVector(nrm, sgn * (doorT / 2 + .028));
			mbx.box("f.handle", p.clone().addScaledVector(along, .055), along, .13, .012, .012);
			mbx.box("f.handle", p.clone().addScaledVector(nrm, -sgn * .014).addScaledVector(along, 0), along, .012, .012, .028);
		}
		else {
			mbx.box("f.metal", base.clone().addScaledVector(nrm, doorT / 2 + .02), along, .12, .02, .02);
			mbx.box("f.metal", base.clone().addScaledVector(nrm, -doorT / 2 - .02), along, .12, .02, .02);
		}
	};
	const glassEntry = (() => {
		if (w.exterior) return false;
		const side = (sg) => roomAt(f, (mid.x + nW.x * sg * (t / 2 + .3)) / MM, (mid.z + nW.z * sg * (t / 2 + .3)) / MM);
		const a = side(1)?.type;
		const b = side(-1)?.type;
		const ldk = (x) => x === "ldk" || x === "living" || x === "dining";
		const pass = (x) => x === "hall" || x === "entrance" || x === "stairs";
		return ldk(a) && pass(b) || ldk(b) && pass(a);
	})();
	/** 扉の板: 通常は壁になじむフラット扉、LDK の入口は框（30mm の黒）＋ガラス */
	const leaf = (m, center, len, hgt, th) => {
		if (!glassEntry) {
			m.box("int.door", center, V(1, 0, 0), len, hgt, th);
			return;
		}
		const fwid = .03;
		const fk = "ext.frame";
		m.box(fk, center.clone().add(V(-len / 2 + fwid / 2, 0, 0)), V(1, 0, 0), fwid, hgt, th);
		m.box(fk, center.clone().add(V(len / 2 - fwid / 2, 0, 0)), V(1, 0, 0), fwid, hgt, th);
		m.box(fk, center.clone(), V(1, 0, 0), len - fwid * 2, fwid * 2, th);
		m.box(fk, center.clone().add(V(0, hgt - fwid, 0)), V(1, 0, 0), len - fwid * 2, fwid, th);
		m.box("ext.glass", center.clone().add(V(0, fwid * 2, 0)), V(1, 0, 0), len - fwid * 2, hgt - fwid * 3, .006);
	};
	if (o.kind === "door") {
		const hingeS = o.hingeAtStart !== false ? s0 : s1;
		const towards = o.hingeAtStart !== false ? 1 : -1;
		let side = w.exterior && w.outsideSign ? -w.outsideSign : o.swingSide ?? 1;
		const lw0 = width - .008;
		const tipInside = (sd) => {
			const hg = A.clone().addScaledVector(dir, hingeS).addScaledVector(nW, sd * (t / 2));
			const ld = dir.clone().multiplyScalar(towards * Math.cos(1.396)).addScaledVector(nW, sd * Math.sin(1.396)).normalize();
			const tip = hg.addScaledVector(ld, lw0);
			return f.outline.some((l) => pointInPolygon({
				x: tip.x / MM,
				y: tip.z / MM
			}, l));
		};
		let ang = 80 * Math.PI / 180;
		if (!tipInside(side)) {
			if (!w.exterior && tipInside(-side)) side = -side;
			else ang = 0;
		}
		const hinge = A.clone().addScaledVector(dir, hingeS).addScaledVector(nW, side * (t / 2));
		const leafDir = dir.clone().multiplyScalar(towards * Math.cos(ang)).addScaledVector(nW, side * Math.sin(ang)).normalize();
		const lw = width - .008;
		meta.doorLeaves.push({
			a: hinge.clone().setY(fl),
			b: hinge.clone().addScaledVector(leafDir, lw).setY(fl)
		});
		const closedDir = dir.clone().multiplyScalar(towards);
		const fullOpen = dir.clone().multiplyScalar(towards * Math.cos(1.396)).addScaledVector(nW, side * Math.sin(1.396)).normalize();
		const dmb = new MeshBuilder();
		dmb.clip = localClip(hinge.clone().setY(0), Math.atan2(-closedDir.z, closedDir.x));
		leaf(dmb, V(lw / 2, fl + .008, 0), lw, H - .008 - topGap, doorT);
		handle(dmb, V(lw - .075, fl + 1, 0), V(-1, 0, 0), V(0, 0, 1));
		meta.doors.push({
			id: o.id,
			kind: "swing",
			level: f.level,
			origin: hinge.clone().setY(0),
			yaw0: Math.atan2(-closedDir.z, closedDir.x),
			openAngle: Math.atan2(closedDir.z * fullOpen.x - closedDir.x * fullOpen.z, closedDir.dot(fullOpen)),
			slideDir: new THREE.Vector3(),
			slideDist: 0,
			staticOpen: ang > 0 ? ang / 1.396 : 0,
			mb: dmb,
			width: lw
		});
	} else if (o.kind === "sliding") {
		const Lw = A.distanceTo(B);
		const others = f.openings.filter((q) => q.wallId === w.id && q.id !== o.id);
		const lw = width - .01;
		const avail = (sd) => {
			let lim = sd > 0 ? Lw - .05 - s1 : s0 - .05;
			for (const q of others) {
				const q0 = q.t0 * MM;
				const q1 = q.t1 * MM;
				if (sd > 0 && q0 > s1 - .02) lim = Math.min(lim, q0 - .02 - s1);
				if (sd < 0 && q1 < s0 + .02) lim = Math.min(lim, s0 - (q1 + .02));
			}
			return Math.max(0, lim);
		};
		const insideAt = (sd, fc, dist) => {
			const tt = sd > 0 ? s1 + dist : s0 - dist;
			const p = A.clone().addScaledVector(dir, tt).addScaledVector(nW, fc * (t / 2 + .06));
			return !f.outline.length || f.outline.some((l) => pointInPolygon({
				x: p.x / .001,
				y: p.z / .001
			}, l));
		};
		let pick = null;
		for (const sd of [1, -1]) for (const fc of [1, -1]) {
			const dist = Math.min(width * .92, avail(sd));
			if (dist < .3 || !insideAt(sd, fc, dist * .5) || !insideAt(sd, fc, dist)) continue;
			if (!pick || dist > pick.dist) pick = {
				sd,
				fc,
				dist
			};
		}
		const fc = pick?.fc ?? 1;
		const face = mid.clone().addScaledVector(nW, fc * (t / 2 + .025));
		const slideDir = dir.clone().multiplyScalar(pick?.sd ?? 1);
		const slideDist = pick?.dist ?? 0;
		const staticOpen = pick && slideDist >= width * .4 ? .6 : 0;
		const dmb = new MeshBuilder();
		dmb.clip = localClip(face.clone().setY(0), Math.atan2(-dir.z, dir.x));
		leaf(dmb, V(0, fl + .008, 0), lw, H - .008 - topGap, doorT * .9);
		dmb.box("f.handle", V(-(pick?.sd ?? 1) * (lw / 2 - .05), fl + .85, fc * (doorT * .45 + .001)), V(1, 0, 0), .012, .35, .002);
		meta.doors.push({
			id: o.id,
			kind: "slide",
			level: f.level,
			origin: face.clone().setY(0),
			yaw0: Math.atan2(-dir.z, dir.x),
			openAngle: 0,
			slideDir,
			slideDist,
			staticOpen,
			mb: dmb,
			width: lw
		});
		const cs = face.clone().addScaledVector(slideDir, slideDist * staticOpen).setY(fl);
		meta.doorLeaves.push({
			a: cs.clone().addScaledVector(dir, -lw / 2),
			b: cs.clone().addScaledVector(dir, lw / 2)
		});
		if (!spec.doors.fullHeight) mb.box(trim, face.clone().setY(head + cw), dir, width * 2, .04, .03);
	}
}
/**
* 波打つ薄い布（カーテン）: 壁に沿う方向 dir に長さ len、正弦波（振幅 3.5cm・周期 11cm）で前後にうねる面を、両面で作る
*/
function curtainWave(mb, start, dir, outN, len, y0, y1) {
	const period = .11;
	const amp = .035;
	const n = Math.max(4, Math.round(len / period * 6));
	const pts = [];
	for (let i = 0; i <= n; i++) {
		const u = len * i / n;
		const w = Math.sin(u / period * Math.PI * 2) * amp;
		pts.push(start.clone().addScaledVector(dir, u).addScaledVector(outN, w));
	}
	for (let i = 0; i < n; i++) {
		const a = pts[i].clone().setY(y0);
		const b = pts[i + 1].clone().setY(y0);
		const c = pts[i + 1].clone().setY(y1);
		const d = pts[i].clone().setY(y1);
		mb.quad("f.curtain", a, b, c, d, dir, V(0, 1, 0));
		mb.quad("f.curtain", b, a, d, c, dir, V(0, 1, 0));
	}
}
/** 天井のダウンライト・間接照明 */
function buildCeilingDetails(mb, f, fl, spec) {
	const ceil = fl + f.ceilingHeight * MM;
	for (const r of f.rooms) {
		if ([
			"closet",
			"storage",
			"void",
			"balcony",
			"porch",
			"stairs"
		].includes(r.type)) continue;
		const xs = r.polygon.map((p) => p.x * MM);
		const zs = r.polygon.map((p) => p.y * MM);
		const x0 = Math.min(...xs);
		const x1 = Math.max(...xs);
		const z0 = Math.min(...zs);
		const z1 = Math.max(...zs);
		if (spec.lighting === "downlight") {
			const lamp = (x, z, rr) => {
				if (!pointInPolygon({
					x: x / .001,
					y: z / .001
				}, r.polygon)) return;
				mb.cylinder("f.downlightRing", V(x, ceil - .004, z), rr + .008, .003, 20);
				mb.cylinder("f.downlight", V(x, ceil - .006, z), rr, .003, 20);
			};
			const W = x1 - x0;
			const Dp = z1 - z0;
			if ([
				"bath",
				"toilet",
				"washroom",
				"closet",
				"storage",
				"hall",
				"entrance",
				"corridor"
			].includes(r.type) || W * Dp < 7) lamp((x0 + x1) / 2, (z0 + z1) / 2, .04);
			else {
				const alongX = W >= Dp;
				const L = alongX ? W : Dp;
				const S = alongX ? Dp : W;
				const nL = Math.max(1, Math.round((L - 1) / 2.7));
				const nS = S >= 4.6 ? 2 : 1;
				for (let i = 0; i < nL; i++) for (let j = 0; j < nS; j++) {
					const cL = nL === 1 ? L / 2 : .9 + (L - 1.8) * i / (nL - 1);
					const cS = nS === 1 ? S / 2 : .9 + (S - 1.8) * j / (nS - 1);
					for (const k of [
						-1,
						0,
						1
					]) {
						const a = cL + k * .3;
						lamp(alongX ? x0 + a : x0 + cS, alongX ? z0 + cS : z0 + a, .0375);
					}
				}
			}
		} else if (!["bath", "toilet"].includes(r.type)) mb.cylinder("f.lampShade", V((x0 + x1) / 2, ceil - .08, (z0 + z1) / 2), .28, .08, 28);
		if (spec.indirectLighting && [
			"ldk",
			"living",
			"bedroom"
		].includes(r.type)) {
			let best = null;
			for (let i = 0; i < r.polygon.length; i++) {
				const p = r.polygon[i];
				const q = r.polygon[(i + 1) % r.polygon.length];
				const len = Math.hypot(q.x - p.x, q.y - p.y) * MM;
				if (len < 2.4) continue;
				if (f.openings.some((o) => {
					if (o.kind !== "window") return false;
					const w = f.walls.find((w) => w.id === o.wallId);
					if (!w) return false;
					const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
					const tm = (o.t0 + o.t1) / 2 / L;
					const c = {
						x: w.a.x + (w.b.x - w.a.x) * tm,
						y: w.a.y + (w.b.y - w.a.y) * tm
					};
					const dx = q.x - p.x;
					const dy = q.y - p.y;
					const t = Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / (dx * dx + dy * dy)));
					return Math.hypot(p.x + dx * t - c.x, p.y + dy * t - c.y) < 300;
				})) continue;
				if (!best || len > best.len) best = {
					a: V(p.x * MM, 0, p.y * MM),
					b: V(q.x * MM, 0, q.y * MM),
					len
				};
			}
			if (best) {
				const d = best.b.clone().sub(best.a).normalize();
				const n = new THREE.Vector3(-d.z, 0, d.x);
				const mid = best.a.clone().add(best.b).multiplyScalar(.5);
				const inside = pointInPolygon({
					x: (mid.x + n.x * .3) / .001,
					y: (mid.z + n.z * .3) / .001
				}, r.polygon) ? 1 : -1;
				const c = mid.clone().addScaledVector(n, inside * .16);
				mb.box("int.shadowGap", c.clone().setY(ceil - .005), d, best.len - .3, .005, .14);
				mb.box("f.cove", c.clone().addScaledVector(n, -inside * .03).setY(ceil - .012), d, best.len - .4, .006, .03);
			}
		}
	}
}
/** 階段（直・折り返し） */
function buildStairs(mb, s, y0, y1, f) {
	const rise = y1 - y0;
	const n = stairStepCount(rise / MM, s);
	const rh = rise / n;
	const tread = "int.stairs";
	const put = (p, yTop) => {
		const min = V(p.minX * MM, yTop - .04, p.minY * MM);
		const max = V(p.maxX * MM, yTop, p.maxY * MM);
		if (max.x - min.x < .01 || max.z - min.z < .01) return;
		mb.aabb(tread, min, max);
		const longX = max.x - min.x >= max.z - min.z;
		const plateT = .012;
		const ph = Math.min(.08, rh * .5);
		if (longX) for (const x of [min.x + .03, max.x - .03 - plateT]) mb.aabb("ext.frame", V(x, yTop - .04 - ph, min.z + .02), V(x + plateT, yTop - .04, max.z - .02));
		else for (const z of [min.z + .03, max.z - .03 - plateT]) mb.aabb("ext.frame", V(min.x + .02, yTop - .04 - ph, z), V(max.x - .02, yTop - .04, z + plateT));
	};
	const lay = stairLayout(s, n);
	for (const p of lay.pieces) put(p, y0 + rh * p.i);
	if (lay.wall) mb.aabb("int.wall", V(lay.wall.minX * MM, y0, lay.wall.minY * MM), V(lay.wall.maxX * MM, y0 + rise * .5 + .9, lay.wall.maxY * MM));
	steelStairDetails(mb, lay, rh, y0, f);
}
/**
* 鉄骨階段の表現: 直線の区間ごとに中央のささら桁（黒皮鉄の鋼板）を勾配なりに通し、
* 壁の無い側にフラットバーの支柱と丸パイプの手すりを付ける（ホームランディックの標準）。
*/
function steelStairDetails(mb, lay, rh, y0, f) {
	const center = (p) => V((p.minX + p.maxX) / 2 * MM, 0, (p.minY + p.maxY) / 2 * MM);
	const runs = [];
	for (const p of lay.pieces) {
		if (p.kind !== "tread") {
			runs.push([]);
			continue;
		}
		const last = runs[runs.length - 1];
		if (last && last.length && last[0].dir.x === p.dir.x && last[0].dir.y === p.dir.y) last.push(p);
		else runs.push([p]);
	}
	const metal = "f.metal";
	for (const run of runs.filter((r) => r.length >= 2)) {
		const a = run[0];
		const b = run[run.length - 1];
		const d = V(a.dir.x, 0, a.dir.y).normalize();
		const perp = V(-d.z, 0, d.x);
		const ca = center(a).setY(y0 + rh * a.i - .04);
		const cb = center(b).setY(y0 + rh * b.i - .04);
		const treadD = Math.abs(V(b.maxX - b.minX, 0, b.maxY - b.minY).dot(d)) * MM;
		const treadW = Math.abs(V(b.maxX - b.minX, 0, b.maxY - b.minY).dot(perp)) * MM;
		const x = cb.clone().sub(ca);
		const len = x.length() + treadD;
		x.normalize();
		const z = perp.clone();
		const y = new THREE.Vector3().crossVectors(z, x).normalize();
		const geo = new THREE.BoxGeometry(len, .2, .012);
		const m = new THREE.Matrix4().makeBasis(x, y, z);
		m.setPosition(ca.clone().add(cb).multiplyScalar(.5).addScaledVector(y, -.12));
		mb.addGeometry(metal, geo, m);
		geo.dispose();
		for (const sg of [1, -1]) {
			let open = false;
			if (f) {
				const q = center(run[Math.floor(run.length / 2)]).clone().addScaledVector(perp, sg * (treadW / 2 + .3));
				const r = roomAt(f, q.x / MM, q.z / MM);
				open = !!r && r.type !== "stairs" && r.type !== "closet" && r.type !== "storage";
			}
			if (!open) continue;
			const posts = [];
			run.forEach((p, k) => {
				if (k % 2 && k !== run.length - 1) return;
				const base = center(p).setY(y0 + rh * p.i).addScaledVector(perp, sg * (treadW / 2 - .05));
				mb.box(metal, base.clone(), d, .04, .9, .012);
				posts.push(base.clone().setY(base.y + .9));
			});
			for (let k = 0; k + 1 < posts.length; k++) mb.tube(metal, posts[k], posts[k + 1], .016, .016, 10);
		}
	}
}
//#endregion
//#region src/scene/furniture.ts
var currentOcc = null;
var currentPlan = null;
var currentModels = [];
var currentRoomId = "";
/** 平面図に描かない部材（照明・小物・水栓など） */
var PLAN_SKIP = /* @__PURE__ */ new Set([
	"f.lamp",
	"f.lampShade",
	"f.leaf",
	"f.chrome",
	"f.screen",
	"f.hood",
	"f.white",
	"f.metal"
]);
var Frame = class {
	mb;
	origin;
	along;
	inward;
	constructor(mb, origin, along, inward) {
		this.mb = mb;
		this.origin = origin;
		this.along = along;
		this.inward = inward;
	}
	/** u: 中心位置（壁に沿う）, v: 壁からの距離, w: 幅, d: 奥行, y0: 下端, h: 高さ */
	box(key, u, v, w, d, y0, h) {
		const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v + d / 2);
		c.y = this.origin.y + y0;
		const soft = key === "f.fabric" || key === "f.fabric2" || key === "f.bedding";
		const minDim = Math.min(w, d, h);
		if (soft && minDim > .03) this.mb.roundedBox(key, c, this.along, w, h, d, Math.min(.06, minDim * .3), 3);
		else if ((key === "f.wood" || key === "f.counter" || key === "f.cabinet") && minDim > .02) this.mb.roundedBox(key, c, this.along, w, h, d, Math.min(.006, minDim * .25), 1);
		else this.mb.box(key, c, this.along, w, h, d);
		if (currentPlan && !PLAN_SKIP.has(key) && w >= .12 && d >= .12 && y0 < 1.2) currentPlan.push({
			key,
			shape: "box",
			cx: c.x,
			cz: c.z,
			w,
			d,
			ax: this.along.x,
			az: this.along.z,
			r: 0,
			top: y0 + h,
			roomId: currentRoomId
		});
		if (currentOcc && y0 + h > .3 && key !== "f.rug") {
			const ex = Math.abs(this.along.x) * w / 2 + Math.abs(this.inward.x) * d / 2;
			const ez = Math.abs(this.along.z) * w / 2 + Math.abs(this.inward.z) * d / 2;
			currentOcc.push({
				minX: c.x - ex,
				maxX: c.x + ex,
				minZ: c.z - ez,
				maxZ: c.z + ez,
				maxY: y0 + h
			});
		}
	}
	cyl(key, u, v, r, y0, h, seg = 16) {
		const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v);
		if (currentPlan && !PLAN_SKIP.has(key) && r >= .1 && y0 < 1.2) currentPlan.push({
			key,
			shape: "circle",
			cx: c.x,
			cz: c.z,
			w: 0,
			d: 0,
			ax: 1,
			az: 0,
			r,
			top: y0 + h,
			roomId: currentRoomId
		});
		c.y = this.origin.y + y0;
		this.mb.cylinder(key, c, r, h, seg);
	}
	sphere(key, u, v, y, r, sy = 1) {
		const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v);
		c.y = this.origin.y + y;
		this.mb.sphere(key, c, r, 10, sy);
	}
	point(u, v, y) {
		const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v);
		c.y = this.origin.y + y;
		return c;
	}
};
/** この階に置いた家具（手修正の初期値・平面図に使う） */
var currentItems = null;
var itemSeq = 0;
var DEG = 180 / Math.PI;
function sideFrame(ctx, s, R = ctx.R) {
	const { mb, y } = ctx;
	const cx = (R.minX + R.maxX) / 2;
	const cz = (R.minZ + R.maxZ) / 2;
	switch (s) {
		case "n": return {
			f: new Frame(mb, V(cx, y, R.minZ), V(1, 0, 0), V(0, 0, 1)),
			len: R.maxX - R.minX
		};
		case "s": return {
			f: new Frame(mb, V(cx, y, R.maxZ), V(-1, 0, 0), V(0, 0, -1)),
			len: R.maxX - R.minX
		};
		case "w": return {
			f: new Frame(mb, V(R.minX, y, cz), V(0, 0, -1), V(1, 0, 0)),
			len: R.maxZ - R.minZ
		};
		case "e": return {
			f: new Frame(mb, V(R.maxX, y, cz), V(0, 0, 1), V(-1, 0, 0)),
			len: R.maxZ - R.minZ
		};
	}
}
var opposite = {
	n: "s",
	s: "n",
	e: "w",
	w: "e"
};
/** 壁沿いの区間 [u0,u1]（中心基準）が開口と干渉しないか */
function isFree(ctx, s, u0, u1) {
	return !ctx.blocked[s].some(([a, b]) => a < u1 && b > u0);
}
/** 幅 w の家具を置ける、中央に最も近い位置 */
function findSpot(ctx, s, w, len, prefer = 0) {
	const cands = [];
	for (let u = -len / 2 + w / 2 + .05; u <= len / 2 - w / 2 - .05; u += .05) cands.push(u);
	cands.sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer));
	for (const u of cands) if (isFree(ctx, s, u - w / 2, u + w / 2)) return u;
	return null;
}
/** 実物モデルを使える環境か（ブラウザ）。使えない場合は簡易形状で植物を描く */
var modelsAvailable = typeof document !== "undefined";
function buildFurniture(model, opts = {}) {
	const mb = new MeshBuilder();
	mb.clip = opts.clip ?? (opts.cut ? topClip(opts.cut.y) : null);
	currentModels = [];
	const lights = [];
	const occupancy = /* @__PURE__ */ new Map();
	kitchenSides = /* @__PURE__ */ new Map();
	const items = /* @__PURE__ */ new Map();
	for (const f of model.floors) {
		if (opts.cut && f.level > opts.cut.level) continue;
		currentItems = [];
		items.set(f.level, currentItems);
		const override = model.furniture?.find((o) => o.level === f.level);
		const env = {
			mb,
			y: f.elevation * MM,
			ceilingY: f.ceilingHeight * MM,
			lights
		};
		for (const room of f.rooms) {
			let inner = largestInnerRect(room.polygon, 5);
			if (!inner) continue;
			const stairRects = f.stairs.filter((st) => st.maxX > inner.minX && st.minX < inner.maxX && st.maxY > inner.minY && st.minY < inner.maxY).map((st) => ({
				minX: st.minX - 150,
				minY: st.minY - 150,
				maxX: st.maxX + 150,
				maxY: st.maxY + 150
			}));
			if (stairRects.length) {
				const parts = rectsMinus([inner], stairRects).sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY));
				if (parts[0]) inner = parts[0];
			}
			const inset = .07;
			const R = {
				minX: inner.minX * MM + inset,
				maxX: inner.maxX * MM - inset,
				minZ: inner.minY * MM + inset,
				maxZ: inner.maxY * MM - inset
			};
			if (R.maxX - R.minX < .5 || R.maxZ - R.minZ < .5) continue;
			currentOcc = [];
			occupancy.set(room.id, currentOcc);
			currentRoomId = room.id;
			const ctx = {
				mb,
				R,
				y: f.elevation * MM,
				blocked: {
					n: [],
					s: [],
					e: [],
					w: []
				},
				windows: {
					n: 0,
					s: 0,
					e: 0,
					w: 0
				},
				lights,
				room,
				env,
				has: /* @__PURE__ */ new Set()
			};
			collectBlocked(ctx, f, inner);
			const ceilingY = f.ceilingHeight * MM;
			const center = V((R.minX + R.maxX) / 2, ctx.y + ceilingY - .02, (R.minZ + R.maxZ) / 2);
			if (override) {
				if (![
					"void",
					"balcony",
					"porch",
					"garage",
					"other",
					"closet",
					"storage"
				].includes(room.type)) lights.push({
					pos: center,
					kind: "ceiling",
					roomId: room.id
				});
				continue;
			}
			for (const it of f.planItems ?? []) {
				if (it.roomId !== room.id) continue;
				emitItem({ ...it }, env);
				ctx.has.add(it.kind);
				if (it.kind === "kitchen") ctx.planKitchen = it;
			}
			switch (room.type) {
				case "ldk":
				case "living":
				case "dining":
				case "kitchen":
					layoutLDK(ctx, model, f);
					break;
				case "bedroom":
				case "kids":
					layoutBedroom(ctx, room.name.includes("主") || (R.maxX - R.minX) * (R.maxZ - R.minZ) > 11);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "study":
					layoutStudy(ctx);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "japanese":
					layoutJapanese(ctx);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "bath":
					layoutBath(ctx);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "washroom":
					layoutWash(ctx);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "toilet":
					layoutToilet(ctx);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "entrance":
					layoutEntrance(ctx);
					lights.push({
						pos: center,
						kind: "ceiling",
						roomId: room.id
					});
					break;
				case "hall": lights.push({
					pos: center,
					kind: "ceiling",
					roomId: room.id
				});
			}
		}
		if (override) for (const it of override.items) {
			currentRoomId = (it.roomId && f.rooms.find((r) => r.id === it.roomId) || f.rooms.find((r) => pointInPolygon({
				x: it.x,
				y: it.y
			}, r.polygon)))?.id ?? "";
			if (currentRoomId && !occupancy.has(currentRoomId)) occupancy.set(currentRoomId, []);
			currentOcc = currentRoomId ? occupancy.get(currentRoomId) : null;
			emitItem({
				...it,
				roomId: currentRoomId || void 0
			}, env);
		}
	}
	currentOcc = null;
	currentItems = null;
	const clip = mb.clip;
	const models = clip ? currentModels.filter((m) => m.pos.dot(clip.n) - clip.d < (clip.n.y > .5 ? -.3 : 0)) : currentModels;
	return {
		mb,
		lights,
		occupancy,
		kitchenSide: kitchenSides,
		models,
		items
	};
}
function sideOfRot(rot) {
	return [
		"n",
		"e",
		"s",
		"w"
	][(Math.round(rot / 90) % 4 + 4) % 4];
}
/** 家具を置く: 位置・向きを記録してから形を作る（手修正の初期値・平面図・3D を同じ経路で） */
function place(kind, fr, u, v, env, extra = {}) {
	const p = fr.point(u, v, 0);
	emitItem({
		id: `fi${++itemSeq}`,
		kind,
		x: Math.round(p.x / MM),
		y: Math.round(p.z / MM),
		rot: Math.round(Math.atan2(fr.along.z, fr.along.x) * DEG),
		roomId: currentRoomId || void 0,
		...extra
	}, env);
}
/** 記録した家具 1 つの形を作る */
function emitItem(it, env) {
	currentItems?.push(it);
	const r = it.rot / DEG;
	const fr = new Frame(env.mb, V(it.x * MM, env.y, it.y * MM), V(Math.cos(r), 0, Math.sin(r)), V(-Math.sin(r), 0, Math.cos(r)));
	const roomId = it.roomId ?? currentRoomId;
	switch (it.kind) {
		case "kitchen":
			kitchen(fr, it.len ?? 3, env.ceilingY, it);
			kitchenSides.set(roomId, sideOfRot(it.rot));
			env.lights.push({
				pos: fr.point(0, (it.kitchenType ?? "peninsula") === "wall" ? 1 : 1.3, env.ceilingY - .02),
				kind: "ceiling",
				roomId
			});
			break;
		case "fridge":
			fr.box("f.fridge", 0, 0, .68, .7, 0, 1.82);
			fr.box("f.metal", .2, .7, .02, .02, .9, .6);
			break;
		case "cupboard": {
			const cw = it.w ?? 1.8;
			fr.box("f.cabinet", 0, 0, cw, .45, 0, .9);
			fr.box("f.counter", 0, 0, cw, .47, .9, .03);
			break;
		}
		case "dining":
			diningSet(fr, 0, 0, env.lights, roomId, env.ceilingY, it.w);
			break;
		case "sofa":
			sofa(fr, 0, 0, it.w ?? 2.1);
			break;
		case "coffeeTable":
			coffeeTable(fr, 0, 0);
			break;
		case "tv":
			tvSet(fr, 0, 0, it.w ?? 1.8);
			break;
		case "rug":
			rug(fr, 0, 0, it.w ?? 2.2, it.d ?? 1.6);
			break;
		case "plant":
			plant(fr, 0, 0, it.w ?? 1);
			break;
		case "chair": {
			const p = fr.point(0, 0, 0);
			currentModels.push({
				id: "modern_arm_chair_01",
				pos: p,
				rotY: Math.atan2(fr.inward.x, fr.inward.z),
				height: .82
			});
			if (currentPlan) currentPlan.push({
				key: "f.fabric",
				shape: "box",
				cx: p.x,
				cz: p.z,
				w: .75,
				d: .8,
				ax: fr.along.x,
				az: fr.along.z,
				r: 0,
				top: .8,
				roomId
			});
			if (currentOcc) currentOcc.push({
				minX: p.x - .4,
				maxX: p.x + .4,
				minZ: p.z - .4,
				maxZ: p.z + .4,
				maxY: .8
			});
			break;
		}
		case "bed":
			bed(fr, 0, 0, it.w ?? 1.4);
			break;
		case "nightstand":
			nightstand(fr, 0, 0, env.lights, roomId);
			break;
		case "desk":
			desk(fr, 0, 0);
			break;
		case "cabinet":
			fr.box("f.cabinet", 0, 0, 1.2, .45, 0, .75);
			break;
		case "bookshelf":
			fr.box("f.cabinet", 0, 0, .9, .32, 0, 1.8);
			for (let i = 1; i < 5; i++) fr.box("f.wood", 0, .01, .84, .3, i * .36, .02);
			break;
		case "lowTable":
			fr.box("f.wood", 0, -.4, 1.2, .8, .3, .05);
			for (const du of [-.55, .55]) for (const dv of [-.35, .35]) fr.box("f.wood", du, dv - .03, .06, .06, 0, .3);
			for (const [du, dv] of [
				[-.35, -.75],
				[.35, -.75],
				[-.35, .75],
				[.35, .75]
			]) fr.box("f.fabric2", du, dv - .26, .52, .52, .01, .07);
			break;
		case "bath": {
			const tw = it.len ?? 1.6;
			fr.box("f.white", 0, 0, tw, .8, 0, .55);
			fr.box("f.water", 0, .08, tw - .16, .64, .5, .02);
			break;
		}
		case "mirror":
			fr.box("f.mirror", 0, .005, .45, .01, .8, .8);
			fr.box("f.chrome", 0, .02, .2, .08, .7, .05);
			break;
		case "washstand":
			fr.box("f.cabinet", 0, 0, .75, .5, 0, .78);
			fr.box("f.counter", 0, 0, .77, .52, .78, .05);
			fr.box("f.white", 0, .1, .45, .32, .8, .06);
			fr.box("f.mirror", 0, .005, .72, .01, 1.05, .85);
			fr.box("f.chrome", 0, .05, .03, .12, .83, .15);
			break;
		case "washer":
			fr.box("f.white", 0, 0, .6, .6, 0, .9);
			fr.cyl("f.screen", 0, .61, .17, .35, .3, 20);
			break;
		case "toilet":
			fr.box("f.white", 0, .02, .38, .2, .45, .35);
			fr.box("f.white", 0, .2, .36, .4, 0, .4);
			fr.cyl("f.white", 0, .55, .19, 0, .4, 20);
			fr.box("f.white", 0, .2, .38, .55, .4, .04);
			fr.box("f.chrome", .28, .4, .12, .1, .7, .05);
			break;
		case "shoeCabinet":
			fr.box("f.cabinet", 0, 0, 1.2, .38, .25, .85);
			fr.box("f.counter", 0, 0, 1.22, .4, 1.1, .03);
	}
}
var kitchenSides = /* @__PURE__ */ new Map();
/** 平面図用: 家具の外形を階ごとに（3D と同じ自動配置） */
function planFurniture(model) {
	const out = /* @__PURE__ */ new Map();
	currentPlan = [];
	try {
		buildFurniture(model);
		const roomFloor = /* @__PURE__ */ new Map();
		for (const f of model.floors) for (const r of f.rooms) roomFloor.set(r.id, f.level);
		for (const it of currentPlan) {
			const lv = roomFloor.get(it.roomId);
			if (lv == null) continue;
			if (!out.has(lv)) out.set(lv, []);
			out.get(lv).push(it);
		}
	} finally {
		currentPlan = null;
	}
	return out;
}
function collectBlocked(ctx, f, inner) {
	const tol = 400;
	for (const o of f.openings) {
		const w = f.walls.find((w) => w.id === o.wallId);
		if (!w) continue;
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		const ux = (w.b.x - w.a.x) / L;
		const uy = (w.b.y - w.a.y) / L;
		const p0 = {
			x: w.a.x + ux * o.t0,
			y: w.a.y + uy * o.t0
		};
		const p1 = {
			x: w.a.x + ux * o.t1,
			y: w.a.y + uy * o.t1
		};
		const horiz = Math.abs(uy) < .1;
		const vert = Math.abs(ux) < .1;
		const blocks = !(o.kind === "window" && o.sill >= 1100);
		const extra = o.kind === "door" ? .1 : .05;
		const addH = (side, z) => {
			if (Math.abs(p0.y - z) > tol) return;
			const { f: fr } = sideFrame(ctx, side);
			const a = (p0.x * MM - fr.origin.x) * fr.along.x;
			const b = (p1.x * MM - fr.origin.x) * fr.along.x;
			if (blocks) ctx.blocked[side].push([Math.min(a, b) - extra, Math.max(a, b) + extra]);
			if (o.kind === "window") ctx.windows[side] += Math.abs(b - a) * (o.windowStyle === "hakidashi" ? 2 : 1);
		};
		const addV = (side, x) => {
			if (Math.abs(p0.x - x) > tol) return;
			const { f: fr } = sideFrame(ctx, side);
			const a = (p0.y * MM - fr.origin.z) * fr.along.z;
			const b = (p1.y * MM - fr.origin.z) * fr.along.z;
			if (blocks) ctx.blocked[side].push([Math.min(a, b) - extra, Math.max(a, b) + extra]);
			if (o.kind === "window") ctx.windows[side] += Math.abs(b - a) * (o.windowStyle === "hakidashi" ? 2 : 1);
		};
		const within = (v, a, b) => v > a - 200 && v < b + 200;
		if (horiz && (within(p0.x, inner.minX, inner.maxX) || within(p1.x, inner.minX, inner.maxX))) {
			addH("n", inner.minY);
			addH("s", inner.maxY);
		}
		if (vert && (within(p0.y, inner.minY, inner.maxY) || within(p1.y, inner.minY, inner.maxY))) {
			addV("w", inner.minX);
			addV("e", inner.maxX);
		}
	}
}
function sofa(fr, u, v, w) {
	const d = .9;
	fr.box("f.metal", u, v + .06, w - .12, .78, 0, .07);
	fr.box("f.fabric", u, v, w, d, .07, .25);
	const n = w > 2.4 ? 3 : 2;
	const sw = w / n;
	for (let i = 0; i < n; i++) fr.box("f.fabric", u - w / 2 + sw * (i + .5), v + .2, sw - .012, .7, .32, .1);
	fr.box("f.fabric", u, v, w, .2, .32, .36);
	for (let i = 0; i < n; i++) fr.box("f.fabric", u - w / 2 + sw * (i + .5), v + .16, sw - .06, .16, .42, .34);
	fr.box("f.fabric2", u - w / 2 + .35, v + .3, .42, .12, .42, .36);
	fr.box("f.fabric2", u + w / 2 - .55, v + .3, .38, .12, .42, .32);
	const sp = fr.point(u + w / 2 + .32, v + .35, 0);
	currentModels.push({
		id: "side_table_01",
		pos: sp,
		rotY: Math.atan2(fr.inward.x, fr.inward.z),
		height: .5
	});
	currentModels.push({
		id: "ceramic_vase_01",
		pos: sp.clone().setY(sp.y + .5),
		rotY: .7,
		height: .2
	});
	if (currentPlan) currentPlan.push({
		key: "f.wood",
		shape: "box",
		cx: sp.x,
		cz: sp.z,
		w: .45,
		d: .45,
		ax: fr.along.x,
		az: fr.along.z,
		r: 0,
		top: .5,
		roomId: currentRoomId
	});
	if (currentOcc) currentOcc.push({
		minX: sp.x - .25,
		maxX: sp.x + .25,
		minZ: sp.z - .25,
		maxZ: sp.z + .25,
		maxY: .5
	});
}
function coffeeTable(fr, u, v) {
	const p = fr.point(u, v + .3, 0);
	currentModels.push({
		id: "coffee_table_round_01",
		pos: p,
		rotY: .3,
		height: .4
	});
	currentModels.push({
		id: "ceramic_vase_01",
		pos: p.clone().setY(p.y + .4).addScaledVector(fr.along, .18),
		rotY: 1.1,
		height: .26
	});
	if (currentPlan) currentPlan.push({
		key: "f.counter",
		shape: "circle",
		cx: p.x,
		cz: p.z,
		w: 0,
		d: 0,
		ax: 1,
		az: 0,
		r: .48,
		top: .4,
		roomId: currentRoomId
	});
	if (currentOcc) currentOcc.push({
		minX: p.x - .5,
		maxX: p.x + .5,
		minZ: p.z - .5,
		maxZ: p.z + .5,
		maxY: .4
	});
	if (modelsAvailable) return;
	fr.box("f.counter", u, v, 1.1, .55, .28, .06);
	fr.box("f.counter", u, v + .08, .8, .39, 0, .28);
	fr.box("f.fabric2", u - .25, v + .16, .26, .2, .34, .035);
	fr.cyl("f.white", u + .28, v + .27, .07, .34, .1, 18);
}
function tvSet(fr, u, v, w = 1.8) {
	fr.box("f.cabinet", u, v, w, .38, .28, .3);
	fr.box("f.screen", u, v + 0, 1.3, .035, .95, .75);
	plant(fr, u + w / 2 + .35, v + .3, 1);
}
function plant(fr, u, v, scale = 1) {
	const p = fr.point(u, v, 0);
	const alt = (Math.sin(p.x * 7.3 + p.z * 3.1) + 1) * .5 > .55;
	currentModels.push({
		id: alt ? "potted_plant_04" : "potted_plant_02",
		pos: p,
		rotY: Math.sin(u * 12.9898 + v * 4.1) * Math.PI,
		height: (alt ? .95 : 1.15) * scale
	});
	if (currentPlan) currentPlan.push({
		key: "f.pot",
		shape: "circle",
		cx: p.x,
		cz: p.z,
		w: 0,
		d: 0,
		ax: 1,
		az: 0,
		r: .3 * scale,
		top: 1,
		roomId: currentRoomId
	});
	if (modelsAvailable) return;
	fr.cyl("f.pot", u, v, .17 * scale, 0, .35 * scale, 14);
	fr.box("f.soil", u, v - .13 * scale, .26 * scale, .26 * scale, .33 * scale, .02);
	const rnd = (i) => Math.sin(i * 12.9898 + u * 78.233) * .5 + .5;
	for (let i = 0; i < 9; i++) {
		const a = i / 9 * Math.PI * 2;
		const r = .14 * scale * (.6 + rnd(i));
		fr.sphere("f.leaf", u + Math.cos(a) * r, v + Math.sin(a) * r, (.6 + rnd(i + 3) * .7) * scale, .16 * scale, .8);
	}
	fr.sphere("f.leaf", u, v, 1.25 * scale, .2 * scale, .9);
}
function rug(fr, u, v, w, d) {
	fr.box("f.rug", u, v, w, d, .002, .012);
}
function diningSet(fr, u, v, lights, roomId, ceilingY, width) {
	const tw = width ?? 1.8;
	const td = .9;
	fr.box("f.wood", u, v - td / 2, tw, td, .68, .04);
	for (const du of [-tw / 2 + .22, tw / 2 - .22]) fr.box("f.wood", u + du, v - td / 2 + .12, .04, .66, 0, .68);
	const perSide = tw >= 2.3 ? 3 : 2;
	const pitch = perSide === 3 ? (tw - .5) / 2 : .9;
	const chairUs = perSide === 3 ? [
		-pitch,
		0,
		pitch
	] : [-.45, .45];
	for (const du of chairUs) for (const side of [-1, 1]) {
		const cu = u + du;
		const cv = v + side * .65;
		fr.box("f.fabric2", cu, cv - .22, .43, .43, .42, .045);
		fr.box("f.wood", cu, cv - .21, .41, .41, .395, .025);
		for (const lu of [-.17, .17]) for (const lv of [-.17, .17]) fr.cyl("f.wood", cu + lu, cv + lv, .013, 0, .395, 10);
		for (const lu of [-.17, .17]) fr.cyl("f.wood", cu + lu, cv + side * .17, .012, .395, .32, 10);
		fr.box("f.wood", cu, cv + side * .17 - .012, .4, .024, .6, .12);
	}
	const us = (tw >= 2.3 ? 3 : 2) === 3 ? [
		-.62,
		0,
		.62
	] : [-.42, .42];
	for (const du of us) {
		const y = 1.52;
		const mh = .62;
		const top = 2.12;
		currentModels.push({
			id: "modern_ceiling_lamp_01",
			pos: fr.point(u + du, v, top),
			rotY: 0,
			height: mh,
			anchor: "top"
		});
		if (modelsAvailable && ceilingY > 2.14) fr.cyl("f.metal", u + du, v, .004, top, ceilingY - top, 8);
		if (!modelsAvailable) {
			fr.box("f.metal", u + du, v - .004, .006, .006, 1.68, ceilingY - y - .16);
			fr.cyl("f.lampShade", u + du, v, .11, y, .16, 18);
			fr.sphere("f.lamp", u + du, v, 1.53, .045);
		}
		lights.push({
			pos: fr.point(u + du, v, 1.42),
			kind: "pendant",
			roomId
		});
	}
}
/** キッチンの仕上げ（扉が暗い色か）。レンジフードの色（シルバー／ブラック）を扉に合わせるために、組み立て前に設定する */
var kitchenFinish = { dark: false };
/**
* LINE KITCHEN（ホームランディックの標準キッチン）。カタログ・プランニングシートの呼び寸法どおりに作る。
* - 間口 W2290 / 2440 / 2590（シンクキャビネット 750/900/1050 ＋ 食器洗い機 450 ＋ 加熱機器キャビネット 1050）、高さ H850、キャビネット奥行 650
* - ペニンシュラ・アイランドはカウンタースタイル: 天板 D750（ダイニング側に 100 の持ち出し）、ダイニング側は FIX パネル
* - 天板 20mm（ステンレス バイブレーション or 扉同色のメラミン）、フラット扉は取っ手なしで天板の下に手掛けの影の線（LINE）
* - アンダーシンク W800×D435×H190、IH 3 口 W750、浅型食器洗い機 W450、台輪 H100
* - レンジフード: 壁付け I 型・Ⅱ型は ASR-3A-9027（薄型・壁掛け）、ペニンシュラ・アイランドは天吊りの箱型（TAJIMA FLBT）。色は扉に合わせてシルバー／ブラック
* - 背面はカップボード フロアタイプ（D450 H850）＋ 吊戸（H600）、端にトール（H2050 D650）のミックスタイプ。冷蔵庫はその並び
* - Ⅱ型: 壁に加熱機器キャビネット W1840、対面にシンクキャビネット W1840（D750）
*/
function kitchen(fr, len, ceilingY, opt = {}) {
	const type = opt.kitchenType ?? "peninsula";
	const stoveSign = (opt.stoveSide ?? "right") === "right" ? 1 : -1;
	const fridge = opt.fridge ?? "right";
	const hood = opt.hood !== false;
	const hoodKey = kitchenFinish.dark ? "f.hoodDark" : "f.hoodSilver";
	const H = .85;
	const TOP = .02;
	const KICK = .1;
	const D = .65;
	/** 手掛けの影の線・扉の目地（扉面から 3mm 出した細い黒い帯） */
	const lineH = (u, v, w, y, h, dir) => fr.box("f.handle", u, dir > 0 ? v - .003 : v - .009, w, .012, y, h);
	/**
	* キャビネット本体: 台輪（奥に引く）・箱・天板・手掛けの線・扉の目地。
	* front = 扉の面がある側（+1: 室内側 v+d, -1: 壁側 v）。sections = 扉の割り（幅と引出し段数）。topD = 天板の奥行（持ち出し分を含む）
	*/
	const cabinet = (u, v, w, d, sections, front, topD = d, topShift = 0) => {
		fr.box("int.shadowGap", u, v + .04, w - .08, d - .08, 0, KICK);
		fr.box("f.cabinet", u, v, w, d, KICK, .73);
		fr.box("f.counter", u, v + topShift, w, topD, .83, TOP);
		const face = front > 0 ? v + d : v;
		lineH(u, face, w - .02, .83 - .03, .022, front);
		let x = u - w / 2 + .02;
		sections.forEach((sec, i) => {
			if (i > 0) fr.box("f.handle", x, front > 0 ? face - .003 : face - .009, .004, .012, .11, .73 - .05);
			for (let r = 1; r < sec.rows; r++) {
				const y = r === 1 ? .83 - .03 - .17 : KICK + .5299999999999999 * (sec.rows - r) / (sec.rows - 1);
				lineH(x + sec.w / 2, face, sec.w - .01, y, .006, front);
			}
			x += sec.w;
		});
	};
	/** 間口の呼称と扉の割り（右シンクのとき左から: シンク / 食器洗い機 / 加熱機器） */
	const sizing = (avail) => {
		const W = avail >= 2.65 ? 2.59 : avail >= 2.5 ? 2.44 : 2.29;
		const sinkW = W === 2.59 ? 1.05 : W === 2.44 ? .9 : .75;
		const secs = [
			{
				w: sinkW,
				rows: 2
			},
			{
				w: .45,
				rows: 1
			},
			{
				w: 1.05,
				rows: 3
			}
		];
		return {
			W,
			secs: stoveSign > 0 ? secs : secs.slice().reverse(),
			sinkU: stoveSign * -(W / 2 - sinkW / 2),
			stoveU: stoveSign * (W / 2 - .525)
		};
	};
	/** アンダーシンク（天板に穴を開け、ステンレスの槽を下げる）と水栓 */
	const sink = (u, v, topD, faucetV) => {
		const sw = .8;
		const sd = .435;
		fr.box("f.stainless", u, v + (topD - sd) / 2, sw, sd, .6499999999999999, .19);
		fr.box("f.carcass", u, v + (topD - sd) / 2 + .01, .78, .415, .6599999999999999, .17);
		fr.cyl("f.chrome", u + .3, faucetV, .016, H, .3, 12);
		fr.box("f.chrome", u + .3, faucetV - .1, .03, .2, 1.13, .025);
		fr.cyl("f.chrome", u + .3, faucetV - .19, .012, 1.02, .12, 10);
	};
	/** IH 3 口（黒ガラス、天板に落とし込み） */
	const ih = (u, v, topD) => {
		fr.box("f.screen", u, v + (topD - .52) / 2, .75, .52, .848, .006);
		for (const du of [-.2, .2]) fr.cyl("f.handle", u + du, v + topD / 2 + .08, .09, .854, .001, 20);
		fr.cyl("f.handle", u, v + topD / 2 - .1, .08, .854, .001, 20);
	};
	/** 壁掛けの薄型フード（ASR-3A-9027: W900、前傾の薄い本体 ＋ 天井までのダクトカバー） */
	const wallHood = (u) => {
		fr.box(hoodKey, u, .02, .9, .5, 1.5, .05);
		fr.box(hoodKey, u, .02, .9, .3, 1.55, .3);
		fr.box(hoodKey, u, .02, .5, .3, 1.85, ceilingY - 1.86);
	};
	/** 天吊りの箱型フード（TAJIMA FLBT: W900 D600、ステンレス） */
	const ceilingHood = (u, v) => {
		fr.box(hoodKey, u, v - .275, .9, .55, ceilingY - .9, .32);
		fr.box(hoodKey, u, v - .15, .4, .3, ceilingY - .59, .59);
	};
	/** 小物: 黒いトレーと器、細い一輪挿し */
	const props = (u, v) => {
		fr.box("f.handle", u - .1 * stoveSign, v, .4, .26, H, .015);
		fr.cyl("f.white", u - .14 * stoveSign, v, .065, .865, .08);
		fr.cyl("f.white", u + .02 * stoveSign, v + .02, .04, .865, .12);
		fr.cyl("f.white", u + .45 * stoveSign, v, .03, H, .24);
		fr.sphere("f.leaf", u + .45 * stoveSign, v, 1.19, .05, 1.5);
	};
	/** 冷蔵庫（扉面が平らな W680 D700 H1820） */
	const fridgeBox = (u) => {
		fr.box("f.fridge", u, .02, .68, .7, 0, 1.82);
		fr.box("f.handle", u - .3, .72, .012, .012, .95, .5);
	};
	/**
	* 背面収納: カップボード フロアタイプ（D450 H850）＋吊戸（D350 H600 上端 2050）、冷蔵庫と反対の端にトール（D650 H2050）
	* wallW = 使える壁の長さ。冷蔵庫は fridge の側の端
	*/
	const backStorage = (wallW, withTall = true) => {
		const fw = fridge === "none" ? 0 : .72;
		const tallW = withTall ? .9 : 0;
		const cupW = Math.max(.9, Math.min(2.74, wallW - fw - tallW));
		const fSign = fridge === "right" ? 1 : -1;
		const x0 = -wallW / 2;
		const order = fSign < 0 ? [
			"fridge",
			"cup",
			"tall"
		] : [
			"tall",
			"cup",
			"fridge"
		];
		let x = x0 + (wallW - fw - tallW - cupW) / 2;
		for (const part of order) if (part === "fridge" && fw) {
			fridgeBox(x + fw / 2);
			x += fw;
		} else if (part === "cup") {
			const n = Math.max(2, Math.round(cupW / .9));
			const secs = Array.from({ length: n }, () => ({
				w: cupW / n,
				rows: 2
			}));
			cabinet(x + cupW / 2, .02, cupW, .45, secs, 1);
			fr.box("f.cabinet", x + cupW / 2, .02, cupW, .35, 1.45, .6);
			lineH(x + cupW / 2, .37, cupW - .02, 1.47, .02, 1);
			for (let k = 1; k < n; k++) fr.box("f.handle", x + cupW / n * k, .367, .004, .012, 1.5, .5);
			x += cupW;
		} else if (part === "tall" && tallW) {
			fr.box("int.shadowGap", x + tallW / 2, .06, tallW - .08, .57, 0, KICK);
			fr.box("f.cabinet", x + tallW / 2, .02, tallW, .65, KICK, 1.9499999999999997);
			fr.box("f.handle", x + tallW / 2, .667, .004, .012, .15, 1.85);
			lineH(x + tallW / 2, .67, tallW - .02, 1, .012, 1);
			x += tallW;
		}
	};
	if (type === "wall") {
		const fw = fridge === "none" ? 0 : .72;
		const { W, secs, sinkU, stoveU } = sizing(Math.min(len - .3, 3.2) - fw);
		const cu = fridge === "none" ? 0 : (fridge === "right" ? -1 : 1) * (fw / 2);
		cabinet(cu, .02, W, D, secs, 1);
		sink(cu + sinkU, .02, D, .1);
		ih(cu + stoveU, .02, D);
		fr.box("f.cabinet", cu, .02, W, .35, 1.45, .6);
		lineH(cu, .37, W - .02, 1.47, .02, 1);
		if (hood) wallHood(cu + stoveU);
		if (fw) fridgeBox(cu + (fridge === "right" ? 1 : -1) * (W / 2 + fw / 2));
		props(cu, .67 - .2);
		return;
	}
	const wallW = Math.min(len - .3, 3.4);
	if (type === "two") {
		const su = stoveSign * (wallW / 2 - .92);
		cabinet(su, .02, 1.84, D, [{
			w: .9,
			rows: 3
		}, {
			w: .9,
			rows: 3
		}], 1);
		ih(su, .02, D);
		if (hood) wallHood(su);
		const restW = wallW - 1.84 - .05;
		if (restW >= 1.2) {
			const rc = -stoveSign * (wallW / 2 - restW / 2);
			const fw = fridge === "none" ? 0 : .72;
			const cupW = Math.max(.6, restW - fw);
			const fridgeFirst = (fridge === "right" ? 1 : -1) === stoveSign ? false : true;
			const cx = rc + (fridgeFirst ? 1 : -1) * stoveSign * (fw / 2);
			cabinet(cx, .02, cupW, .45, [{
				w: cupW / 2,
				rows: 2
			}, {
				w: cupW / 2,
				rows: 2
			}], 1);
			fr.box("f.cabinet", cx, .02, cupW, .35, 1.45, .6);
			lineH(cx, .37, cupW - .02, 1.47, .02, 1);
			if (fw) fridgeBox(rc - (fridgeFirst ? 1 : -1) * stoveSign * (cupW / 2));
		}
		const cv = opt.d ? Math.max(1.3, Math.min(2.6, opt.d)) : 1.65 + .325;
		cabinet(su, cv - D / 2, 1.84, D, [{
			w: 1,
			rows: 2
		}, {
			w: .84,
			rows: 1
		}], -1, .75, .05);
		sink(su - stoveSign * .3, cv - D / 2 + .1, .65, cv + .3);
		props(su + stoveSign * .5, cv + .1);
		return;
	}
	backStorage(wallW, true);
	const { W, secs, sinkU, stoveU } = sizing(Math.min(len - .4, 3));
	const cv = opt.d ? Math.max(1.3, Math.min(2.6, opt.d)) : 1.775;
	cabinet(0, cv - D / 2, W, D, secs, -1, .75, .05);
	sink(sinkU, cv - D / 2 + .1, .65, cv + .3);
	ih(stoveU, cv - D / 2, D);
	if (hood) ceilingHood(stoveU, cv);
	props(0, cv + .12);
}
function layoutLDK(ctx, model, f) {
	const { R } = ctx;
	const W = R.maxX - R.minX;
	const D = R.maxZ - R.minZ;
	const ceilingY = f.ceilingHeight * MM;
	const winSide = Object.entries(ctx.windows).sort((a, b) => b[1] - a[1])[0][0];
	const longX = W >= D;
	const winParallelLong = (winSide === "n" || winSide === "s") === longX;
	const cx0 = (R.minX + R.maxX) / 2;
	const cz0 = (R.minZ + R.maxZ) / 2;
	const wetRooms = [
		"washroom",
		"bath",
		"toilet"
	].map((t) => f.rooms.filter((r) => r.type === t)).find((l) => l.length) ?? [];
	const wetC = wetRooms.length ? wetRooms.map((r) => ({
		x: r.labelPos.x * MM,
		y: r.labelPos.y * MM
	})).sort((a, b) => Math.hypot(a.x - cx0, a.y - cz0) - Math.hypot(b.x - cx0, b.y - cz0))[0] : null;
	let kSide;
	if (winParallelLong) {
		if (longX) kSide = wetC && wetC.x > (R.minX + R.maxX) / 2 ? "e" : "w";
		else kSide = wetC && wetC.y > (R.minZ + R.maxZ) / 2 ? "s" : "n";
	} else kSide = opposite[winSide];
	if (ctx.planKitchen) kSide = sideOfRot(ctx.planKitchen.rot);
	const total = kSide === "e" || kSide === "w" ? W : D;
	const kDepth = total >= 6.5 ? 2.5 : 2.3;
	const dDepth = total >= 6.5 ? 2.4 : 2.1;
	const hasLiving = total - kDepth - dDepth >= 2.4 && ctx.room.type !== "dining" && ctx.room.type !== "kitchen";
	const { f: kf, len: klen } = sideFrame(ctx, kSide);
	if (!ctx.has.has("kitchen")) place("kitchen", kf, 0, 0, ctx.env, { len: +klen.toFixed(2) });
	if (!ctx.has.has("dining")) place("dining", kf, 0, kDepth + dDepth / 2, ctx.env);
	if (!hasLiving) return;
	if (ctx.has.has("sofa")) {
		ctx.lights.push({
			pos: kf.point(0, kDepth + dDepth + (total - kDepth - dDepth) / 2, ceilingY - .02),
			kind: "ceiling",
			roomId: ctx.room.id
		});
		return;
	}
	const livStart = kDepth + dDepth;
	const livDepth = total - livStart;
	const endSide = opposite[kSide];
	const { f: ef, len: elen } = sideFrame(ctx, endSide);
	const tvU = findSpot(ctx, endSide, 2, elen, 0);
	if (tvU != null && livDepth >= 3.2) {
		place("tv", ef, tvU, .02, ctx.env, { w: 1.8 });
		const sofaV = Math.min(livDepth - 1, 3);
		place("rug", ef, tvU, .9, ctx.env, {
			w: 2.2,
			d: +Math.max(1.4, sofaV - .7).toFixed(2)
		});
		place("coffeeTable", ef, tvU, 1.2, ctx.env);
		place("sofa", new Frame(ctx.mb, ef.point(tvU, sofaV + .9, 0), ef.along.clone().negate(), ef.inward.clone().negate()), 0, 0, ctx.env, { w: 2.1 });
		place("plant", ef, -elen / 2 + .35, .35, ctx.env, { w: 1.1 });
		const chairU = tvU + 1.75;
		if (Math.abs(chairU) < elen / 2 - .5 && isFree(ctx, endSide, chairU - .45, chairU + .45)) {
			const cp = ef.point(chairU, Math.max(1.4, sofaV - .6), 0);
			const toward = ef.point(tvU, sofaV * .5, 0).sub(cp).setY(0).normalize();
			place("chair", new Frame(ctx.mb, cp, V(toward.z, 0, -toward.x), toward), 0, 0, ctx.env);
		}
		ctx.lights.push({
			pos: ef.point(tvU, livDepth / 2, ceilingY - .02),
			kind: "ceiling",
			roomId: ctx.room.id
		});
		return;
	}
	const tvSide = (kSide === "e" || kSide === "w" ? ["n", "s"] : ["w", "e"]).sort((a, b) => ctx.windows[a] - ctx.windows[b])[0];
	const { f: tf, len: tlen } = sideFrame(ctx, tvSide);
	const uLiv = kf.point(0, livStart + livDepth / 2, 0).clone().sub(tf.origin).dot(tf.along);
	const tvU2 = findSpot(ctx, tvSide, 1.9, tlen, uLiv) ?? uLiv;
	place("tv", tf, tvU2, .02, ctx.env, { w: 1.8 });
	const across = tvSide === "n" || tvSide === "s" ? D : W;
	const sofaV = Math.min(across - 1, 2.8);
	place("rug", tf, tvU2, .9, ctx.env, {
		w: 2.2,
		d: +Math.max(1.4, sofaV - .7).toFixed(2)
	});
	place("coffeeTable", tf, tvU2, 1.25, ctx.env);
	place("sofa", new Frame(ctx.mb, tf.point(tvU2, sofaV + .9, 0), tf.along.clone().negate(), tf.inward.clone().negate()), 0, 0, ctx.env, { w: 2.1 });
	ctx.lights.push({
		pos: tf.point(tvU2, across / 2, ceilingY - .02),
		kind: "ceiling",
		roomId: ctx.room.id
	});
}
function bed(fr, u, v, w) {
	const L = 2;
	fr.box("f.wood", u, v, w + .06, 2.04, .08, .22);
	fr.box("f.wood", u, v - .04, w + .06, .06, .08, .85);
	fr.box("f.bedding", u, v + .02, w, L, .3, .2);
	fr.box("f.fabric2", u, v + .75, w + .02, 1.28, .48, .05);
	fr.box("f.fabric2", u, v + 1.75, w + .04, .3, .3, .2);
	const np = w > 1.2 ? 2 : 1;
	for (let i = 0; i < np; i++) {
		const pu = np === 2 ? u + (i === 0 ? -w / 4 : w / 4) : u;
		fr.box("f.bedding", pu, v + .1, np === 2 ? w / 2 - .1 : w - .2, .4, .5, .12);
	}
}
function nightstand(fr, u, v, lights, roomId) {
	fr.box("f.wood", u, v, .45, .4, 0, .5);
	fr.cyl("f.metal", u, v + .2, .06, .5, .02);
	fr.cyl("f.metal", u, v + .2, .01, .52, .3);
	fr.cyl("f.lampShade", u, v + .2, .12, .72, .2);
	lights.push({
		pos: fr.point(u, v + .2, .8),
		kind: "lamp",
		roomId
	});
}
function layoutBedroom(ctx, big) {
	const { R } = ctx;
	const W = R.maxX - R.minX;
	const D = R.maxZ - R.minZ;
	const bw = big ? Math.min(W, D) > 3.2 ? 1.6 : 1.4 : 1;
	const order = [
		"n",
		"s",
		"e",
		"w"
	].sort((a, b) => ctx.windows[a] - ctx.windows[b]);
	let placed = null;
	for (const withStands of big ? [true, false] : [false]) {
		for (const s of order) {
			const { f, len } = sideFrame(ctx, s);
			const depth = s === "n" || s === "s" ? D : W;
			if (depth < 2.5) continue;
			const u = findSpot(ctx, s, withStands ? bw + 1 : bw + .1, len, 0);
			if (u == null) continue;
			placed = {
				s,
				f,
				len,
				u,
				depth,
				withStands
			};
			break;
		}
		if (placed) break;
	}
	if (ctx.has.has("bed")) placed = null;
	if (placed) {
		const { s, f, u, depth } = placed;
		place("bed", f, u, .02, ctx.env, { w: bw });
		if (placed.withStands) {
			place("nightstand", f, u - bw / 2 - .3, .02, ctx.env);
			place("nightstand", f, u + bw / 2 + .3, .02, ctx.env);
		}
		place("rug", f, u, .9, ctx.env, {
			w: +(bw + .9).toFixed(2),
			d: 1.6
		});
		if (!big) {
			const other = opposite[s];
			const { f: of, len: olen } = sideFrame(ctx, other);
			const du = findSpot(ctx, other, 1.1, olen, 0);
			if (du != null && depth > 3) place("desk", of, du, .02, ctx.env);
		} else {
			const { f: of, len: olen } = sideFrame(ctx, opposite[s]);
			const du = findSpot(ctx, opposite[s], 1.2, olen, olen / 4);
			if (du != null && depth > 3.4) {
				place("cabinet", of, du, .02, ctx.env);
				place("plant", of, du + .9, .3, ctx.env, { w: .8 });
			}
		}
		return;
	}
}
function desk(fr, u, v) {
	fr.box("f.wood", u, v, 1, .55, .7, .03);
	fr.box("f.wood", u - .48, v, .03, .55, 0, .7);
	fr.box("f.wood", u + .48, v, .03, .55, 0, .7);
	fr.box("f.screen", u, v + .08, .55, .03, .73, .34);
	fr.box("f.fabric2", u, v + .75, .45, .45, .42, .08);
	fr.box("f.fabric2", u, v + .95, .45, .06, .5, .45);
	fr.cyl("f.metal", u, v + .75, .03, 0, .42);
}
function layoutStudy(ctx) {
	const order = [
		"n",
		"s",
		"e",
		"w"
	].sort((a, b) => ctx.windows[b] - ctx.windows[a]);
	for (const s of order) {
		const { f, len } = sideFrame(ctx, s);
		const u = findSpot(ctx, s, 1.1, len, 0);
		if (u == null) continue;
		place("desk", f, u, .02, ctx.env);
		const o = opposite[s];
		const { f: of, len: olen } = sideFrame(ctx, o);
		const su = findSpot(ctx, o, .9, olen, 0);
		if (su != null) place("bookshelf", of, su, .02, ctx.env);
		return;
	}
}
function layoutJapanese(ctx) {
	const { R } = ctx;
	place("lowTable", new Frame(ctx.mb, V((R.minX + R.maxX) / 2, ctx.y, (R.minZ + R.maxZ) / 2), V(1, 0, 0), V(0, 0, 1)), 0, 0, ctx.env);
}
function layoutBath(ctx) {
	const { R } = ctx;
	const s = R.maxX - R.minX >= R.maxZ - R.minZ ? ctx.windows.n > ctx.windows.s ? "s" : "n" : ctx.windows.w > ctx.windows.e ? "e" : "w";
	const { f, len } = sideFrame(ctx, s);
	const tw = Math.min(len - .05, 1.6);
	if (!ctx.has.has("bath")) place("bath", f, 0, 0, ctx.env, { len: +tw.toFixed(2) });
	const o = opposite[s];
	const { f: of } = sideFrame(ctx, o);
	place("mirror", of, .3, 0, ctx.env);
}
function layoutWash(ctx) {
	const order = [
		"n",
		"s",
		"e",
		"w"
	].sort((a, b) => ctx.windows[a] - ctx.windows[b]);
	let used = null;
	if (ctx.has.has("washstand")) used = sideOfRot(ctx.has.has("washstand") ? currentItems?.find((it) => it.roomId === ctx.room.id && it.kind === "washstand")?.rot ?? 0 : 0);
	else for (const s of order) {
		const { f, len } = sideFrame(ctx, s);
		const u = findSpot(ctx, s, .8, len, -len / 4);
		if (u == null) continue;
		place("washstand", f, u, 0, ctx.env);
		used = s;
		break;
	}
	if (!used) return;
	for (const s of order) {
		if (s === used) continue;
		const { f, len } = sideFrame(ctx, s);
		const u = findSpot(ctx, s, .65, len, len / 4);
		if (u == null) continue;
		place("washer", f, u, .02, ctx.env);
		return;
	}
}
function layoutToilet(ctx) {
	const { R } = ctx;
	const cands = R.maxX - R.minX < R.maxZ - R.minZ ? ["n", "s"] : ["w", "e"];
	if (ctx.has.has("toilet")) return;
	const s = cands.sort((a, b) => ctx.blocked[a].length - ctx.blocked[b].length)[0];
	const { f } = sideFrame(ctx, s);
	place("toilet", f, 0, 0, ctx.env);
}
function layoutEntrance(ctx) {
	const s = [
		"n",
		"s",
		"e",
		"w"
	].sort((a, b) => ctx.blocked[a].length - ctx.blocked[b].length)[0];
	const { f, len } = sideFrame(ctx, s);
	const u = findSpot(ctx, s, 1.2, len, 0);
	if (u == null) return;
	place("shoeCabinet", f, u, 0, ctx.env);
	place("plant", f, u + .3, .2, ctx.env, { w: .35 });
	place("plant", f, u + .9, .25, ctx.env, { w: .7 });
}
//#endregion
//#region src/styles/noise.ts
/** 軽量な値ノイズ / fBm（テクスチャ生成用） */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = a + 1831565813 >>> 0;
		let t = a;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
//#endregion
//#region src/scene/landscape.ts
/**
* 外構・敷地の自動生成
* 玄関の向きを「道路側」とし、駐車スペース・アプローチ・植栽・フェンスを配置する。
*/
var SIDE_WORLD = {
	top: V(0, 0, -1),
	bottom: V(0, 0, 1),
	left: V(-1, 0, 0),
	right: V(1, 0, 0)
};
/** 主な接道（複数あれば玄関に近い向き → 駐車場の奥行が取れる側 → 広い道路） */
function primaryRoad(site, entranceOutward, bbox) {
	if (!site?.roads.length) return null;
	const depth = (r) => {
		const bd = site.bounds?.[r.side];
		if (bd == null || !bbox) return null;
		const v = bd / 1e3;
		return r.side === "top" ? bbox.min.z - v : r.side === "bottom" ? v - bbox.max.z : r.side === "left" ? bbox.min.x - v : v - bbox.max.x;
	};
	const score = (r) => {
		const d = depth(r);
		const room = d == null ? 0 : d >= 5.5 ? 8 : d >= 3 ? 2 : -8;
		return (entranceOutward ? SIDE_WORLD[r.side].dot(entranceOutward) * 6 : 0) + room + (r.widthMm ?? 4e3) / 1e3 + (r.source === "manual" ? 100 : 0);
	};
	return site.roads.slice().sort((a, b) => score(b) - score(a))[0];
}
function buildLandscape(meta, style, siteData, planExt) {
	const mb = new MeshBuilder();
	const trees = new MeshBuilder();
	const plan = {
		trees: [],
		shrubs: [],
		paving: [],
		cars: []
	};
	const b = meta.bbox;
	const ent = meta.entrance;
	const pr = primaryRoad(siteData, ent?.outward, b);
	let road = pr ? SIDE_WORLD[pr.side].clone() : ent ? ent.outward.clone() : V(0, 0, 1);
	if (Math.abs(road.x) > Math.abs(road.z)) road = V(Math.sign(road.x), 0, 0);
	else road = V(0, 0, Math.sign(road.z) || 1);
	const side = 1.6;
	const back = 2.2;
	const min = new THREE.Vector2(b.min.x - side, b.min.z - side);
	const max = new THREE.Vector2(b.max.x + side, b.max.z + side);
	const bd = siteData?.bounds ?? {};
	const clampOut = (edge, pos, sign, def) => {
		if (pos == null) return edge + sign * def;
		const d = (pos / 1e3 - edge) * sign;
		return edge + sign * Math.max(.3, Math.min(20, d));
	};
	const front = 6;
	min.x = clampOut(b.min.x, bd.left, -1, road.x < 0 ? front : road.x > 0 ? back : side);
	max.x = clampOut(b.max.x, bd.right, 1, road.x > 0 ? front : road.x < 0 ? back : side);
	min.y = clampOut(b.min.z, bd.top, -1, road.z < 0 ? front : road.z > 0 ? back : side);
	max.y = clampOut(b.max.z, bd.bottom, 1, road.z > 0 ? front : road.z < 0 ? back : side);
	const gy = 0;
	const poly = siteData?.polygon?.map((q) => V(q.x / 1e3, gy, q.y / 1e3));
	if (poly && poly.length >= 3) mb.polygon("l.ground", poly, V(0, 1, 0), V(1, 0, 0), V(0, 0, 1));
	else mb.quad("l.ground", V(min.x, gy, min.y), V(min.x, gy, max.y), V(max.x, gy, max.y), V(max.x, gy, min.y), V(1, 0, 0), V(0, 0, 1));
	const R = 120;
	const cx = (min.x + max.x) / 2;
	const cz = (min.y + max.y) / 2;
	mb.quad("l.far", V(cx - R, -.02, cz - R), V(cx - R, -.02, cz + R), V(cx + R, -.02, cz + R), V(cx + R, -.02, cz - R), V(1, 0, 0), V(0, 0, 1));
	const roadW = pr?.widthMm ? Math.max(3, Math.min(20, pr.widthMm / 1e3)) : 6;
	let roadCenter;
	const roadEdges = (siteData?.edges ?? []).filter((e) => e.kind === "road");
	if (roadEdges.length) {
		const sc = V((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
		let bestDot = -Infinity;
		roadCenter = V(0, 0, 0);
		for (const e of roadEdges) {
			const A = V(e.a.x / 1e3, 0, e.a.y / 1e3);
			const B = V(e.b.x / 1e3, 0, e.b.y / 1e3);
			const dir = B.clone().sub(A).normalize();
			let out = V(-dir.z, 0, dir.x);
			const mid = A.clone().add(B).multiplyScalar(.5);
			if (out.dot(mid.clone().sub(sc)) < 0) out = out.negate();
			const A2 = A.clone().addScaledVector(dir, -12);
			const B2 = B.clone().addScaledVector(dir, 12);
			const p = [
				A2,
				B2,
				B2.clone().addScaledVector(out, roadW),
				A2.clone().addScaledVector(out, roadW)
			].map((q) => q.setY(.005));
			if (new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).y < 0) mb.quad("l.road", p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
			else mb.quad("l.road", p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
			mb.box("l.curb", mid.clone().addScaledVector(out, .1), dir, A.distanceTo(B) + .2, .12, .2);
			const d = out.dot(road);
			if (d > bestDot) {
				bestDot = d;
				roadCenter = mid.clone().addScaledVector(out, roadW / 2);
			}
		}
	} else if (road.x !== 0) {
		const x0 = road.x > 0 ? max.x + .2 : min.x - .2 - roadW;
		mb.quad("l.road", V(x0, .005, cz - 60), V(x0, .005, cz + 60), V(x0 + roadW, .005, cz + 60), V(x0 + roadW, .005, cz - 60), V(1, 0, 0), V(0, 0, 1));
		roadCenter = V(x0 + roadW / 2, 0, cz);
		mb.aabb("l.curb", V(road.x > 0 ? max.x : min.x - .2, 0, cz - 60), V(road.x > 0 ? max.x + .2 : min.x, .12, cz + 60));
	} else {
		const z0 = road.z > 0 ? max.y + .2 : min.y - .2 - roadW;
		mb.quad("l.road", V(cx - 60, .005, z0), V(cx - 60, .005, z0 + roadW), V(cx + 60, .005, z0 + roadW), V(cx + 60, .005, z0), V(1, 0, 0), V(0, 0, 1));
		roadCenter = V(cx, 0, z0 + roadW / 2);
		mb.aabb("l.curb", V(cx - 60, 0, road.z > 0 ? max.y : min.y - .2), V(cx + 60, .12, road.z > 0 ? max.y + .2 : min.y));
	}
	const along = road.x !== 0 ? V(0, 0, 1) : V(1, 0, 0);
	const frontEdge = road.x > 0 ? b.max.x : road.x < 0 ? b.min.x : road.z > 0 ? b.max.z : b.min.z;
	const siteEdge = road.x > 0 ? max.x : road.x < 0 ? min.x : road.z > 0 ? max.y : min.y;
	const entAlong = ent ? ent.pos.dot(along) : road.x !== 0 ? cz : cx;
	const alongMin = road.x !== 0 ? min.y : min.x;
	const alongMax = road.x !== 0 ? max.y : max.x;
	const parkW = 5.4;
	const parkSign = entAlong - alongMin > alongMax - entAlong ? -1 : 1;
	const parkCenterAlong = parkSign < 0 ? Math.max(alongMin + parkW / 2 + .3, entAlong - 1.4 - parkW / 2) : Math.min(alongMax - parkW / 2 - .3, entAlong + 1.4 + parkW / 2);
	const depthA = Math.min(frontEdge, siteEdge) + .3;
	const depthB = Math.max(frontEdge, siteEdge);
	const toWorld = (a, d, y) => road.x !== 0 ? V(d, y, a) : V(a, y, d);
	const rect = (key, a0, a1, d0, d1, y) => {
		const p = [
			toWorld(a0, d0, y),
			toWorld(a1, d0, y),
			toWorld(a1, d1, y),
			toWorld(a0, d1, y)
		];
		plan.paving.push({
			key,
			pts: p
		});
		if (new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).y < 0) mb.quad(key, p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
		else mb.quad(key, p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
	};
	rect("l.driveway", parkCenterAlong - parkW / 2, parkCenterAlong + parkW / 2, depthA - .3, depthB, .012);
	const parking = {
		center: toWorld(parkCenterAlong, (depthA + depthB) / 2, 0),
		along
	};
	if (planExt?.cars.length) for (const c of planExt.cars) {
		plan.cars.push(c);
		const a = V(c.dirX, 0, c.dirZ).normalize();
		const s = V(-a.z, 0, a.x);
		const p = [
			V(c.x, .012, c.z).addScaledVector(a, -2.7).addScaledVector(s, -1.35),
			V(c.x, .012, c.z).addScaledVector(a, 2.7).addScaledVector(s, -1.35),
			V(c.x, .012, c.z).addScaledVector(a, 2.7).addScaledVector(s, 1.35),
			V(c.x, .012, c.z).addScaledVector(a, -2.7).addScaledVector(s, 1.35)
		];
		plan.paving.push({
			key: "l.driveway",
			pts: p
		});
		if (new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).y < 0) mb.quad("l.driveway", p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
		else mb.quad("l.driveway", p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
	}
	else if (depthB - depthA > 4.8) {
		const nCar = 2;
		for (let i = 0; i < nCar; i++) {
			const c = toWorld(parkCenterAlong + (i - .5) * 2.6, (depthA + depthB) / 2, 0);
			plan.cars.push({
				x: c.x,
				z: c.z,
				dirX: road.x,
				dirZ: road.z
			});
		}
	}
	if (ent) rect("l.approach", entAlong - .65, entAlong + .65, depthA + 1.2, depthB, .018);
	function shrub(p, s) {
		if (!spotOk(p, s * .5)) return;
		plan.shrubs.push({
			x: p.x,
			z: p.z,
			r: s * .75
		});
		for (let i = 0; i < 7; i++) {
			const off = V((rnd() - .5) * s * 1.4, s * (.35 + rnd() * .5), (rnd() - .5) * s * 1.4);
			trees.card("l.leafCardDark", p.clone().setY(0).add(off), s * (1 + rnd() * .5), new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI));
		}
	}
	/** 植栽を置ける位置か: 敷地の内側（形が分かれば）、建物・駐車場・アプローチに重ならない */
	function spotOk(p, r) {
		if (p.x - r < min.x || p.x + r > max.x || p.z - r < min.y || p.z + r > max.y) return false;
		if (poly && poly.length >= 3) {
			let inside = false;
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const a = poly[i];
				const c = poly[j];
				if (a.z > p.z !== c.z > p.z && p.x < (c.x - a.x) * (p.z - a.z) / (c.z - a.z) + a.x) inside = !inside;
			}
			if (!inside) return false;
		}
		if (p.x > b.min.x - r - .3 && p.x < b.max.x + r + .3 && p.z > b.min.z - r - .3 && p.z < b.max.z + r + .3) return false;
		for (const pv of plan.paving) {
			const xs = pv.pts.map((q) => q.x);
			const zs = pv.pts.map((q) => q.z);
			if (p.x > Math.min(...xs) - r && p.x < Math.max(...xs) + r && p.z > Math.min(...zs) - r && p.z < Math.max(...zs) + r) return false;
		}
		return true;
	}
	const rnd = mulberry32(42);
	const fenceType = style.landscape.fence;
	const neighborEdges = (siteData?.edges ?? []).filter((e) => e.kind === "neighbor");
	const edges = neighborEdges.length ? neighborEdges.map((e) => [V(e.a.x / 1e3, 0, e.a.y / 1e3), V(e.b.x / 1e3, 0, e.b.y / 1e3)]) : [
		[V(min.x, 0, min.y), V(max.x, 0, min.y)],
		[V(max.x, 0, min.y), V(max.x, 0, max.y)],
		[V(max.x, 0, max.y), V(min.x, 0, max.y)],
		[V(min.x, 0, max.y), V(min.x, 0, min.y)]
	];
	for (const [a, c] of edges) {
		const mid = a.clone().add(c).multiplyScalar(.5);
		const out = mid.clone().sub(V(cx, 0, cz));
		if (out.normalize().dot(road) > .9) continue;
		if (Math.abs(out.dot(road)) < .1) {
			const sFront = frontEdge * (road.x + road.z) - .5;
			for (const p of [a, c]) {
				const sp = p.dot(road);
				if (sp > sFront) p.addScaledVector(road, sFront - sp);
			}
			mid.copy(a).add(c).multiplyScalar(.5);
		}
		const dir = c.clone().sub(a);
		const L = dir.length();
		if (L < .3) continue;
		dir.normalize();
		if (fenceType === "block" || fenceType === "wood") {
			mb.box("l.block", mid.clone(), dir, L, .4, .12);
			if (fenceType === "wood") {
				const n = Math.floor(L / .12);
				for (let i = 0; i < n; i += 1) {
					if (i % 2) continue;
					const p = a.clone().addScaledVector(dir, (i + .5) * .12).setY(.4);
					mb.box("l.fenceWood", p, dir, .09, .8, .02);
				}
				mb.box("l.fenceWood", mid.clone().setY(1.15), dir, L, .04, .05);
			}
		} else if (fenceType === "hedge") {
			const n = Math.max(1, Math.floor(L / .9));
			for (let i = 0; i < n; i++) shrub(a.clone().addScaledVector(dir, (i + .5) * (L / n)), .6);
		}
	}
	const addTree = (p0, h, kind, exact = false) => {
		const r0 = h * .22;
		const siteC = V((min.x + max.x) / 2, 0, (min.y + max.y) / 2);
		let p = exact ? p0.clone() : null;
		for (let k = 0; k <= 6 && !p; k++) {
			const q = p0.clone().lerp(siteC, k * .12);
			if (spotOk(q, r0)) p = q;
		}
		if (!p) return;
		plan.trees.push({
			x: p.x,
			z: p.z,
			r: h * (kind === "modern" ? .26 : .3)
		});
		const leafKey = kind === "japanese" ? "l.leafCardDark" : "l.leafSpray";
		const up = V(0, 1, 0);
		const turn = (d, minA, maxA) => {
			const ax = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < .95 ? up : V(1, 0, 0)).normalize();
			ax.applyAxisAngle(d, rnd() * Math.PI * 2);
			return d.clone().applyAxisAngle(ax, minA + rnd() * (maxA - minA)).lerp(up, .15).normalize();
		};
		const leaves = (a, b, sz) => {
			const n = 3;
			for (let i = 0; i < n; i++) {
				const q = a.clone().lerp(b, .35 + .65 * rnd()).add(V((rnd() - .5) * .12, (rnd() - .5) * .08, (rnd() - .5) * .12));
				trees.card(leafKey, q, sz * (.75 + rnd() * .5), new THREE.Euler((rnd() - .5) * 1.6, rnd() * Math.PI * 2, (rnd() - .5) * 1.6));
			}
		};
		const leafSize = Math.max(.32, h * .11);
		const grow = (a, dir, len, r, level) => {
			const b = a.clone().addScaledVector(dir, len);
			trees.tube("l.trunk", a, b, r, r * .72);
			if (level >= 3) {
				leaves(a, b, leafSize);
				return;
			}
			const nChild = level === 0 ? 3 : 2;
			for (let i = 0; i < nChild; i++) {
				const t = .5 + .45 * (i + rnd() * .6) / nChild;
				grow(a.clone().lerp(b, t), turn(dir, .45, .85), len * (.5 + rnd() * .15), r * .55, level + 1);
			}
			grow(b, turn(dir, .05, .25), len * (.55 + rnd() * .1), r * .7, level + 1);
			if (level >= 2) leaves(a, b, leafSize * .9);
		};
		const stems = kind === "modern" ? 4 : kind === "natural" ? 3 : 1;
		for (let i = 0; i < stems; i++) {
			const az = i / stems * Math.PI * 2 + rnd() * .8;
			const lean = stems > 1 ? .14 + rnd() * .16 : .04;
			const d0 = V(Math.cos(az) * lean, 1, Math.sin(az) * lean).normalize();
			const base = p.clone().setY(0).add(V(Math.cos(az) * .06, 0, Math.sin(az) * .06));
			const r0 = (stems > 1 ? .04 : .08) * (h / 4);
			grow(base, d0, h * (.42 + rnd() * .08), r0, 0);
		}
	};
	const kind = style.landscape.trees;
	const drawn = planExt?.trees ?? [];
	for (const t of drawn) addTree(V(t.x, 0, t.z), Math.min(5.5, Math.max(2.2, t.r * 4.5)), kind, true);
	if (ent && drawn.length < 2) {
		const cornerAlong = parkSign > 0 ? alongMin + 1.3 : alongMax - 1.3;
		addTree(toWorld(Math.abs(cornerAlong - entAlong) > 1.8 ? cornerAlong : entAlong - 2.2 * parkSign, depthB - 1.1, 0), 4.2, kind);
		shrub(toWorld(entAlong + 1 * -parkSign, depthB - .5, 0), .35);
		shrub(toWorld(entAlong + 2.2 * -parkSign, depthB - .6, 0), .4);
	}
	const backCenter = road.clone().multiplyScalar(-1);
	const bpos = V(cx, 0, cz).addScaledVector(backCenter, (road.x !== 0 ? max.x - min.x : max.y - min.y) / 2 - .9);
	if (drawn.length < 2) {
		addTree(bpos.clone().addScaledVector(along, (alongMax - alongMin) * .35), 3.6, kind);
		addTree(bpos.clone().addScaledVector(along, -(alongMax - alongMin) * .38), 3, kind);
	}
	for (let i = 0; i < 5; i++) shrub(bpos.clone().addScaledVector(along, (rnd() - .5) * (alongMax - alongMin) * .8), .3 + rnd() * .2);
	for (let guard = 0; plan.trees.length < 3 && guard < 3; guard++) {
		let best = null;
		for (let x = min.x + 1; x <= max.x - 1; x += .5) for (let z = min.y + 1; z <= max.y - 1; z += .5) {
			const p = V(x, 0, z);
			if (!spotOk(p, 1)) continue;
			const dB = Math.max(b.min.x - x, x - b.max.x, b.min.z - z, z - b.max.z, 0);
			const dT = Math.min(99, ...plan.trees.map((t) => Math.hypot(t.x - x, t.z - z)));
			const front = (x - (b.min.x + b.max.x) / 2) * road.x + (z - (b.min.z + b.max.z) / 2) * road.z > (road.x !== 0 ? (b.max.x - b.min.x) / 2 : (b.max.z - b.min.z) / 2);
			const score = -Math.abs(dB - 2.2) + Math.min(dT, 6) * .8 - (front ? 4 : 0);
			if (!best || score > best.score) best = {
				p,
				score
			};
		}
		if (!best) break;
		const n0 = plan.trees.length;
		addTree(best.p, 3.4 + rnd() * .8, kind);
		if (plan.trees.length === n0) break;
		shrub(best.p.clone().add(V(.9, 0, .5)), .35);
	}
	const town = [];
	{
		let seed = 7;
		const r2 = () => {
			seed = seed * 16807 % 2147483647;
			return seed / 2147483647;
		};
		const sides = [
			{
				n: V(1, 0, 0),
				ok: !(road.x > 0)
			},
			{
				n: V(-1, 0, 0),
				ok: !(road.x < 0)
			},
			{
				n: V(0, 0, 1),
				ok: !(road.z > 0)
			},
			{
				n: V(0, 0, -1),
				ok: !(road.z < 0)
			}
		];
		for (const s of sides) {
			if (!s.ok) continue;
			V(-s.n.z, 0, s.n.x);
			const edge = s.n.x !== 0 ? s.n.x > 0 ? max.x : min.x : s.n.z > 0 ? max.y : min.y;
			const span = s.n.x !== 0 ? [min.y, max.y] : [min.x, max.x];
			const sideOfRoad = Math.abs(s.n.dot(road)) < .5;
			if (sideOfRoad) {
				const roadEdge = road.x !== 0 ? road.x > 0 ? max.x : min.x : road.z > 0 ? max.y : min.y;
				if (road.x + road.z > 0) span[1] = Math.min(span[1], roadEdge - 3);
				else span[0] = Math.max(span[0], roadEdge + 3);
			}
			let t = span[0] - (sideOfRoad && road.x + road.z < 0 ? 0 : 4 + r2() * 3);
			while (t < span[1] + (sideOfRoad && road.x + road.z > 0 ? 0 : 4)) {
				const w = 6 + r2() * 3;
				const d = 6.5 + r2() * 2.5;
				const hh = r2() > .3 ? 6 : 3.2;
				const gap = 2.2 + r2() * 1.8;
				if (t + w > span[1] + (sideOfRoad && road.x + road.z > 0 ? 0 : 4)) break;
				(s.n.x !== 0 ? 0 : 1) * 0;
				const center = V(0, 0, 0);
				if (s.n.x !== 0) center.set(edge + s.n.x * (gap + d / 2), 0, t + w / 2);
				else center.set(t + w / 2, 0, edge + s.n.z * (gap + d / 2));
				const dir = s.n.x !== 0 ? V(0, 0, 1) : V(1, 0, 0);
				const len = w;
				const depth = d;
				const key = r2() > .66 ? "l.nbWallB" : r2() > .4 ? "l.nbWallA" : "l.nbWallC";
				const one = new MeshBuilder();
				mb_box(one, key, center, dir, len, hh, depth);
				mb_box(one, "l.nbRoof", center.clone().setY(hh), dir, len + .5, .35, depth + .5);
				const ex = dir.x !== 0 ? len : depth;
				const ez = dir.x !== 0 ? depth : len;
				town.push({
					mb: one,
					box: new THREE.Box3(V(center.x - ex / 2, 0, center.z - ez / 2), V(center.x + ex / 2, hh + .4, center.z + ez / 2))
				});
				t += w + .4 + r2() * 1.2;
			}
		}
	}
	return {
		mb,
		trees,
		town,
		site: {
			min,
			max,
			roadDir: road,
			roadCenter,
			parking
		},
		plan
	};
}
function mb_box(m, key, base, dir, len, height, depth) {
	m.box(key, base, dir, len, height, depth);
}
//#endregion
//#region src/styles/presets.ts
var ext = (s) => s;
/** ホームランディックの標準的な外観: 塗り壁の箱、低い片流れ（ほぼ陸屋根に見える）、薄い黒の鼻隠し、アクセントは SOLIDO */
function plasterBox(o) {
	const accent = o.accent === void 0 ? null : o.accent;
	return {
		id: o.id,
		name: o.name,
		catch: o.catch,
		description: o.description,
		swatch: [
			o.wall,
			accent ?? o.wall2 ?? o.wall,
			"#2a2b2d",
			o.frame ?? "#1f1f1f"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 100,
			verge: 60,
			material: {
				pattern: "standingSeam",
				color: "#2a2b2d",
				roughness: .5,
				metalness: .4
			},
			fascia: "#2a2b2d",
			soffit: {
				pattern: "paint",
				color: o.wall,
				roughness: .95
			},
			gutter: false
		},
		wall: {
			pattern: "stucco",
			color: o.wall,
			color2: o.wall2 ?? o.wall,
			roughness: .97,
			normalStrength: o.coarse ?? .3
		},
		accent: accent ? {
			pattern: "solido",
			color: accent,
			roughness: .92,
			normalStrength: .6
		} : void 0,
		accentRule: accent ? "entrance" : "none",
		foundation: {
			pattern: "plaster",
			color: "#8f8d88",
			roughness: .92,
			normalStrength: .25
		},
		frame: {
			color: o.frame ?? "#1f1f1f",
			metalness: .4
		},
		entranceDoor: {
			pattern: "paint",
			color: "#3a3a3a",
			roughness: .55
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#b0aca3",
				color2: "#9a968d"
			},
			approach: {
				pattern: "stone",
				color: "#8f8c86",
				color2: "#7d7a74",
				roughness: .85,
				size: .8,
				size2: .5
			},
			driveway: {
				pattern: "concrete",
				color: "#aeaba5",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	};
}
var EXTERIOR_STYLES = [
	plasterBox({
		id: "hl-jolypat-grey",
		name: "ジョリパット グレー",
		catch: "中間グレーの塗り壁の箱",
		description: "ジョリパットの中間グレーの塗り壁を一色で回したホームランディックの定番。低い片流れで屋根を見せず、薄い黒の鼻隠しで箱を引き締めます。アクセント（SOLIDO・木板）はコーディネートで玄関まわりに足せます。",
		wall: "#8f8e8a",
		wall2: "#86857f"
	}),
	plasterBox({
		id: "hl-jolypat-greige",
		name: "ジョリパット グレージュ",
		catch: "やわらかなグレージュの塗り壁",
		description: "グレージュのジョリパットを一色で。陰影がやわらかく、植栽が映える外観です。",
		wall: "#a99f93",
		wall2: "#a1978b"
	}),
	plasterBox({
		id: "hl-jolypat-beige",
		name: "ジョリパット ベージュ",
		catch: "明るいベージュの塗り壁",
		description: "明るいベージュの塗り壁を一色で回した穏やかな外観。",
		wall: "#c4b8a6",
		wall2: "#bcb09e"
	}),
	plasterBox({
		id: "hl-soton-grey",
		name: "そとん壁 グレー",
		catch: "粗い掻き落としの陰影",
		description: "シラスの「そとん壁」の掻き落とし仕上げ。粗い肌理が光で陰影をつくり、塗り壁だけで表情が出ます。アクセントなしの潔い箱。",
		wall: "#8a8781",
		wall2: "#7f7c76",
		coarse: .8,
		accent: null
	}),
	plasterBox({
		id: "hl-sto-lightgrey",
		name: "Sto 塗り壁 ライトグレー",
		catch: "明るいグレーの塗り壁",
		description: "Sto の明るいグレーの塗り壁を一色で。軽やかでシャープな外観です。",
		wall: "#b3b2ae",
		wall2: "#abaaa6"
	}),
	ext({
		id: "hl-galva-black",
		name: "ガルバ ブラック × 塗り壁",
		catch: "黒のガルバの量塊と、グレーの塗り壁",
		description: "黒の縦張りガルバリウムを主に、1 階の一部をグレーの塗り壁で切り替えた構成。ガルバの陰影と塗り壁の柔らかさの対比です。",
		swatch: [
			"#2e2f31",
			"#8f8e8a",
			"#2a2b2d",
			"#1c1c1c"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 100,
			verge: 60,
			material: {
				pattern: "standingSeam",
				color: "#262729",
				roughness: .5,
				metalness: .45
			},
			fascia: "#232426",
			soffit: {
				pattern: "paint",
				color: "#2e2f31",
				roughness: .9
			},
			gutter: false
		},
		wall: {
			pattern: "galvalume",
			color: "#2e2f31",
			color2: "#28292b",
			roughness: .6,
			metalness: .45
		},
		accent: {
			pattern: "stucco",
			color: "#8f8e8a",
			color2: "#86857f",
			roughness: .97,
			normalStrength: .35
		},
		accentRule: "lower",
		foundation: {
			pattern: "concrete",
			color: "#8a8883",
			roughness: .9
		},
		frame: {
			color: "#1a1a1a",
			metalness: .4
		},
		entranceDoor: {
			pattern: "paint",
			color: "#2a2a2a",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#a9a69e",
				color2: "#93908a"
			},
			approach: {
				pattern: "concrete",
				color: "#aaa7a1",
				roughness: .85
			},
			driveway: {
				pattern: "concrete",
				color: "#b0ada7",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "hl-grey-box",
		name: "グレーの箱 × 縦スリット",
		catch: "中間グレーの吹付け、黒い薄い庇",
		description: "中間グレーの吹付け塗装の箱に、縦長のスリットと細い黒の庇。砂利に飛び石、細い樹形の木を 2 本だけ。窓は目立たせず、陰影と素材の肌理で見せる外観です。",
		swatch: [
			"#8f8e8a",
			"#a9aaa8",
			"#26272a",
			"#1f1f1f"
		],
		roof: {
			type: "flat",
			pitch: .3,
			eaves: 60,
			verge: 40,
			material: {
				pattern: "standingSeam",
				color: "#2a2b2d",
				roughness: .5,
				metalness: .4
			},
			fascia: "#262729",
			soffit: {
				pattern: "paint",
				color: "#8f8e8a",
				roughness: .95
			},
			gutter: false
		},
		wall: {
			pattern: "stucco",
			color: "#8f8e8a",
			color2: "#85847f",
			roughness: .97,
			normalStrength: .45
		},
		accent: {
			pattern: "solido",
			color: "#5d5c59",
			roughness: .92,
			normalStrength: .6
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#9b9993",
			roughness: .9
		},
		frame: {
			color: "#202020",
			metalness: .4
		},
		entranceDoor: {
			pattern: "paint",
			color: "#3a3a3a",
			roughness: .55
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#b0aca3",
				color2: "#9a968d"
			},
			approach: {
				pattern: "stone",
				color: "#8f8c86",
				color2: "#7d7a74",
				roughness: .85,
				size: .8,
				size2: .5
			},
			driveway: {
				pattern: "concrete",
				color: "#aeaba5",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "hl-dark-tile",
		name: "黒ガルバ × 炭色タイル基壇",
		catch: "漆黒の量塊、石の足元、コンクリートの塀",
		description: "深い黒の縦張りガルバリウムの量塊を、炭色のタイルの基壇で受けた外観。道路側にはライトグレーのコンクリートの塀。シャープな黒と素材の違いで品を出します。",
		swatch: [
			"#303133",
			"#4a4b4d",
			"#2a2b2d",
			"#1c1c1c"
		],
		roof: {
			type: "flat",
			pitch: .3,
			eaves: 80,
			verge: 50,
			material: {
				pattern: "standingSeam",
				color: "#262729",
				roughness: .5,
				metalness: .45
			},
			fascia: "#232426",
			soffit: {
				pattern: "paint",
				color: "#2e2f31",
				roughness: .9
			},
			gutter: false
		},
		wall: {
			pattern: "galvalume",
			color: "#303133",
			color2: "#28292b",
			roughness: .6,
			metalness: .45
		},
		accent: {
			pattern: "stone",
			color: "#4a4b4d",
			color2: "#3d3e40",
			roughness: .8,
			size: .6,
			size2: .3
		},
		accentRule: "lower",
		foundation: {
			pattern: "concrete",
			color: "#8a8883",
			roughness: .9
		},
		frame: {
			color: "#1a1a1a",
			metalness: .4
		},
		entranceDoor: {
			pattern: "paint",
			color: "#2a2a2a",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#a9a69e",
				color2: "#93908a"
			},
			approach: {
				pattern: "concrete",
				color: "#aaa7a1",
				roughness: .85
			},
			driveway: {
				pattern: "concrete",
				color: "#b0ada7",
				roughness: .9
			},
			fence: "block",
			trees: "modern"
		}
	}),
	ext({
		id: "lux-sumi-yakisugi",
		name: "墨色左官 × 焼杉",
		catch: "黒い佇まい、木の艶",
		description: "墨を含んだ左官の壁に、炭化した焼杉板を合わせた深い色の外観。陰影だけで形を見せ、軒裏の木と細い黒サッシが静かな艶を添えます。",
		swatch: [
			"#3a3836",
			"#221f1c",
			"#2b2b2b",
			"#1a1a1a"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 450,
			verge: 300,
			material: {
				pattern: "standingSeam",
				color: "#26272a",
				roughness: .5,
				metalness: .45
			},
			fascia: "#232426",
			soffit: {
				pattern: "woodSiding",
				color: "#7a5f45",
				color2: "#6b5239",
				roughness: .75
			},
			gutter: false
		},
		wall: {
			pattern: "plaster",
			color: "#3b3936",
			color2: "#343230",
			roughness: .92,
			normalStrength: .45
		},
		accent: {
			pattern: "woodSiding",
			color: "#211e1b",
			color2: "#171514",
			roughness: .55,
			size: .15
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#6e6c69",
			roughness: .9
		},
		frame: {
			color: "#1a1a1a",
			metalness: .4
		},
		entranceDoor: {
			pattern: "wood",
			color: "#5a4332",
			color2: "#4a3628",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#8e8b85",
				color2: "#75726c"
			},
			approach: {
				pattern: "stone",
				color: "#7f7c76",
				color2: "#6c6964",
				roughness: .8,
				size: .9,
				size2: .45
			},
			driveway: {
				pattern: "concrete",
				color: "#a8a5a0",
				roughness: .9
			},
			fence: "none",
			trees: "japanese"
		}
	}),
	ext({
		id: "lux-shikkui-oya",
		name: "漆喰 × 大谷石",
		catch: "白と石の静けさ",
		description: "艶を消した漆喰の白い量塊に、大谷石の柔らかな基壇と塀。素材の肌理だけで品をつくる、ギャラリーのような外観です。",
		swatch: [
			"#efece5",
			"#cfc6b3",
			"#2b2b2b",
			"#2a2a2a"
		],
		roof: {
			type: "flat",
			pitch: .3,
			eaves: 100,
			verge: 100,
			material: {
				pattern: "standingSeam",
				color: "#2b2c2e",
				roughness: .5,
				metalness: .4
			},
			fascia: "#2b2c2e",
			soffit: {
				pattern: "plaster",
				color: "#e9e5dc",
				roughness: .95
			},
			gutter: false
		},
		wall: {
			pattern: "plaster",
			color: "#efece5",
			color2: "#e6e2d9",
			roughness: .97,
			normalStrength: .3
		},
		accent: {
			pattern: "stone",
			color: "#cfc6b3",
			color2: "#bdb3a0",
			roughness: .9,
			size: .9,
			size2: .3
		},
		accentRule: "lower",
		foundation: {
			pattern: "stone",
			color: "#c4bba8",
			color2: "#b2a896",
			roughness: .9,
			size: .9,
			size2: .3
		},
		frame: {
			color: "#2a2a2a",
			metalness: .35
		},
		entranceDoor: {
			pattern: "wood",
			color: "#8a6a4c",
			color2: "#765a40",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#c9c4ba",
				color2: "#b3ada2"
			},
			approach: {
				pattern: "stone",
				color: "#cbc3b1",
				color2: "#b7ae9c",
				roughness: .85,
				size: .9,
				size2: .45
			},
			driveway: {
				pattern: "concrete",
				color: "#c4c0ba",
				roughness: .9
			},
			fence: "none",
			trees: "japanese"
		}
	}),
	ext({
		id: "lux-black-galva-cedar",
		name: "黒ガルバ × 杉",
		catch: "鋭い黒と、やわらかな木",
		description: "深い黒のガルバリウム小波に、節の少ない杉板の壁を差し込んだ構成。軒を深く出し、木の壁が夕景に浮かび上がります。",
		swatch: [
			"#2a2b2d",
			"#b08a5e",
			"#2a2b2d",
			"#1f1f1f"
		],
		roof: {
			type: "shed",
			pitch: 1,
			eaves: 900,
			verge: 450,
			material: {
				pattern: "standingSeam",
				color: "#26272a",
				roughness: .45,
				metalness: .5
			},
			fascia: "#26272a",
			soffit: {
				pattern: "woodSiding",
				color: "#b08a5e",
				color2: "#9a7750",
				roughness: .7
			},
			gutter: false
		},
		wall: {
			pattern: "galvalume",
			color: "#2a2b2d",
			color2: "#232426",
			roughness: .55,
			metalness: .5
		},
		accent: {
			pattern: "woodSiding",
			color: "#b08a5e",
			color2: "#9a7750",
			roughness: .7,
			size: .14
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#8f8d89",
			roughness: .9
		},
		frame: {
			color: "#1f1f1f",
			metalness: .4
		},
		entranceDoor: {
			pattern: "wood",
			color: "#9a7750",
			color2: "#86663f",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#9d9a93",
				color2: "#85827b"
			},
			approach: {
				pattern: "concrete",
				color: "#b4b1ab",
				roughness: .9
			},
			driveway: {
				pattern: "concrete",
				color: "#b9b6b0",
				roughness: .9
			},
			fence: "none",
			trees: "japanese"
		}
	}),
	ext({
		id: "hl-white-plaster",
		name: "塗り壁ホワイト",
		catch: "白の塗り壁 × 軒の無い箱",
		description: "やわらかなコテむらの白い塗り壁に、細い黒のサッシ。軒をほとんど出さず薄い鼻隠しだけで屋根を見せない箱の佇まい。玄関まわりの木の縦格子が温もりを添えます。",
		swatch: [
			"#f1efea",
			"#1f1f1f",
			"#a07b56",
			"#2b2b2b"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 120,
			verge: 80,
			material: {
				pattern: "standingSeam",
				color: "#2b2c2e",
				roughness: .5,
				metalness: .45
			},
			fascia: "#2b2c2e",
			soffit: {
				pattern: "paint",
				color: "#e8e4dc",
				roughness: .95
			},
			gutter: false
		},
		wall: {
			pattern: "stucco",
			color: "#e8e4dc",
			roughness: .95,
			normalStrength: .35
		},
		accent: {
			pattern: "woodSiding",
			color: "#8e6a49",
			color2: "#7a5a3d",
			roughness: .7
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#a7a49f",
			roughness: .9
		},
		frame: {
			color: "#1f1f1f",
			metalness: .35
		},
		entranceDoor: {
			pattern: "wood",
			color: "#7d5b3e",
			color2: "#664a31",
			roughness: .55
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#a9a69f",
				color2: "#8c8982"
			},
			approach: {
				pattern: "tileFloor",
				color: "#9b968f",
				roughness: .7,
				size: .6,
				size2: .6
			},
			driveway: {
				pattern: "concrete",
				color: "#bdbab4",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "hl-greige-cube",
		name: "塗り壁グレージュ",
		catch: "グレージュのキューブ",
		description: "あたたかみのあるグレージュの塗り壁で包んだ、軒の無いキューブ型。屋根は 0.5 寸の片流れで、正面からは水平なラインだけが見えます。余計な線を出さない、静かで洗練された外観です。",
		swatch: [
			"#d8d1c6",
			"#2a2a2a",
			"#b7ad9f",
			"#1f1f1f"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 0,
			verge: 0,
			material: {
				pattern: "standingSeam",
				color: "#2b2c2e",
				roughness: .5,
				metalness: .45
			},
			fascia: "#2b2c2e",
			soffit: {
				pattern: "woodSiding",
				color: "#a8825c",
				color2: "#94704c",
				roughness: .7
			},
			gutter: false
		},
		wall: {
			pattern: "stucco",
			color: "#d6cfc3",
			roughness: .95,
			normalStrength: .35
		},
		accent: {
			pattern: "stucco",
			color: "#b6ad9f",
			roughness: .95,
			normalStrength: .35
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#a19e99",
			roughness: .9
		},
		frame: {
			color: "#1f1f1f",
			metalness: .35
		},
		entranceDoor: {
			pattern: "woodSiding",
			color: "#6f5440",
			color2: "#5e4735",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#bfb9ae",
				color2: "#9d978b"
			},
			approach: {
				pattern: "tileFloor",
				color: "#8d8983",
				roughness: .7,
				size: .6,
				size2: .6
			},
			driveway: {
				pattern: "concrete",
				color: "#b8b5ae",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "hl-gray-plaster",
		name: "塗り壁ライトグレー",
		catch: "ウォームグレー × 木の縦格子",
		description: "あたたかみのあるグレーの塗り壁に、玄関まわりの木の縦格子をあわせた都会的なデザイン。軒を出さない 0.5 寸の片流れで、道路側は窓を絞った静かな面構えに。",
		swatch: [
			"#c9c5bd",
			"#8e6a49",
			"#2c2d2f",
			"#1f1f1f"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 120,
			verge: 80,
			material: {
				pattern: "standingSeam",
				color: "#2c2d2f",
				roughness: .5,
				metalness: .45
			},
			fascia: "#2c2d2f",
			soffit: {
				pattern: "woodSiding",
				color: "#a07b56",
				color2: "#8c6947",
				roughness: .7
			},
			gutter: false
		},
		wall: {
			pattern: "stucco",
			color: "#c9c5bd",
			roughness: .95,
			normalStrength: .35
		},
		accent: {
			pattern: "woodSiding",
			color: "#94704f",
			color2: "#7f5e41",
			roughness: .7
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#a19e99",
			roughness: .9
		},
		frame: {
			color: "#1f1f1f",
			metalness: .35
		},
		entranceDoor: {
			pattern: "wood",
			color: "#7a5a3e",
			color2: "#65492f",
			roughness: .55
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#a3a09a",
				color2: "#86837d"
			},
			approach: {
				pattern: "tileFloor",
				color: "#8f8b85",
				roughness: .7,
				size: .6,
				size2: .6
			},
			driveway: {
				pattern: "concrete",
				color: "#bab7b1",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "hl-charcoal-plaster",
		name: "ガルバ縦張りチャコール",
		catch: "チャコールの箱 × タイルの基壇",
		description: "チャコールのガルバリウム縦張りの箱を、濃いグレーのタイルの基壇に載せた重厚でシックな外観。軒を出さず、窓は縦長のスリットに絞ります。夜景では窓の灯りが美しく浮かび上がります。",
		swatch: [
			"#33353a",
			"#3d3f43",
			"#2a2a2a",
			"#1a1a1a"
		],
		roof: {
			type: "shed",
			pitch: .5,
			eaves: 0,
			verge: 0,
			material: {
				pattern: "standingSeam",
				color: "#2a2a2b",
				roughness: .5,
				metalness: .45
			},
			fascia: "#3f3d3b",
			soffit: {
				pattern: "woodSiding",
				color: "#9a7654",
				color2: "#86633f",
				roughness: .7
			},
			gutter: false
		},
		wall: {
			pattern: "galvalume",
			color: "#33353a",
			roughness: .55,
			metalness: .3
		},
		accent: {
			pattern: "stone",
			color: "#3d3f43",
			color2: "#2e3034",
			roughness: .8
		},
		accentRule: "lower",
		foundation: {
			pattern: "concrete",
			color: "#96938e",
			roughness: .9
		},
		frame: {
			color: "#1a1a1a",
			metalness: .35
		},
		entranceDoor: {
			pattern: "wood",
			color: "#8a6644",
			color2: "#735333",
			roughness: .55
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#aaa59b",
				color2: "#8a847a"
			},
			approach: {
				pattern: "tileFloor",
				color: "#6f6b66",
				roughness: .7,
				size: .6,
				size2: .6
			},
			driveway: {
				pattern: "concrete",
				color: "#b2afa9",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "simple-modern",
		name: "シンプルモダン",
		catch: "白×黒のキューブ",
		description: "白い塗り壁にブラックのガルバリウムを効かせた、軒ゼロのシャープな箱型デザイン。",
		swatch: [
			"#f2f1ee",
			"#2b2c2e",
			"#2b2c2e",
			"#1d1d1f"
		],
		roof: {
			type: "shed",
			pitch: 2.5,
			eaves: 150,
			verge: 100,
			material: {
				pattern: "standingSeam",
				color: "#2f3033",
				roughness: .45,
				metalness: .5
			},
			fascia: "#2b2c2e",
			soffit: {
				pattern: "paint",
				color: "#2b2c2e",
				roughness: .8
			},
			gutter: false
		},
		wall: {
			pattern: "plaster",
			color: "#f1f0ec",
			roughness: .9
		},
		accent: {
			pattern: "galvalume",
			color: "#2e2f32",
			roughness: .4,
			metalness: .55
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#9c9a96",
			roughness: .9
		},
		frame: {
			color: "#1c1c1e",
			metalness: .4
		},
		entranceDoor: {
			pattern: "wood",
			color: "#6e4b31",
			color2: "#4d3220",
			roughness: .55
		},
		landscape: {
			ground: {
				pattern: "grass",
				color: "#5d7e3a",
				color2: "#7c9a4b"
			},
			approach: {
				pattern: "tileFloor",
				color: "#8d8a85",
				roughness: .7,
				tile: 2.4
			},
			driveway: {
				pattern: "concrete",
				color: "#b3b0aa",
				roughness: .9
			},
			fence: "block",
			trees: "modern"
		}
	}),
	ext({
		id: "natural",
		name: "ナチュラル",
		catch: "木のぬくもりと切妻屋根",
		description: "やさしいベージュの外壁に天然木調のアクセント。深めの軒が表情をつくる、飽きのこない定番スタイル。",
		swatch: [
			"#e9e1d3",
			"#a8764a",
			"#4a4d52",
			"#f3f1ec"
		],
		roof: {
			type: "gable",
			pitch: 4,
			eaves: 600,
			verge: 450,
			material: {
				pattern: "slate",
				color: "#4a4d52",
				color2: "#3b3e42",
				roughness: .75
			},
			fascia: "#f3f1ec",
			soffit: {
				pattern: "woodSiding",
				color: "#c89a6c",
				color2: "#b5855a",
				roughness: .7,
				tile: 1.26
			},
			gutter: true
		},
		wall: {
			pattern: "siding",
			color: "#e8dfd0",
			color2: "#ddd2c0",
			roughness: .85
		},
		accent: {
			pattern: "woodSiding",
			color: "#b07c4f",
			color2: "#8f6039",
			roughness: .7
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#a19e98",
			roughness: .9
		},
		frame: {
			color: "#efeeea",
			metalness: .2
		},
		entranceDoor: {
			pattern: "wood",
			color: "#9b6b43",
			color2: "#7a5132",
			roughness: .6
		},
		landscape: {
			ground: {
				pattern: "grass",
				color: "#628538",
				color2: "#83a452"
			},
			approach: {
				pattern: "paving",
				color: "#b9a88f",
				color2: "#a39278",
				roughness: .8
			},
			driveway: {
				pattern: "concrete",
				color: "#b8b5ae",
				roughness: .9
			},
			fence: "wood",
			trees: "natural"
		}
	}),
	ext({
		id: "wa-modern",
		name: "和モダン",
		catch: "深い軒と格子の陰影",
		description: "墨色の外壁に木格子、いぶし瓦の寄棟屋根。深い軒が落とす陰影で、凛とした佇まいに。",
		swatch: [
			"#3a3836",
			"#9c7652",
			"#55585c",
			"#3d3a36"
		],
		roof: {
			type: "hip",
			pitch: 4.5,
			eaves: 900,
			verge: 900,
			material: {
				pattern: "roofTile",
				color: "#5d6166",
				color2: "#4d5156",
				roughness: .55,
				metalness: .15
			},
			fascia: "#2d2b29",
			soffit: {
				pattern: "woodSiding",
				color: "#a77c52",
				color2: "#94693f",
				roughness: .7
			},
			gutter: true
		},
		wall: {
			pattern: "plaster",
			color: "#3b3937",
			roughness: .92
		},
		accent: {
			pattern: "woodSiding",
			color: "#9a7249",
			color2: "#7d5835",
			roughness: .75
		},
		accentRule: "lower",
		foundation: {
			pattern: "concrete",
			color: "#8f8c87",
			roughness: .9
		},
		frame: {
			color: "#3a352f",
			metalness: .3
		},
		entranceDoor: {
			pattern: "woodSiding",
			color: "#6b4c30",
			color2: "#5a3e25",
			roughness: .6
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#b8b3a8",
				color2: "#8f8a80"
			},
			approach: {
				pattern: "stone",
				color: "#8e8a82",
				color2: "#77736c",
				roughness: .8
			},
			driveway: {
				pattern: "concrete",
				color: "#aeaba5",
				roughness: .9
			},
			fence: "hedge",
			trees: "japanese"
		}
	}),
	ext({
		id: "nordic",
		name: "北欧",
		catch: "白い板張りと急勾配の屋根",
		description: "白い横張りの板壁に、黒い急勾配の切妻屋根。北欧の街並みのような可愛らしさとぬくもり。",
		swatch: [
			"#f4f2ed",
			"#2f3134",
			"#2f3134",
			"#f4f2ed"
		],
		roof: {
			type: "gable",
			pitch: 7,
			eaves: 350,
			verge: 300,
			material: {
				pattern: "standingSeam",
				color: "#2e3033",
				roughness: .5,
				metalness: .45
			},
			fascia: "#f4f2ed",
			soffit: {
				pattern: "paint",
				color: "#f4f2ed"
			},
			gutter: true
		},
		wall: {
			pattern: "lapSiding",
			color: "#f3f1ec",
			roughness: .8
		},
		accent: void 0,
		accentRule: "none",
		foundation: {
			pattern: "concrete",
			color: "#a3a09a",
			roughness: .9
		},
		frame: {
			color: "#1f2023",
			metalness: .3
		},
		entranceDoor: {
			pattern: "paint",
			color: "#35506b",
			roughness: .5
		},
		landscape: {
			ground: {
				pattern: "grass",
				color: "#5f8a3d",
				color2: "#86ab57"
			},
			approach: {
				pattern: "paving",
				color: "#a09c95",
				color2: "#8c8881"
			},
			driveway: {
				pattern: "gravel",
				color: "#c5c0b6",
				color2: "#a8a298"
			},
			fence: "wood",
			trees: "natural"
		}
	}),
	ext({
		id: "south-euro",
		name: "南欧",
		catch: "陽だまりの塗り壁とオレンジ瓦",
		description: "アイボリーの塗り壁とテラコッタの瓦。明るく開放的な、リゾートのような外観。",
		swatch: [
			"#efe4cf",
			"#c46b3e",
			"#c46b3e",
			"#f2eee6"
		],
		roof: {
			type: "hip",
			pitch: 4,
			eaves: 450,
			verge: 450,
			material: {
				pattern: "roofTile",
				color: "#c56a3d",
				color2: "#a9542d",
				roughness: .7
			},
			fascia: "#efe4cf",
			soffit: {
				pattern: "paint",
				color: "#f2ebdd"
			},
			gutter: true
		},
		wall: {
			pattern: "plaster",
			color: "#eee2cb",
			roughness: .95
		},
		accent: {
			pattern: "stone",
			color: "#c8b797",
			color2: "#b09f80",
			roughness: .85
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#a8a39a",
			roughness: .9
		},
		frame: {
			color: "#f2eee6",
			metalness: .2
		},
		entranceDoor: {
			pattern: "wood",
			color: "#7d4d2c",
			color2: "#653c20",
			roughness: .6
		},
		landscape: {
			ground: {
				pattern: "grass",
				color: "#6a8c3c",
				color2: "#8fae55"
			},
			approach: {
				pattern: "brick",
				color: "#b86b45",
				color2: "#9c5634",
				roughness: .85
			},
			driveway: {
				pattern: "concrete",
				color: "#bdb8ae",
				roughness: .9
			},
			fence: "block",
			trees: "natural"
		}
	}),
	ext({
		id: "industrial",
		name: "ガルバ×ウッド",
		catch: "無骨でクールな片流れ",
		description: "ブラックのガルバリウム角波に杉板のアクセント。片流れ屋根で、太陽光パネルとも好相性。",
		swatch: [
			"#2d2f31",
			"#b98a5a",
			"#2d2f31",
			"#1f2022"
		],
		roof: {
			type: "shed",
			pitch: 2.5,
			eaves: 300,
			verge: 200,
			material: {
				pattern: "standingSeam",
				color: "#2c2e30",
				roughness: .45,
				metalness: .55
			},
			fascia: "#2c2e30",
			soffit: {
				pattern: "woodSiding",
				color: "#b98a5a",
				color2: "#a0744a",
				roughness: .7
			},
			gutter: false
		},
		wall: {
			pattern: "galvalume",
			color: "#2e3032",
			roughness: .4,
			metalness: .55
		},
		accent: {
			pattern: "woodSiding",
			color: "#b98a5a",
			color2: "#9b6e43",
			roughness: .75
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#96938e",
			roughness: .9
		},
		frame: {
			color: "#1f2022",
			metalness: .4
		},
		entranceDoor: {
			pattern: "woodSiding",
			color: "#b0814f",
			color2: "#946538",
			roughness: .6
		},
		landscape: {
			ground: {
				pattern: "gravel",
				color: "#9e9a93",
				color2: "#7f7b74"
			},
			approach: {
				pattern: "concrete",
				color: "#a9a6a0",
				roughness: .85
			},
			driveway: {
				pattern: "concrete",
				color: "#b1aea8",
				roughness: .9
			},
			fence: "none",
			trees: "modern"
		}
	}),
	ext({
		id: "hotel-like",
		name: "ラグジュアリー",
		catch: "タイルと石張りの重厚感",
		description: "白系タイルに石張りのアクセント、陸屋根のフラットな水平ライン。ホテルのような上質感。",
		swatch: [
			"#ece9e3",
			"#6f6a63",
			"#d9d6d0",
			"#3a3a3c"
		],
		roof: {
			type: "flat",
			pitch: 0,
			eaves: 0,
			verge: 0,
			material: {
				pattern: "concrete",
				color: "#9d9a95",
				roughness: .9
			},
			fascia: "#e6e3dd",
			soffit: {
				pattern: "paint",
				color: "#f1efeb"
			},
			gutter: false
		},
		wall: {
			pattern: "brick",
			color: "#ebe7e0",
			color2: "#ddd8cf",
			roughness: .6,
			tile: 1
		},
		accent: {
			pattern: "stone",
			color: "#77716a",
			color2: "#5e5953",
			roughness: .7
		},
		accentRule: "entrance",
		foundation: {
			pattern: "concrete",
			color: "#9f9c97",
			roughness: .9
		},
		frame: {
			color: "#3a3a3c",
			metalness: .5
		},
		entranceDoor: {
			pattern: "woodSiding",
			color: "#4b3627",
			color2: "#3b2a1e",
			roughness: .45
		},
		landscape: {
			ground: {
				pattern: "grass",
				color: "#557a36",
				color2: "#779a4a"
			},
			approach: {
				pattern: "tileFloor",
				color: "#6d6861",
				roughness: .6
			},
			driveway: {
				pattern: "tileFloor",
				color: "#a19c94",
				roughness: .7
			},
			fence: "block",
			trees: "modern"
		}
	})
];
var DEFAULT_DESIGN = {
	specId: "minimal-lines",
	exteriorId: "hl-jolypat-grey",
	interiorId: "hl-standard",
	timeOfDay: "day",
	furniture: true
};
function exteriorById(id) {
	return EXTERIOR_STYLES.find((s) => s.id === id) ?? EXTERIOR_STYLES[0];
}
//#endregion
//#region src/drawings/sheet.ts
/** YYYY.MM.DD → 和暦の短い表記（R8.09.13）。令和以外・読めない日付はそのまま */
function warekiOf(date) {
	const m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(date);
	if (!m) return date;
	const y = +m[1];
	const mm = m[2].padStart(2, "0");
	const dd = m[3].padStart(2, "0");
	if (y >= 2019) return `R${y - 2018}.${mm}.${dd}`;
	if (y >= 1989) return `H${y - 1988}.${mm}.${dd}`;
	return date;
}
/**
* 図面名の枠（御社の図面の「1階 平面図 S:1/100」）。中央 cx、上端 y。
* 文字は字間を空け、枠は細い線。縮尺の数字に {{SCALE}} を入れると図枠に入れるときに実際の縮尺に置き換わる
*/
function boxedTitle(cx, y, text, fs = 300) {
	const w = textWidth(text, fs) + fs * 1.6;
	const h = fs * 1.7;
	return `<rect x="${(cx - w / 2).toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="#fff" stroke="#111" stroke-width="${Math.max(10, fs * .05).toFixed(0)}"/><text x="${cx.toFixed(0)}" y="${(y + h * .72).toFixed(0)}" font-size="${fs}" text-anchor="middle" fill="#111" letter-spacing="${(fs * .22).toFixed(0)}">${esc$1(text)}</text>`;
}
/** 文字幅の目安（字間込み。全角 = 1 文字分、半角 = 0.6） */
function textWidth(t, fs) {
	let w = 0;
	for (const ch of t) w += /[\x20-\x7e｡-ﾟ]/.test(ch) ? .6 : 1;
	return w * fs * 1.22;
}
var FONT = `'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
function esc$1(s) {
	return s.replace(/[&<>]/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;"
	})[c]);
}
/** 表（タイトル行＋見出し＋行）。戻り値は svg と高さ */
function svgTable(x, y, title, cols, rows, opts = {}) {
	const fs = opts.fontSize ?? 170;
	const rh = opts.rowH ?? 300;
	const W = cols.reduce((s, c) => s + c.w, 0);
	let s = "";
	let cy = y;
	if (title) {
		s += `<text x="${x}" y="${cy + fs}" font-size="${fs * 1.15}" font-weight="600" fill="#222">${esc$1(title)}</text>`;
		cy += fs * 1.6;
	}
	const cell = (cx, cw, txt, align, bold = false) => {
		return `<text x="${align === "right" ? cx + cw - 60 : align === "center" ? cx + cw / 2 : cx + 60}" y="${cy + rh * .68}" font-size="${fs}" ${bold ? "font-weight=\"600\"" : ""} text-anchor="${align === "right" ? "end" : align === "center" ? "middle" : "start"}" fill="#222">${esc$1(txt)}</text>`;
	};
	s += `<rect x="${x}" y="${cy}" width="${W}" height="${rh}" fill="#efede8" stroke="#333" stroke-width="10"/>`;
	let cx = x;
	for (const c of cols) {
		s += cell(cx, c.w, c.label, "center", true);
		cx += c.w;
	}
	cy += rh;
	for (const r of rows) {
		s += `<rect x="${x}" y="${cy}" width="${W}" height="${rh}" fill="#fff" stroke="#333" stroke-width="10"/>`;
		cx = x;
		cols.forEach((c, i) => {
			s += cell(cx, c.w, r[i] ?? "", c.align ?? "left");
			cx += c.w;
		});
		cy += rh;
	}
	cx = x;
	for (const c of cols.slice(0, -1)) {
		cx += c.w;
		s += `<line x1="${cx}" y1="${y + (title ? fs * 1.6 : 0)}" x2="${cx}" y2="${cy}" stroke="#333" stroke-width="10"/>`;
	}
	return {
		svg: s,
		h: cy - y,
		w: W
	};
}
/** 1 枚の内容を A3 の図枠に入れる（composeSheet の 1 パネル版） */
function wrapSheet(inner, vb, info, opts = {}) {
	return composeSheet([{
		inner,
		vb
	}], info, opts);
}
/**
* 複数の図（パネル）を A3 の図枠に流し込む（左上から右へ並べ、収まらなければ次の段）。
* 1/100 → 1/150 → 1/200 … の順で、全体が収まる縮尺を選ぶ。右側に表などを置く場合は right に渡す。
*/
function composeSheet(panels, info, opts = {}) {
	const MARGIN = 10;
	const TITLE_H = 22;
	const gap = opts.gap ?? 1600;
	const rgap = opts.right ? 1e3 : 0;
	const rightW = opts.right?.w ?? 0;
	const scales = [
		100,
		150,
		200,
		250,
		300,
		400,
		500
	];
	const topH = (d) => opts.top ? opts.top.h * d / 100 + gap * .6 : 0;
	const layout = (availW) => {
		const placed = [];
		let x = 0;
		let y = 0;
		let rowH = 0;
		let maxW = 0;
		for (const p of panels) {
			if (x > 0 && x + p.vb.w > availW) {
				y += rowH + gap;
				x = 0;
				rowH = 0;
			}
			placed.push({
				p,
				x,
				y
			});
			x += p.vb.w + gap;
			rowH = Math.max(rowH, p.vb.h);
			maxW = Math.max(maxW, x - gap);
		}
		return {
			placed,
			w: maxW,
			h: y + rowH
		};
	};
	let denom = scales[scales.length - 1];
	let lay = layout(Infinity);
	for (const d of scales) {
		const margin = MARGIN * d;
		const titleH = TITLE_H * d;
		const availW = 420 * d - margin * 2 - (opts.right ? rightW + rgap : 0);
		const availH = 297 * d - margin * 2 - titleH - topH(d);
		const L = layout(availW);
		if (L.w <= availW && L.h <= availH && (opts.right?.h ?? 0) <= availH) {
			denom = d;
			lay = L;
			break;
		}
		lay = L;
	}
	const W = 420 * denom;
	const H = 297 * denom;
	const margin = MARGIN * denom;
	const titleH = TITLE_H * denom;
	const sw = Math.max(16, denom * .18);
	const fs = denom * 2.4;
	const areaW = W - margin * 2 - (opts.right ? rightW + rgap : 0);
	const areaH = H - margin * 2 - titleH - topH(denom);
	const ox = margin + Math.max(0, (areaW - lay.w) / 2);
	const oy = margin + topH(denom) + Math.max(0, (areaH - lay.h) / 2);
	let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`;
	s += opts.defs ?? "";
	s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
	s += `<rect x="${margin * .5}" y="${margin * .5}" width="${W - margin}" height="${H - margin}" fill="none" stroke="#111" stroke-width="${sw * 2}"/>`;
	s += `<rect x="${margin * .5 + sw * 6}" y="${margin * .5 + sw * 6}" width="${W - margin - sw * 12}" height="${H - margin - sw * 12}" fill="none" stroke="#111" stroke-width="${sw * .6}"/>`;
	for (const pl of lay.placed) s += `<g transform="translate(${ox + pl.x - pl.p.vb.x} ${oy + pl.y - pl.p.vb.y})">${pl.p.inner.replace(/\{\{SCALE\}\}/g, String(denom))}</g>`;
	if (opts.right) s += `<g transform="translate(${W - margin - rightW} ${margin + topH(denom)})">${opts.right.svg}</g>`;
	if (opts.top) {
		const k = (W - margin * 2) / opts.top.w;
		s += `<g transform="translate(${margin} ${margin}) scale(${k.toFixed(4)})">${opts.top.svg}</g>`;
	}
	const bx = margin * .5 + sw * 6;
	const by = H - margin * .5 - sw * 6 - titleH;
	const bw = W - margin - sw * 12;
	s += `<rect x="${bx}" y="${by}" width="${bw}" height="${titleH}" fill="#fff" stroke="#111" stroke-width="${sw * 1.2}"/>`;
	const col = [
		.235,
		.06,
		.29,
		.045,
		.045,
		.265,
		.06
	];
	const xs = [bx];
	for (const c of col) xs.push(xs[xs.length - 1] + bw * c);
	const midY = by + titleH / 2;
	const lab = (x, y, t) => `<text x="${(x + fs * .35).toFixed(0)}" y="${(y + fs * .95).toFixed(0)}" font-size="${(fs * .62).toFixed(0)}" fill="#111">${esc$1(t)}</text>`;
	const vline = (x) => `<line x1="${x.toFixed(0)}" y1="${by}" x2="${x.toFixed(0)}" y2="${by + titleH}" stroke="#111" stroke-width="${sw * .8}"/>`;
	const hline = (x0, x1, y, dash = false) => `<line x1="${x0.toFixed(0)}" y1="${y.toFixed(0)}" x2="${x1.toFixed(0)}" y2="${y.toFixed(0)}" stroke="#111" stroke-width="${sw * .6}"${dash ? " stroke-dasharray=\"40 40\"" : ""}/>`;
	for (const x of xs.slice(1, -1)) s += vline(x);
	s += hline(xs[0], xs[1], midY);
	s += lab(xs[0], by, "工事名") + lab(xs[0], midY, "図面名");
	s += `<text x="${((xs[0] + xs[1]) / 2).toFixed(0)}" y="${(by + titleH * .36).toFixed(0)}" font-size="${(fs * 1.25).toFixed(0)}" text-anchor="middle" fill="#111" letter-spacing="${(fs * .3).toFixed(0)}">${esc$1(info.project)}</text>`;
	s += `<text x="${((xs[0] + xs[1]) / 2).toFixed(0)}" y="${(by + titleH * .86).toFixed(0)}" font-size="${(fs * 1.15).toFixed(0)}" text-anchor="middle" fill="#111" letter-spacing="${(fs * .3).toFixed(0)}">${esc$1(info.drawing)}</text>`;
	s += hline(xs[1], xs[2], midY);
	s += lab(xs[1], by, "縮尺") + lab(xs[1], midY, "日付");
	s += `<text x="${((xs[1] + xs[2]) / 2).toFixed(0)}" y="${(by + titleH * .4).toFixed(0)}" font-size="${(fs * 1.05).toFixed(0)}" text-anchor="middle" fill="#111">1/${denom}</text>`;
	s += `<text x="${((xs[1] + xs[2]) / 2).toFixed(0)}" y="${(by + titleH * .9).toFixed(0)}" font-size="${(fs * 1).toFixed(0)}" text-anchor="middle" fill="#111">${esc$1(warekiOf(info.date))}</text>`;
	s += lab(xs[2], by, "図面更新日");
	for (let k = 1; k <= 4; k++) s += hline(xs[2] + fs * .3, xs[3] - fs * .3, by + titleH * k / 5, true);
	s += lab(xs[3], by, "設計者") + lab(xs[4], by, "担当者");
	if (info.designer) s += `<text x="${((xs[3] + xs[4]) / 2).toFixed(0)}" y="${(by + titleH * .7).toFixed(0)}" font-size="${(fs * .9).toFixed(0)}" text-anchor="middle" fill="#111">${esc$1(info.designer)}</text>`;
	if (info.staff) s += `<text x="${((xs[4] + xs[5]) / 2).toFixed(0)}" y="${(by + titleH * .7).toFixed(0)}" font-size="${(fs * .9).toFixed(0)}" text-anchor="middle" fill="#111">${esc$1(info.staff)}</text>`;
	{
		const x0 = xs[5];
		const cw = xs[6] - xs[5];
		const logoW = info.logo ? titleH * .72 : 0;
		if (info.logo) s += `<image href="${info.logo}" x="${(x0 + fs * .8).toFixed(0)}" y="${(by + titleH * .14).toFixed(0)}" width="${logoW.toFixed(0)}" height="${(titleH * .72).toFixed(0)}" preserveAspectRatio="xMidYMid meet"/>`;
		const name = (info.company ?? info.designer ?? "").trim();
		const [l1, l2] = name.includes("　") ? name.split("　", 2) : name.includes(" ") ? name.split(" ", 2) : /一級建築士事務所$/.test(name) ? [name.replace(/一級建築士事務所$/, ""), "一級建築士事務所"] : [name, ""];
		const nx = x0 + fs * .8 + logoW + fs * .8;
		if (l1) s += `<text x="${nx.toFixed(0)}" y="${(by + titleH * .44).toFixed(0)}" font-size="${(fs * 1.45).toFixed(0)}" fill="#111" letter-spacing="${(fs * .12).toFixed(0)}">${esc$1(l1)}</text>`;
		if (l2) s += `<text x="${nx.toFixed(0)}" y="${(by + titleH * .84).toFixed(0)}" font-size="${(fs * 1.2).toFixed(0)}" fill="#111" letter-spacing="${(fs * .42).toFixed(0)}">${esc$1(l2)}</text>`;
		if (info.license) {
			const parts = info.license.split(/[　 ]+/).filter(Boolean);
			const lx = x0 + cw - fs * .8;
			s += `<text x="${lx.toFixed(0)}" y="${(by + titleH * .42).toFixed(0)}" font-size="${(fs * .85).toFixed(0)}" text-anchor="end" fill="#111">${esc$1(parts[0] ?? "")}</text>`;
			if (parts.length > 1) s += `<text x="${(lx - fs * .6).toFixed(0)}" y="${(by + titleH * .84).toFixed(0)}" font-size="${(fs * 1.05).toFixed(0)}" text-anchor="end" fill="#111" letter-spacing="${(fs * .35).toFixed(0)}">${esc$1(parts.slice(1).join("　"))}</text>`;
		}
	}
	s += lab(xs[6], by, "図面NO");
	if (info.no) s += `<text x="${((xs[6] + xs[7]) / 2).toFixed(0)}" y="${(by + titleH * .74).toFixed(0)}" font-size="${(fs * 1.5).toFixed(0)}" text-anchor="middle" fill="#111">${esc$1(info.no)}</text>`;
	s += `</svg>`;
	return s;
}
//#endregion
//#region src/drawings/plan.ts
/**
* プレゼン用の清書平面図（SVG）
* 部屋を色分けし、壁・建具・室名・帖数・寸法・方位を描く。
*/
/** 外構（3D と同じ配置: 駐車場・アプローチ・植栽） */
var landscapeCache = /* @__PURE__ */ new WeakMap();
function landscapeOf(model) {
	if (landscapeCache.has(model)) return landscapeCache.get(model);
	let lp = null;
	try {
		const ext = EXTERIOR_STYLES[0];
		const { meta } = buildBuilding(model, { exterior: ext });
		lp = buildLandscape(meta, ext, model.site).plan;
	} catch {
		lp = null;
	}
	landscapeCache.set(model, lp);
	return lp;
}
/** 樹木: ゆらぎのある輪郭の樹冠 */
function treeSvg(x, y, r, seed) {
	const n = 28;
	const pts = [];
	for (let i = 0; i < n; i++) {
		const a = i / n * Math.PI * 2;
		const k = 1 + .07 * Math.sin(a * 7 + seed) + .04 * Math.sin(a * 13 + seed * 2.3);
		pts.push(`${(x + Math.cos(a) * r * k).toFixed(0)},${(y + Math.sin(a) * r * k).toFixed(0)}`);
	}
	return `<polygon points="${pts.join(" ")}" fill="#d3dfc4" fill-opacity="0.82" stroke="#8ea47c" stroke-width="12"/><circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(r * .55).toFixed(0)}" fill="none" stroke="#a9bb98" stroke-width="7" stroke-dasharray="50 40"/><circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="45" fill="#8ea47c"/>`;
}
/** 車（平面図の記号） */
function carSvg(x, y, dx, dy) {
	const L = 4600;
	const W = 1760;
	const ang = Math.atan2(dy, dx) * 180 / Math.PI;
	return `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) rotate(${ang.toFixed(1)})"><rect x="-2300" y="-880" width="${L}" height="${W}" rx="420" fill="#fff" stroke="#9a958e" stroke-width="12"/><rect x="-828" y="-720" width="${L * .42}" height="1440" rx="200" fill="none" stroke="#b5b0a8" stroke-width="10"/><line x1="${L * .24}" y1="-700" x2="${L * .24}" y2="${W / 2 - 180}" stroke="#b5b0a8" stroke-width="10"/></g>`;
}
/** 家具の外形（モデルごとに1回だけ計算） */
var furnitureCache = /* @__PURE__ */ new WeakMap();
function furnitureOf$1(model, level) {
	let m = furnitureCache.get(model);
	if (!m) {
		try {
			m = planFurniture(model);
		} catch {
			m = /* @__PURE__ */ new Map();
		}
		furnitureCache.set(model, m);
	}
	return m.get(level) ?? [];
}
/** 家具を平面図の線で描く（高さの低いものから順に重ねる） */
function furnitureSvg(items, hl = false) {
	let s = "";
	const sorted = items.slice().sort((a, b) => a.top - b.top);
	for (const it of sorted) {
		const rug = it.key === "f.rug";
		const fill = hl ? rug ? "none" : "#fff" : rug ? "none" : it.key === "f.bedding" || it.key.startsWith("f.fabric") ? "#fdfcfa" : it.key === "f.counter" || it.key === "f.cabinet" ? "#f4f1ec" : "#faf8f4";
		const stroke = hl ? rug ? "#999" : "#444" : rug ? "#bdb5aa" : "#76716a";
		const dash = rug ? " stroke-dasharray=\"60 40\"" : "";
		if (it.shape === "circle") {
			s += `<circle cx="${(it.cx * 1e3).toFixed(0)}" cy="${(it.cz * 1e3).toFixed(0)}" r="${(it.r * 1e3).toFixed(0)}" fill="${fill}" stroke="${stroke}" stroke-width="9"${dash}/>`;
			continue;
		}
		const ax = it.ax;
		const az = it.az;
		const bx = -az;
		const bz = ax;
		const hw = it.w * 1e3 / 2;
		const hd = it.d * 1e3 / 2;
		const cx = it.cx * 1e3;
		const cz = it.cz * 1e3;
		const p = (sa, sb) => `${(cx + ax * hw * sa + bx * hd * sb).toFixed(0)},${(cz + az * hw * sa + bz * hd * sb).toFixed(0)}`;
		s += `<polygon points="${p(-1, -1)} ${p(1, -1)} ${p(1, 1)} ${p(-1, 1)}" fill="${fill}" stroke="${stroke}" stroke-width="9" stroke-linejoin="round"${dash}/>`;
	}
	return s;
}
var ROOM_COLORS = {
	ldk: "#f6e7cf",
	living: "#f6e7cf",
	dining: "#f6e7cf",
	kitchen: "#f3e1c4",
	japanese: "#e3e8c8",
	bedroom: "#e3ecf5",
	kids: "#f3e3ea",
	study: "#ece6f3",
	bath: "#dcecf1",
	washroom: "#dcecf1",
	toilet: "#dcecf1",
	entrance: "#e9e6e0",
	hall: "#f1efea",
	stairs: "#efece6",
	closet: "#ece8df",
	storage: "#ece8df",
	balcony: "#e4e4e4",
	porch: "#e4e4e4",
	garage: "#e4e4e4",
	void: "#ffffff",
	other: "#f1efea"
};
var FINISH = {
	ldk: "wood",
	living: "wood",
	dining: "wood",
	kitchen: "wood",
	bedroom: "wood",
	kids: "wood",
	study: "wood",
	hall: "wood",
	closet: "wood",
	storage: "wood",
	other: "wood",
	stairs: "wood",
	japanese: "tatami",
	bath: "tile",
	washroom: "tile",
	toilet: "tile",
	entrance: "stone",
	porch: "stone",
	balcony: "deck",
	garage: "concrete",
	void: "none"
};
var FINISH_FILL = {
	wood: "#f1e8da",
	tatami: "#e6e7cb",
	tile: "#eceeef",
	stone: "#e3e0da",
	deck: "#e6ddcf",
	concrete: "#e8e7e4",
	none: "#ffffff"
};
/** 目地・板目のパターン（mm 単位。複数の図を1ページに並べても同じ定義なので ID は共通） */
var PLAN_DEFS = "<defs><pattern id=\"mp-wood-h\" patternUnits=\"userSpaceOnUse\" width=\"1820\" height=\"150\"><rect width=\"1820\" height=\"150\" fill=\"#f1e8da\"/><line x1=\"0\" y1=\"0\" x2=\"1820\" y2=\"0\" stroke=\"#e1d3bf\" stroke-width=\"7\"/><line x1=\"0\" y1=\"0\" x2=\"0\" y2=\"150\" stroke=\"#e6dac8\" stroke-width=\"5\"/></pattern><pattern id=\"mp-wood-v\" patternUnits=\"userSpaceOnUse\" width=\"150\" height=\"1820\"><rect width=\"150\" height=\"1820\" fill=\"#f1e8da\"/><line x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1820\" stroke=\"#e1d3bf\" stroke-width=\"7\"/><line x1=\"0\" y1=\"0\" x2=\"150\" y2=\"0\" stroke=\"#e6dac8\" stroke-width=\"5\"/></pattern><pattern id=\"mp-tile\" patternUnits=\"userSpaceOnUse\" width=\"300\" height=\"300\"><rect width=\"300\" height=\"300\" fill=\"#eceeef\"/><path d=\"M0 0H300M0 0V300\" stroke=\"#dcdfe1\" stroke-width=\"6\" fill=\"none\"/></pattern><pattern id=\"mp-stone\" patternUnits=\"userSpaceOnUse\" width=\"600\" height=\"600\"><rect width=\"600\" height=\"600\" fill=\"#e3e0da\"/><path d=\"M0 0H600M0 0V600\" stroke=\"#d2cec6\" stroke-width=\"7\" fill=\"none\"/></pattern><pattern id=\"mp-deck\" patternUnits=\"userSpaceOnUse\" width=\"1000\" height=\"120\"><rect width=\"1000\" height=\"120\" fill=\"#e6ddcf\"/><line x1=\"0\" y1=\"0\" x2=\"1000\" y2=\"0\" stroke=\"#d3c6b2\" stroke-width=\"10\"/></pattern></defs>";
/** 室名の下に (帖) を書く部屋（御社の図面: 居室・LDK・縁側・納戸・パントリーなど広さを示す部屋。水まわり・ホール・物入には書かない） */
var TATAMI_ROOMS = /* @__PURE__ */ new Set([
	"ldk",
	"living",
	"dining",
	"kitchen",
	"japanese",
	"bedroom",
	"kids",
	"study",
	"other"
]);
var OPENING_KIND_JA = {
	window: "窓",
	door: "片開き戸",
	sliding: "引戸",
	entrance: "玄関戸",
	open: "開口"
};
/** 建具表: 窓は W1…、戸は D1…、開口は O1… の順に番号を付ける */
function openingSchedule(f) {
	const out = [];
	const counters = {
		W: 0,
		D: 0,
		O: 0
	};
	const walls = f.walls.slice().sort((a, b) => a.id.localeCompare(b.id, void 0, { numeric: true }));
	for (const w of walls) {
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		if (L < 1) continue;
		const ux = (w.b.x - w.a.x) / L;
		const uy = (w.b.y - w.a.y) / L;
		const nx = -uy;
		const ny = ux;
		const sgn = w.exterior ? w.outsideSign ?? 1 : 1;
		const ops = f.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t0 - b.t0);
		for (const o of ops) {
			const pre = o.kind === "window" ? "W" : o.kind === "open" ? "O" : "D";
			counters[pre]++;
			const tm = (o.t0 + o.t1) / 2;
			const off = w.thickness / 2 + 420;
			out.push({
				id: o.id,
				tag: `${pre}${counters[pre]}`,
				kindJa: o.windowStyle === "hakidashi" ? "掃出し窓" : o.windowStyle === "koshi" ? "腰窓" : o.windowStyle === "high" ? "高窓" : o.windowStyle === "small" ? "小窓" : OPENING_KIND_JA[o.kind] ?? o.kind,
				w: Math.round(o.t1 - o.t0),
				h: Math.round(o.height),
				sill: Math.round(o.sill),
				x: w.a.x + ux * tm + nx * off * sgn,
				y: w.a.y + uy * tm + ny * off * sgn
			});
		}
	}
	return out;
}
/** 階の床面積（㎡）: 吹抜・バルコニー・ポーチ・車庫を除く */
function floorArea(f) {
	return f.rooms.filter((r) => r.type !== "void" && r.type !== "balcony" && r.type !== "porch" && r.type !== "garage").reduce((a, r) => a + r.area, 0);
}
/** 外形の面積（㎡。穴は引く） */
function outlineArea(f) {
	const area = (loop) => {
		let a = 0;
		for (let i = 0; i < loop.length; i++) {
			const p = loop[i];
			const q = loop[(i + 1) % loop.length];
			a += p.x * q.y - q.x * p.y;
		}
		return a / 2;
	};
	const vals = f.outline.map(area);
	const outer = Math.max(...vals.map((v) => Math.abs(v)), 0);
	let total = outer;
	for (const v of vals) if (Math.abs(v) !== outer) total -= Math.abs(v);
	return total / 1e6;
}
/** 面積表（階別床面積・延床・建築面積・敷地面積・建蔽率・容積率） */
function areaTableSvg(model, x, y) {
	const rows = [];
	let total = 0;
	for (const f of model.floors) {
		const a = floorArea(f);
		total += a;
		rows.push([
			`${f.level}階 床面積`,
			`${a.toFixed(2)} ㎡`,
			`${(a / 3.30579).toFixed(2)} 坪`
		]);
	}
	rows.push([
		"延床面積",
		`${total.toFixed(2)} ㎡`,
		`${(total / 3.30579).toFixed(2)} 坪`
	]);
	const bld = Math.max(...model.floors.map(outlineArea), 0);
	rows.push([
		"建築面積",
		`${bld.toFixed(2)} ㎡`,
		`${(bld / 3.30579).toFixed(2)} 坪`
	]);
	const site = model.site?.areaM2;
	if (site) {
		rows.push([
			"敷地面積",
			`${site.toFixed(2)} ㎡`,
			`${(site / 3.30579).toFixed(2)} 坪`
		]);
		rows.push([
			"建蔽率",
			`${(bld / site * 100).toFixed(1)} %`,
			""
		]);
		rows.push([
			"容積率",
			`${(total / site * 100).toFixed(1)} %`,
			""
		]);
	}
	try {
		const tk = takeoff(model, {
			grade: "P",
			eavesMm: 100,
			pitch: .5,
			roofType: "shed",
			solido: "none"
		});
		rows.push([
			"外壁面積",
			`${tk.extWall.toFixed(1)} ㎡`,
			""
		]);
		rows.push([
			"屋根面積",
			`${tk.roofArea.toFixed(1)} ㎡`,
			""
		]);
	} catch {}
	return svgTable(x, y, "面積表", [
		{
			label: "項目",
			w: 3400
		},
		{
			label: "㎡",
			w: 2600,
			align: "right"
		},
		{
			label: "坪",
			w: 2400,
			align: "right"
		}
	], rows, {
		fontSize: 260,
		rowH: 440
	});
}
/** 建具表（この階） */
function openingTableSvg(f, x, y, maxRows = 22) {
	const sch = openingSchedule(f);
	const rows = sch.slice(0, maxRows).map((e) => [
		e.tag,
		e.kindJa,
		`${e.w}`,
		`${e.h}`,
		e.sill ? `${e.sill}` : "-"
	]);
	if (sch.length > maxRows) rows.push([
		`ほか ${sch.length - maxRows}`,
		"",
		"",
		"",
		""
	]);
	return svgTable(x, y, `建具表（${f.level}階）`, [
		{
			label: "記号",
			w: 1300,
			align: "center"
		},
		{
			label: "種別",
			w: 2900
		},
		{
			label: "W",
			w: 1300,
			align: "right"
		},
		{
			label: "H",
			w: 1300,
			align: "right"
		},
		{
			label: "腰高",
			w: 1600,
			align: "right"
		}
	], rows, {
		fontSize: 240,
		rowH: 400
	});
}
function floorPlanSvg(model, f, opts = {}) {
	const parts = floorPlanParts(model, f, opts);
	if (opts.sheet) {
		const at = areaTableSvg(model, 0, 0);
		const ot = openingTableSvg(f, 0, at.h + 700);
		const right = {
			svg: at.svg + ot.svg,
			w: Math.max(at.w, ot.w),
			h: at.h + 700 + ot.h
		};
		return wrapSheet(parts.inner, parts.vb, opts.sheet, {
			right,
			defs: parts.defs
		});
	}
	const vb = parts.vb;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">${parts.defs}<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#fff"/>${parts.inner}</svg>`;
}
/** 平面図の中身（図枠に流し込む用）。図枠に入れる時は外構・道路を描かない（図面としての密度を優先） */
function floorPlanParts(model, f, opts = {}) {
	if (opts.sheet) opts = {
		showLandscape: false,
		showRoad: false,
		...opts
	};
	const hl = (opts.style ?? "hl") === "hl";
	const pts = f.outline.flat().concat(f.walls.flatMap((w) => [w.a, w.b]));
	const minX = Math.min(...pts.map((p) => p.x));
	const maxX = Math.max(...pts.map((p) => p.x));
	const minY = Math.min(...pts.map((p) => p.y));
	const maxY = Math.max(...pts.map((p) => p.y));
	const pad = 1800;
	const vb = {
		x: minX - pad,
		y: minY - pad,
		w: maxX - minX + pad * 2,
		h: maxY - minY + pad * 2 + 900
	};
	let s = "";
	const land = f.level === 1 && opts.showLandscape !== false ? landscapeOf(model) : null;
	if (land) {
		for (const pv of land.paving) {
			const pts = pv.pts.map((q) => `${(q.x * 1e3).toFixed(0)},${(q.z * 1e3).toFixed(0)}`).join(" ");
			s += pv.key === "l.approach" ? `<polygon points="${pts}" fill="url(#mp-stone)" stroke="#c9c4bc" stroke-width="10"/>` : `<polygon points="${pts}" fill="#ebe9e5" stroke="#cfcbc4" stroke-width="10"/>`;
		}
		for (const c of land.cars) s += carSvg(c.x * 1e3, c.z * 1e3, c.dirX, c.dirZ);
	}
	for (const r of f.rooms) {
		const fin = FINISH[r.type] ?? "wood";
		const xs0 = r.polygon.map((p) => p.x);
		const ys0 = r.polygon.map((p) => p.y);
		const wide = Math.max(...xs0) - Math.min(...xs0) >= Math.max(...ys0) - Math.min(...ys0);
		const pat = fin === "wood" ? `url(#mp-wood-${wide ? "h" : "v"})` : fin === "tile" ? "url(#mp-tile)" : fin === "stone" ? "url(#mp-stone)" : fin === "deck" ? "url(#mp-deck)" : FINISH_FILL[fin];
		const fill = opts.roomTint?.[r.id] ?? (opts.colorCoded ? ROOM_COLORS[r.type] ?? "#f1efea" : hl ? "#fff" : pat);
		const stroke = opts.highlightRoomId === r.id ? "#d9822b" : "none";
		s += `<polygon points="${r.polygon.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="${stroke === "none" ? 0 : 60}"/>`;
		if (r.type === "japanese") {
			const xs = r.polygon.map((p) => p.x);
			const ys = r.polygon.map((p) => p.y);
			const x0 = Math.min(...xs);
			const x1 = Math.max(...xs);
			const y0 = Math.min(...ys);
			const y1 = Math.max(...ys);
			const tc = hl ? "#999" : "#b9bf96";
			for (let x = x0 + 910; x < x1 - 100; x += 910) s += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="${tc}" stroke-width="${hl ? 7 : 12}"/>`;
			for (let y = y0 + 1820; y < y1 - 100; y += 1820) s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${tc}" stroke-width="${hl ? 7 : 12}"/>`;
		}
	}
	if (opts.showFurniture !== false) s += furnitureSvg(furnitureOf$1(model, f.level), hl);
	for (const st of f.stairs) {
		const lay = stairLayout(st, stairStepCount(f.height || 2900, st));
		s += `<rect x="${st.minX}" y="${st.minY}" width="${st.maxX - st.minX}" height="${st.maxY - st.minY}" fill="${hl ? "#f3e6c9" : "#f7f5f0"}" stroke="${hl ? "#777" : "#999"}" stroke-width="${hl ? 8 : 10}"/>`;
		for (const p of lay.pieces) s += `<rect x="${p.minX.toFixed(0)}" y="${p.minY.toFixed(0)}" width="${(p.maxX - p.minX).toFixed(0)}" height="${(p.maxY - p.minY).toFixed(0)}" fill="none" stroke="${hl ? "#555" : "#aaa"}" stroke-width="${hl ? 7 : 8}"/>`;
		const cs = lay.pieces.map((p) => `${((p.minX + p.maxX) / 2).toFixed(0)},${((p.minY + p.maxY) / 2).toFixed(0)}`);
		if (cs.length > 1) s += `<polyline points="${cs.join(" ")}" fill="none" stroke="${hl ? "#333" : "#888"}" stroke-width="${hl ? 9 : 12}"/>`;
		const last = lay.pieces[lay.pieces.length - 1];
		if (last) {
			const cx = (last.minX + last.maxX) / 2;
			const cy = (last.minY + last.maxY) / 2;
			const d = last.dir;
			const tip = {
				x: cx + d.x * 160,
				y: cy + d.y * 160
			};
			s += `<polygon points="${tip.x.toFixed(0)},${tip.y.toFixed(0)} ${(cx - d.y * 90).toFixed(0)},${(cy + d.x * 90).toFixed(0)} ${(cx + d.y * 90).toFixed(0)},${(cy - d.x * 90).toFixed(0)}" fill="${hl ? "#333" : "#888"}"/>`;
		}
		const first = lay.pieces[0];
		if (first) s += `<text x="${((first.minX + first.maxX) / 2).toFixed(0)}" y="${((first.minY + first.maxY) / 2 + 60).toFixed(0)}" font-size="${hl ? 190 : 160}" text-anchor="middle" fill="${hl ? "#111" : "#777"}" stroke="#fff" stroke-width="40" paint-order="stroke">${st.goesUp ? "UP" : "DN"}</text>`;
	}
	const mod = model.module;
	if (mod && (opts.showModuleGrid ?? !!opts.sheet)) {
		const step = mod.size;
		const gx0 = mod.phaseX + Math.floor((minX - mod.phaseX) / step) * step;
		const gy0 = mod.phaseY + Math.floor((minY - mod.phaseY) / step) * step;
		let g = "";
		for (let x = gx0; x <= maxX + step; x += step) g += `M${x.toFixed(0)} ${(minY - 600).toFixed(0)}V${(maxY + 600).toFixed(0)}`;
		for (let y = gy0; y <= maxY + step; y += step) g += `M${(minX - 600).toFixed(0)} ${y.toFixed(0)}H${(maxX + 600).toFixed(0)}`;
		s += `<path d="${g}" fill="none" stroke="#9b9589" stroke-width="7" stroke-dasharray="70 90" stroke-opacity="0.55"/>`;
	}
	for (const w of f.walls) {
		const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		if (L < 1) continue;
		const ux = (w.b.x - w.a.x) / L;
		const uy = (w.b.y - w.a.y) / L;
		const nx = -uy;
		const ny = ux;
		const ops = f.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t0 - b.t0);
		const solid = [];
		let cur = 0;
		for (const o of ops) {
			if (o.t0 > cur) solid.push([cur, o.t0]);
			cur = Math.max(cur, o.t1);
		}
		if (cur < L) solid.push([cur, L]);
		const h = w.thickness / 2;
		for (const [t0, t1] of solid) {
			const p = (t, sgn) => `${(w.a.x + ux * t + nx * h * sgn).toFixed(0)},${(w.a.y + uy * t + ny * h * sgn).toFixed(0)}`;
			s += hl ? `<polygon points="${p(t0, 1)} ${p(t1, 1)} ${p(t1, -1)} ${p(t0, -1)}" fill="#5e5e5e" stroke="#111" stroke-width="7"/>` : `<polygon points="${p(t0, 1)} ${p(t1, 1)} ${p(t1, -1)} ${p(t0, -1)}" fill="#2b2b2b"/>`;
		}
		if (hl) {
			const posts = [0, L];
			for (const o of ops) if (o.kind === "window") posts.push(o.t0, o.t1);
			for (const t of posts) {
				const cx = w.a.x + ux * t;
				const cy = w.a.y + uy * t;
				const q = [
					[cx + ux * 52 + nx * 52, cy + uy * 52 + ny * 52],
					[cx - ux * 52 + nx * 52, cy - uy * 52 + ny * 52],
					[cx - ux * 52 - nx * 52, cy - uy * 52 - ny * 52],
					[cx + ux * 52 - nx * 52, cy + uy * 52 - ny * 52]
				];
				s += `<polygon points="${q.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(" ")}" fill="#1a1a1a" stroke="#000" stroke-width="5"/>`;
			}
		}
		for (const o of ops) {
			const a = {
				x: w.a.x + ux * o.t0,
				y: w.a.y + uy * o.t0
			};
			const b = {
				x: w.a.x + ux * o.t1,
				y: w.a.y + uy * o.t1
			};
			const len = o.t1 - o.t0;
			const P = (t, off) => ({
				x: a.x + ux * t + nx * off,
				y: a.y + uy * t + ny * off
			});
			const leaf = (t0, t1, off, th) => {
				return `<polygon points="${[
					P(t0, off - th / 2),
					P(t1, off - th / 2),
					P(t1, off + th / 2),
					P(t0, off + th / 2)
				].map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ")}" fill="#fff" stroke="#222" stroke-width="10"/>`;
			};
			if (o.kind === "window" && hl) {
				const ln = (p0, p1, wd = 7, col = "#111") => `<line x1="${p0.x.toFixed(0)}" y1="${p0.y.toFixed(0)}" x2="${p1.x.toFixed(0)}" y2="${p1.y.toFixed(0)}" stroke="${col}" stroke-width="${wd}"/>`;
				for (const k of [-1, 1]) s += ln(P(0, h * k), P(len, h * k));
				const style = o.windowStyle ?? (len >= 1600 ? "hakidashi" : len >= 1200 ? "koshi" : "small");
				if (style === "hakidashi" || style === "koshi" || style !== "small" && style !== "slit" && style !== "high" && len >= 1200) {
					const g = Math.min(28, h * .4);
					s += ln(P(0, -g), P(len * .53, -g)) + ln(P(len * .47, g), P(len, g));
					s += ln(P(len * .53, -g), P(len * .53, g)) + ln(P(len * .47, -g), P(len * .47, g));
				} else {
					s += ln(P(0, 0), P(len, 0));
					if (style === "small" || style === "slit") {
						const out = w.exterior ? w.outsideSign ?? 1 : 1;
						const a0 = P(0, h * out);
						const a1 = P(len, h * out);
						const ap = P(len / 2, (h + Math.min(len * .45, 420)) * out);
						s += `<polygon points="${a0.x.toFixed(0)},${a0.y.toFixed(0)} ${ap.x.toFixed(0)},${ap.y.toFixed(0)} ${a1.x.toFixed(0)},${a1.y.toFixed(0)}" fill="none" stroke="#111" stroke-width="6"/>`;
					}
				}
				for (const t of [0, len]) s += ln(P(t, -h), P(t, h));
			} else if (o.kind === "window") {
				for (const k of [-1, 1]) {
					const p0 = P(0, h * k);
					const p1 = P(len, h * k);
					s += `<line x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}" stroke="#333" stroke-width="9"/>`;
				}
				const g0 = P(0, 0);
				const g1 = P(len, 0);
				s += `<line x1="${g0.x}" y1="${g0.y}" x2="${g1.x}" y2="${g1.y}" stroke="#5f8fb0" stroke-width="16"/>`;
				for (const t of [0, len]) {
					const e0 = P(t, -h);
					const e1 = P(t, h);
					s += `<line x1="${e0.x}" y1="${e0.y}" x2="${e1.x}" y2="${e1.y}" stroke="#333" stroke-width="9"/>`;
				}
			} else if (o.kind === "door" || o.kind === "entrance") {
				const hingeAtStart = o.hingeAtStart !== false;
				const hinge = hingeAtStart ? a : b;
				const strike = hingeAtStart ? b : a;
				const side = o.swingSide ?? 1;
				const tip = {
					x: hinge.x + nx * len * side,
					y: hinge.y + ny * len * side
				};
				const tk = o.kind === "entrance" ? 50 : 40;
				const dirU = hingeAtStart ? 1 : -1;
				const hb = {
					x: hinge.x + nx * h * side,
					y: hinge.y + ny * h * side
				};
				const lp = [
					hb,
					{
						x: hb.x + ux * dirU * tk,
						y: hb.y + uy * dirU * tk
					},
					{
						x: tip.x + ux * dirU * tk,
						y: tip.y + uy * dirU * tk
					},
					tip
				];
				const sweep = cross(strike.x - hinge.x, strike.y - hinge.y, tip.x - hinge.x, tip.y - hinge.y) > 0 ? 1 : 0;
				s += `<path d="M${tip.x.toFixed(0)} ${tip.y.toFixed(0)} A${len} ${len} 0 0 ${sweep} ${strike.x.toFixed(0)} ${strike.y.toFixed(0)}" fill="none" stroke="${hl ? "#222" : "#555"}" stroke-width="6"/>`;
				s += `<polygon points="${lp.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ")}" fill="#fff" stroke="#222" stroke-width="${hl ? 7 : 9}"/>`;
			} else if (o.kind === "sliding") {
				for (const t of [0, len]) {
					const e0 = P(t, -h);
					const e1 = P(t, h);
					s += `<line x1="${e0.x.toFixed(0)}" y1="${e0.y.toFixed(0)}" x2="${e1.x.toFixed(0)}" y2="${e1.y.toFixed(0)}" stroke="#333" stroke-width="9"/>`;
				}
				const th = 36;
				const off = Math.min(h * .5, 28);
				if (len >= 1200) {
					s += leaf(0, len * .53, -off, th);
					s += leaf(len * .47, len, off, th);
				} else s += leaf(0, len, off, th);
			}
		}
	}
	if (land) {
		land.shrubs.forEach((t, i) => s += `<circle cx="${(t.x * 1e3).toFixed(0)}" cy="${(t.z * 1e3).toFixed(0)}" r="${(t.r * 1e3).toFixed(0)}" fill="#c9d8b8" fill-opacity="0.85" stroke="#93a982" stroke-width="10"/>` + (i < 0 ? "" : ""));
		land.trees.forEach((t, i) => s += treeSvg(t.x * 1e3, t.z * 1e3, t.r * 1e3, i * 1.7 + .4));
	}
	for (const r of f.rooms) {
		if (r.type === "stairs") continue;
		const name = r.name.normalize("NFKC");
		const c = r.labelPos ?? polygonCentroid(r.polygon);
		const xs = r.polygon.map((p) => p.x);
		const ys = r.polygon.map((p) => p.y);
		const rw = Math.max(...xs) - Math.min(...xs);
		const rh = Math.max(...ys) - Math.min(...ys);
		const big = r.area > 4;
		const fs = Math.max(120, Math.min(big ? 230 : 180, rw * .86 / textEm(name), rh * .3));
		const tatami = r.labeledTatami ?? r.area / 1.62;
		const halo = `stroke="#fff" stroke-width="${Math.round(fs * .22)}" stroke-linejoin="round" paint-order="stroke"`;
		if (hl) {
			const showTatami = TATAMI_ROOMS.has(r.type) && r.area >= 2.4;
			const tj = Math.abs(tatami - Math.round(tatami)) < .08 ? `${Math.round(tatami)}` : tatami.toFixed(1);
			s += `<text x="${c.x}" y="${c.y + (showTatami ? -fs * .15 : fs * .35)}" font-size="${fs.toFixed(0)}" text-anchor="middle" fill="#111" letter-spacing="${(fs * .08).toFixed(0)}" ${halo}>${esc(name)}</text>`;
			if (showTatami) s += `<text x="${c.x}" y="${c.y + fs * .85}" font-size="${(fs * .82).toFixed(0)}" text-anchor="middle" fill="#111" ${halo}>(${tj}帖)</text>`;
			continue;
		}
		s += `<text x="${c.x}" y="${c.y - (big ? 30 : -fs * .35)}" font-size="${fs.toFixed(0)}" text-anchor="middle" fill="#2a2a2a" font-weight="500" letter-spacing="${(fs * .06).toFixed(0)}" ${halo}>${esc(name)}</text>`;
		if (big) s += `<text x="${c.x}" y="${c.y + fs * .95}" font-size="${(fs * .68).toFixed(0)}" text-anchor="middle" fill="#7a7a7a" ${halo}>${tatami.toFixed(1)}帖</text>`;
	}
	let dimsBelow = false;
	if (opts.showDims !== false) {
		const op = f.outline.flat();
		const src = op.length ? op : pts;
		const ox0 = Math.min(...src.map((p) => p.x));
		const ox1 = Math.max(...src.map((p) => p.x));
		const oy0 = Math.min(...src.map((p) => p.y));
		const oy1 = Math.max(...src.map((p) => p.y));
		const edges = model.floors[0] === f ? model.site?.edges ?? [] : [];
		const clearance = (side) => {
			let best = Infinity;
			for (const e of edges) for (let i = 0; i <= 20; i++) {
				const x = e.a.x + (e.b.x - e.a.x) * i / 20;
				const y = e.a.y + (e.b.y - e.a.y) * i / 20;
				if (side === "top" && x > ox0 && x < ox1 && y < oy0) best = Math.min(best, oy0 - y);
				if (side === "bottom" && x > ox0 && x < ox1 && y > oy1) best = Math.min(best, y - oy1);
				if (side === "left" && y > oy0 && y < oy1 && x < ox0) best = Math.min(best, ox0 - x);
				if (side === "right" && y > oy0 && y < oy1 && x > ox1) best = Math.min(best, x - ox1);
			}
			return best;
		};
		const hSide = clearance("top") >= Math.min(1600, clearance("bottom")) ? "top" : "bottom";
		dimsBelow = hSide === "bottom";
		const vSide = clearance("left") >= Math.min(1600, clearance("right")) ? "left" : "right";
		const uniq = (v) => {
			const out = [];
			for (const x of [...v].sort((p, q) => p - q)) if (!out.length || x - out[out.length - 1] > 150) out.push(x);
			return out;
		};
		const xsC = uniq(src.map((p) => p.x));
		const ysC = uniq(src.map((p) => p.y));
		const hy = (k) => hSide === "top" ? oy0 - 600 - k * 500 : oy1 + 600 + k * 500;
		const vx = (k) => vSide === "left" ? ox0 - 600 - k * 500 : ox1 + 600 + k * 500;
		const fmt = (v) => hl ? Math.round(v).toLocaleString("en-US") : `${Math.round(v)}`;
		if (xsC.length > 2) for (let i = 0; i + 1 < xsC.length; i++) s += dimLine(xsC[i], hy(0), xsC[i + 1], hy(0), fmt(xsC[i + 1] - xsC[i]), false, hSide === "bottom", hl);
		s += dimLine(ox0, hy(xsC.length > 2 ? 1 : 0), ox1, hy(xsC.length > 2 ? 1 : 0), fmt(ox1 - ox0), false, hSide === "bottom", hl);
		if (ysC.length > 2) for (let i = 0; i + 1 < ysC.length; i++) s += dimLine(vx(0), ysC[i], vx(0), ysC[i + 1], fmt(ysC[i + 1] - ysC[i]), true, vSide === "right", hl);
		s += dimLine(vx(ysC.length > 2 ? 1 : 0), oy0, vx(ysC.length > 2 ? 1 : 0), oy1, fmt(oy1 - oy0), true, vSide === "right", hl);
		for (const x of xsC) s += `<line x1="${x}" y1="${hSide === "top" ? oy0 - 150 : oy1 + 150}" x2="${x}" y2="${hy(1) + (hSide === "top" ? -100 : 100)}" stroke="#999" stroke-width="6"/>`;
		for (const y of ysC) s += `<line x1="${vSide === "left" ? ox0 - 150 : ox1 + 150}" y1="${y}" x2="${vx(1) + (vSide === "left" ? -100 : 100)}" y2="${y}" stroke="#999" stroke-width="6"/>`;
	}
	const siteEdges = model.floors[0] === f && opts.showRoad !== false ? model.site?.edges : void 0;
	if (siteEdges?.length) {
		const c = {
			x: (minX + maxX) / 2,
			y: (minY + maxY) / 2
		};
		const w0 = model.site.roads[0]?.widthMm;
		const ext = {
			minX: vb.x,
			minY: vb.y,
			maxX: vb.x + vb.w,
			maxY: vb.y + vb.h
		};
		for (const e of siteEdges) {
			const L = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
			if (L < 1) continue;
			const u = {
				x: (e.b.x - e.a.x) / L,
				y: (e.b.y - e.a.y) / L
			};
			let n = {
				x: -u.y,
				y: u.x
			};
			const m = {
				x: (e.a.x + e.b.x) / 2,
				y: (e.a.y + e.b.y) / 2
			};
			if (n.x * (m.x - c.x) + n.y * (m.y - c.y) < 0) n = {
				x: -n.x,
				y: -n.y
			};
			if (e.kind === "road") {
				const D = 900;
				const q = [
					e.a,
					e.b,
					{
						x: e.b.x + n.x * D,
						y: e.b.y + n.y * D
					},
					{
						x: e.a.x + n.x * D,
						y: e.a.y + n.y * D
					}
				];
				s += `<polygon points="${q.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ")}" fill="#e4e2de"/>`;
				let deg = Math.atan2(u.y, u.x) * 180 / Math.PI;
				if (deg > 90) deg -= 180;
				if (deg < -90) deg += 180;
				const tp = {
					x: m.x + n.x * D * .5,
					y: m.y + n.y * D * .5
				};
				if (L > 2500) s += `<text x="${tp.x.toFixed(0)}" y="${tp.y.toFixed(0)}" font-size="230" text-anchor="middle" dy="80" fill="#555" transform="rotate(${deg.toFixed(1)} ${tp.x.toFixed(0)} ${tp.y.toFixed(0)})">${esc(`道路${w0 ? `（幅員${(w0 / 1e3).toFixed(1)}m）` : ""}`)}</text>`;
				for (const p of q) {
					ext.minX = Math.min(ext.minX, p.x - 300);
					ext.minY = Math.min(ext.minY, p.y - 300);
					ext.maxX = Math.max(ext.maxX, p.x + 300);
					ext.maxY = Math.max(ext.maxY, p.y + 300);
				}
			}
			s += `<line x1="${e.a.x.toFixed(0)}" y1="${e.a.y.toFixed(0)}" x2="${e.b.x.toFixed(0)}" y2="${e.b.y.toFixed(0)}" stroke="${e.kind === "road" ? "#555" : "#888"}" stroke-width="${e.kind === "road" ? 24 : 14}" stroke-dasharray="200 60 30 60"/>`;
			for (const p of [e.a, e.b]) {
				ext.minX = Math.min(ext.minX, p.x - 300);
				ext.minY = Math.min(ext.minY, p.y - 300);
				ext.maxX = Math.max(ext.maxX, p.x + 300);
				ext.maxY = Math.max(ext.maxY, p.y + 300);
			}
		}
		vb.x = ext.minX;
		vb.y = ext.minY;
		vb.w = ext.maxX - ext.minX;
		vb.h = ext.maxY - ext.minY + 1900;
	}
	if (!siteEdges?.length && model.site?.roads.length && model.floors[0] === f && opts.showRoad !== false) for (const r of model.site.roads) {
		const bnd = model.site.bounds[r.side];
		const label = `道路${r.widthMm ? `（幅員${(r.widthMm / 1e3).toFixed(1)}m）` : ""}`;
		const depth = 700;
		const horiz = r.side === "top" || r.side === "bottom";
		const edge = r.side === "top" ? minY : r.side === "bottom" ? maxY : r.side === "left" ? minX : maxX;
		const sign = r.side === "top" || r.side === "left" ? -1 : 1;
		const p0 = edge + sign * Math.min(6e3, Math.max(r.side === "bottom" ? 2100 : 1500, bnd != null ? (bnd - edge) * sign : 0));
		const p1 = p0 + sign * depth;
		const [a0, a1] = horiz ? [minX - 600, maxX + 600] : [minY - 600, maxY + 600];
		if (horiz) {
			s += `<rect x="${a0}" y="${Math.min(p0, p1)}" width="${a1 - a0}" height="${depth}" fill="#e4e2de"/>`;
			s += `<line x1="${a0}" y1="${p0}" x2="${a1}" y2="${p0}" stroke="#777" stroke-width="14" stroke-dasharray="200 60 30 60"/>`;
			s += `<text x="${(a0 + a1) / 2}" y="${(p0 + p1) / 2 + 80}" font-size="230" text-anchor="middle" fill="#555">${esc(label)}</text>`;
		} else {
			s += `<rect x="${Math.min(p0, p1)}" y="${a0}" width="${depth}" height="${a1 - a0}" fill="#e4e2de"/>`;
			s += `<line x1="${p0}" y1="${a0}" x2="${p0}" y2="${a1}" stroke="#777" stroke-width="14" stroke-dasharray="200 60 30 60"/>`;
			const cx = (p0 + p1) / 2;
			const cy = (a0 + a1) / 2;
			s += `<text x="${cx}" y="${cy}" font-size="230" text-anchor="middle" fill="#555" transform="rotate(${sign > 0 ? 90 : -90} ${cx} ${cy})" dy="80">${esc(label)}</text>`;
		}
		const far = Math.max(p0, p1) + 300;
		const near = Math.min(p0, p1) - 300;
		if (r.side === "right") vb.w = Math.max(vb.w, far - vb.x);
		if (r.side === "bottom") vb.h = Math.max(vb.h, far - vb.y);
		if (r.side === "left" && near < vb.x) {
			vb.w += vb.x - near;
			vb.x = near;
		}
		if (r.side === "top" && near < vb.y) {
			vb.h += vb.y - near;
			vb.y = near;
		}
	}
	s += northArrow(maxX + 900, minY - 600, model.northAngleDeg);
	const title = opts.title ?? (hl ? `${f.level}階 平面図` : `${f.level}階平面図`);
	const ty = maxY + (dimsBelow ? 2200 : 1500);
	const tx = (minX + maxX) / 2;
	const area = f.rooms.reduce((a, r) => a + r.area, 0);
	if (hl) {
		s += boxedTitle(tx, ty - 300, `${title} S:1/${opts.sheet ? "{{SCALE}}" : "100"}`, 300);
		if (!opts.sheet) s += `<text x="${tx}" y="${ty + 720}" font-size="170" text-anchor="middle" fill="#777">床面積（参考）約 ${area.toFixed(1)}㎡（${(area / 3.30579).toFixed(1)}坪）</text>`;
	} else {
		s += `<text x="${tx}" y="${ty}" font-size="300" text-anchor="middle" fill="#222" font-weight="600" letter-spacing="40">${esc(title)}</text>`;
		s += `<text x="${tx}" y="${ty + 380}" font-size="170" text-anchor="middle" fill="#777">床面積（参考）約 ${area.toFixed(1)}㎡（${(area / 3.30579).toFixed(1)}坪）</text>`;
	}
	s += scaleBar(tx - 2500, ty + 620);
	vb.h = Math.max(vb.h, ty + 1100 - vb.y);
	if (opts.tags ?? !!opts.sheet) for (const e of openingSchedule(f)) {
		s += `<circle cx="${e.x.toFixed(0)}" cy="${e.y.toFixed(0)}" r="200" fill="#fff" stroke="#333" stroke-width="10"/>`;
		s += `<text x="${e.x.toFixed(0)}" y="${(e.y + 55).toFixed(0)}" font-size="150" text-anchor="middle" fill="#222">${esc(e.tag)}</text>`;
	}
	if (opts.sectionLines?.length) {
		const bx0 = minX - 700;
		const bx1 = maxX + 700;
		const by0 = minY - 700;
		const by1 = maxY + 700;
		for (const sl of opts.sectionLines) {
			const n = {
				x: sl.nx,
				y: sl.nz
			};
			const d = sl.d * 1e3;
			const t = {
				x: -n.y,
				y: n.x
			};
			const p0 = {
				x: n.x * d,
				y: n.y * d
			};
			let tMin = -Infinity;
			let tMax = Infinity;
			for (const [c0, c1, pc, tc] of [[
				bx0,
				bx1,
				p0.x,
				t.x
			], [
				by0,
				by1,
				p0.y,
				t.y
			]]) {
				if (Math.abs(tc) < 1e-9) continue;
				const a = (c0 - pc) / tc;
				const b = (c1 - pc) / tc;
				tMin = Math.max(tMin, Math.min(a, b));
				tMax = Math.min(tMax, Math.max(a, b));
			}
			if (!(tMax > tMin)) continue;
			const A = {
				x: p0.x + t.x * tMin,
				y: p0.y + t.y * tMin
			};
			const B = {
				x: p0.x + t.x * tMax,
				y: p0.y + t.y * tMax
			};
			s += `<line x1="${A.x.toFixed(0)}" y1="${A.y.toFixed(0)}" x2="${B.x.toFixed(0)}" y2="${B.y.toFixed(0)}" stroke="#111" stroke-width="22" stroke-dasharray="500 200 80 200"/>`;
			for (const E of [A, B]) {
				const ex = E.x - n.x * 450;
				const ey = E.y - n.y * 450;
				s += `<line x1="${E.x.toFixed(0)}" y1="${E.y.toFixed(0)}" x2="${ex.toFixed(0)}" y2="${ey.toFixed(0)}" stroke="#111" stroke-width="30"/>`;
				const hx = ex - n.x * 180;
				const hy = ey - n.y * 180;
				s += `<polygon points="${(ex - n.x * 60 + t.x * 130).toFixed(0)},${(ey - n.y * 60 + t.y * 130).toFixed(0)} ${(ex - n.x * 60 - t.x * 130).toFixed(0)},${(ey - n.y * 60 - t.y * 130).toFixed(0)} ${hx.toFixed(0)},${hy.toFixed(0)}" fill="#111"/>`;
				s += `<text x="${(E.x + t.x * 0 + n.x * 330).toFixed(0)}" y="${(E.y + n.y * 330 + 90).toFixed(0)}" font-size="260" font-weight="700" text-anchor="middle" fill="#111">${esc(sl.label)}</text>`;
			}
		}
	}
	if (opts.marks?.length) {
		const RED = "#d7263d";
		for (const mk of opts.marks) {
			let lx = NaN;
			let ly = NaN;
			for (const r of mk.rects ?? []) {
				s += `<rect x="${r.minX.toFixed(0)}" y="${r.minY.toFixed(0)}" width="${(r.maxX - r.minX).toFixed(0)}" height="${(r.maxY - r.minY).toFixed(0)}" fill="${RED}" fill-opacity="0.08" stroke="${RED}" stroke-width="40" stroke-dasharray="180 100"/>`;
				if (Number.isNaN(lx)) {
					lx = (r.minX + r.maxX) / 2;
					ly = r.minY - 120;
				}
			}
			for (const l of mk.lines ?? []) {
				s += `<line x1="${l.a.x.toFixed(0)}" y1="${l.a.y.toFixed(0)}" x2="${l.b.x.toFixed(0)}" y2="${l.b.y.toFixed(0)}" stroke="${RED}" stroke-width="70" stroke-linecap="round" stroke-dasharray="220 140" opacity="0.85"/>`;
				if (Number.isNaN(lx)) {
					lx = (l.a.x + l.b.x) / 2;
					ly = (l.a.y + l.b.y) / 2 - 160;
				}
			}
			if (mk.label && !Number.isNaN(lx)) s += `<text x="${lx.toFixed(0)}" y="${ly.toFixed(0)}" font-size="230" font-weight="700" text-anchor="middle" fill="${RED}" stroke="#fff" stroke-width="60" paint-order="stroke" stroke-linejoin="round">${esc(mk.label)}</text>`;
		}
	}
	return {
		inner: s,
		vb,
		defs: PLAN_DEFS
	};
}
function cross(ax, ay, bx, by) {
	return ax * by - ay * bx;
}
function esc(s) {
	return s.replace(/[&<>]/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;"
	})[c]);
}
/** 文字幅の目安（全角 = 1、半角 = 0.6） */
function textEm(t) {
	let w = 0;
	for (const ch of t) w += /[\x20-\x7e｡-ﾟ]/.test(ch) ? .6 : 1;
	return Math.max(1, w);
}
function dimLine(x1, y1, x2, y2, label, vertical, flip = false, hl = false) {
	let s = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hl ? "#222" : "#555"}" stroke-width="8"/>`;
	for (const [x, y] of [[x1, y1], [x2, y2]]) s += hl ? `<circle cx="${x}" cy="${y}" r="34" fill="#fff" stroke="#222" stroke-width="10"/>` : `<line x1="${x - 55}" y1="${y + 55}" x2="${x + 55}" y2="${y - 55}" stroke="#333" stroke-width="14"/>`;
	const L = Math.hypot(x2 - x1, y2 - y1);
	const fs = Math.min(150, Math.max(80, L / 4.2));
	const cx = (x1 + x2) / 2;
	const cy = (y1 + y2) / 2;
	const d = flip ? -70 : 70;
	if (vertical) s += `<text x="${cx - d}" y="${cy}" font-size="${fs.toFixed(0)}" fill="#444" text-anchor="middle" transform="rotate(-90 ${cx - d} ${cy})" dy="${flip ? fs * .75 : 0}">${label}</text>`;
	else s += `<text x="${cx}" y="${cy - d}" font-size="${fs.toFixed(0)}" fill="#444" text-anchor="middle" dy="${flip ? fs * .75 : 0}">${label}</text>`;
	return s;
}
/** スケールバー（0〜5m） */
function scaleBar(x, y) {
	let s = "";
	for (let i = 0; i < 5; i++) s += `<rect x="${x + i * 1e3}" y="${y}" width="1000" height="90" fill="${i % 2 ? "#fff" : "#333"}" stroke="#333" stroke-width="10"/>`;
	for (const m of [
		0,
		1,
		2,
		5
	]) s += `<text x="${x + m * 1e3}" y="${y + 260}" font-size="130" text-anchor="middle" fill="#555">${m}${m === 5 ? "m" : ""}</text>`;
	return s;
}
function northArrow(x, y, angleDeg, r = 380) {
	return `<g transform="translate(${x} ${y}) rotate(${angleDeg})"><circle r="${r}" fill="none" stroke="#333" stroke-width="18"/><path d="M0 ${-r * 1.05} L${r * .32} ${r * .55} L0 ${r * .3} L${-r * .32} ${r * .55} Z" fill="#333"/><text y="${-r * 1.25}" font-size="${r * .7}" text-anchor="middle" fill="#333" font-weight="bold">N</text></g>`;
}
//#endregion
//#region src/drawings/dxf.ts
function pair(code, value) {
	return `${code}\n${value}\n`;
}
function line(layer, x1, y1, x2, y2) {
	return pair(0, "LINE") + pair(8, layer) + pair(10, x1.toFixed(1)) + pair(20, y1.toFixed(1)) + pair(30, 0) + pair(11, x2.toFixed(1)) + pair(21, y2.toFixed(1)) + pair(31, 0);
}
function text$1(layer, x, y, h, str, align = "center") {
	let s = pair(0, "TEXT") + pair(8, layer) + pair(10, x.toFixed(1)) + pair(20, y.toFixed(1)) + pair(30, 0) + pair(40, h) + pair(1, str.replace(/[\r\n]/g, " "));
	if (align === "center") s += pair(72, 1) + pair(11, x.toFixed(1)) + pair(21, y.toFixed(1)) + pair(31, 0);
	return s;
}
function floorEntities(f, ox) {
	const L = `${f.level}F`;
	const Y = (y) => -y;
	let s = "";
	for (const w of f.walls) {
		const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
		if (len < 1) continue;
		const ux = (w.b.x - w.a.x) / len;
		const uy = (w.b.y - w.a.y) / len;
		const nx = -uy;
		const ny = ux;
		const h = w.thickness / 2;
		const P = (t, sgn) => [ox + w.a.x + ux * t + nx * h * sgn, Y(w.a.y + uy * t + ny * h * sgn)];
		const ops = f.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t0 - b.t0);
		const solid = [];
		let cur = 0;
		for (const o of ops) {
			if (o.t0 > cur) solid.push([cur, o.t0]);
			cur = Math.max(cur, o.t1);
		}
		if (cur < len) solid.push([cur, len]);
		for (const [t0, t1] of solid) {
			const a1 = P(t0, 1);
			const b1 = P(t1, 1);
			const a2 = P(t0, -1);
			const b2 = P(t1, -1);
			s += line(`${L}_WALL`, a1[0], a1[1], b1[0], b1[1]);
			s += line(`${L}_WALL`, a2[0], a2[1], b2[0], b2[1]);
			s += line(`${L}_WALL`, a1[0], a1[1], a2[0], a2[1]);
			s += line(`${L}_WALL`, b1[0], b1[1], b2[0], b2[1]);
		}
		for (const o of ops) {
			const a = P(o.t0, 0);
			const b = P(o.t1, 0);
			if (o.kind === "window") {
				for (const k of [-1, 1]) {
					const p0 = P(o.t0, k);
					const p1 = P(o.t1, k);
					s += line(`${L}_OPENING`, p0[0], p0[1], p1[0], p1[1]);
				}
				s += line(`${L}_OPENING`, a[0], a[1], b[0], b[1]);
			} else {
				s += line(`${L}_OPENING`, a[0], a[1], b[0], b[1]);
				if (o.kind === "door" || o.kind === "entrance") {
					const hingeStart = o.hingeAtStart !== false;
					const hinge = hingeStart ? P(o.t0, 0) : P(o.t1, 0);
					const side = (o.swingSide ?? 1) * (hingeStart ? 1 : 1);
					const len2 = o.t1 - o.t0;
					const tipX = hinge[0] + nx * len2 * side;
					const tipY = hinge[1] - ny * len2 * side;
					s += line(`${L}_OPENING`, hinge[0], hinge[1], tipX, tipY);
					const a0 = Math.atan2(tipY - hinge[1], tipX - hinge[0]);
					const strike = hingeStart ? P(o.t1, 0) : P(o.t0, 0);
					let da = Math.atan2(strike[1] - hinge[1], strike[0] - hinge[0]) - a0;
					while (da > Math.PI) da -= 2 * Math.PI;
					while (da < -Math.PI) da += 2 * Math.PI;
					let px = tipX;
					let py = tipY;
					for (let i = 1; i <= 12; i++) {
						const ang = a0 + da * i / 12;
						const qx = hinge[0] + Math.cos(ang) * len2;
						const qy = hinge[1] + Math.sin(ang) * len2;
						s += line(`${L}_OPENING`, px, py, qx, qy);
						px = qx;
						py = qy;
					}
				}
			}
		}
	}
	for (const r of f.rooms) {
		if (r.type === "void") continue;
		const tat = r.labeledTatami ?? r.area / 1.62;
		s += text$1(`${L}_TEXT`, ox + r.labelPos.x, Y(r.labelPos.y) + 80, 250, r.name);
		s += text$1(`${L}_TEXT`, ox + r.labelPos.x, Y(r.labelPos.y) - 260, 180, `${tat.toFixed(1)}帖`);
	}
	for (const e of openingSchedule(f)) s += text$1(`${L}_TEXT`, ox + e.x, Y(e.y), 150, e.tag);
	for (const st of f.stairs) {
		const c = [
			[st.minX, st.minY],
			[st.maxX, st.minY],
			[st.maxX, st.maxY],
			[st.minX, st.maxY]
		];
		for (let i = 0; i < 4; i++) {
			const a = c[i];
			const b = c[(i + 1) % 4];
			s += line(`${L}_STAIR`, ox + a[0], Y(a[1]), ox + b[0], Y(b[1]));
		}
	}
	for (const loop of f.outline) for (let i = 0; i < loop.length; i++) {
		const a = loop[i];
		const b = loop[(i + 1) % loop.length];
		s += line(`${L}_OUTLINE`, ox + a.x, Y(a.y), ox + b.x, Y(b.y));
	}
	const xs = f.walls.flatMap((w) => [w.a.x, w.b.x]);
	const ys = f.walls.flatMap((w) => [w.a.y, w.b.y]);
	if (xs.length) s += text$1(`${L}_TEXT`, ox + (Math.min(...xs) + Math.max(...xs)) / 2, Y(Math.max(...ys)) - 1200, 400, `${f.level}階平面図`);
	return s;
}
function modelToDxf(model) {
	const layers = [];
	for (const f of model.floors) for (const k of [
		"WALL",
		"OPENING",
		"TEXT",
		"STAIR",
		"OUTLINE"
	]) layers.push(`${f.level}F_${k}`);
	const colors = {
		WALL: 7,
		OPENING: 4,
		TEXT: 3,
		STAIR: 6,
		OUTLINE: 8
	};
	let s = "";
	s += pair(0, "SECTION") + pair(2, "HEADER") + pair(9, "$ACADVER") + pair(1, "AC1009") + pair(9, "$INSUNITS") + pair(70, 4) + pair(0, "ENDSEC");
	s += pair(0, "SECTION") + pair(2, "TABLES") + pair(0, "TABLE") + pair(2, "LAYER") + pair(70, layers.length);
	for (const l of layers) s += pair(0, "LAYER") + pair(2, l) + pair(70, 0) + pair(62, colors[l.split("_")[1]] ?? 7) + pair(6, "CONTINUOUS");
	s += pair(0, "ENDTAB") + pair(0, "ENDSEC");
	s += pair(0, "SECTION") + pair(2, "ENTITIES");
	let ox = 0;
	for (const f of model.floors) {
		s += floorEntities(f, ox);
		const xs = f.walls.flatMap((w) => [w.a.x, w.b.x]).concat(f.outline.flat().map((p) => p.x));
		const w = xs.length ? Math.max(...xs) - Math.min(...xs) : 1e4;
		ox += w + 6e3;
	}
	s += pair(0, "ENDSEC") + pair(0, "EOF");
	return s;
}
//#endregion
//#region src/estimate/catalog.ts
var T = .3025;
var CATEGORIES = [
	{
		id: "temp",
		no: 1,
		name: "仮設工事",
		lines: [
			{
				id: "temp.set",
				spec: "仮設工事",
				desc: "仮設工事一式",
				unit: "式",
				cost: 176e3,
				on: "both"
			},
			{
				id: "temp.fence",
				spec: "仮囲い工事",
				desc: "仮囲い（グリーンネット・パネル・単管）組立て共 ※敷地境界計上",
				unit: "m",
				cost: 1100,
				qty: (a) => a.siteEdge,
				qtyNote: "敷地外周",
				on: "both"
			},
			{
				id: "temp.scaffold",
				spec: "外部足場",
				desc: "外部足場組立・解体",
				unit: "㎡",
				cost: 550,
				qty: (a) => a.extWall + a.insulArea,
				qtyNote: "外壁面積＋断熱面積",
				on: "both"
			},
			{
				id: "temp.mesh",
				spec: "外部足場",
				desc: "メッシュシート",
				unit: "㎡",
				cost: 150,
				qty: (a) => a.extWall,
				qtyNote: "外壁面積",
				on: "both"
			},
			{
				id: "temp.inner",
				spec: "内部足場",
				desc: "吹抜け足場 ※4.5帖毎に一式",
				unit: "式",
				cost: 65e3,
				qty: (a) => a.voidArea / 7.29,
				qtyNote: "吹抜面積 ÷ 7.29",
				on: "both"
			},
			{
				id: "temp.waste",
				spec: "残材処理費",
				desc: "残材処理費",
				unit: "㎡",
				cost: 1650,
				qty: (a) => a.constArea,
				qtyNote: "施工面積",
				on: "both"
			},
			{
				id: "temp.crane",
				spec: "上棟クレーン",
				desc: "上棟用クレーン一式",
				unit: "日",
				cost: 55e3,
				on: "both"
			},
			{
				id: "temp.parking",
				spec: "工事車両駐車場",
				desc: "工事車両駐車場確保費用 ※状況により判断 18ヵ月/台分",
				unit: "式",
				cost: 8e4,
				on: "both"
			},
			{
				id: "temp.guard",
				spec: "ガードマン費用",
				desc: "ガードマン費用",
				unit: "人工",
				cost: 2e4,
				qty: () => 10,
				on: "both"
			}
		]
	},
	{
		id: "found",
		no: 2,
		name: "基礎工事",
		lines: [
			{
				id: "found.hw1",
				spec: "基礎工事一式",
				desc: "基礎立ち上がり W150㎜ 金物工法 シングル配筋",
				unit: "㎡",
				cost: 28e3,
				round: -2,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				group: "found",
				on: ["S"]
			},
			{
				id: "found.se1",
				spec: "基礎工事一式",
				desc: "基礎立ち上がり W170㎜ SE工法 シングル配筋",
				unit: "㎡",
				cost: 3e4,
				round: -2,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				group: "found",
				on: "none"
			},
			{
				id: "found.hw2",
				spec: "基礎工事一式",
				desc: "基礎立ち上がり W150㎜ 金物工法 ダブル配筋",
				unit: "㎡",
				cost: 33e3,
				round: -2,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				group: "found",
				on: "none"
			},
			{
				id: "found.se",
				spec: "基礎工事一式",
				desc: "基礎立ち上がり W170㎜ SE構法",
				unit: "㎡",
				cost: 34e3,
				round: -2,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				group: "found",
				on: ["P"]
			},
			{
				id: "found.soil",
				spec: "残土処分",
				desc: "残土処分 ※計画・敷地条件により変更となる場合があります",
				unit: "㎡",
				cost: 4e3,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				on: "both"
			},
			{
				id: "found.deep1",
				spec: "深基礎",
				desc: "基礎立ち上がり H-100",
				unit: "m",
				cost: 3500,
				round: -2,
				qty: (a) => a.deepFound100,
				qtyNote: "入力",
				optional: true,
				on: "both"
			},
			{
				id: "found.deep2",
				spec: "深基礎",
				desc: "基礎立ち上がり H-200",
				unit: "m",
				cost: 7e3,
				round: -2,
				qty: (a) => a.deepFound200,
				qtyNote: "入力",
				optional: true,
				on: "both"
			},
			{
				id: "found.deep3",
				spec: "深基礎",
				desc: "基礎立ち上がり H-300",
				unit: "m",
				cost: 10500,
				round: -2,
				qty: (a) => a.deepFound300,
				qtyNote: "入力",
				optional: true,
				on: "both"
			},
			{
				id: "found.deep4",
				spec: "深基礎",
				desc: "基礎立ち上がり H-400",
				unit: "m",
				cost: 14e3,
				round: -2,
				qty: (a) => a.deepFound400,
				qtyNote: "入力",
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "wood",
		no: 3,
		name: "木工事",
		lines: [
			{
				id: "wood.precutHw",
				spec: "プレカット・構造材・金物",
				desc: "プレカット構造材 金物工法 ※下地材等込",
				unit: "㎡",
				cost: 29e3,
				round: -2,
				qty: (a) => a.constArea,
				qtyNote: "施工面積",
				group: "precut",
				on: ["S"]
			},
			{
				id: "wood.precutSe",
				spec: "プレカット・構造材・金物",
				desc: "プレカット構造材 SE工法 ※下地材等込",
				unit: "㎡",
				cost: 46e3,
				round: -2,
				qty: (a) => a.constArea,
				qtyNote: "施工面積",
				group: "precut",
				on: ["P"]
			},
			{
				id: "wood.carpHw",
				spec: "大工工事",
				desc: "大工工事 手間代 ※交通諸経費込み",
				unit: "坪",
				cost: 45e3,
				round: -2,
				qty: (a) => a.totalTsubo,
				qtyNote: "延床坪",
				group: "carp",
				on: ["S"]
			},
			{
				id: "wood.carpSe",
				spec: "大工工事",
				desc: "大工工事 手間代 SE構法",
				unit: "坪",
				cost: 5e4,
				round: -2,
				qty: (a) => a.totalTsubo,
				qtyNote: "延床坪",
				group: "carp",
				on: ["P"]
			},
			{
				id: "wood.carpExtra",
				spec: "大工工事",
				desc: "大工工事 手間代 施工面積",
				unit: "坪",
				cost: 2e4,
				round: -2,
				qty: (a) => a.extraArea * T,
				qtyNote: "施工面積（追加分）坪",
				on: "both"
			},
			{
				id: "wood.airtight",
				spec: "大工工事",
				desc: "気密施工 手間代",
				unit: "人工",
				cost: 2e4,
				round: -2,
				qty: () => 10,
				on: "both"
			},
			{
				id: "wood.gwLabor",
				spec: "大工工事",
				desc: "断熱材（グラスウール） 手間代 ※10坪一人工",
				unit: "人工",
				cost: 2e4,
				round: -2,
				qty: (a) => Math.ceil(a.totalTsubo / 10),
				qtyNote: "延床坪 ÷ 10",
				group: "insulLabor",
				on: ["S"]
			},
			{
				id: "wood.soffitPb",
				spec: "大工工事",
				desc: "外部天井PB貼り上げ",
				unit: "人工",
				cost: 2e4,
				round: -2,
				qty: (a) => a.soffitArea / 8,
				qtyNote: "軒天面積 ÷ 8",
				on: "both"
			},
			{
				id: "wood.slopeCeil",
				spec: "大工工事",
				desc: "勾配天井施工費",
				unit: "㎡",
				cost: 5e3,
				round: -2,
				qty: (a) => a.slopeCeil,
				qtyNote: "勾配天井面積",
				optional: true,
				on: "both"
			},
			{
				id: "wood.evoltz",
				spec: "大工工事",
				desc: "エボルツ施工費",
				unit: "人工",
				cost: 2e4,
				round: -2,
				qty: (a) => a.evoltz ? 2 : 0,
				qtyNote: "制振ダンパー採用時",
				optional: true,
				on: "both"
			},
			{
				id: "wood.soffitWood",
				spec: "大工工事",
				desc: "木板軒天 大工梁手間",
				unit: "人工",
				cost: 2e4,
				round: -2,
				qty: (a) => a.soffitWood ? 2 : 0,
				qtyNote: "木板軒天採用時",
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "roof",
		no: 4,
		name: "屋根・樋工事・板金",
		lines: [
			{
				id: "roof.gl",
				spec: "ガルバリウム鋼板葺き",
				desc: "ガルバリウム鋼板 カラーGL0.35",
				unit: "㎡",
				cost: 4400,
				qty: (a) => a.roofArea,
				qtyNote: "屋根面積",
				on: "both"
			},
			{
				id: "roof.under",
				spec: "ガルバリウム鋼板葺き",
				desc: "下地 改質アスルーフィング",
				unit: "㎡",
				cost: 1e3,
				qty: (a) => a.roofArea,
				qtyNote: "屋根面積",
				group: "roofing",
				on: "both"
			},
			{
				id: "roof.underKmew",
				spec: "ガルバリウム鋼板葺き",
				desc: "KMEW イーグルガード 保証なし",
				unit: "㎡",
				cost: 1500,
				qty: (a) => a.roofArea,
				qtyNote: "屋根面積",
				group: "roofing",
				on: "none"
			},
			{
				id: "roof.underLiner",
				spec: "ガルバリウム鋼板葺き",
				desc: "田島 ライナールーフィング 保証なし",
				unit: "㎡",
				cost: 1300,
				qty: (a) => a.roofArea,
				qtyNote: "屋根面積",
				group: "roofing",
				on: "none"
			},
			{
				id: "roof.underMaster",
				spec: "ガルバリウム鋼板葺き",
				desc: "田島 マスタールーフィング 30年保証",
				unit: "㎡",
				cost: 3800,
				qty: (a) => a.roofArea,
				qtyNote: "屋根面積",
				group: "roofing",
				on: "none"
			},
			{
				id: "roof.verge",
				spec: "ガルバリウム鋼板葺き",
				desc: "水上けらば包み（下地・唐草共）",
				unit: "m",
				cost: 1700,
				qty: (a) => a.eaveLen,
				qtyNote: "軒先長さ",
				on: "both"
			},
			{
				id: "roof.ridgeVent",
				spec: "換気棟",
				desc: "換気棟 ※棟長さ計上",
				unit: "m",
				cost: 8e3,
				qty: (a) => a.ridgeLen,
				qtyNote: "棟長さ",
				on: "both"
			},
			{
				id: "roof.gutterPana",
				spec: "軒樋",
				desc: "〈Panasonic〉KAKU 材工",
				unit: "m",
				cost: 3800,
				qty: (a) => a.eaveLen,
				qtyNote: "軒先長さ",
				group: "gutter",
				on: "both"
			},
			{
				id: "roof.gutterTanita",
				spec: "軒樋",
				desc: "〈タニタハウジング〉ハコH6号 or 半丸105",
				unit: "m",
				cost: 5500,
				qty: (a) => a.eaveLen,
				qtyNote: "軒先長さ",
				group: "gutter",
				on: "none"
			},
			{
				id: "roof.down1",
				spec: "竪樋",
				desc: "〈Panasonic〉竪樋丸60 材工 1階 3.5m",
				unit: "箇所",
				cost: 8e3,
				qty: (a) => a.downspouts1,
				qtyNote: "1階 竪樋本数",
				group: "down1",
				on: "both"
			},
			{
				id: "roof.down2",
				spec: "竪樋",
				desc: "〈Panasonic〉竪樋丸60 材工 2階 6.5m",
				unit: "箇所",
				cost: 14500,
				qty: (a) => a.downspouts2,
				qtyNote: "2階 竪樋本数",
				group: "down2",
				on: "both"
			},
			{
				id: "roof.downT1",
				spec: "竪樋",
				desc: "〈タニタハウジング〉タニタ丸60 1階 3.5m",
				unit: "箇所",
				cost: 14e3,
				qty: (a) => a.downspouts1,
				qtyNote: "1階 竪樋本数",
				group: "down1",
				on: "none"
			},
			{
				id: "roof.downT2",
				spec: "竪樋",
				desc: "〈タニタハウジング〉タニタ丸60 2階 6.5m",
				unit: "箇所",
				cost: 27e3,
				qty: (a) => a.downspouts2,
				qtyNote: "2階 竪樋本数",
				group: "down2",
				on: "none"
			},
			{
				id: "roof.downK1",
				spec: "竪樋",
				desc: "〈タニタハウジング〉角たてとい76×46 1階 3.5m",
				unit: "箇所",
				cost: 18500,
				qty: (a) => a.downspouts1,
				qtyNote: "1階 竪樋本数",
				group: "down1",
				on: "none"
			},
			{
				id: "roof.downK2",
				spec: "竪樋",
				desc: "〈タニタハウジング〉角たてとい76×46 2階 6.5m",
				unit: "箇所",
				cost: 35e3,
				qty: (a) => a.downspouts2,
				qtyNote: "2階 竪樋本数",
				group: "down2",
				on: "none"
			},
			{
				id: "roof.balc",
				spec: "バルコニー防水工事",
				desc: "バルコニー床 防水工事",
				unit: "㎡",
				cost: 7e3,
				qty: (a) => a.balconyArea,
				qtyNote: "バルコニー面積",
				on: "both"
			},
			{
				id: "roof.balcMin",
				spec: "バルコニー防水工事",
				desc: "バルコニー床 防水工事 ※最低価格",
				unit: "式",
				cost: 6e4,
				qty: (a) => a.balconyArea > 0 && a.balconyArea * 1e4 < 85710 ? 1 : 0,
				qtyNote: "小さいバルコニーのとき",
				optional: true,
				on: "both"
			},
			{
				id: "roof.flash",
				spec: "土台水切り",
				desc: "板金水切り",
				unit: "m",
				cost: 1100,
				round: -2,
				qty: (a) => a.foundPerim,
				qtyNote: "基礎外周",
				group: "flash",
				on: "both"
			},
			{
				id: "roof.flashWm",
				spec: "土台水切り",
				desc: "鋼板製 WM防鼠付シャープ水切り",
				unit: "m",
				cost: 2200,
				round: -2,
				qty: (a) => a.foundPerim,
				qtyNote: "基礎外周",
				group: "flash",
				on: "none"
			}
		]
	},
	{
		id: "sash",
		no: 5,
		name: "金属建具工事",
		lines: [
			{
				id: "sash.thermos",
				spec: "LIXIL",
				desc: "【LIXIL】サーモス2H ※概算",
				unit: "式",
				cost: 8e5,
				round: -2,
				group: "sash",
				on: ["S"]
			},
			{
				id: "sash.tw",
				spec: "LIXIL",
				desc: "【LIXIL】TW ※概算",
				unit: "式",
				cost: 95e4,
				round: -2,
				group: "sash",
				on: ["P"]
			},
			{
				id: "sash.thermosFire",
				spec: "LIXIL",
				desc: "【LIXIL】サーモス2H 防火 ※概算",
				unit: "式",
				cost: 12e5,
				round: -2,
				group: "sash",
				on: "none"
			},
			{
				id: "sash.twFire",
				spec: "LIXIL",
				desc: "【LIXIL】TW 防火 ※概算",
				unit: "式",
				cost: 14e5,
				round: -2,
				group: "sash",
				on: "none"
			},
			{
				id: "sash.doorVenato",
				spec: "YKK",
				desc: "玄関開き戸 ヴェナートD30 ストレートハンドル",
				unit: "式",
				cost: 12e4,
				round: -2,
				group: "entDoor",
				on: "both"
			},
			{
				id: "sash.doorVenatoFire",
				spec: "YKK",
				desc: "玄関開き戸 ヴェナートD30 ストレートハンドル ※防火",
				unit: "式",
				cost: 24e4,
				round: -2,
				group: "entDoor",
				on: "none"
			},
			{
				id: "sash.doorConcord",
				spec: "YKK",
				desc: "玄関引き戸 コンコード",
				unit: "式",
				cost: 28e4,
				round: -2,
				group: "entDoor",
				on: "none"
			},
			{
				id: "sash.doorConcordFire",
				spec: "YKK",
				desc: "玄関引き戸 コンコード ※防火",
				unit: "式",
				cost: 37e4,
				round: -2,
				group: "entDoor",
				on: "none"
			},
			{
				id: "sash.pocketKey",
				spec: "YKK",
				desc: "ポケットキー追加 ※電源直結",
				unit: "式",
				cost: 11e4,
				round: -2,
				qty: (a) => a.pocketKey ? 1 : 0,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "extwall",
		no: 6,
		name: "外壁工事",
		lines: [
			{
				id: "ext.jolypat",
				spec: "外壁サイディング＋塗り壁",
				desc: "ジョリパット塗装＋サイディング15㎜",
				unit: "㎡",
				cost: 11500,
				qty: (a) => a.extWall - a.solidoArea,
				qtyNote: "外壁面積 − SOLIDO 部分",
				group: "extwall",
				on: "both"
			},
			{
				id: "ext.sto",
				spec: "外壁サイディング＋塗り壁",
				desc: "Sto 塗装＋サイディング15㎜",
				unit: "㎡",
				cost: 11500,
				qty: (a) => a.extWall - a.solidoArea,
				qtyNote: "外壁面積 − SOLIDO 部分",
				group: "extwall",
				on: "none"
			},
			{
				id: "ext.gl",
				spec: "ガルバリウム鋼板",
				desc: "ガルバリウム鋼板 Kスパン＋プラスターボード×2",
				unit: "㎡",
				cost: 10500,
				qty: (a) => a.extWall - a.solidoArea,
				qtyNote: "外壁面積 − SOLIDO 部分",
				group: "extwall",
				on: "none"
			},
			{
				id: "ext.solido",
				spec: "SOLIDO",
				desc: "〈ケイミュー〉SOLIDO LAP",
				unit: "㎡",
				cost: 14500,
				qty: (a) => a.solidoArea,
				qtyNote: "SOLIDO 面積",
				optional: true,
				on: "both"
			},
			{
				id: "ext.tyvek",
				spec: "下地",
				desc: "透湿防水シート〈デュポン〉タイベックシルバー（遮熱付き）貼り",
				unit: "㎡",
				cost: 300,
				qty: (a) => a.extWall,
				qtyNote: "外壁面積",
				on: "both"
			},
			{
				id: "ext.corner",
				spec: "出隅",
				desc: "同質出隅材 サイディング",
				unit: "箇所",
				cost: 12e3,
				qty: (a) => a.corners - a.solidoCorners,
				qtyNote: "建物角 − SOLIDO 部分",
				on: "both"
			},
			{
				id: "ext.cornerSolidoA",
				spec: "出隅",
				desc: "同質出隅材 SOLIDO アングル",
				unit: "箇所",
				cost: 7e3,
				qty: (a) => a.solidoCorners,
				optional: true,
				on: "both"
			},
			{
				id: "ext.cornerSolidoB",
				spec: "出隅",
				desc: "同質出隅材 SOLIDO 突き付け",
				unit: "箇所",
				cost: 17500,
				qty: () => 0,
				optional: true,
				on: "both"
			},
			{
				id: "ext.caulk",
				spec: "コーキング",
				desc: "外部コーキング",
				unit: "式",
				cost: 62e3,
				on: "both"
			},
			{
				id: "ext.soffitFire",
				spec: "軒天ボード",
				desc: "軒天ボード二重張り ※準防火",
				unit: "㎡",
				cost: 4500,
				round: -2,
				qty: (a) => a.fireZone ? a.soffitArea : 0,
				qtyNote: "準防火地域のとき 軒天面積",
				group: "soffit",
				on: "none"
			},
			{
				id: "ext.soffit",
				spec: "軒天ボード",
				desc: "軒天ボード張り",
				unit: "㎡",
				cost: 2250,
				round: -2,
				qty: (a) => a.soffitArea,
				qtyNote: "軒天面積",
				group: "soffit",
				on: "both"
			},
			{
				id: "ext.soffitVent",
				spec: "軒天見切り材",
				desc: "軒天換気見切り〈Joto〉FV-016P L=1,820",
				unit: "式",
				cost: 4e4,
				round: -2,
				on: "both"
			},
			{
				id: "ext.soffitWood",
				spec: "軒天木板",
				desc: "〈チャネルオリジナル〉軒天羽目板 杉＋自然塗装",
				unit: "㎡",
				cost: 8500,
				round: -2,
				qty: (a) => a.soffitWood ? a.soffitArea : 0,
				optional: true,
				on: "both"
			},
			{
				id: "ext.neoma",
				spec: "外壁付加断熱",
				desc: "ネオマフォーム t25",
				unit: "㎡",
				cost: 4500,
				round: -2,
				qty: (a) => a.addInsul ? a.extWall : 0,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "inmat",
		no: 7,
		name: "内部建材工事",
		lines: [
			{
				id: "in.floorIns",
				spec: "床断熱材（大引間）",
				desc: "スタイロフォームⅢ種 805×805 90㎜",
				unit: "㎡",
				cost: 4e3,
				qty: (a) => a.floor1,
				qtyNote: "1階床面積",
				group: "floorIns",
				on: ["S"]
			},
			{
				id: "in.foundIns",
				spec: "基礎断熱",
				desc: "スタイロフォームⅢ種 805×805 90㎜",
				unit: "㎡",
				cost: 5e3,
				qty: (a) => a.floor1,
				qtyNote: "1階床面積",
				group: "floorIns",
				on: ["P"]
			},
			{
				id: "in.roofGw",
				spec: "屋根断熱材",
				desc: "グラスウール16K t200",
				unit: "㎡",
				cost: 3e3,
				qty: (a) => a.insulArea,
				qtyNote: "断熱面積",
				group: "roofIns",
				on: ["S"]
			},
			{
				id: "in.roofCf",
				spec: "屋根断熱材",
				desc: "セルロースファイバー t200 ※シート施工込",
				unit: "㎡",
				cost: 3500,
				qty: (a) => a.insulArea,
				qtyNote: "断熱面積",
				group: "roofIns",
				on: ["P"]
			},
			{
				id: "in.wallGw105",
				spec: "壁断熱",
				desc: "グラスウール16K t105",
				unit: "㎡",
				cost: 1e3,
				qty: (a) => a.extWall,
				qtyNote: "外壁面積",
				group: "wallIns",
				on: ["S"]
			},
			{
				id: "in.wallGw120",
				spec: "壁断熱",
				desc: "グラスウール16K t120",
				unit: "㎡",
				cost: 1500,
				qty: (a) => a.extWall,
				qtyNote: "外壁面積",
				group: "wallIns",
				on: "none"
			},
			{
				id: "in.wallCf105",
				spec: "壁断熱",
				desc: "セルロースファイバー t105",
				unit: "㎡",
				cost: 2800,
				qty: (a) => a.extWall,
				qtyNote: "外壁面積",
				group: "wallIns",
				on: "none"
			},
			{
				id: "in.wallCf120",
				spec: "壁断熱",
				desc: "セルロースファイバー t120 ※シート施工込",
				unit: "㎡",
				cost: 3500,
				qty: (a) => a.extWall,
				qtyNote: "外壁面積",
				group: "wallIns",
				on: ["P"]
			},
			{
				id: "in.sound",
				spec: "室内防音材",
				desc: "セルロースファイバー t120 ※シート施工込",
				unit: "㎡",
				cost: 5e3,
				qty: (a) => a.soundArea,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "plaster",
		no: 8,
		name: "塗り・左官工事・タイル",
		lines: [
			{
				id: "pl.paint",
				spec: "内部 塗装",
				desc: "内部棚等 塗装工事一式 ※造作家具塗装は別途",
				unit: "坪",
				cost: 4500,
				qty: (a) => a.totalTsubo,
				qtyNote: "延床坪",
				on: "both"
			},
			{
				id: "pl.seal",
				spec: "室内シーリング",
				desc: "キッチン・洗面 他",
				unit: "式",
				cost: 4e4,
				on: "both"
			},
			{
				id: "pl.foundSkirt",
				spec: "基礎外周巾木",
				desc: "立ち上がりモルタル刷毛引き仕上げ",
				unit: "㎡",
				cost: 1500,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				on: "both"
			},
			{
				id: "pl.boilerBase",
				spec: "給湯器台",
				desc: "給湯器下土間",
				unit: "式",
				cost: 33e3,
				round: -2,
				on: "both"
			},
			{
				id: "pl.porchTile",
				spec: "土間・ポーチタイル貼り",
				desc: "ポーチ（磁器質タイル 600×600程度）＋外部ポーチ",
				unit: "㎡",
				cost: 23e3,
				round: -2,
				qty: (a) => a.porchIn,
				qtyNote: "内部ポーチ・テラス面積",
				on: "both"
			},
			{
				id: "pl.porchBase",
				spec: "土間・ポーチタイル貼り",
				desc: "ポーチ下地",
				unit: "㎡",
				cost: 15e3,
				round: -2,
				qty: (a) => a.porchOut,
				qtyNote: "外部ポーチ・テラス面積",
				on: "both"
			},
			{
				id: "pl.doma",
				spec: "土間仕上げ",
				desc: "土間モルタル金鏝＆刷毛引き仕上げ",
				unit: "㎡",
				cost: 1400,
				round: -2,
				qty: (a) => a.porchOut,
				qtyNote: "外部ポーチ・テラス面積",
				on: "both"
			},
			{
				id: "pl.oil",
				spec: "無垢床塗装",
				desc: "無垢床現場塗り 自然クリア塗装",
				unit: "㎡",
				cost: 2200,
				round: -2,
				qty: (a) => a.solidFloor ? a.flooringArea : 0,
				optional: true,
				on: "both"
			},
			{
				id: "pl.floorTile",
				spec: "室内タイル床",
				desc: "磁器質タイル張り 600×600 ※LDK ホール",
				unit: "㎡",
				cost: 2e4,
				round: -2,
				qty: (a) => a.innerTileArea,
				optional: true,
				on: "both"
			},
			{
				id: "pl.wallSolido",
				spec: "室内壁タイル",
				desc: "SOLIDO張り 600×600 ※リビング・キッチン",
				unit: "㎡",
				cost: 12e3,
				round: -2,
				qty: (a) => a.innerSolidoArea,
				optional: true,
				on: "both"
			},
			{
				id: "pl.doorPaint",
				spec: "建具塗装",
				desc: "神谷建具塗装",
				unit: "箇所",
				cost: 13e3,
				round: -2,
				qty: (a) => a.doorPaint ? a.doors : 0,
				optional: true,
				on: "both"
			},
			{
				id: "pl.porters",
				spec: "室内塗り壁",
				desc: "ポーターズペイント＋塗り壁用クロス ストーン",
				unit: "㎡",
				cost: 8e3,
				round: -2,
				qty: (a) => a.paintWallArea,
				optional: true,
				on: "both"
			},
			{
				id: "pl.balcTile",
				spec: "バルコニータイル",
				desc: "バルコニータイル＋床上げ",
				unit: "㎡",
				cost: 35e3,
				round: -2,
				qty: (a) => a.balconyTile ? a.balconyArea : 0,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "inbuild",
		no: 9,
		name: "内装建材工事",
		lines: [
			{
				id: "ib.kamachi",
				spec: "玄関 上り框",
				desc: "【イエモン】木製上がり框 L=2,000",
				unit: "式",
				cost: 25e3,
				on: "both"
			},
			{
				id: "ib.floorIemonClear",
				spec: "床材",
				desc: "【イエモン】挽板 t15 w158 ジャイロオーク クリア・スモーク",
				unit: "㎡",
				cost: 6800,
				round: -2,
				qty: (a) => a.flooringArea,
				qtyNote: "フローリング面積",
				group: "floor",
				on: "none"
			},
			{
				id: "ib.floorIemonMocha",
				spec: "床材",
				desc: "【イエモン】挽板 t15 w158 ジャイロオーク モカ",
				unit: "㎡",
				cost: 7e3,
				round: -2,
				qty: (a) => a.flooringArea,
				qtyNote: "フローリング面積",
				group: "floor",
				on: "none"
			},
			{
				id: "ib.floorChannel",
				spec: "床材",
				desc: "【チャネルオリジナル】挽板 t15 オーク W150",
				unit: "㎡",
				cost: 7e3,
				round: -2,
				qty: (a) => a.flooringArea,
				qtyNote: "フローリング面積",
				group: "floor",
				on: "both"
			},
			{
				id: "ib.floorIoc",
				spec: "床材",
				desc: "【IOC】無垢床",
				unit: "㎡",
				cost: 18e3,
				round: -2,
				qty: (a) => a.flooringArea,
				qtyNote: "フローリング面積",
				group: "floor",
				on: "none"
			},
			{
				id: "ib.doorKamiya",
				spec: "建具",
				desc: "【神谷コーポレーション】キューブ",
				unit: "箇所",
				cost: 7e4,
				round: -2,
				qty: (a) => a.doors,
				qtyNote: "建具個数",
				group: "door",
				on: "both"
			},
			{
				id: "ib.doorLixil",
				spec: "建具",
				desc: "【LIXIL】ラシッサ",
				unit: "箇所",
				cost: 28e3,
				round: -2,
				qty: (a) => a.doors,
				qtyNote: "建具個数",
				group: "door",
				on: "none"
			},
			{
				id: "ib.sill",
				spec: "窓枠",
				desc: "【イエモン】木製下台 or クロス巻込み",
				unit: "坪",
				cost: 1700,
				round: -2,
				qty: (a) => a.totalTsubo,
				qtyNote: "延床坪",
				on: "both"
			},
			{
				id: "ib.skirting",
				spec: "巾木",
				desc: "【神谷コーポレーション】スリム巾木",
				unit: "坪",
				cost: 1100,
				round: -2,
				qty: (a) => a.totalTsubo,
				qtyNote: "延床坪",
				on: "both"
			},
			{
				id: "ib.highCeil",
				spec: "高天井",
				desc: "高天井変更費 ※H2500以上",
				unit: "㎥",
				cost: 4e4,
				round: -2,
				qty: (a) => a.highCeil,
				optional: true,
				on: "both"
			},
			{
				id: "ib.stairSt",
				spec: "階段",
				desc: "St鉄骨階段 St手摺 木踏板",
				unit: "式",
				cost: 85e4,
				round: -2,
				qty: (a) => a.stairs,
				qtyNote: "階段数",
				group: "stair",
				on: "both"
			},
			{
				id: "ib.handrail",
				spec: "手摺",
				desc: "St手摺",
				unit: "m",
				cost: 35e3,
				round: -2,
				qty: (a) => a.handrailLen,
				optional: true,
				on: "both"
			},
			{
				id: "ib.shelves",
				spec: "棚工事一式",
				desc: "【WOODONE】室内棚工事一式 ※概算 仕様打合せにて詳細決定",
				unit: "式",
				cost: 3e5,
				round: -2,
				on: "both"
			},
			{
				id: "ib.floorHatch",
				spec: "床下点検口",
				desc: "高断熱型床下点検口",
				unit: "式",
				cost: 32e3,
				round: -2,
				on: "both"
			},
			{
				id: "ib.ceilHatch",
				spec: "天井点検口",
				desc: "アルミ天井点検口 450サイズ",
				unit: "式",
				cost: 17e3,
				round: -2,
				on: "both"
			},
			{
				id: "ib.evoltz",
				spec: "制振ダンパー",
				desc: "evoltz B5 6本",
				unit: "式",
				cost: 38e4,
				round: -2,
				qty: (a) => a.evoltz ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "ib.woodCeil",
				spec: "木板天井",
				desc: "〈チャネルオリジナル〉軒天羽目板 杉＋自然塗装",
				unit: "㎡",
				cost: 8500,
				round: -2,
				qty: (a) => a.woodCeilArea,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "custom",
		no: 10,
		name: "造作工事",
		lines: [
			{
				id: "cu.vanity1200",
				spec: "造作洗面",
				desc: "造作洗面 W1200 ※概算",
				unit: "式",
				cost: 33e4,
				group: "vanity",
				on: "both"
			},
			{
				id: "cu.vanity750",
				spec: "造作洗面",
				desc: "造作洗面 W750 ※概算",
				unit: "式",
				cost: 22e4,
				group: "vanity",
				on: "none"
			},
			{
				id: "cu.cupboard",
				spec: "造作カップボード",
				desc: "造作カップボード W1820 ※概算",
				unit: "式",
				cost: 385e3,
				round: -2,
				on: "both"
			}
		]
	},
	{
		id: "interior",
		no: 11,
		name: "内装工事",
		lines: [
			{
				id: "it.clothAA",
				spec: "ビニールクロス",
				desc: "天井・壁 ビニールクロス貼り（AA級・普及品）・耐震パテ",
				unit: "坪",
				cost: 29e3,
				qty: (a) => a.constTsubo + a.voidArea * T,
				qtyNote: "施工坪＋吹抜坪",
				group: "cloth",
				on: ["P"]
			},
			{
				id: "it.clothA",
				spec: "ビニールクロス",
				desc: "天井・壁 ビニールクロス貼り（A級・普及品）",
				unit: "坪",
				cost: 26e3,
				qty: (a) => a.totalTsubo + a.voidArea * T,
				qtyNote: "延床坪＋吹抜坪",
				group: "cloth",
				on: ["S"]
			},
			{
				id: "it.floorTile",
				spec: "フロアタイル",
				desc: "床フロアタイル貼り",
				unit: "㎡",
				cost: 8e3,
				qty: (a) => a.floorTileArea,
				qtyNote: "フロアタイル面積",
				on: "both"
			},
			{
				id: "it.floorTileWc",
				spec: "フロアタイル",
				desc: "床フロアタイル貼り トイレ",
				unit: "式",
				cost: 2e4,
				qty: (a) => a.toilets,
				qtyNote: "トイレ数",
				on: "both"
			},
			{
				id: "it.doorCloth",
				spec: "建具クロス張り",
				desc: "神谷コーポレーション 建具クロス張り",
				unit: "箇所",
				cost: 5e3,
				qty: (a) => a.doorCloth,
				optional: true,
				on: "both"
			},
			{
				id: "it.tatami1",
				spec: "畳（縁無し 1帖）",
				desc: "スタイロ畳",
				unit: "枚",
				cost: 2e4,
				qty: (a) => a.tatami1,
				qtyNote: "和室の帖数",
				optional: true,
				on: "both"
			},
			{
				id: "it.tatamiHalf",
				spec: "畳（縁無し 半帖）",
				desc: "スタイロ畳",
				unit: "枚",
				cost: 15e3,
				qty: (a) => a.tatamiHalf,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "equip",
		no: 12,
		name: "設備工事",
		lines: [
			{
				id: "eq.bath1616",
				spec: "ユニットバス",
				desc: "【TOTO】サザナ 1616",
				unit: "式",
				cost: 42e4,
				margin: .8,
				group: "bath",
				on: "both"
			},
			{
				id: "eq.bath1620",
				spec: "ユニットバス",
				desc: "【TOTO】サザナ 1620 ※概算",
				unit: "式",
				cost: 8e5,
				margin: .8,
				group: "bath",
				on: "none"
			},
			{
				id: "eq.wc1",
				spec: "1階トイレ",
				desc: "【TOTO】NJ1",
				unit: "式",
				cost: 12e4,
				margin: .8,
				qty: (a) => Math.min(1, a.toilets),
				on: "both"
			},
			{
				id: "eq.handwash",
				spec: "1階トイレ",
				desc: "手洗いカウンター＋水栓",
				unit: "式",
				cost: 75e3,
				margin: .8,
				qty: (a) => a.handwash ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "eq.wc2",
				spec: "2階トイレ",
				desc: "【TOTO】ZJ1",
				unit: "式",
				cost: 7e4,
				margin: .8,
				qty: (a) => Math.max(0, a.toilets - 1),
				qtyNote: "トイレ数 − 1",
				on: "both"
			},
			{
				id: "eq.kitchenHl",
				spec: "システムキッチン",
				desc: "【HLオリジナル】LINEキッチン ペニンシュラ型",
				unit: "式",
				cost: 1e6,
				margin: .8,
				group: "kitchen",
				on: "both"
			},
			{
				id: "eq.kitchenCustom",
				spec: "システムキッチン",
				desc: "造作キッチン",
				unit: "式",
				cost: 35e5,
				margin: .8,
				group: "kitchen",
				on: "none"
			},
			{
				id: "eq.vent3wall",
				spec: "換気設備",
				desc: "第三種 壁式 換気",
				unit: "式",
				cost: 85e3,
				group: "vent",
				on: ["S"]
			},
			{
				id: "eq.vent3dsdd",
				spec: "換気設備",
				desc: "第三種換気 ダクト式 DSDD ※防蟻をセントリコンに変更",
				unit: "式",
				cost: 12e5,
				group: "vent",
				on: "none"
			},
			{
				id: "eq.vent3lufro",
				spec: "換気設備",
				desc: "第三種換気 ダクト式 ルフロ",
				unit: "式",
				cost: 3e5,
				group: "vent",
				on: ["P"]
			},
			{
				id: "eq.vent1lossnay",
				spec: "換気設備",
				desc: "第一種換気 ダクト式 ロスナイ",
				unit: "式",
				cost: 6e5,
				group: "vent",
				on: "none"
			},
			{
				id: "eq.vent1sumika",
				spec: "換気設備",
				desc: "第一種換気 ダクト式 澄家",
				unit: "式",
				cost: 14e5,
				group: "vent",
				on: "none"
			},
			{
				id: "eq.acFloor",
				spec: "空調",
				desc: "床下エアコン ※ガラリ・エアコン設置工事 基礎断熱は別途",
				unit: "式",
				cost: 42e4,
				group: "ac",
				on: "both"
			},
			{
				id: "eq.acDaikin",
				spec: "空調",
				desc: "ダイキン アメニティ エアコン",
				unit: "式",
				cost: 13e5,
				group: "ac",
				on: "none"
			},
			{
				id: "eq.acc",
				spec: "設備アクセサリー",
				desc: "中部レプ一式",
				unit: "式",
				cost: 25e3,
				on: "both"
			},
			{
				id: "eq.kanta",
				spec: "衣類乾燥機",
				desc: "幹太くん引き込み工事のみ",
				unit: "式",
				cost: 4e4,
				qty: (a) => a.kanta ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "eq.slop",
				spec: "衣類乾燥機",
				desc: "スロップシンク＆単水栓",
				unit: "式",
				cost: 8e4,
				qty: (a) => a.slopSink ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "eq.ecojozu",
				spec: "給湯器",
				desc: "エコジョーズ",
				unit: "式",
				cost: 25e4,
				group: "water",
				on: "none"
			},
			{
				id: "eq.ecocute360",
				spec: "給湯器",
				desc: "エコキュート 360L",
				unit: "式",
				cost: 38e4,
				group: "water",
				on: "both"
			},
			{
				id: "eq.ecocute460",
				spec: "給湯器",
				desc: "エコキュート 460L",
				unit: "式",
				cost: 4e5,
				group: "water",
				on: "none"
			},
			{
				id: "eq.ecoone",
				spec: "給湯器",
				desc: "エコワン 70L ※ウルトラファインバブル付き",
				unit: "式",
				cost: 65e4,
				group: "water",
				on: "none"
			},
			{
				id: "eq.pv43",
				spec: "太陽光",
				desc: "【キューセルズ】4.3kw パワコン込",
				unit: "式",
				cost: 11e5,
				group: "pv",
				on: "both"
			},
			{
				id: "eq.pvNone",
				spec: "太陽光",
				desc: "太陽光なし",
				unit: "式",
				cost: 0,
				group: "pv",
				on: "none"
			}
		]
	},
	{
		id: "elec",
		no: 13,
		name: "電気工事",
		lines: [
			{
				id: "el.main",
				spec: "電気工事",
				desc: "引込み幹線・仮設ポール工事・他電気工事費",
				unit: "式",
				cost: 496650,
				on: "both"
			},
			{
				id: "el.ecocute",
				spec: "電気工事",
				desc: "エコキュート接続工事",
				unit: "式",
				cost: 4e4,
				qty: (a) => a.waterHeater === "ecocute" ? 1 : 0,
				qtyNote: "エコキュートのとき",
				on: "both"
			},
			{
				id: "el.light",
				spec: "電灯コンセント設備工事",
				desc: "電灯配線工事",
				unit: "箇所",
				cost: 1700,
				qty: (a) => Math.round(40 * a.scale),
				qtyNote: "延床 30 坪で 40",
				on: "both"
			},
			{
				id: "el.switch",
				spec: "電灯コンセント設備工事",
				desc: "スイッチ配線工事",
				unit: "箇所",
				cost: 3e3,
				qty: (a) => Math.round(30 * a.scale),
				qtyNote: "延床 30 坪で 30",
				on: "both"
			},
			{
				id: "el.switch3",
				spec: "電灯コンセント設備工事",
				desc: "3路スイッチ配線工事",
				unit: "箇所",
				cost: 7500,
				qty: (a) => Math.round(5 * a.scale),
				qtyNote: "延床 30 坪で 5",
				on: "both"
			},
			{
				id: "el.outlet",
				spec: "電灯コンセント設備工事",
				desc: "コンセント配線工事",
				unit: "箇所",
				cost: 3e3,
				qty: (a) => Math.round(25 * a.scale),
				qtyNote: "延床 30 坪で 25",
				on: "both"
			},
			{
				id: "el.outletE",
				spec: "電灯コンセント設備工事",
				desc: "E付専用コンセント工事",
				unit: "箇所",
				cost: 1e4,
				qty: (a) => Math.round(8 * a.scale),
				qtyNote: "延床 30 坪で 8",
				on: "both"
			},
			{
				id: "el.ac",
				spec: "電灯コンセント設備工事",
				desc: "100W or 200W エアコン用コンセント工事＆スリーブ工事",
				unit: "箇所",
				cost: 13e3,
				qty: (a) => Math.round(5 * a.scale),
				qtyNote: "延床 30 坪で 5",
				on: "both"
			},
			{
				id: "el.outletWp",
				spec: "電灯コンセント設備工事",
				desc: "アース付防水コンセント配線工事",
				unit: "箇所",
				cost: 7500,
				qty: (a) => Math.round(5 * a.scale),
				qtyNote: "延床 30 坪で 5",
				on: "both"
			},
			{
				id: "el.soStyle",
				spec: "電灯コンセント設備工事",
				desc: "So スタイル スイッチ or コンセント設置",
				unit: "箇所",
				cost: 1550,
				qty: (a) => a.soStyle,
				optional: true,
				on: "both"
			},
			{
				id: "el.furnOutlet",
				spec: "電灯コンセント設備工事",
				desc: "家具用コンセント工事 ※神保コンセント",
				unit: "箇所",
				cost: 3300,
				qty: (a) => Math.round(10 * a.scale),
				qtyNote: "延床 30 坪で 10",
				on: "both"
			},
			{
				id: "el.kitchenOutlet",
				spec: "電灯コンセント設備工事",
				desc: "キッチン家具コンセント埋め込み工事",
				unit: "箇所",
				cost: 8e3,
				qty: () => 0,
				optional: true,
				on: "both"
			},
			{
				id: "el.jb",
				spec: "電灯コンセント設備工事",
				desc: "JB取付工事",
				unit: "箇所",
				cost: 2500,
				qty: () => 0,
				optional: true,
				on: "both"
			},
			{
				id: "el.ev",
				spec: "電灯コンセント設備工事",
				desc: "EVコンセント工事",
				unit: "箇所",
				cost: 18e3,
				qty: (a) => a.evOutlet ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "el.autoSw",
				spec: "電灯コンセント設備工事",
				desc: "かってにスイッチ設置",
				unit: "箇所",
				cost: 9e3,
				qty: () => 0,
				optional: true,
				on: "both"
			},
			{
				id: "el.ventDuct",
				spec: "換気扇設備工事",
				desc: "換気扇ダクト工事＆ベントキャップ",
				unit: "箇所",
				cost: 13500,
				qty: (a) => a.fanDucts,
				qtyNote: "P: 3 ／ S: 6",
				on: "both"
			},
			{
				id: "el.pipeFan",
				spec: "換気扇設備工事",
				desc: "壁・天井換気扇 パイプファン",
				unit: "箇所",
				cost: 14e3,
				qty: (a) => a.pipeFans,
				qtyNote: "P: 3 ／ S: 5",
				on: "both"
			},
			{
				id: "el.intercom",
				spec: "弱電設備工事",
				desc: "インターホン工事",
				unit: "箇所",
				cost: 45e3,
				on: "both"
			},
			{
				id: "el.tv",
				spec: "弱電設備工事",
				desc: "テレビ配線工事",
				unit: "箇所",
				cost: 7e3,
				on: "both"
			},
			{
				id: "el.tel",
				spec: "弱電設備工事",
				desc: "電話工事",
				unit: "箇所",
				cost: 7e3,
				on: "both"
			},
			{
				id: "el.lan",
				spec: "弱電設備工事",
				desc: "LAN工事",
				unit: "箇所",
				cost: 13500,
				qty: () => 2,
				on: "both"
			},
			{
				id: "el.conduit",
				spec: "弱電設備工事",
				desc: "空配管",
				unit: "箇所",
				cost: 5e3,
				on: "both"
			},
			{
				id: "el.fixtures",
				spec: "照明器具",
				desc: "照明器具 ※概算",
				unit: "箇所",
				cost: 4e5,
				margin: .8,
				on: "both"
			}
		]
	},
	{
		id: "plumb",
		no: 14,
		name: "給排水工事",
		lines: [
			{
				id: "pb.outWater",
				spec: "屋外給水設備工事",
				desc: "配管工事費",
				unit: "式",
				cost: 55e3,
				on: "both"
			},
			{
				id: "pb.tap",
				spec: "屋外給水設備工事",
				desc: "外部立水栓 or 散水栓",
				unit: "式",
				cost: 2e4,
				on: "both"
			},
			{
				id: "pb.outDrain",
				spec: "屋外排水設備工事",
				desc: "配管工事費",
				unit: "式",
				cost: 145e3,
				on: "both"
			},
			{
				id: "pb.sewerPit",
				spec: "屋外排水設備工事",
				desc: "汚水桝",
				unit: "箇所",
				cost: 11e3,
				qty: () => 10,
				on: "both"
			},
			{
				id: "pb.rainPit",
				spec: "屋外排水設備工事",
				desc: "雨水桝",
				unit: "箇所",
				cost: 14e3,
				qty: () => 10,
				on: "both"
			},
			{
				id: "pb.septic",
				spec: "浄化槽",
				desc: "5人槽 ※130㎡未満",
				unit: "式",
				cost: 65e4,
				qty: (a) => a.septic ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "pb.inner",
				spec: "屋内給排水設備工事",
				desc: "屋内給排水工事",
				unit: "式",
				cost: 48e4,
				on: "both"
			},
			{
				id: "pb.no2f",
				spec: "屋内給排水設備工事",
				desc: "二階水回り無し",
				unit: "式",
				cost: -7e4,
				qty: (a) => a.wet2f === "none" ? 1 : 0,
				qtyNote: "2階に水回りが無いとき",
				on: "both"
			},
			{
				id: "pb.ldk2f",
				spec: "屋内給排水設備工事",
				desc: "二階リビング水回り給排水工事",
				unit: "式",
				cost: 165e3,
				qty: (a) => a.wet2f === "ldk" ? 1 : 0,
				qtyNote: "2階リビングのとき",
				on: "both"
			},
			{
				id: "pb.sleeve",
				spec: "土間スリーブ工事",
				desc: "基礎貫通スリーブ",
				unit: "式",
				cost: 8e4,
				on: "both"
			},
			{
				id: "pb.wcSet",
				spec: "土間スリーブ工事",
				desc: "トイレ設置＆接続",
				unit: "箇所",
				cost: 17e3,
				qty: (a) => a.toilets,
				qtyNote: "トイレ数",
				on: "both"
			},
			{
				id: "pb.handwashSet",
				spec: "土間スリーブ工事",
				desc: "手洗い設置＆接続",
				unit: "式",
				cost: 2e4,
				qty: (a) => a.handwash ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "pb.vanitySet",
				spec: "土間スリーブ工事",
				desc: "洗面化粧台設置＆接続",
				unit: "式",
				cost: 66e3,
				on: "both"
			},
			{
				id: "pb.washerSet",
				spec: "土間スリーブ工事",
				desc: "洗濯水栓・洗濯トラップ設置＆接続",
				unit: "組",
				cost: 9e3,
				on: "both"
			},
			{
				id: "pb.kitchenSet",
				spec: "土間スリーブ工事",
				desc: "キッチン接続",
				unit: "式",
				cost: 35e3,
				on: "both"
			},
			{
				id: "pb.bathSet",
				spec: "土間スリーブ工事",
				desc: "ユニットバス接続",
				unit: "式",
				cost: 9e3,
				on: "both"
			},
			{
				id: "pb.slopSet",
				spec: "土間スリーブ工事",
				desc: "スロップシンク接続",
				unit: "式",
				cost: 17e3,
				qty: (a) => a.slopSink ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "pb.mixer",
				spec: "土間スリーブ工事",
				desc: "混合栓変更",
				unit: "箇所",
				cost: 25e3,
				qty: () => 0,
				optional: true,
				on: "both"
			},
			{
				id: "pb.gas",
				spec: "ガス工事",
				desc: "ガス配管工事",
				unit: "式",
				cost: 17e4,
				qty: (a) => a.waterHeater === "ecocute" ? 0 : 1,
				qtyNote: "ガス給湯のとき",
				on: "both"
			}
		]
	},
	{
		id: "misc",
		no: 15,
		name: "雑工事",
		lines: [
			{
				id: "mi.clean",
				spec: "美装工事",
				desc: "美装工事（お引渡し掃除）",
				unit: "㎡",
				cost: 550,
				round: -1,
				qty: (a) => a.totalArea,
				qtyNote: "延床面積",
				on: "both"
			},
			{
				id: "mi.termite",
				spec: "防蟻処置",
				desc: "防蟻処置 ※DSDD の場合除く",
				unit: "㎡",
				cost: 500,
				qty: (a) => a.buildArea,
				qtyNote: "建築面積",
				on: "both"
			},
			{
				id: "mi.airtest",
				spec: "気密測定",
				desc: "気密測定一式",
				unit: "式",
				cost: 6e4,
				on: "both"
			},
			{
				id: "mi.travel",
				spec: "交通費",
				desc: "交通費 ※支店から15km以上計上",
				unit: "km",
				cost: 1e4,
				round: -2,
				qty: (a) => a.travelKm,
				optional: true,
				on: "both"
			}
		]
	},
	{
		id: "design",
		no: 16,
		name: "諸経費",
		lines: [
			{
				id: "de.design",
				spec: "設計費用",
				desc: "設計監理費用",
				unit: "式",
				cost: 3e5,
				fixedPrice: 1e6,
				on: "both"
			},
			{
				id: "de.struct",
				spec: "許容応力度計算",
				desc: "許容応力度計算",
				unit: "式",
				cost: 3e5,
				round: -2,
				qty: (a) => a.structCalc ? 1 : 0,
				optional: true,
				on: "both"
			},
			{
				id: "de.longlife",
				spec: "長期優良住宅",
				desc: "長期優良住宅申請代行費",
				unit: "式",
				cost: 3e5,
				fixedPrice: 38e4,
				on: "both"
			},
			{
				id: "de.inspect",
				spec: "第三者機関目視録",
				desc: "第三者機関による目視録",
				unit: "式",
				cost: 15e4,
				margin: .75,
				round: -2,
				on: "both"
			}
		]
	}
];
/** 雑工事・諸経費は金額を 1 円単位（シートの ROUNDDOWN(…,0)）、それ以外は十円単位 */
var AMOUNT_ROUND = {
	misc: 0,
	design: 0
};
//#endregion
//#region src/estimate/calc.ts
/** 見積の計算: 価格表 × 数量 → 行・工事ごとの小計・合計・税 */
var TAX_RATE = .1;
function roundDown(v, digits) {
	const k = Math.pow(10, -digits);
	return Math.floor(v / k) * k;
}
function unitPriceOf(l) {
	if (l.fixedPrice != null) return l.fixedPrice;
	return roundDown(l.cost / (l.margin ?? .7), l.round ?? -1);
}
/** group の既定（グレードごと） */
function defaultGroups(grade) {
	const g = {};
	for (const c of CATEGORIES) for (const l of c.lines) {
		if (!l.group || g[l.group]) continue;
		if (l.on === "both" || Array.isArray(l.on) && l.on.includes(grade)) g[l.group] = l.id;
	}
	for (const c of CATEGORIES) for (const l of c.lines) if (l.group && !g[l.group]) g[l.group] = l.id;
	return g;
}
function newChoice(grade) {
	return {
		grade,
		groups: defaultGroups(grade),
		qty: {},
		off: [],
		extras: [],
		roundUnit: 1e4
	};
}
function isOn(l, choice) {
	if (choice.off.includes(l.id)) return false;
	if (l.group) return (choice.groups[l.group] ?? defaultGroups(choice.grade)[l.group]) === l.id;
	if (l.on === "none") return false;
	if (l.on === "both" || l.on == null) return true;
	return l.on.includes(choice.grade);
}
/** 選んだ行から決まる数量側の条件（給湯の種類など） */
function deriveAreas(a, choice) {
	const water = choice.groups.water ?? "";
	return {
		...a,
		waterHeater: /ecocute/.test(water) ? "ecocute" : "gas"
	};
}
function computeEstimate(areasIn, choice) {
	const a = deriveAreas(areasIn, choice);
	const categories = CATEGORIES.map((def) => {
		const lines = def.lines.map((l) => {
			const selected = isOn(l, choice);
			const qtyAuto = l.qty ? Math.max(0, l.qty(a)) : 1;
			const qty = selected ? choice.qty[l.id] ?? qtyAuto : 0;
			const unitPrice = unitPriceOf(l);
			const amount = roundDown(unitPrice * qty, AMOUNT_ROUND[def.id] ?? -1);
			return {
				def: l,
				id: l.id,
				cat: def.id,
				spec: l.spec,
				desc: l.desc,
				unit: l.unit,
				unitPrice,
				unitCost: l.cost,
				qty,
				qtyAuto,
				qtyNote: l.qtyNote,
				amount,
				cost: l.cost * qty,
				selected,
				group: l.group,
				optional: !!l.optional
			};
		});
		for (const x of choice.extras.filter((e) => e.cat === def.id)) lines.push({
			id: x.id,
			cat: def.id,
			spec: "追加",
			desc: x.desc,
			unit: x.unit,
			unitPrice: x.price,
			unitCost: x.cost,
			qty: x.qty,
			qtyAuto: x.qty,
			amount: roundDown(x.price * x.qty, -1),
			cost: x.cost * x.qty,
			selected: x.qty > 0,
			optional: true,
			extra: true
		});
		return {
			def,
			lines,
			amount: lines.reduce((s, l) => s + l.amount, 0),
			cost: lines.reduce((s, l) => s + l.cost, 0)
		};
	});
	const rawSubtotal = categories.reduce((s, c) => s + c.amount, 0);
	const unit = choice.roundUnit ?? 1e4;
	const adjust = unit > 0 && rawSubtotal > 0 ? -(rawSubtotal % unit) : 0;
	const subtotal = rawSubtotal + adjust;
	const cost = categories.reduce((s, c) => s + c.cost, 0);
	const tax = Math.floor(subtotal * TAX_RATE);
	return {
		categories,
		rawSubtotal,
		adjust,
		subtotal,
		cost,
		tax,
		total: subtotal + tax,
		perTsubo: a.totalTsubo > 0 ? subtotal / a.totalTsubo : 0
	};
}
//#endregion
//#region src/coordinate/catalog.ts
/**
* コーディネート: メーカー・品番つきの仕上げ・設備のカタログ。
* 選ぶと (1) 3D の材質（外観・内観のテイストに上書き）と (2) 見積の該当行（group の選択）が同時に変わる。
* 社内の積算シートに載っている商品を中心に、ホームランディックの標準仕様（塗り壁の箱・黒サッシ・オーク床・白壁・鉄骨階段）でそろえている。
*/
var paint = (color, roughness = .55) => ({
	pattern: "paint",
	color,
	roughness
});
/** セラミック天板（目地の無い大判。わずかな石目） */
var ceramic = (color, color2) => ({
	pattern: "marble",
	color,
	color2,
	roughness: .3,
	size: 3.2,
	size2: 3.2
});
/** LINE KITCHEN のモルタル調メラミン（モルタライト・モルタブラック・グレーストーン）: ざらつきのある塗り調 */
var mortar = (color, color2) => ({
	pattern: "plaster",
	color,
	color2,
	roughness: .55,
	normalStrength: .12
});
/** ステンレス バイブレーション天板 */
var stainless = () => ({
	pattern: "paint",
	color: "#b9bbbd",
	roughness: .32,
	metalness: .9
});
var FINISH_CATEGORIES = [
	{
		id: "extWall",
		label: "外壁",
		part: "外部",
		defaultFor: (d) => /galva|gl/.test(d.exteriorId) ? "ext.gl.black" : "ext.jp.mid",
		products: [
			{
				id: "ext.jp.white",
				maker: "アイカ工業",
				name: "ジョリパット",
				code: "JP-100 ゆず肌",
				color: "ホワイト",
				swatch: ["#e8e6e0"],
				apply: (s) => {
					s.ext.wall = {
						...s.ext.wall,
						pattern: "stucco",
						color: "#e8e6e0",
						color2: "#e2e0da"
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.jolypat"
				}
			},
			{
				id: "ext.jp.light",
				maker: "アイカ工業",
				name: "ジョリパット",
				code: "JP-100 ゆず肌",
				color: "ライトグレー",
				swatch: ["#cfcdc7"],
				apply: (s) => {
					s.ext.wall = {
						...s.ext.wall,
						pattern: "stucco",
						color: "#cfcdc7",
						color2: "#c8c6c0"
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.jolypat"
				}
			},
			{
				id: "ext.jp.mid",
				maker: "アイカ工業",
				name: "ジョリパット",
				code: "JP-100 ゆず肌",
				color: "中間グレー",
				swatch: ["#9a9893"],
				apply: (s) => {
					s.ext.wall = {
						...s.ext.wall,
						pattern: "stucco",
						color: "#9a9893",
						color2: "#93918c"
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.jolypat"
				}
			},
			{
				id: "ext.jp.dark",
				maker: "アイカ工業",
				name: "ジョリパット",
				code: "JP-100 ゆず肌",
				color: "ダークグレー",
				swatch: ["#5d5c59"],
				apply: (s) => {
					s.ext.wall = {
						...s.ext.wall,
						pattern: "stucco",
						color: "#5d5c59",
						color2: "#575653"
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.jolypat"
				}
			},
			{
				id: "ext.sto.white",
				maker: "Sto",
				name: "StoColor Lotusan（塗り壁）",
				code: "Sto 塗り壁 シリコン",
				color: "オフホワイト",
				swatch: ["#ebe9e3"],
				apply: (s) => {
					s.ext.wall = {
						...s.ext.wall,
						pattern: "stucco",
						color: "#ebe9e3",
						color2: "#e5e3dd",
						normalStrength: .25
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.sto"
				}
			},
			{
				id: "ext.sto.grey",
				maker: "Sto",
				name: "StoColor Lotusan（塗り壁）",
				code: "Sto 塗り壁 シリコン",
				color: "グレージュ",
				swatch: ["#b3aea4"],
				apply: (s) => {
					s.ext.wall = {
						...s.ext.wall,
						pattern: "stucco",
						color: "#b3aea4",
						color2: "#aca79d",
						normalStrength: .25
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.sto"
				}
			},
			{
				id: "ext.gl.black",
				maker: "アイジー工業",
				name: "ガルバリウム鋼板 Kスパン",
				code: "SGL ガルスパン",
				color: "ブラック",
				swatch: ["#2b2c2e"],
				apply: (s) => {
					s.ext.wall = {
						pattern: "standingSeam",
						color: "#2b2c2e",
						roughness: .5,
						metalness: .4
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.gl"
				}
			},
			{
				id: "ext.gl.silver",
				maker: "アイジー工業",
				name: "ガルバリウム鋼板 Kスパン",
				code: "SGL ガルスパン",
				color: "銀黒",
				swatch: ["#6b6d70"],
				apply: (s) => {
					s.ext.wall = {
						pattern: "standingSeam",
						color: "#6b6d70",
						roughness: .45,
						metalness: .5
					};
				},
				estimate: {
					group: "extwall",
					line: "ext.gl"
				}
			}
		]
	},
	{
		id: "accent",
		label: "アクセント外壁",
		part: "外部",
		defaultFor: (d) => exteriorById(d.exteriorId).accent ? "acc.solido.black" : "acc.none",
		products: [
			{
				id: "acc.none",
				maker: "—",
				name: "アクセントなし",
				code: "",
				swatch: ["#dddbd5"],
				apply: (s) => {
					s.ext.accent = void 0;
					s.ext.accentRule = "none";
				},
				note: "SOLIDO の行が 0 になります"
			},
			{
				id: "acc.solido.black",
				maker: "ケイミュー",
				name: "SOLIDO typeF LAP",
				code: "SOLIDO LAP",
				color: "鉄黒",
				swatch: ["#3f3d3a"],
				apply: (s) => {
					s.ext.accent = {
						pattern: "solido",
						color: "#3f3d3a",
						roughness: .92,
						normalStrength: .6
					};
					if (s.ext.accentRule === "none") s.ext.accentRule = "entrance";
				}
			},
			{
				id: "acc.solido.grey",
				maker: "ケイミュー",
				name: "SOLIDO typeF LAP",
				code: "SOLIDO LAP",
				color: "灰",
				swatch: ["#8d8b86"],
				apply: (s) => {
					s.ext.accent = {
						pattern: "solido",
						color: "#8d8b86",
						roughness: .92,
						normalStrength: .6
					};
					if (s.ext.accentRule === "none") s.ext.accentRule = "entrance";
				}
			},
			{
				id: "acc.solido.rust",
				maker: "ケイミュー",
				name: "SOLIDO typeF LAP",
				code: "SOLIDO LAP",
				color: "錆茶",
				swatch: ["#6a5345"],
				apply: (s) => {
					s.ext.accent = {
						pattern: "solido",
						color: "#6a5345",
						roughness: .92,
						normalStrength: .6
					};
					if (s.ext.accentRule === "none") s.ext.accentRule = "entrance";
				}
			},
			{
				id: "acc.wood",
				maker: "チャネルオリジナル",
				name: "ウイルウォール（木板）",
				code: "レッドシダー",
				color: "ナチュラル",
				swatch: ["#9c7b58"],
				apply: (s) => {
					s.ext.accent = {
						pattern: "wood",
						color: "#9c7b58",
						color2: "#86683f",
						roughness: .8
					};
					if (s.ext.accentRule === "none") s.ext.accentRule = "entrance";
				}
			}
		]
	},
	{
		id: "roof",
		label: "屋根",
		part: "外部",
		products: [{
			id: "roof.gl.black",
			maker: "日鉄鋼板",
			name: "ガルバリウム鋼板 立平葺き",
			code: "ニスクカラー GL0.35",
			color: "ブラック",
			swatch: ["#2a2b2d"],
			apply: (s) => {
				s.ext.roof.material = {
					pattern: "standingSeam",
					color: "#2a2b2d",
					roughness: .5,
					metalness: .4
				};
				s.ext.roof.fascia = "#1f1f1f";
			}
		}, {
			id: "roof.gl.silver",
			maker: "日鉄鋼板",
			name: "ガルバリウム鋼板 立平葺き",
			code: "ニスクカラー GL0.35",
			color: "シルバー",
			swatch: ["#9a9c9e"],
			apply: (s) => {
				s.ext.roof.material = {
					pattern: "standingSeam",
					color: "#9a9c9e",
					roughness: .4,
					metalness: .6
				};
			}
		}]
	},
	{
		id: "soffit",
		label: "軒天（軒の裏）",
		part: "外部",
		products: [
			{
				id: "soffit.same",
				maker: "—",
				name: "外壁と同色の塗り壁",
				code: "",
				color: "外壁同色",
				swatch: ["#9a9893"],
				apply: (s) => {
					s.ext.roof.soffit = {
						pattern: "paint",
						color: s.ext.wall.color,
						roughness: .95
					};
				},
				note: "軒の裏まで外壁と同じ色で回し、箱の輪郭を強調します"
			},
			{
				id: "soffit.white",
				maker: "ケイミュー",
				name: "軒天ボード（無塗装板 塗装）",
				code: "軒天 12mm",
				color: "ホワイト",
				swatch: ["#efeeea"],
				apply: (s) => {
					s.ext.roof.soffit = {
						pattern: "paint",
						color: "#efeeea",
						roughness: .9
					};
				}
			},
			{
				id: "soffit.black",
				maker: "ケイミュー",
				name: "軒天ボード（無塗装板 塗装）",
				code: "軒天 12mm",
				color: "ブラック",
				swatch: ["#2c2c2d"],
				apply: (s) => {
					s.ext.roof.soffit = {
						pattern: "paint",
						color: "#2c2c2d",
						roughness: .85
					};
				}
			},
			{
				id: "soffit.cedar",
				maker: "チャネルオリジナル",
				name: "レッドシダー 軒天羽目板",
				code: "ウイルウォール 軒天",
				color: "ナチュラル",
				swatch: ["#a88762"],
				apply: (s) => {
					s.ext.roof.soffit = {
						pattern: "woodSiding",
						color: "#a88762",
						color2: "#8f6f4c",
						roughness: .75,
						size: .1
					};
				}
			},
			{
				id: "soffit.oak",
				maker: "ニチハ",
				name: "軒天 木目調ボード",
				code: "センターサイディング 軒天",
				color: "ライトオーク",
				swatch: ["#c2a37a"],
				apply: (s) => {
					s.ext.roof.soffit = {
						pattern: "woodSiding",
						color: "#c2a37a",
						color2: "#ad8f66",
						roughness: .7,
						size: .1
					};
				}
			}
		]
	},
	{
		id: "sash",
		label: "サッシ",
		part: "外部",
		products: [
			{
				id: "sash.tw.black",
				maker: "LIXIL",
				name: "TW（高性能樹脂複合）",
				code: "TW トリプルガラス",
				color: "ブラック",
				swatch: ["#1f1f1f"],
				apply: (s) => {
					s.ext.frame = {
						color: "#1f1f1f",
						metalness: .3
					};
				},
				estimate: {
					group: "sash",
					line: "sash.tw"
				}
			},
			{
				id: "sash.tw.silver",
				maker: "LIXIL",
				name: "TW（高性能樹脂複合）",
				code: "TW トリプルガラス",
				color: "ナチュラルシルバー",
				swatch: ["#b9bcbf"],
				apply: (s) => {
					s.ext.frame = {
						color: "#b9bcbf",
						metalness: .6
					};
				},
				estimate: {
					group: "sash",
					line: "sash.tw"
				}
			},
			{
				id: "sash.tw.white",
				maker: "LIXIL",
				name: "TW（高性能樹脂複合）",
				code: "TW トリプルガラス",
				color: "ホワイト",
				swatch: ["#f0f0ee"],
				apply: (s) => {
					s.ext.frame = {
						color: "#f0f0ee",
						metalness: .2
					};
				},
				estimate: {
					group: "sash",
					line: "sash.tw"
				}
			},
			{
				id: "sash.thermos.black",
				maker: "LIXIL",
				name: "サーモスⅡ-H",
				code: "サーモス2H ペアガラス",
				color: "ブラック",
				swatch: ["#1f1f1f"],
				apply: (s) => {
					s.ext.frame = {
						color: "#1f1f1f",
						metalness: .3
					};
				},
				estimate: {
					group: "sash",
					line: "sash.thermos"
				},
				note: "S シリーズ標準"
			},
			{
				id: "sash.thermos.silver",
				maker: "LIXIL",
				name: "サーモスⅡ-H",
				code: "サーモス2H ペアガラス",
				color: "ナチュラルシルバー",
				swatch: ["#b9bcbf"],
				apply: (s) => {
					s.ext.frame = {
						color: "#b9bcbf",
						metalness: .6
					};
				},
				estimate: {
					group: "sash",
					line: "sash.thermos"
				}
			}
		]
	},
	{
		id: "entDoor",
		label: "玄関ドア",
		part: "外部",
		products: [
			{
				id: "door.venato.black",
				maker: "YKK AP",
				name: "ヴェナート D30 片開き",
				code: "D30 ストレートハンドル",
				color: "ブラック",
				swatch: ["#2a2a2a"],
				apply: (s) => {
					s.ext.entranceDoor = paint("#2a2a2a", .5);
				},
				estimate: {
					group: "entDoor",
					line: "sash.doorVenato"
				}
			},
			{
				id: "door.venato.walnut",
				maker: "YKK AP",
				name: "ヴェナート D30 片開き",
				code: "D30 ストレートハンドル",
				color: "ショコラウォールナット",
				swatch: ["#5a3d2b"],
				apply: (s) => {
					s.ext.entranceDoor = {
						pattern: "wood",
						color: "#5a3d2b",
						color2: "#4a3223",
						roughness: .55
					};
				},
				estimate: {
					group: "entDoor",
					line: "sash.doorVenato"
				}
			},
			{
				id: "door.venato.oak",
				maker: "YKK AP",
				name: "ヴェナート D30 片開き",
				code: "D30 ストレートハンドル",
				color: "キャラメルチーク",
				swatch: ["#a2764d"],
				apply: (s) => {
					s.ext.entranceDoor = {
						pattern: "wood",
						color: "#a2764d",
						color2: "#8c6340",
						roughness: .55
					};
				},
				estimate: {
					group: "entDoor",
					line: "sash.doorVenato"
				}
			},
			{
				id: "door.concord.black",
				maker: "YKK AP",
				name: "コンコード 玄関引き戸",
				code: "コンコード S30",
				color: "ブラック",
				swatch: ["#2a2a2a"],
				apply: (s) => {
					s.ext.entranceDoor = paint("#2a2a2a", .5);
				},
				estimate: {
					group: "entDoor",
					line: "sash.doorConcord"
				}
			}
		]
	},
	{
		id: "floor",
		label: "床材",
		part: "内部",
		defaultFor: (d) => /slate|tile/.test(d.interiorId) ? "floor.tile.black" : "floor.channel.oak",
		products: [
			{
				id: "floor.channel.oak",
				maker: "チャネルオリジナル",
				name: "オーク 挽板フローリング",
				code: "挽板 t15 W150",
				color: "ナチュラル（自然塗装）",
				swatch: ["#c9a97c"],
				apply: (s) => {
					s.int.floor = {
						pattern: "woodFloor",
						color: "#c9a97c",
						color2: "#b8976c",
						roughness: .55,
						size: .15
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorChannel"
				}
			},
			{
				id: "floor.iemon.clear",
				maker: "イエモン",
				name: "ジャイロオーク 挽板",
				code: "挽板 t15 W158",
				color: "クリア",
				swatch: ["#cdb089"],
				apply: (s) => {
					s.int.floor = {
						pattern: "woodFloor",
						color: "#cdb089",
						color2: "#bd9e77",
						roughness: .5,
						size: .158
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorIemonClear"
				}
			},
			{
				id: "floor.iemon.smoke",
				maker: "イエモン",
				name: "ジャイロオーク 挽板",
				code: "挽板 t15 W158",
				color: "スモーク",
				swatch: ["#a88f6c"],
				apply: (s) => {
					s.int.floor = {
						pattern: "woodFloor",
						color: "#a88f6c",
						color2: "#98805f",
						roughness: .5,
						size: .158
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorIemonClear"
				}
			},
			{
				id: "floor.iemon.mocha",
				maker: "イエモン",
				name: "ジャイロオーク 挽板",
				code: "挽板 t15 W158",
				color: "モカ",
				swatch: ["#8c7152"],
				apply: (s) => {
					s.int.floor = {
						pattern: "woodFloor",
						color: "#8c7152",
						color2: "#7c6347",
						roughness: .5,
						size: .158
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorIemonMocha"
				}
			},
			{
				id: "floor.ioc.oak",
				maker: "IOC",
				name: "オーク 無垢フローリング",
				code: "無垢 t15 W120",
				color: "ナチュラル",
				swatch: ["#d2b58d"],
				apply: (s) => {
					s.int.floor = {
						pattern: "woodFloor",
						color: "#d2b58d",
						color2: "#c2a47c",
						roughness: .6,
						size: .12
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorIoc"
				},
				note: "無垢。床塗装の行（任意）も"
			},
			{
				id: "floor.tile.black",
				maker: "サンワカンパニー",
				name: "磁器質タイル 600角",
				code: "セメント調 600×600",
				color: "チャコール",
				swatch: ["#3b3a38"],
				apply: (s) => {
					s.int.floor = {
						pattern: "tileFloor",
						color: "#3b3a38",
						roughness: .4,
						size: .6,
						size2: .6,
						tile: 1.2
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorChannel"
				},
				note: "LDK タイル床は「室内タイル床」の数量で別途"
			},
			{
				id: "floor.nagoya.600",
				maker: "名古屋モザイク工業",
				name: "磁器質タイル 600角（内床用）",
				code: "600×600 ※品番は品番メモに",
				color: "グレー",
				swatch: ["#8b8984"],
				apply: (s) => {
					s.int.floor = {
						pattern: "tileFloor",
						color: "#8b8984",
						color2: "#84827d",
						roughness: .42,
						size: .6,
						size2: .6,
						tile: 1.2
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorChannel"
				},
				note: "LDK タイル床は「室内タイル床」の数量で別途"
			},
			{
				id: "floor.sangetsu.ft.stone",
				maker: "サンゲツ",
				name: "フロアタイル（ストーン調）",
				code: "IS シリーズ 457×457 ※品番は品番メモに",
				color: "ライムストーン",
				swatch: ["#c9c3b8"],
				apply: (s) => {
					s.int.floor = {
						pattern: "tileFloor",
						color: "#c9c3b8",
						color2: "#c1bbb0",
						roughness: .5,
						size: .457,
						size2: .457,
						tile: .914
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorChannel"
				},
				note: "フロアタイルは単価が下がるので「任意の項目」で調整"
			},
			{
				id: "floor.sangetsu.ft.wood",
				maker: "サンゲツ",
				name: "フロアタイル（ウッド調）",
				code: "WD シリーズ 152×914 ※品番は品番メモに",
				color: "グレージュオーク",
				swatch: ["#b7a289"],
				apply: (s) => {
					s.int.floor = {
						pattern: "woodFloor",
						color: "#b7a289",
						color2: "#a89276",
						roughness: .55,
						size: .152,
						size2: .914
					};
				},
				estimate: {
					group: "floor",
					line: "ib.floorChannel"
				}
			}
		]
	},
	{
		id: "wetFloor",
		label: "玄関・水まわりの床",
		part: "内部",
		products: [
			{
				id: "wet.nagoya.600.grey",
				maker: "名古屋モザイク工業",
				name: "磁器質タイル 600角",
				code: "600×600 ※品番は品番メモに",
				color: "グレー",
				swatch: ["#8e8c88"],
				apply: (s) => {
					s.int.wetFloor = {
						pattern: "tileFloor",
						color: "#8e8c88",
						roughness: .45,
						size: .6,
						size2: .6,
						tile: 1.2
					};
					s.int.entranceFloor = {
						pattern: "tileFloor",
						color: "#6f6d69",
						roughness: .55,
						size: .6,
						size2: 1.2,
						tile: 2.4
					};
				}
			},
			{
				id: "wet.nagoya.600.charcoal",
				maker: "名古屋モザイク工業",
				name: "磁器質タイル 600角",
				code: "600×600 ※品番は品番メモに",
				color: "チャコール",
				swatch: ["#44423f"],
				apply: (s) => {
					s.int.wetFloor = {
						pattern: "tileFloor",
						color: "#5a5855",
						roughness: .45,
						size: .6,
						size2: .6,
						tile: 1.2
					};
					s.int.entranceFloor = {
						pattern: "tileFloor",
						color: "#44423f",
						roughness: .55,
						size: .6,
						size2: 1.2,
						tile: 2.4
					};
				}
			},
			{
				id: "wet.nagoya.300",
				maker: "名古屋モザイク工業",
				name: "磁器質タイル 300角",
				code: "300×300 ※品番は品番メモに",
				color: "ベージュグレー",
				swatch: ["#b3aa9c"],
				apply: (s) => {
					s.int.wetFloor = {
						pattern: "tileFloor",
						color: "#b3aa9c",
						roughness: .5,
						size: .3,
						size2: .3,
						tile: 1.2
					};
					s.int.entranceFloor = {
						pattern: "tileFloor",
						color: "#9c9387",
						roughness: .55,
						size: .3,
						size2: .3,
						tile: 1.2
					};
				}
			},
			{
				id: "wet.sangetsu.ft",
				maker: "サンゲツ",
				name: "フロアタイル（ストーン調）",
				code: "IS シリーズ 457×457 ※品番は品番メモに",
				color: "グレー",
				swatch: ["#a9a6a0"],
				apply: (s) => {
					s.int.wetFloor = {
						pattern: "tileFloor",
						color: "#a9a6a0",
						color2: "#a19e98",
						roughness: .5,
						size: .457,
						size2: .457,
						tile: .914
					};
				}
			},
			{
				id: "wet.sangetsu.cf",
				maker: "サンゲツ",
				name: "クッションフロア（石目）",
				code: "H-FLOOR ※品番は品番メモに",
				color: "ホワイトマーブル",
				swatch: ["#dcd9d3"],
				apply: (s) => {
					s.int.wetFloor = {
						pattern: "marble",
						color: "#dcd9d3",
						color2: "#cfccc6",
						roughness: .35,
						size: .6,
						size2: .6
					};
				}
			}
		]
	},
	{
		id: "wall",
		label: "内壁",
		part: "内部",
		products: [
			{
				id: "wall.cloth.white",
				maker: "サンゲツ",
				name: "ビニールクロス AA級",
				code: "SP シリーズ",
				color: "ホワイト（石目）",
				swatch: ["#efede8"],
				apply: (s) => {
					s.int.wall = {
						pattern: "plaster",
						color: "#efede8",
						color2: "#e8e5df",
						roughness: .95,
						normalStrength: .18
					};
				},
				estimate: {
					group: "cloth",
					line: "it.clothAA"
				}
			},
			{
				id: "wall.cloth.grey",
				maker: "サンゲツ",
				name: "ビニールクロス AA級",
				code: "SP シリーズ",
				color: "ライトグレー",
				swatch: ["#dcdad5"],
				apply: (s) => {
					s.int.wall = {
						pattern: "plaster",
						color: "#dcdad5",
						color2: "#d5d3ce",
						roughness: .95,
						normalStrength: .18
					};
				},
				estimate: {
					group: "cloth",
					line: "it.clothAA"
				}
			},
			{
				id: "wall.cloth.greige",
				maker: "サンゲツ",
				name: "ビニールクロス AA級",
				code: "SP シリーズ ※品番は品番メモに",
				color: "グレージュ",
				swatch: ["#cfc8bd"],
				apply: (s) => {
					s.int.wall = {
						pattern: "plaster",
						color: "#cfc8bd",
						color2: "#c8c1b6",
						roughness: .95,
						normalStrength: .18
					};
				},
				estimate: {
					group: "cloth",
					line: "it.clothAA"
				}
			},
			{
				id: "wall.lilycolor",
				maker: "リリカラ",
				name: "ビニールクロス（LV）",
				code: "LV シリーズ ※品番は品番メモに",
				color: "オフホワイト",
				swatch: ["#ece9e3"],
				apply: (s) => {
					s.int.wall = {
						pattern: "plaster",
						color: "#ece9e3",
						color2: "#e5e2dc",
						roughness: .95,
						normalStrength: .18
					};
				},
				estimate: {
					group: "cloth",
					line: "it.clothAA"
				}
			},
			{
				id: "wall.sincol",
				maker: "シンコール",
				name: "ビニールクロス（BB）",
				code: "BB シリーズ ※品番は品番メモに",
				color: "ホワイト",
				swatch: ["#f0eeea"],
				apply: (s) => {
					s.int.wall = {
						pattern: "plaster",
						color: "#f0eeea",
						color2: "#e9e7e2",
						roughness: .95,
						normalStrength: .18
					};
				},
				estimate: {
					group: "cloth",
					line: "it.clothAA"
				}
			},
			{
				id: "wall.porters.stone",
				maker: "PORTER’S PAINTS",
				name: "ポーターズペイント",
				code: "ストーンペイント",
				color: "ライムストーン",
				swatch: ["#d9d4c8"],
				apply: (s) => {
					s.int.wall = {
						pattern: "plaster",
						color: "#d9d4c8",
						color2: "#d1ccbf",
						roughness: .97,
						normalStrength: .35
					};
				},
				note: "「室内塗り壁」の面積を入れると見積に反映"
			}
		]
	},
	{
		id: "door",
		label: "建具",
		part: "内部",
		products: [
			{
				id: "door.kamiya.cube",
				maker: "神谷コーポレーション",
				name: "フルハイトドア キューブ",
				code: "CUBE 天井高 2,400",
				color: "壁と同色（クロス巻き）",
				swatch: ["#efede8"],
				apply: (s) => {
					s.int.door = {
						pattern: "paint",
						color: s.int.wall.color,
						roughness: .6
					};
				},
				estimate: {
					group: "door",
					line: "ib.doorKamiya"
				}
			},
			{
				id: "door.kamiya.black",
				maker: "神谷コーポレーション",
				name: "フルハイトドア キューブ",
				code: "CUBE 天井高 2,400",
				color: "ブラック",
				swatch: ["#2a2a2a"],
				apply: (s) => {
					s.int.door = paint("#2a2a2a", .5);
				},
				estimate: {
					group: "door",
					line: "ib.doorKamiya"
				}
			},
			{
				id: "door.lixil.lasissa",
				maker: "LIXIL",
				name: "ラシッサ D",
				code: "ラシッサD パレット",
				color: "クリエモカ",
				swatch: ["#b89572"],
				apply: (s) => {
					s.int.door = {
						pattern: "wood",
						color: "#b89572",
						color2: "#a2805d",
						roughness: .55
					};
				},
				estimate: {
					group: "door",
					line: "ib.doorLixil"
				},
				note: "S シリーズ向け"
			},
			{
				id: "door.panasonic.veritis",
				maker: "パナソニック",
				name: "ベリティス",
				code: "ベリティス ハイドア（H2400）",
				color: "ホワイトオーク柄",
				swatch: ["#d8c6a8"],
				apply: (s) => {
					s.int.door = {
						pattern: "wood",
						color: "#d8c6a8",
						color2: "#c8b394",
						roughness: .55
					};
				},
				estimate: {
					group: "door",
					line: "ib.doorLixil"
				},
				note: "S シリーズ向け"
			},
			{
				id: "door.woodone.doretus",
				maker: "ウッドワン",
				name: "ドレタス",
				code: "ドレタス ハイドア（H2400）",
				color: "グレー塗装",
				swatch: ["#9a9893"],
				apply: (s) => {
					s.int.door = paint("#9a9893", .55);
				},
				estimate: {
					group: "door",
					line: "ib.doorLixil"
				}
			}
		]
	},
	{
		id: "stair",
		label: "階段",
		part: "内部",
		products: [{
			id: "stair.steel",
			maker: "造作（鉄工）",
			name: "スチール階段",
			code: "St 鉄骨 ＋ 木踏板 ＋ St 手摺",
			color: "黒皮鉄・オーク",
			swatch: ["#2a2a2a", "#c9a97c"],
			estimate: {
				group: "stair",
				line: "ib.stairSt"
			}
		}]
	},
	{
		id: "kitchen",
		label: "キッチン",
		part: "設備",
		defaultFor: (d) => /slate|grey|cedar|dark/.test(d.interiorId) ? "kitchen.hl.line.mortablack" : "kitchen.hl.line.mortalight",
		products: [
			{
				id: "kitchen.hl.line.mortalight",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "モルタライト（天板・扉同色）",
				swatch: ["#b3a995", "#b3a995"],
				apply: (s) => {
					s.int.furniture.counter = mortar("#b3a995", "#a89e8a");
					s.int.furniture.cabinet = mortar("#b3a995", "#a89e8a");
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.mortablack",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "モルタブラック（天板・扉同色）",
				swatch: ["#3a3a36", "#3a3a36"],
				apply: (s) => {
					s.int.furniture.counter = mortar("#3a3a36", "#33332f");
					s.int.furniture.cabinet = mortar("#3a3a36", "#33332f");
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.darkgrey",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "ダークグレー × ステンレス バイブレーション天板",
				swatch: ["#b9bbbd", "#2f3a40"],
				apply: (s) => {
					s.int.furniture.counter = stainless();
					s.int.furniture.cabinet = paint("#2f3a40", .5);
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.greystone",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "グレーストーン（天板・扉同色）",
				swatch: ["#5e6165", "#5e6165"],
				apply: (s) => {
					s.int.furniture.counter = mortar("#5e6165", "#55585c");
					s.int.furniture.cabinet = mortar("#5e6165", "#55585c");
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.white",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "ナチュラルホワイト × ステンレス バイブレーション天板",
				swatch: ["#b9bbbd", "#f1f0ec"],
				apply: (s) => {
					s.int.furniture.counter = stainless();
					s.int.furniture.cabinet = paint("#f1f0ec", .45);
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.darkbeige",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "ダークベージュ（天板・扉同色）",
				swatch: ["#a89f99", "#a89f99"],
				apply: (s) => {
					s.int.furniture.counter = paint("#a89f99", .4);
					s.int.furniture.cabinet = paint("#a89f99", .5);
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.walnut",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "ウォールナット（GROUP2）× ステンレス バイブレーション天板",
				swatch: ["#b9bbbd", "#6e4b36"],
				apply: (s) => {
					s.int.furniture.counter = stainless();
					s.int.furniture.cabinet = {
						pattern: "wood",
						color: "#6e4b36",
						color2: "#5a3c2b",
						roughness: .5
					};
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.hl.line.ash",
				maker: "ホームランディック",
				name: "LINE KITCHEN ペニンシュラ",
				code: "W2590 H850 カウンタースタイル",
				color: "アッシュ（GROUP2）× ステンレス バイブレーション天板",
				swatch: ["#b9bbbd", "#cfb58d"],
				apply: (s) => {
					s.int.furniture.counter = stainless();
					s.int.furniture.cabinet = {
						pattern: "wood",
						color: "#cfb58d",
						color2: "#bca27a",
						roughness: .5
					};
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				}
			},
			{
				id: "kitchen.lixil.richelle",
				maker: "LIXIL",
				name: "リシェルSI ペニンシュラ I 型",
				code: "W2585 セラミックトップ",
				color: "グレースモーク × 扉 ウォールナット",
				swatch: ["#7d7b78", "#6e5542"],
				apply: (s) => {
					s.int.furniture.counter = ceramic("#7d7b78", "#747270");
					s.int.furniture.cabinet = {
						pattern: "wood",
						color: "#6e5542",
						color2: "#5c4535",
						roughness: .5
					};
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				},
				note: "LINE キッチンと同等の金額として見積に載せます"
			},
			{
				id: "kitchen.panasonic.lclass",
				maker: "パナソニック",
				name: "Lクラス フラット対面",
				code: "W2600 有機ガラス系ワークトップ",
				color: "ホワイト × 扉 ライトグレー",
				swatch: ["#ecebe8", "#c6c5c1"],
				apply: (s) => {
					s.int.furniture.counter = {
						pattern: "paint",
						color: "#ecebe8",
						roughness: .22
					};
					s.int.furniture.cabinet = paint("#c6c5c1", .45);
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				},
				note: "LINE キッチンと同等の金額として見積に載せます"
			},
			{
				id: "kitchen.cleanup.centro",
				maker: "クリナップ",
				name: "セントロ ペニンシュラ",
				code: "W2550 ステンレスワークトップ",
				color: "ステンレス × 扉 チャコール",
				swatch: ["#b9bbbd", "#3a3b3d"],
				apply: (s) => {
					s.int.furniture.counter = {
						pattern: "paint",
						color: "#b9bbbd",
						roughness: .35,
						metalness: .9
					};
					s.int.furniture.cabinet = paint("#3a3b3d", .5);
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				},
				note: "LINE キッチンと同等の金額として見積に載せます"
			},
			{
				id: "kitchen.graftekt",
				maker: "グラフテクト",
				name: "メルクリオ ペニンシュラ",
				code: "W2600 エバルト（ラミネート）",
				color: "ベトングレー × 扉 同色",
				swatch: ["#9a9893", "#9a9893"],
				apply: (s) => {
					s.int.furniture.counter = {
						pattern: "plaster",
						color: "#9a9893",
						color2: "#92908b",
						roughness: .45,
						normalStrength: .15
					};
					s.int.furniture.cabinet = paint("#9a9893", .5);
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenHl"
				},
				note: "LINE キッチンと同等の金額として見積に載せます"
			},
			{
				id: "kitchen.custom.oak",
				maker: "造作（家具工事）",
				name: "造作キッチン",
				code: "オーク突板 ＋ ステンレスバイブレーション天板",
				color: "オーク × ステンレス",
				swatch: ["#b9bbbd", "#c3a06f"],
				apply: (s) => {
					s.int.furniture.counter = {
						pattern: "paint",
						color: "#b9bbbd",
						roughness: .35,
						metalness: .9
					};
					s.int.furniture.cabinet = {
						pattern: "wood",
						color: "#c3a06f",
						color2: "#ae8b5d",
						roughness: .5
					};
				},
				estimate: {
					group: "kitchen",
					line: "eq.kitchenCustom"
				}
			}
		]
	},
	{
		id: "cupboard",
		label: "カップボード（背面収納）",
		part: "設備",
		products: [
			{
				id: "cup.line.same",
				maker: "ホームランディック",
				name: "LINE KITCHEN カップボード ミックスタイプ",
				code: "W2440〜2740 D450 H850 ＋ 吊戸 ＋ トール",
				color: "キッチン扉と同色",
				swatch: ["#b3a995"],
				apply: (s) => {
					s.int.furniture.cabinet = { ...s.int.furniture.cabinet };
				},
				note: "扉はキッチンと同じ面材。取っ手なし"
			},
			{
				id: "cup.custom.oak",
				maker: "造作（家具工事）",
				name: "造作カップボード",
				code: "オーク突板 ＋ 石目カウンター",
				color: "オーク",
				swatch: ["#c3a06f"],
				apply: (s) => {
					s.int.furniture.cabinet = {
						pattern: "wood",
						color: "#c3a06f",
						color2: "#ae8b5d",
						roughness: .5
					};
				}
			},
			{
				id: "cup.custom.white",
				maker: "造作（家具工事）",
				name: "造作カップボード",
				code: "メラミン ホワイト ＋ 石目カウンター",
				color: "ホワイト",
				swatch: ["#ecebe8"],
				apply: (s) => {
					s.int.furniture.cabinet = paint("#ecebe8", .5);
				}
			},
			{
				id: "cup.lixil.richelle",
				maker: "LIXIL",
				name: "リシェルSI カップボード",
				code: "W2700 トール＋カウンター",
				color: "キッチン同色",
				swatch: ["#6e5542"],
				apply: (s) => {
					s.int.furniture.cabinet = { ...s.int.furniture.cabinet };
				}
			}
		]
	},
	{
		id: "bath",
		label: "浴室",
		part: "設備",
		products: [{
			id: "bath.toto.sazana1616",
			maker: "TOTO",
			name: "サザナ 1616",
			code: "HT シリーズ Tタイプ",
			color: "ほっカラリ床 × アクセントパネル",
			swatch: ["#e9e7e2", "#8e8c88"],
			estimate: {
				group: "bath",
				line: "eq.bath1616"
			}
		}, {
			id: "bath.toto.sazana1620",
			maker: "TOTO",
			name: "サザナ 1620",
			code: "HT シリーズ Tタイプ",
			color: "ほっカラリ床 × アクセントパネル",
			swatch: ["#e9e7e2", "#8e8c88"],
			estimate: {
				group: "bath",
				line: "eq.bath1620"
			}
		}]
	},
	{
		id: "vanity",
		label: "洗面",
		part: "設備",
		products: [{
			id: "vanity.custom1200",
			maker: "造作",
			name: "造作洗面 W1200",
			code: "メラミンカウンター ＋ 実験用シンク",
			color: "ホワイト",
			swatch: ["#e6e4df"],
			estimate: {
				group: "vanity",
				line: "cu.vanity1200"
			}
		}, {
			id: "vanity.custom750",
			maker: "造作",
			name: "造作洗面 W750",
			code: "メラミンカウンター ＋ 実験用シンク",
			color: "ホワイト",
			swatch: ["#e6e4df"],
			estimate: {
				group: "vanity",
				line: "cu.vanity750"
			}
		}]
	},
	{
		id: "toilet",
		label: "トイレ",
		part: "設備",
		products: [{
			id: "toilet.toto",
			maker: "TOTO",
			name: "1階 NJ1 ／ 2階 ZJ1",
			code: "NJ1・ZJ1",
			color: "ホワイト",
			swatch: ["#f4f3f0"]
		}]
	},
	{
		id: "water",
		label: "給湯",
		part: "設備",
		products: [
			{
				id: "water.ecocute360",
				maker: "三菱電機",
				name: "エコキュート 360L",
				code: "SRT-S376",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "water",
					line: "eq.ecocute360"
				}
			},
			{
				id: "water.ecocute460",
				maker: "三菱電機",
				name: "エコキュート 460L",
				code: "SRT-S466",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "water",
					line: "eq.ecocute460"
				}
			},
			{
				id: "water.ecoone",
				maker: "リンナイ",
				name: "エコワン 70L",
				code: "ECO ONE ハイブリッド",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "water",
					line: "eq.ecoone"
				},
				note: "ガス配管の行が入ります"
			},
			{
				id: "water.ecojozu",
				maker: "リンナイ",
				name: "エコジョーズ",
				code: "RUF-E",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "water",
					line: "eq.ecojozu"
				}
			}
		]
	},
	{
		id: "vent",
		label: "換気",
		part: "設備",
		products: [
			{
				id: "vent.lufro",
				maker: "日本住環境",
				name: "ルフロ400（ダクト式第三種）",
				code: "LUFRO 400",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "vent",
					line: "eq.vent3lufro"
				}
			},
			{
				id: "vent.wall",
				maker: "パナソニック",
				name: "壁式 第三種換気",
				code: "パイプファン",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "vent",
					line: "eq.vent3wall"
				}
			},
			{
				id: "vent.lossnay",
				maker: "三菱電機",
				name: "ロスナイ（ダクト式第一種）",
				code: "VL-",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "vent",
					line: "eq.vent1lossnay"
				}
			},
			{
				id: "vent.sumika",
				maker: "マーベックス",
				name: "澄家（第一種 全熱交換）",
				code: "sumika",
				swatch: ["#dcdcdc"],
				estimate: {
					group: "vent",
					line: "eq.vent1sumika"
				}
			}
		]
	},
	{
		id: "ac",
		label: "空調",
		part: "設備",
		products: [{
			id: "ac.floor",
			maker: "ダイキン／三菱",
			name: "床下エアコン",
			code: "壁掛け 1 台を床下へ",
			swatch: ["#dcdcdc"],
			estimate: {
				group: "ac",
				line: "eq.acFloor"
			}
		}, {
			id: "ac.daikin",
			maker: "ダイキン",
			name: "アメニティエアコン（ビルトイン）",
			code: "ハウジングエアコン",
			swatch: ["#dcdcdc"],
			estimate: {
				group: "ac",
				line: "eq.acDaikin"
			}
		}]
	},
	{
		id: "pv",
		label: "太陽光",
		part: "設備",
		products: [{
			id: "pv.qcells",
			maker: "Qセルズ",
			name: "太陽光 4.3kW",
			code: "Q.TRON パワコン込",
			swatch: ["#1c2a3a"],
			estimate: {
				group: "pv",
				line: "eq.pv43"
			}
		}, {
			id: "pv.none",
			maker: "—",
			name: "太陽光なし",
			code: "",
			swatch: ["#dddbd5"],
			estimate: {
				group: "pv",
				line: "eq.pvNone"
			}
		}]
	},
	{
		id: "light",
		label: "照明",
		part: "設備",
		products: [
			{
				id: "light.3000",
				maker: "DAIKO／パナソニック",
				name: "ダウンライト・間接照明 一式",
				code: "電球色 3000K",
				color: "3000K",
				swatch: ["#ffd9a8"],
				apply: (s) => {
					s.int.lightKelvin = 3e3;
				}
			},
			{
				id: "light.2700",
				maker: "DAIKO／パナソニック",
				name: "ダウンライト・間接照明 一式",
				code: "電球色 2700K",
				color: "2700K",
				swatch: ["#ffc98a"],
				apply: (s) => {
					s.int.lightKelvin = 2700;
				}
			},
			{
				id: "light.3500",
				maker: "DAIKO／パナソニック",
				name: "ダウンライト・間接照明 一式",
				code: "温白色 3500K",
				color: "3500K",
				swatch: ["#ffe7c4"],
				apply: (s) => {
					s.int.lightKelvin = 3500;
				}
			}
		]
	}
];
//#endregion
//#region src/mcp/tools.ts
var MAX_MODELS = 20;
var seq = 0;
function createContext(init = {}) {
	return {
		models: /* @__PURE__ */ new Map(),
		fetch: typeof fetch === "function" ? fetch : void 0,
		...init
	};
}
function text(value, structured) {
	return {
		content: [{
			type: "text",
			text: typeof value === "string" ? value : JSON.stringify(value, null, 1)
		}],
		...structured ? { structuredContent: structured } : {}
	};
}
function fail(msg) {
	return {
		content: [{
			type: "text",
			text: msg
		}],
		isError: true
	};
}
function num(v) {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v)) return +v;
}
function bool(v, dflt) {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return /^(true|1|yes|on)$/i.test(v);
	return dflt;
}
var r1 = (v) => Math.round(v * 10) / 10;
var r2 = (v) => Math.round(v * 100) / 100;
function isModel(v) {
	return !!v && typeof v === "object" && Array.isArray(v.floors) && typeof v.northAngleDeg === "number";
}
/** model / model_id / プロジェクトファイルのどれかから間取りを取り出す */
function resolveModel(args, ctx) {
	let m = args.model ?? (args.project && typeof args.project === "object" ? args.project : void 0) ?? args.project_json;
	if (typeof m === "string") try {
		m = JSON.parse(m);
	} catch {
		throw new Error("model は JSON として読めませんでした");
	}
	if (m && typeof m === "object" && m.format?.startsWith("madori-project")) m = m.model;
	if (isModel(m)) return m;
	const id = args.model_id;
	if (typeof id === "string" && id) {
		const found = ctx.models.get(id);
		if (!found) throw new Error(`model_id "${id}" は見つかりません（サーバーが再起動したか、別のインスタンスです）。parse_floor_plan をやり直すか、include_model: true で受け取った model をそのまま渡してください`);
		return found;
	}
	throw new Error("model_id（parse_floor_plan の結果）か model（include_model で受け取った JSON／アプリで保存したプロジェクトファイル）を指定してください");
}
function storeModel(ctx, model) {
	const id = `m${Date.now().toString(36)}${(++seq).toString(36)}`;
	ctx.models.set(id, model);
	while (ctx.models.size > MAX_MODELS) {
		const oldest = ctx.models.keys().next().value;
		if (oldest === void 0) break;
		ctx.models.delete(oldest);
	}
	return id;
}
var LIVABLE_EXCLUDE = /* @__PURE__ */ new Set([
	"void",
	"balcony",
	"porch",
	"garage"
]);
function furnitureOf(model, f) {
	return model.furniture?.find((x) => x.level === f.level)?.items ?? f.planItems ?? [];
}
/** エージェントが一度に把握できる要約（寸法は mm、面積は ㎡） */
function summarizeModel(model, modelId) {
	const floors = model.floors.map((f) => {
		const livable = f.rooms.filter((r) => !LIVABLE_EXCLUDE.has(r.type)).reduce((s, r) => s + r.area, 0);
		const openings = {};
		for (const o of f.openings) openings[o.kind] = (openings[o.kind] ?? 0) + 1;
		const xs = f.outline.flat().map((p) => p.x);
		const ys = f.outline.flat().map((p) => p.y);
		return {
			level: f.level,
			floor_area_m2: r2(livable),
			floor_area_tsubo: r1(livable / 3.30579),
			bbox_mm: xs.length ? {
				w: Math.round(Math.max(...xs) - Math.min(...xs)),
				d: Math.round(Math.max(...ys) - Math.min(...ys))
			} : null,
			rooms: f.rooms.map((r) => ({
				id: r.id,
				name: r.name,
				type: r.type,
				type_label: ROOM_TYPE_LABEL[r.type] ?? r.type,
				area_m2: r2(r.area),
				tatami: r1(r.area / 1.62),
				labeled_tatami: r.labeledTatami ?? null
			})),
			walls: f.walls.length,
			exterior_walls: f.walls.filter((w) => w.exterior).length,
			openings,
			stairs: f.stairs.map((s) => ({
				kind: s.kind,
				goes_up: s.goesUp,
				w_mm: Math.round(s.maxX - s.minX),
				d_mm: Math.round(s.maxY - s.minY)
			})),
			furniture: furnitureOf(model, f).map((it) => ({
				kind: it.kind,
				...it.kitchenType ? { kitchen_type: it.kitchenType } : {},
				room_id: it.roomId ?? null
			}))
		};
	});
	const issues = woodCheck(model);
	return {
		...modelId ? { model_id: modelId } : {},
		name: model.name,
		floors,
		total_floor_area_m2: r2(floors.reduce((s, f) => s + f.floor_area_m2, 0)),
		module: model.module ? {
			size_mm: model.module.size,
			grid_mm: model.module.grid,
			fit: r2(model.module.fit),
			snapped: model.module.snapped,
			source: model.module.source
		} : null,
		north_angle_deg: model.northAngleDeg,
		north_detected: model.report.northDetected ?? null,
		scale: {
			denominator: model.report.scaleDenominator,
			source: model.report.scaleSource
		},
		wall_thicknesses_mm: model.report.wallThicknesses,
		site: model.site ? {
			roads: model.site.roads.map((r) => ({
				side: r.side,
				width_mm: r.widthMm ?? null,
				source: r.source
			})),
			area_m2: model.site.areaM2 ?? null
		} : null,
		warnings: model.report.warnings,
		wood_check: issues.map((i) => ({
			severity: i.severity,
			title: i.title
		}))
	};
}
function decodeBase64(s) {
	const clean = s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
	if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(clean, "base64"));
	const bin = atob(clean);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
var MODEL_ARGS = {
	model_id: {
		type: "string",
		description: "parse_floor_plan が返した model_id"
	},
	model: {
		type: "object",
		description: "parse_floor_plan に include_model: true を付けて受け取った model、またはアプリで保存したプロジェクトファイル（.json）の中身。model_id の代わりに渡す"
	}
};
var TOOLS = [
	{
		name: "parse_floor_plan",
		title: "平面図を読み取る",
		description: "平面図（CAD から出力したベクター PDF、または DXF）を読み取り、階・部屋（用途・面積・帖数）・壁・開口・階段・家具・木造モジュール・方位・接道を返します。結果の model_id を wood_check / floor_plan_svg / export_dxf / estimate に渡せます。入力は pdf_base64・pdf_url・dxf_text・project（アプリで保存した .json）のどれか 1 つ。",
		inputSchema: {
			type: "object",
			properties: {
				pdf_base64: {
					type: "string",
					description: "PDF の中身（base64。data: URL でも可）"
				},
				pdf_url: {
					type: "string",
					description: "PDF の URL（サーバーから取りに行く）"
				},
				dxf_text: {
					type: "string",
					description: "DXF の中身（テキスト、実寸 mm）"
				},
				project: {
					type: "object",
					description: "アプリで保存したプロジェクトファイル（madori-project-v1）の中身"
				},
				name: {
					type: "string",
					description: "図面の名前（物件名など）"
				},
				scale_denominator: {
					type: "number",
					description: "縮尺を手で指定（100 → 1/100）。省略時は図面から自動判定"
				},
				module: {
					type: "string",
					enum: [
						"auto",
						"shaku",
						"meter",
						"none"
					],
					description: "木造のモジュール: auto=図面から判定（既定）, shaku=尺 910, meter=メーター 1000, none=格子へ寄せない"
				},
				include_model: {
					type: "boolean",
					description: "true にすると結果に model（間取りの JSON 全体）も入れる。サーバーが入れ替わっても他のツールに渡せる",
					default: false
				}
			}
		},
		async run(args, ctx) {
			const name = typeof args.name === "string" ? args.name : void 0;
			const module = typeof args.module === "string" && [
				"auto",
				"shaku",
				"meter",
				"none"
			].includes(args.module) ? args.module : "auto";
			const scaleDenominator = num(args.scale_denominator);
			let model;
			if (args.project && typeof args.project === "object") model = resolveModel({ model: args.project }, ctx);
			else if (typeof args.dxf_text === "string" && args.dxf_text.trim()) model = parseDxf(args.dxf_text, {
				name,
				module
			});
			else if (typeof args.pdf_base64 === "string" && args.pdf_base64 || typeof args.pdf_url === "string" && args.pdf_url) {
				if (!ctx.pdfjs) return fail("このサーバーは PDF を読めません（pdf.js が無い環境）。DXF か、アプリで保存したプロジェクトファイルを渡してください");
				let data;
				if (typeof args.pdf_base64 === "string" && args.pdf_base64) data = decodeBase64(args.pdf_base64);
				else {
					if (!ctx.fetch) return fail("この環境では URL から PDF を取れません。pdf_base64 で渡してください");
					const url = String(args.pdf_url);
					if (!/^https?:\/\//i.test(url)) return fail("pdf_url は http(s) の URL にしてください");
					const res = await ctx.fetch(url);
					if (!res.ok) return fail(`PDF を取得できませんでした: HTTP ${res.status}`);
					data = new Uint8Array(await res.arrayBuffer());
				}
				if (data.length < 8 || String.fromCharCode(...data.slice(0, 4)) !== "%PDF") return fail("PDF ではないデータです（先頭が %PDF ではありません）");
				model = await parseFloorPlanPdf(data, ctx.pdfjs, {
					...ctx.pdfOptions,
					name: name ?? "plan.pdf",
					scaleDenominator,
					module
				});
			} else return fail("pdf_base64・pdf_url・dxf_text・project のどれかを指定してください");
			const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
			if (!model.floors.length || rooms === 0) return fail("平面図を認識できませんでした。CAD から出力したベクター形式の PDF（スキャン画像ではないもの）をお試しください。warnings: " + model.report.warnings.join(" / "));
			const id = storeModel(ctx, model);
			const summary = summarizeModel(model, id);
			const out = bool(args.include_model, false) ? {
				...summary,
				model
			} : summary;
			return text(out, out);
		}
	},
	{
		name: "wood_check",
		title: "木造の常識チェック",
		description: "在来軸組の設計士が図面を見たときの違和感をルールで出します: つながらない短い壁（読み取りミスの疑い）・格子に乗らない壁の端・2 階の直下率と外壁の受け・梁のスパン（2 間超）・開口だらけの外壁・出入口の無い部屋・上下階の階段位置・UB／便所の寸法。severity: warn=要確認, info=設計上の注意, ok=問題なし。",
		inputSchema: {
			type: "object",
			properties: { ...MODEL_ARGS }
		},
		async run(args, ctx) {
			const issues = woodCheck(resolveModel(args, ctx)).map((i) => ({
				id: i.id,
				level: i.level ?? null,
				severity: i.severity,
				title: i.title,
				detail: i.detail,
				fixable: !!i.fix,
				fix_label: i.fix?.label ?? null
			}));
			const out = {
				warn: issues.filter((i) => i.severity === "warn").length,
				info: issues.filter((i) => i.severity === "info").length,
				issues
			};
			return text(out, out);
		}
	},
	{
		name: "floor_plan_svg",
		title: "平面図（SVG）",
		description: "読み取った間取りの清書平面図を SVG で返します。sheet: true で A3 図枠（表題欄・面積表・建具表・1 間の格子）付き。",
		inputSchema: {
			type: "object",
			properties: {
				...MODEL_ARGS,
				level: {
					type: "number",
					description: "階（1, 2, 3）。既定 1"
				},
				sheet: {
					type: "boolean",
					description: "図枠に入れる（既定 false）"
				},
				project: {
					type: "string",
					description: "図枠の工事名（例: 〇〇様邸 新築工事）"
				},
				designer: {
					type: "string",
					description: "図枠の設計者・会社名"
				},
				show_furniture: {
					type: "boolean",
					description: "家具を描く（既定 true）"
				},
				show_dims: {
					type: "boolean",
					description: "寸法を描く（既定 true）"
				}
			}
		},
		async run(args, ctx) {
			const model = resolveModel(args, ctx);
			const level = num(args.level) ?? 1;
			const f = model.floors.find((x) => x.level === level);
			if (!f) return fail(`${level}階がありません（ある階: ${model.floors.map((x) => x.level).join(", ")}）`);
			return { content: [{
				type: "text",
				text: floorPlanSvg(model, f, {
					sheet: bool(args.sheet, false) ? {
						project: typeof args.project === "string" && args.project ? args.project : `${model.name} 新築工事`,
						drawing: `${level}階 平面図`,
						date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "."),
						designer: typeof args.designer === "string" ? args.designer : "",
						no: `A-${level}`
					} : void 0,
					showFurniture: bool(args.show_furniture, true),
					showDims: bool(args.show_dims, true),
					title: `${level}階平面図`
				})
			}] };
		}
	},
	{
		name: "export_dxf",
		title: "DXF 書き出し",
		description: "読み取った間取り（壁芯・開口・部屋名・階段）を CAD へ戻すための DXF（実寸 mm、階ごとのレイヤー）を返します。",
		inputSchema: {
			type: "object",
			properties: { ...MODEL_ARGS }
		},
		async run(args, ctx) {
			return { content: [{
				type: "text",
				text: modelToDxf(resolveModel(args, ctx))
			}] };
		}
	},
	{
		name: "estimate",
		title: "概算見積",
		description: "間取りから数量（延床・施工面積・外壁・屋根・基礎外周・建具数など）を拾い、社内の積算シート（P シリーズ／S シリーズ）の既定仕様で概算見積（工事別の金額・税込合計・坪単価）を出します。金額は円。",
		inputSchema: {
			type: "object",
			properties: {
				...MODEL_ARGS,
				grade: {
					type: "string",
					enum: ["P", "S"],
					description: "シリーズ。既定 P"
				},
				roof_type: {
					type: "string",
					enum: [
						"gable",
						"hip",
						"shed",
						"flat"
					],
					description: "屋根の形（既定: 標準テイストの屋根）"
				},
				pitch: {
					type: "number",
					description: "屋根勾配（寸。例 3 = 3寸）"
				},
				eaves_mm: {
					type: "number",
					description: "軒の出 (mm)"
				}
			}
		},
		async run(args, ctx) {
			const model = resolveModel(args, ctx);
			const grade = args.grade === "S" ? "S" : "P";
			const ext = exteriorById(DEFAULT_DESIGN.exteriorId);
			const roofType = typeof args.roof_type === "string" && [
				"gable",
				"hip",
				"shed",
				"flat"
			].includes(args.roof_type) ? args.roof_type : ext.roof.type;
			const areas = takeoff(model, {
				grade,
				eavesMm: num(args.eaves_mm) ?? ext.roof.eaves,
				pitch: num(args.pitch) ?? ext.roof.pitch,
				roofType,
				solido: ext.accent ? ext.accentRule : "none"
			});
			const est = computeEstimate(areas, newChoice(grade));
			const quantities = {};
			for (const fdef of AREA_FIELDS) quantities[fdef.key] = {
				label: fdef.label,
				value: r2(Number(areas[fdef.key]) || 0),
				unit: fdef.unit
			};
			const out = {
				grade,
				totals: {
					total_floor_area_m2: r2(areas.totalArea),
					total_floor_area_tsubo: r2(areas.totalTsubo),
					construction_area_m2: r2(areas.constArea),
					construction_area_tsubo: r2(areas.constTsubo)
				},
				quantities,
				categories: est.categories.map((c) => ({
					id: c.def.id,
					no: c.def.no,
					name: c.def.name,
					amount: Math.round(c.amount),
					lines: c.lines.length
				})),
				subtotal: Math.round(est.subtotal),
				adjust: Math.round(est.adjust),
				tax: Math.round(est.tax),
				total: Math.round(est.total),
				per_tsubo: Math.round(est.perTsubo),
				note: "既定仕様の概算です。仕上げ・設備を選ぶと金額が変わります（アプリのコーディネート・見積画面）"
			};
			return text(out, out);
		}
	},
	{
		name: "catalog",
		title: "仕上げ・設備カタログ",
		description: "アプリで選べる仕上げ・設備（外壁・屋根・床・キッチン・浴室・建具など、メーカー・品番つき）を検索します。query はメーカー名・商品名・品番・色の部分一致。",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "検索語（例: LINE KITCHEN, ジョリパット, ブラック）"
				},
				category: {
					type: "string",
					description: "カテゴリ id（例: extWall, kitchen）。categories だけ知りたいときは list_categories: true"
				},
				part: {
					type: "string",
					enum: [
						"外部",
						"内部",
						"設備"
					],
					description: "部位で絞る"
				},
				list_categories: {
					type: "boolean",
					description: "true でカテゴリ一覧だけ返す"
				}
			}
		},
		async run(args) {
			if (bool(args.list_categories, false)) {
				const cats = FINISH_CATEGORIES.map((c) => ({
					id: c.id,
					label: c.label,
					part: c.part,
					products: c.products.length
				}));
				return text({ categories: cats }, { categories: cats });
			}
			const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
			const items = [];
			for (const c of FINISH_CATEGORIES) {
				if (typeof args.category === "string" && args.category && c.id !== args.category) continue;
				if (typeof args.part === "string" && args.part && c.part !== args.part) continue;
				for (const p of c.products) {
					const hay = `${p.maker} ${p.name} ${p.code} ${p.color ?? ""} ${c.label}`.toLowerCase();
					if (q && !hay.includes(q)) continue;
					items.push({
						category: c.id,
						category_label: c.label,
						part: c.part,
						id: p.id,
						maker: p.maker,
						name: p.name,
						code: p.code,
						color: p.color ?? null,
						note: p.note ?? null
					});
				}
			}
			const out = {
				count: items.length,
				items: items.slice(0, 200)
			};
			return text(out, out);
		}
	},
	{
		name: "get_model",
		title: "間取り JSON を取り出す",
		description: "model_id の間取り（BuildingModel の JSON 全体）を返します。別のサーバーに渡したり、保存したりする用。",
		inputSchema: {
			type: "object",
			properties: { model_id: MODEL_ARGS.model_id },
			required: ["model_id"]
		},
		async run(args, ctx) {
			const model = resolveModel({ model_id: args.model_id }, ctx);
			return { content: [{
				type: "text",
				text: JSON.stringify(model)
			}] };
		}
	},
	{
		name: "list_models",
		title: "読み取り済みの間取り",
		description: "このサーバーが覚えている model_id の一覧。",
		inputSchema: {
			type: "object",
			properties: {}
		},
		async run(_args, ctx) {
			const items = [...ctx.models.entries()].map(([id, m]) => ({
				model_id: id,
				name: m.name,
				floors: m.floors.length
			}));
			return text({ models: items }, { models: items });
		}
	}
];
function toolByName(name, tools = TOOLS) {
	return tools.find((t) => t.name === name);
}
//#endregion
//#region src/mcp/server.ts
/**
* MCP サーバーの中身（JSON-RPC 2.0）。輸送路（stdio / HTTP）に依存しない。
*
* 対応するメソッド: initialize, notifications/*, ping, tools/list, tools/call, prompts/list, prompts/get,
* resources/list, resources/templates/list, logging/setLevel
* 仕様: https://modelcontextprotocol.io/specification/2025-06-18
*/
var SERVER_INFO = {
	name: "madori-presentation",
	title: "間取りプレゼン",
	version: "0.1.0"
};
var LATEST_PROTOCOL = "2025-06-18";
var KNOWN_PROTOCOLS = [
	"2025-06-18",
	"2025-03-26",
	"2024-11-05"
];
var INSTRUCTIONS = "住宅の平面図（PDF／DXF）を読み取って、部屋・壁・開口・階段・家具を持つ間取りモデルにするサーバーです。まず parse_floor_plan で model_id を得て、wood_check（木造の常識チェック）・floor_plan_svg（清書平面図）・export_dxf（CAD へ戻す）・estimate（概算見積）に渡してください。寸法は mm、面積は ㎡（帖 = ㎡ ÷ 1.62）。木造は 910 の尺モジュール（半間 455 の格子）が基本です。本番サーバー（/api/mcp）はインスタンスが入れ替わると model_id を忘れるので、長い作業では include_model: true で model を受け取り、次のツールに渡してください。";
var PROMPTS = [{
	name: "plan_review",
	title: "間取りレビュー",
	description: "平面図を読み取り、木造の常識チェックと部屋構成を踏まえて、設計士向けのレビュー（日本語）を書く",
	arguments: [{
		name: "source",
		description: "PDF のパス／URL、または model_id",
		required: true
	}, {
		name: "focus",
		description: "重点（例: 構造, 動線, 収納, 採光）",
		required: false
	}]
}];
function promptMessages(name, args) {
	if (name !== "plan_review") throw rpcError(-32602, `prompt "${name}" はありません`);
	const src = args.source ?? "";
	const focus = args.focus ? `特に「${args.focus}」を重点的に見てください。` : "";
	return {
		description: PROMPTS[0].description,
		messages: [{
			role: "user",
			content: {
				type: "text",
				text: `次の平面図をレビューしてください: ${src}\n手順: (1) まだ model_id でなければ parse_floor_plan で読み取る（PDF は base64 で渡す） (2) wood_check を実行する (3) 部屋構成（各階の部屋・面積・帖数）、動線（玄関→LDK→水回り→階段）、木造としての注意点（直下率・梁のスパン・耐力壁・階段の位置）、読み取りミスの疑いがある所、を分けて日本語で簡潔にまとめる。寸法は mm、面積は ㎡ と帖で書く。${focus}`
			}
		}]
	};
}
function rpcError(code, message, data) {
	return {
		code,
		message,
		data,
		__rpc: true
	};
}
function isRpcError(e) {
	return !!e && typeof e === "object" && e.__rpc === true;
}
function createMcpServer(ctx, opts = {}) {
	const tools = opts.tools ?? TOOLS;
	async function dispatch(req) {
		const p = req.params ?? {};
		switch (req.method) {
			case "initialize": {
				const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : LATEST_PROTOCOL;
				return {
					protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
					capabilities: {
						tools: { listChanged: false },
						prompts: { listChanged: false },
						resources: {
							subscribe: false,
							listChanged: false
						},
						logging: {}
					},
					serverInfo: SERVER_INFO,
					instructions: INSTRUCTIONS
				};
			}
			case "ping": return {};
			case "logging/setLevel": return {};
			case "tools/list": return { tools: tools.map((t) => ({
				name: t.name,
				title: t.title,
				description: t.description,
				inputSchema: t.inputSchema
			})) };
			case "tools/call": {
				const name = typeof p.name === "string" ? p.name : "";
				const tool = toolByName(name, tools);
				if (!tool) throw rpcError(-32602, `ツール "${name}" はありません。tools/list で確認してください`);
				const args = p.arguments && typeof p.arguments === "object" ? p.arguments : {};
				try {
					return await tool.run(args, ctx);
				} catch (e) {
					return {
						content: [{
							type: "text",
							text: e.message || String(e)
						}],
						isError: true
					};
				}
			}
			case "prompts/list": return { prompts: PROMPTS };
			case "prompts/get": return promptMessages(typeof p.name === "string" ? p.name : "", p.arguments && typeof p.arguments === "object" ? p.arguments : {});
			case "resources/list": return { resources: [] };
			case "resources/templates/list": return { resourceTemplates: [] };
			case "resources/read": throw rpcError(-32002, "リソースはありません");
			case "completion/complete": return { completion: {
				values: [],
				hasMore: false
			} };
			default: throw rpcError(-32601, `メソッド "${req.method}" には対応していません`);
		}
	}
	async function handle(msg) {
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) return {
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "JSON-RPC 2.0 のリクエストではありません"
			}
		};
		const req = msg;
		const hasId = req.id !== void 0 && req.id !== null;
		if (typeof req.method !== "string") {
			if (hasId && (req.result !== void 0 || req.error !== void 0)) return null;
			return {
				jsonrpc: "2.0",
				id: req.id ?? null,
				error: {
					code: -32600,
					message: "method がありません"
				}
			};
		}
		if (req.jsonrpc !== "2.0") return hasId ? {
			jsonrpc: "2.0",
			id: req.id,
			error: {
				code: -32600,
				message: "jsonrpc は \"2.0\" にしてください"
			}
		} : null;
		if (!hasId || req.method.startsWith("notifications/")) {
			if (!hasId) return null;
		}
		try {
			const result = await dispatch(req);
			return hasId ? {
				jsonrpc: "2.0",
				id: req.id,
				result
			} : null;
		} catch (e) {
			if (!hasId) return null;
			if (isRpcError(e)) return {
				jsonrpc: "2.0",
				id: req.id,
				error: {
					code: e.code,
					message: e.message,
					...e.data !== void 0 ? { data: e.data } : {}
				}
			};
			return {
				jsonrpc: "2.0",
				id: req.id,
				error: {
					code: -32603,
					message: e.message || String(e)
				}
			};
		}
	}
	async function handleMany(input) {
		if (Array.isArray(input)) {
			if (!input.length) return {
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32600,
					message: "空のバッチです"
				}
			};
			const out = [];
			for (const m of input) {
				const r = await handle(m);
				if (r) out.push(r);
			}
			return out.length ? out : null;
		}
		return handle(input);
	}
	return {
		handle,
		handleMany,
		tools
	};
}
//#endregion
//#region src/mcp/node.ts
/**
* Node 向けの入口（stdio サーバーと本番の /api/mcp が共通で使う）。
* vite.mcp.config.ts でこのファイルを 1 つの ESM（api/_bundle/mcp-core.mjs）に束ねる:
* Vercel の関数は TypeScript を束ねずに ESM として動かすので、拡張子の無い import が並ぶ src/ をそのまま読めないため。
*/
/** pdfjs-dist の場所（CMap・標準フォント）。Vercel では /var/task/node_modules、ローカルでは require.resolve */
function findPdfjsDir(fromUrl) {
	const cands = [path.join(process.cwd(), "node_modules", "pdfjs-dist")];
	if (fromUrl) try {
		const req = createRequire(fromUrl);
		cands.push(path.dirname(req.resolve("pdfjs-dist/package.json")));
	} catch {}
	for (const c of cands) if (existsSync(path.join(c, "cmaps"))) return c;
	return null;
}
/** pdf.js と CMap の場所を組み込んだ Node 用のコンテキスト */
function createNodeContext(pdfjs, fromUrl) {
	const dir = findPdfjsDir(fromUrl);
	return createContext({
		pdfjs,
		pdfOptions: dir ? {
			cMapUrl: path.join(dir, "cmaps") + "/",
			standardFontDataUrl: path.join(dir, "standard_fonts") + "/",
			wasmUrl: path.join(dir, "wasm") + "/"
		} : {}
	});
}
//#endregion
export { INSTRUCTIONS, SERVER_INFO, TOOLS, createContext, createMcpServer, createNodeContext, findPdfjsDir, resolveModel, storeModel, summarizeModel };
