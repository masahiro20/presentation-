/**
 * 3D データの読み込み（importModel.ts）のテスト。Node 上で DOM 無しに動くこと。
 * サンプル 3DS（scripts/make-sample-3ds.mjs が生成）を読み、単位・上方向の推定・配置（PlacedModel）を確かめる。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { ACCEPT_EXT, bakeObject, base64ToArrayBuffer, detectFormat, guessUnit, guessUpAxis, importModelFile, is3dsBuffer, PlacedModel, prepare3ds, unitScale, type BakedMeshData } from '../src/sunstudy/importModel';
import { DEFAULT_PLACEMENT, type ImportedModel, type ModelPlacement } from '../src/sunstudy/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = path.join(ROOT, 'public', 'samples', 'sample_house.3ds');
const SCRIPT = path.join(ROOT, 'scripts', 'make-sample-3ds.mjs');

/** Node の Buffer → 独立した ArrayBuffer（Buffer はプールを共有することがある） */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function readSample(): ArrayBuffer {
  return toArrayBuffer(readFileSync(SAMPLE));
}

/** スクリプトで 3DS を生成して読む（scale ≠ 1 の変種はテスト用の一時ディレクトリへ） */
function generate(scale: number): ArrayBuffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sample-3ds-'));
  const out = path.join(dir, `sample_${scale}.3ds`);
  execFileSync(process.execPath, [SCRIPT, '--scale', String(scale), '--out', out], { stdio: 'pipe' });
  return toArrayBuffer(readFileSync(out));
}

function place(model: ImportedModel, over: Partial<ModelPlacement> = {}): PlacedModel {
  return new PlacedModel(model, { ...DEFAULT_PLACEMENT, unit: 'mm', upAxis: 'z', hiddenObjects: [], ...over });
}

/** 配置済みモデルの中から名前でメッシュを探し、そのワールド bbox を返す */
function worldBoxOf(p: PlacedModel, name: string): THREE.Box3 {
  let found: THREE.Object3D | null = null;
  p.pivot.updateMatrixWorld(true);
  p.pivot.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh && o.name === name) found = o;
  });
  expect(found, `mesh ${name}`).not.toBeNull();
  return new THREE.Box3().setFromObject(found!, true);
}

const bufFrom = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

/** 単純な 3DS チャンクの走査（テスト用）: 先頭で見つかった id のチャンクの中身の位置を返す */
function findChunk(data: ArrayBuffer, id: number, containers = [0x4d4d, 0x3d3d, 0x4000, 0x4100]): number {
  const dv = new DataView(data);
  const walk = (start: number, end: number): number => {
    let pos = start;
    while (pos + 6 <= end) {
      const cid = dv.getUint16(pos, true);
      const size = dv.getUint32(pos + 2, true);
      if (cid === id) return pos + 6;
      if (containers.includes(cid)) {
        let body = pos + 6;
        if (cid === 0x4000) while (dv.getUint8(body) !== 0) body++, void 0;
        if (cid === 0x4000) body++;
        const r = walk(body, pos + size);
        if (r >= 0) return r;
      }
      pos += size;
    }
    return -1;
  };
  return walk(0, data.byteLength);
}

// ---------------------------------------------------------------------------

describe('形式の判定・単位と上方向の推定', () => {
  it('detectFormat: 拡張子（大文字小文字を問わず）。.gltf は glb 扱い、対応外は null', () => {
    expect(detectFormat('house.3ds')).toBe('3ds');
    expect(detectFormat('HOUSE.3DS')).toBe('3ds');
    expect(detectFormat(' a.obj ')).toBe('obj');
    expect(detectFormat('a.stl')).toBe('stl');
    expect(detectFormat('a.glb')).toBe('glb');
    expect(detectFormat('a.gltf')).toBe('glb');
    expect(detectFormat('a.FBX')).toBe('fbx');
    expect(detectFormat('a.txt')).toBeNull();
    expect(detectFormat('noext')).toBeNull();
    expect(detectFormat('a.3ds.txt')).toBeNull();
    expect(ACCEPT_EXT).toContain('3ds');
  });

  it('is3dsBuffer: 先頭 4D4D（リトルエンディアン）', () => {
    expect(is3dsBuffer(bufFrom([0x4d, 0x4d, 0x10, 0, 0, 0]))).toBe(true);
    expect(is3dsBuffer(bufFrom([0x4d, 0x4d, 0x10]))).toBe(false); // 短すぎる
    expect(is3dsBuffer(bufFrom([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))).toBe(false);
    expect(is3dsBuffer(new ArrayBuffer(0))).toBe(false);
  });

  it('guessUnit: 水平の長辺 L > 1500 → mm、150 < L ≤ 1500 → cm、L ≤ 150 → m（高さは見ない）', () => {
    const box = (x: number, y: number, z: number) => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, y, z));
    expect(guessUnit(box(1500.5, 5, 3), 'z')).toBe('mm');
    expect(guessUnit(box(9100, 7280, 8200), 'z')).toBe('mm');
    expect(guessUnit(box(1500, 5, 3), 'z')).toBe('cm');
    expect(guessUnit(box(150.5, 5, 3), 'z')).toBe('cm');
    expect(guessUnit(box(150, 5, 3), 'z')).toBe('m');
    expect(guessUnit(box(10, 8, 6), 'z')).toBe('m');
    // Y-up: 水平は x と z。y（高さ）が大きくても単位には影響しない
    expect(guessUnit(box(100, 3000, 100), 'y')).toBe('m');
    expect(guessUnit(box(100, 10, 2000), 'y')).toBe('mm');
    expect(guessUnit(new THREE.Box3(), 'z')).toBe('mm');
  });

  it('guessUpAxis: 形式の既定（3DS/OBJ/STL は Z、GLB/FBX は Y）。bbox が強く矛盾すれば薄い軸を上に', () => {
    const box = (x: number, y: number, z: number) => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, y, z));
    expect(guessUpAxis('3ds', box(10000, 8000, 3000))).toBe('z');
    expect(guessUpAxis('obj', box(10, 8, 6))).toBe('z');
    expect(guessUpAxis('stl', new THREE.Box3())).toBe('z');
    // Z が 3 軸で最大、Y が最小、比 1.5 倍超 → Y-up で保存されたデータと見る
    // 3DS は形式として Z-up なので、狭小住宅（高さ > 幅）でも向きを変えない
    expect(guessUpAxis('3ds', box(6000, 3000, 8000))).toBe('z');
    // OBJ/STL は塔のように極端に細長いときだけ横倒しとみなす
    expect(guessUpAxis('obj', box(3, 1, 12))).toBe('y');
    expect(guessUpAxis('obj', box(6, 3, 8))).toBe('z');
    // 比が 1.5 倍以下なら既定のまま
    expect(guessUpAxis('3ds', box(6000, 6000, 8000))).toBe('z');
    // Z が最大でも X の方が大きければ（幅 > 高さの普通の建物）既定のまま
    expect(guessUpAxis('3ds', box(10000, 3000, 8000))).toBe('z');
    expect(guessUpAxis('glb', box(10, 6, 8))).toBe('y');
    // FBX は Y-up が既定。平屋のように見える比率でも、極端に細長くなければ向きは変えない（UI で切替可能）
    expect(guessUpAxis('fbx', box(6000, 8000, 3000))).toBe('y');
    // 既定の上方向（Y）だけが極端に長い = 実は Z-up で保存された細長いデータと見なす
    expect(guessUpAxis('fbx', box(3, 12, 1))).toBe('z');
    expect(guessUpAxis('fbx', box(3, 1, 12))).toBe('y');
  });

  it('unitScale: 単位 → m。custom は customScale（不正なら 1）', () => {
    expect(unitScale({ unit: 'mm', customScale: 1 })).toBe(0.001);
    expect(unitScale({ unit: 'cm', customScale: 1 })).toBe(0.01);
    expect(unitScale({ unit: 'm', customScale: 1 })).toBe(1);
    expect(unitScale({ unit: 'ft', customScale: 1 })).toBeCloseTo(0.3048, 6);
    expect(unitScale({ unit: 'custom', customScale: 0.002 })).toBe(0.002);
    expect(unitScale({ unit: 'custom', customScale: 0 })).toBe(1);
    expect(unitScale({ unit: 'custom', customScale: NaN })).toBe(1);
  });

  it('base64ToArrayBuffer: 空白を無視して復元する', () => {
    const src = new Uint8Array([0x4d, 0x4d, 1, 2, 3, 250, 255]);
    const b64 = Buffer.from(src).toString('base64');
    const back = new Uint8Array(base64ToArrayBuffer(b64.slice(0, 4) + '\n ' + b64.slice(4)));
    expect([...back]).toEqual([...src]);
  });
});

// ---------------------------------------------------------------------------

describe('サンプル住宅（3DS, mm, Z-up）', () => {
  let model: ImportedModel;
  beforeAll(async () => {
    model = await importModelFile({ name: 'sample_house.3ds', data: readSample() });
  });

  it('形式・単位・上方向を推定し、bbox は 10300 × 8780 × 8200 mm（1 % 以内）', () => {
    expect(model.format).toBe('3ds');
    expect(model.guessedUnit).toBe('mm');
    expect(model.guessedUp).toBe('z');
    const s = model.rawBox.getSize(new THREE.Vector3());
    expect(Math.abs(s.x - 10300) / 10300).toBeLessThan(0.01);
    expect(Math.abs(s.y - (7280 + 1500)) / 8780).toBeLessThan(0.01);
    expect(Math.abs(s.z - 8200) / 8200).toBeLessThan(0.01);
    // 底面は z = 0、平面の中心は原点付近（南の窓が 10 mm 出ている分だけ南に寄る）
    expect(model.rawBox.min.z).toBeCloseTo(0, 3);
    expect(model.rawBox.min.x).toBeCloseTo(-5150, 3);
    expect(model.rawBox.max.y).toBeCloseTo(3640 + 1500, 3);
  });

  it('三角形を数え、オブジェクト一覧に roof・porch などがある（除外なし）', () => {
    expect(model.triangles).toBeGreaterThan(0);
    expect(model.triangles).toBe(4 * 12 + 8); // 箱 4 つ + 切妻の立体
    const names = model.objects.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['wall', 'roof', 'porch', 'window_1', 'window_2']));
    expect(model.objects.every((o) => !o.autoHidden)).toBe(true);
    const roof = model.objects.find((o) => o.name === 'roof')!;
    expect(roof.triangles).toBe(8);
    expect(roof.size[0]).toBeCloseTo(10300, 3);
    expect(roof.size[2]).toBeCloseTo(2200, 3);
    const porch = model.objects.find((o) => o.name === 'porch')!;
    expect(porch.size).toEqual([2000, 1500, 2400]);
    expect(model.data.byteLength).toBeGreaterThan(0);
  });

  it('焼き込み: raw は平らなグループ、単位変換、非インデックス、法線あり。色は sRGB→リニア、窓はガラス扱い', () => {
    expect(model.raw.children.length).toBe(5);
    for (const o of model.raw.children) {
      const m = o as THREE.Mesh;
      expect(m.isMesh).toBe(true);
      expect(m.matrix.equals(new THREE.Matrix4())).toBe(true);
      expect(m.geometry.index).toBeNull();
      expect(m.geometry.getAttribute('normal').count).toBe(m.geometry.getAttribute('position').count);
    }
    const ud = (name: string) => (model.raw.children.find((o) => o.name === name) as THREE.Mesh).userData as BakedMeshData;
    expect(ud('window_1').glass).toBe(true);
    // ガラスも影を落とす・遮蔽する（表示だけ半透明）
    expect(ud('window_1').noShadow).toBe(false);
    expect(ud('roof').glass).toBe(false);
    expect(ud('wall').materialName).toBe('wall');
    expect(ud('roof').materialName).toBe('roof');
    const wall = new THREE.Color('#f0ece4'); // three は 16 進を sRGB として読みリニアに変換する
    expect(ud('wall').origColor.r).toBeCloseTo(wall.r, 2);
    expect(ud('wall').origColor.g).toBeCloseTo(wall.g, 2);
    expect(ud('wall').origColor.b).toBeCloseTo(wall.b, 2);
    const roof = new THREE.Color('#5a5e66');
    expect(ud('roof').origColor.r).toBeCloseTo(roof.r, 2);
    expect(ud('roof').origColor.b).toBeCloseTo(roof.b, 2);
    expect(ud('wall').origOpacity).toBe(1);
    expect(model.notes.some((n) => /ガラス/.test(n))).toBe(true);
  });

  it('法線は外向き（各三角形の法線 · (重心 − 中心) > 0）', () => {
    const wall = model.raw.children.find((o) => o.name === 'wall') as THREE.Mesh;
    const pos = wall.geometry.getAttribute('position');
    const nrm = wall.geometry.getAttribute('normal');
    const center = wall.geometry.boundingBox!.getCenter(new THREE.Vector3());
    for (let t = 0; t < pos.count / 3; t++) {
      const c = new THREE.Vector3();
      for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, t * 3 + k));
      c.divideScalar(3).sub(center);
      const n = new THREE.Vector3().fromBufferAttribute(nrm, t * 3);
      expect(n.length()).toBeCloseTo(1, 5);
      expect(n.dot(c)).toBeGreaterThan(0);
    }
  });

  it('PlacedModel: 寸法 w ≈ 10.3, d ≈ 8.78, h ≈ 8.2 m、底面 y = 0、水平中心は原点', () => {
    const p = place(model);
    const { w, d, h } = p.dimensions();
    expect(w).toBeCloseTo(10.3, 2);
    expect(Math.abs(d - 8.78)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(h - 8.2)).toBeLessThanOrEqual(0.02);
    expect(p.localBox.min.y).toBeCloseTo(0, 6);
    expect(p.localBox.min.x + p.localBox.max.x).toBeCloseTo(0, 6);
    expect(p.localBox.min.z + p.localBox.max.z).toBeCloseTo(0, 6);
    expect(p.pivot.name).toBe('building');
    expect(p.object?.children[0].children.length).toBe(5);
    // 読み込み時の推定値をそのまま使っても同じ
    const q = new PlacedModel(model, { ...DEFAULT_PLACEMENT, unit: model.guessedUnit, upAxis: model.guessedUp });
    expect(q.dimensions().h).toBeCloseTo(h, 6);
    p.dispose();
    q.dispose();
  });

  it('足跡の四隅（南西→南東→北東→北西）とポーチ（モデルの北側）の位置', () => {
    const p = place(model);
    const fp = p.footprintEN();
    expect(fp).toHaveLength(4);
    const hw = p.size.x / 2;
    const hd = p.size.z / 2;
    expect(fp[0].e).toBeCloseTo(-hw, 6);
    expect(fp[0].n).toBeCloseTo(-hd, 6);
    expect(fp[1].e).toBeCloseTo(hw, 6);
    expect(fp[1].n).toBeCloseTo(-hd, 6);
    expect(fp[2].e).toBeCloseTo(hw, 6);
    expect(fp[2].n).toBeCloseTo(hd, 6);
    expect(fp[3].e).toBeCloseTo(-hw, 6);
    expect(fp[3].n).toBeCloseTo(hd, 6);
    // 上から見て反時計回り（符号付き面積 > 0）
    let area = 0;
    for (let i = 0; i < 4; i++) area += fp[i].e * fp[(i + 1) % 4].n - fp[(i + 1) % 4].e * fp[i].n;
    expect(area).toBeGreaterThan(0);
    expect(area / 2).toBeCloseTo(p.size.x * p.size.z, 6);
    // ポーチ: モデルの +y（北）側 → ワールド −z。中心は y = 3640..5140 → 4390 mm、全体中心のずれ分を補正
    const porch = worldBoxOf(p, 'porch');
    const c = porch.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(0, 3);
    expect(-c.z).toBeGreaterThan(3);
    expect(porch.max.z).toBeCloseTo(p.localBox.min.z + 1.5, 3); // 北端から 1.5 m
    expect(porch.max.y).toBeCloseTo(2.4, 3);
    p.dispose();
  });

  it('headingDeg = 90 で足跡が回転し、モデルの北側（ポーチ）が東を向く', () => {
    const p0 = place(model);
    const porch0 = worldBoxOf(p0, 'porch').getCenter(new THREE.Vector3());
    const p = place(model, { headingDeg: 90 });
    const fp = p.footprintEN();
    const es = fp.map((c) => c.e);
    const ns = fp.map((c) => c.n);
    expect(Math.max(...es) - Math.min(...es)).toBeCloseTo(p.size.z, 6); // 東西の幅 = 元の奥行
    expect(Math.max(...ns) - Math.min(...ns)).toBeCloseTo(p.size.x, 6);
    const porch = worldBoxOf(p, 'porch').getCenter(new THREE.Vector3());
    expect(porch.x).toBeCloseTo(-porch0.z, 6); // 北 (−z) → 東 (+x)
    expect(porch.x).toBeGreaterThan(3);
    expect(porch.z).toBeCloseTo(0, 6);
    // 寸法（回転前）は変わらない
    expect(p.dimensions()).toEqual(p0.dimensions());
    // 180° で南北が入れ替わる
    const p180 = place(model, { headingDeg: 180 });
    const porch180 = worldBoxOf(p180, 'porch').getCenter(new THREE.Vector3());
    expect(porch180.z).toBeCloseTo(-porch0.z, 6);
    p0.dispose();
    p.dispose();
    p180.dispose();
  });

  it('offsetE / offsetN / baseY は pivot の位置に、ワールド bbox もそれに従う', () => {
    const p = place(model, { offsetE: 12, offsetN: -7, baseY: 1.5 });
    expect(p.pivot.position.x).toBe(12);
    expect(p.pivot.position.z).toBe(7);
    expect(p.pivot.position.y).toBe(1.5);
    const wb = p.worldBox();
    expect(wb.min.y).toBeCloseTo(1.5, 6);
    expect(wb.max.y).toBeCloseTo(1.5 + p.size.y, 6);
    const c = wb.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(12, 6);
    expect(c.z).toBeCloseTo(7, 6);
    const fp = p.footprintEN();
    expect(fp[0].e).toBeCloseTo(12 - p.size.x / 2, 6);
    expect(fp[0].n).toBeCloseTo(-7 - p.size.z / 2, 6);
    p.dispose();
  });

  it('hiddenObjects: roof を隠すと高さ ≈ 6.0 m、幅は 9.1 m（けらば無し）になる', () => {
    const p = place(model, { hiddenObjects: ['roof'] });
    const { w, d, h } = p.dimensions();
    expect(Math.abs(h - 6.0)).toBeLessThanOrEqual(0.02);
    expect(w).toBeCloseTo(9.1, 2);
    expect(Math.abs(d - 8.78)).toBeLessThanOrEqual(0.02);
    expect(p.object?.children[0].children.map((c) => c.name)).not.toContain('roof');
    // 配置オブジェクトの変更 → rebuild で反映される
    p.placement.hiddenObjects = ['roof', 'porch'];
    p.rebuild();
    expect(p.dimensions().d).toBeCloseTo(7.29, 2);
    p.dispose();
  });

  it('mirror は寸法・足跡を変えない（x 反転のみ）。unit / custom で寸法が比例する', () => {
    const base = place(model);
    const mir = place(model, { mirror: true });
    expect(mir.dimensions().w).toBeCloseTo(base.dimensions().w, 6);
    expect(mir.dimensions().d).toBeCloseTo(base.dimensions().d, 6);
    expect(mir.dimensions().h).toBeCloseTo(base.dimensions().h, 6);
    // 窓 1（モデルの −x 側）は鏡像で +x 側へ
    const w1 = worldBoxOf(base, 'window_1').getCenter(new THREE.Vector3());
    const w1m = worldBoxOf(mir, 'window_1').getCenter(new THREE.Vector3());
    expect(w1m.x).toBeCloseTo(-w1.x, 6);
    expect(w1.x).toBeLessThan(0);
    const cm = place(model, { unit: 'cm' });
    expect(cm.dimensions().w).toBeCloseTo(103, 3);
    const custom = place(model, { unit: 'custom', customScale: 0.002 });
    expect(custom.dimensions().h).toBeCloseTo(16.4, 3);
    base.dispose();
    mir.dispose();
    cm.dispose();
    custom.dispose();
  });

  it('表示: appearance white / original で材質が差し替わり、窓は半透明（影は落とす）', () => {
    const white = place(model);
    const wallW = (white.object!.getObjectByName('wall') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(wallW.name).toBe('white');
    expect(wallW.color.getHexString()).toBe('f2f0ea');
    const win = white.object!.getObjectByName('window_1') as THREE.Mesh;
    expect(win.castShadow).toBe(true);
    expect((win.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    const orig = place(model, { appearance: 'original' });
    const wallO = (orig.object!.getObjectByName('wall') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(wallO.name).toBe('original');
    expect(wallO.color.getHexString()).toBe('f0ece4');
    expect((orig.object!.getObjectByName('wall') as THREE.Mesh).castShadow).toBe(true);
    white.dispose();
    orig.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('生成スクリプトと MASTER_SCALE', () => {
  it('スクリプトは決定的で、public/samples/sample_house.3ds と同じバイト列を作る', () => {
    const fresh = generate(1);
    const pub = readSample();
    expect(fresh.byteLength).toBe(pub.byteLength);
    expect(Buffer.from(fresh).equals(Buffer.from(pub))).toBe(true);
    expect(is3dsBuffer(pub)).toBe(true);
    // 先頭チャンクの長さ = ファイル長
    expect(new DataView(pub).getUint32(2, true)).toBe(pub.byteLength);
  });

  it('MASTER_SCALE 0.5 の変種: 座標は 2 倍で書かれ、TDSLoader が group.scale に入れるため焼き込み後は同じ寸法になる', async () => {
    const scaled = generate(0.5);
    const dv = new DataView(scaled);
    const ms = findChunk(scaled, 0x0100);
    expect(ms).toBeGreaterThan(0);
    expect(dv.getFloat32(ms, true)).toBe(0.5);
    // POINT_ARRAY の生の座標は実寸の 2 倍（wall: x = ±9100）
    const pa = findChunk(scaled, 0x4110);
    const n = dv.getUint16(pa, true);
    let maxX = 0;
    for (let i = 0; i < n; i++) maxX = Math.max(maxX, Math.abs(dv.getFloat32(pa + 2 + i * 12, true)));
    expect(maxX).toBeCloseTo(9100, 3);
    // TDSLoader: MASTER_SCALE → group.scale
    const g = new TDSLoader().parse(scaled.slice(0), '');
    expect(g.scale.x).toBe(0.5);
    // 読み込み（焼き込み）後は S = 1 と同じ bbox・寸法。単位も mm のまま
    const a = await importModelFile({ name: 'sample_house.3ds', data: readSample() });
    const b = await importModelFile({ name: 'sample_scaled.3ds', data: scaled });
    expect(b.guessedUnit).toBe('mm');
    expect(b.triangles).toBe(a.triangles);
    const sa = a.rawBox.getSize(new THREE.Vector3());
    const sb = b.rawBox.getSize(new THREE.Vector3());
    expect(sb.x).toBeCloseTo(sa.x, 2);
    expect(sb.y).toBeCloseTo(sa.y, 2);
    expect(sb.z).toBeCloseTo(sa.z, 2);
    const pa2 = place(a);
    const pb = place(b);
    expect(pb.dimensions().w).toBeCloseTo(pa2.dimensions().w, 4);
    expect(pb.dimensions().d).toBeCloseTo(pa2.dimensions().d, 4);
    expect(pb.dimensions().h).toBeCloseTo(pa2.dimensions().h, 4);
    pa2.dispose();
    pb.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OBJ（テキスト）', () => {
  const objBox = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, offset: number) => {
    const v = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    const q = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
      [1, 2, 6, 5],
    ];
    return [`o ${name}`, ...v.map((p) => `v ${p.join(' ')}`), ...q.map((f) => `f ${f.map((i) => i + 1 + offset).join(' ')}`)].join('\n');
  };
  const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it('Z-up の箱 10 × 8 × 6 m → guessedUnit m、Z-up、12 三角形', async () => {
    const text = '# box\n' + objBox('house', 0, 10, 0, 8, 0, 6, 0) + '\n';
    const m = await importModelFile({ name: 'box.obj', data: encode(text) });
    expect(m.format).toBe('obj');
    expect(m.guessedUnit).toBe('m');
    expect(m.guessedUp).toBe('z');
    expect(m.triangles).toBe(12);
    expect(m.objects.map((o) => o.name)).toEqual(['house']);
    const s = m.rawBox.getSize(new THREE.Vector3());
    expect([s.x, s.y, s.z]).toEqual([10, 8, 6]);
    const p = new PlacedModel(m, { ...DEFAULT_PLACEMENT, unit: 'm', upAxis: 'z' });
    const d = p.dimensions();
    expect(d.w).toBeCloseTo(10, 9);
    expect(d.d).toBeCloseTo(8, 9);
    expect(d.h).toBeCloseTo(6, 9);
    expect(p.localBox.min.y).toBeCloseTo(0, 9);
    p.dispose();
  });

  it('地面の板（名前 ground）は自動で除外され、bbox・単位推定から外れる', async () => {
    const text = objBox('house', 0, 9100, 0, 7280, 0, 6000, 0) + '\n' + objBox('ground', -20000, 29100, -20000, 27280, -10, 0, 8) + '\n';
    const m = await importModelFile({ name: 'site.obj', data: encode(text) });
    const ground = m.objects.find((o) => o.name === 'ground')!;
    expect(ground.autoHidden).toBe(true);
    expect(ground.reason).toMatch(/地面|敷地/);
    expect(m.objects.find((o) => o.name === 'house')!.autoHidden).toBe(false);
    const s = m.rawBox.getSize(new THREE.Vector3());
    expect(s.x).toBe(9100);
    expect(m.guessedUnit).toBe('mm');
    expect(m.notes.some((n) => /除外/.test(n))).toBe(true);
    // 隠す指定で配置すると建物だけ
    const p = new PlacedModel(m, { ...DEFAULT_PLACEMENT, unit: 'mm', upAxis: 'z', hiddenObjects: ['ground'] });
    expect(p.dimensions().h).toBeCloseTo(6, 6);
    p.dispose();
  });

  it('名前の無い大きく薄い板も形から地面と判定する', async () => {
    const text = objBox('house', 0, 9100, 0, 7280, 0, 6000, 0) + '\n' + objBox('slab', -20000, 29100, -20000, 27280, -10, 0, 8) + '\n';
    const m = await importModelFile({ name: 'site.obj', data: encode(text) });
    const slab = m.objects.find((o) => o.name === 'slab')!;
    expect(slab.autoHidden).toBe(true);
    expect(slab.reason).toMatch(/薄い板/);
  });
});

// ---------------------------------------------------------------------------

describe('焼き込み（bakeObject）', () => {
  /** 各三角形の法線が外向きか（原点中心の凸形状） */
  const outward = (mesh: THREE.Mesh) => {
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    const center = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
    let ok = 0;
    for (let t = 0; t < pos.count / 3; t++) {
      const c = new THREE.Vector3();
      for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, t * 3 + k));
      c.divideScalar(3).sub(center);
      const n = new THREE.Vector3().fromBufferAttribute(nrm, t * 3);
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) return false;
      if (n.dot(c) > 0) ok++;
    }
    return ok === pos.count / 3;
  };

  it('鏡像（負のスケール）のインスタンスでも法線は有効で外向き', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshStandardMaterial());
    a.name = 'normal';
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshStandardMaterial());
    b.name = 'mirrored';
    b.scale.set(-1, 1, 1);
    b.position.set(10, 0, 0);
    const c = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshStandardMaterial());
    c.name = 'mirrored2';
    c.scale.set(1, -2, 1);
    c.rotation.set(0.3, 0.7, 0.1);
    root.add(a, b, c);
    const { raw, dropped } = bakeObject(root, null);
    expect(dropped).toBe(0);
    expect(raw.children.map((o) => o.name)).toEqual(['normal', 'mirrored', 'mirrored2']);
    for (const o of raw.children) {
      const m = o as THREE.Mesh;
      expect(m.geometry.getAttribute('position').count).toBe(36);
      expect(outward(m), m.name).toBe(true);
    }
    // 鏡像のワールド位置は保たれる（焼き込み後は単位行列）
    const mb = raw.children[1] as THREE.Mesh;
    expect(mb.geometry.boundingBox!.getCenter(new THREE.Vector3()).x).toBeCloseTo(10, 6);
    expect(mb.matrixWorld.equals(new THREE.Matrix4())).toBe(true);
  });

  it('行列式 0 のメッシュは単位行列扱い、NaN や範囲外のインデックスの三角形は除く', () => {
    const root = new THREE.Group();
    const zero = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    zero.name = 'zero';
    zero.scale.set(0, 0, 0);
    const bad = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    bad.name = 'bad';
    bad.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 1, 1, 0, 0, 1, 1]), 3));
    bad.geometry.setIndex([0, 1, 2, 3, 4, 5, 0, 1, 99]);
    const noMat = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    noMat.name = 'empty';
    root.add(zero, bad, noMat);
    const { raw, dropped } = bakeObject(root, '3ds');
    expect(dropped).toBe(2);
    expect(raw.children.map((o) => o.name)).toEqual(['zero', 'bad']);
    expect((raw.children[0] as THREE.Mesh).geometry.getAttribute('position').count).toBe(36);
    expect((raw.children[1] as THREE.Mesh).geometry.getAttribute('position').count).toBe(3);
  });

  it('マテリアルの色・不透明度・ガラス判定を userData に残し、テクスチャは捨てる', () => {
    const root = new THREE.Group();
    const tex = new THREE.Texture();
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x80a0c0, transparent: true, opacity: 0.3, map: tex }));
    glass.name = 'curtain';
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [new THREE.MeshStandardMaterial({ color: 0x000000 }), new THREE.MeshStandardMaterial({ color: 0xff0000, name: 'red' })]);
    multi.name = 'Window frame';
    root.add(glass, multi);
    const { raw } = bakeObject(root, 'glb');
    const g = (raw.children[0] as THREE.Mesh).userData as BakedMeshData;
    expect(g.glass).toBe(true); // 不透明度 < 0.5
    expect(g.origOpacity).toBeCloseTo(0.3, 6);
    expect(g.origColor.getHex()).toBe(0x80a0c0);
    const m = (raw.children[1] as THREE.Mesh).userData as BakedMeshData;
    expect(m.glass).toBe(true); // 名前に window
    expect(m.origColor.getHex()).toBe(0xff0000); // 黒でない最初の色
    expect(m.materialName).toBe('red');
    expect(m.origOpacity).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('エラー・前処理', () => {
  it('3DS の識別子が無いバッファは日本語のメッセージで拒否する', async () => {
    const data = bufFrom([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 1, 2, 3, 4]);
    await expect(importModelFile({ name: 'fake.3ds', data })).rejects.toThrow(/3DS 形式のファイルではないようです/);
  });

  it('対応外の拡張子・空のファイルを拒否する', async () => {
    await expect(importModelFile({ name: 'a.skp', data: bufFrom([1, 2, 3]) })).rejects.toThrow(/対応していない形式/);
    await expect(importModelFile({ name: 'a.obj', data: new ArrayBuffer(0) })).rejects.toThrow(/ファイルが空です/);
  });

  it('面の無い 3DS（ヘッダーだけ）は「面が見つからない」エラー', async () => {
    // 4D4D + 3D3D の空チャンク
    const data = bufFrom([0x4d, 0x4d, 12, 0, 0, 0, 0x3d, 0x3d, 6, 0, 0, 0]);
    await expect(importModelFile({ name: 'empty.3ds', data })).rejects.toThrow(/三角形/);
  });

  it('prepare3ds: 長さ 0 のチャンクはエラー、特異な MESH_MATRIX は単位行列に直し注意を残す', () => {
    const notes: string[] = [];
    expect(() => prepare3ds(bufFrom([0x4d, 0x4d, 12, 0, 0, 0, 0x3d, 0x3d, 0, 0, 0, 0]), notes)).toThrow(/長さ 0 のチャンク/);

    const src = readSample();
    const pos = findChunk(src, 0x4160);
    expect(pos).toBeGreaterThan(0);
    const broken = src.slice(0);
    const dv = new DataView(broken);
    for (let i = 0; i < 12; i++) dv.setFloat32(pos + i * 4, 0, true);
    const fixed = prepare3ds(broken, notes);
    expect(fixed).not.toBe(broken); // 複製を返す
    expect(new DataView(fixed).getFloat32(pos, true)).toBe(1);
    expect(new DataView(fixed).getFloat32(pos + 4 * 4, true)).toBe(1);
    expect(notes.some((n) => /MESH_MATRIX/.test(n))).toBe(true);
    // 正常なファイルでは何も書き換えず注意も無い
    const notes2: string[] = [];
    const same = prepare3ds(src, notes2);
    expect(Buffer.from(same).equals(Buffer.from(src))).toBe(true);
    expect(notes2).toEqual([]);
  });

  it('全部 0 の MESH_MATRIX でも読み込める（TDSLoader の逆行列で頂点が消えない）', async () => {
    const src = readSample();
    const pos = findChunk(src, 0x4160);
    const broken = src.slice(0);
    const dv = new DataView(broken);
    for (let i = 0; i < 12; i++) dv.setFloat32(pos + i * 4, 0, true);
    const m = await importModelFile({ name: 'broken.3ds', data: broken });
    expect(m.triangles).toBe(56);
    expect(m.rawBox.getSize(new THREE.Vector3()).x).toBeCloseTo(10300, 2);
    expect(m.notes.some((n) => /MESH_MATRIX/.test(n))).toBe(true);
  });
});
