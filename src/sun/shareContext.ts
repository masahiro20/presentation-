/**
 * 体験リンク（お客様のスマホ）に周辺環境を持っていくためのデータ。
 * 日照の画面で取得した周辺建物（PLATEAU・国土地理院・OSM・手動・想定の家）と航空写真を、
 * ワールド座標の三角形と画像にして project.json に入れる。お客様の画面は SunContext を持たないので、ここだけで組み立てられる形にする。
 *
 * 見る人（お客様）: 自分の家が「どんな周りに建つか」が、外観・光と一緒に見える。
 */
import * as THREE from 'three';
import { PLANNED_COLORS } from './plannedHouse';

export interface ShareNeighbor {
  /** 非インデックスの三角形（ワールド座標 m、cm 単位に丸め） */
  pos: number[];
  /** マテリアルの範囲（0 = 屋根、1 = 壁） */
  groups: { start: number; count: number; materialIndex: number }[];
  planned?: boolean;
  manual?: boolean;
  label?: string;
}

/** 街路・緑地・樹木（OpenStreetMap）の 1 かたまり: 三角形の頂点（ワールド）と色。leaf は葉のカード（表裏を描く・影を落とす） */
export interface ShareStreet {
  key: string;
  color: string;
  pos: number[];
  leaf?: true;
}

export interface ShareContext {
  neighbors: ShareNeighbor[];
  /** 道路・緑地・街路樹 */
  streets?: ShareStreet[];
  /** 航空写真: 2 枚の三角形（ワールド座標）と画像（JPEG の data URL）、出典 */
  aerial?: { pos: number[]; uv: number[]; image: string; attribution?: string };
}

/**
 * 周辺建物の外壁: 窓をシェーダーで描く（UV・テクスチャ不要。ワールド座標から模様を決める）。
 *
 * 前は「階ごと・2.1 m ごとに同じ窓」が並ぶ格子で、どの建物も事務所ビルの模型のように見えていた。
 * 住宅地らしく: 一間（1.82 m）ごとの区画に、窓なし・腰窓・掃き出し窓・小窓を建物の面ごとにばらつかせる
 * （3 階より上は窓の多い集合住宅・ビルの並び）。窓の色は控えめにし、足元に基礎の帯を付ける。
 * 遠くでは窓の模様を平均の色へならす（細かい模様のちらつきを出さない）。影・解析には影響しない。
 */
export function facadeMaterial(color: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFacadeWp;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFacadeWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFacadeWp;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.3, facadeWin);')
      .replace(
        '#include <color_fragment>',
        `float facadeWin = 0.0;
        #include <color_fragment>
        {
          vec3 fn = normalize(cross(dFdx(vFacadeWp), dFdy(vFacadeWp)));
          if (abs(fn.y) < 0.5) {
            bool xFace = abs(fn.x) > abs(fn.z);
            float along = xFace ? vFacadeWp.z : vFacadeWp.x;
            float side = xFace ? sign(fn.x) * 3.0 : sign(fn.z) * 7.0;
            float h = vFacadeWp.y - 0.45;
            float fl = floor(h / 2.9);
            float fy = fract(h / 2.9);
            float bay = floor(along / 1.82);
            float fx = fract(along / 1.82);
            float r = fract(sin(dot(vec3(bay, fl, side), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            float blank = fl > 2.5 ? 0.1 : 0.36;
            vec2 lo = vec2(0.19, 0.34);
            vec2 hi = vec2(0.81, 0.72);
            if (r > 0.9) { lo = vec2(0.36, 0.44); hi = vec2(0.64, 0.72); }
            else if (r > 0.74) { lo = vec2(0.08, 0.06); hi = vec2(0.92, 0.72); }
            float ax = max(fwidth(along) / 1.82, 1e-4);
            float ay = max(fwidth(vFacadeWp.y) / 2.9, 1e-4);
            float win = smoothstep(lo.x - ax, lo.x + ax, fx) * (1.0 - smoothstep(hi.x - ax, hi.x + ax, fx)) * smoothstep(lo.y - ay, lo.y + ay, fy) * (1.0 - smoothstep(hi.y - ay, hi.y + ay, fy));
            win *= step(blank, r);
            float far = smoothstep(0.2, 0.55, max(ax, ay));
            vec3 glass = mix(vec3(0.21, 0.25, 0.30), vec3(0.40, 0.47, 0.54), smoothstep(lo.y, hi.y, fy));
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.76 * (1.0 - far));
            diffuseColor.rgb *= mix(1.0, 0.94, far);
            diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(-0.03, 0.03, h));
            facadeWin = win * (1.0 - far);
          }
        }`,
      );
  };
  m.customProgramCacheKey = () => 'facade2';
  return m;
}

/** 周辺建物の外壁の色: 主役（計画建物）を引き立てる淡い色。白・ベージュ・グレージュ・明るいグレーをばらつかせる */
export const WALL_COLORS = ['#e8e6e1', '#ddd8cf', '#e4e0da', '#d2cec6', '#e9e4d6', '#cfc9bd', '#cbced1'];
/** 周辺建物の屋根の色（航空写真を貼らないとき）: 濃いグレー・グレー・青みのスレート・茶 */
export const ROOF_COLORS = ['#6a6d72', '#8d8f93', '#6f7a84', '#7d7067'];

/** 体験リンク側: データから周辺環境のグループを組み立てる（影を落とし・受ける） */
export function buildShareContextGroup(c: ShareContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'share-context';
  const walls = WALL_COLORS.map((col) => facadeMaterial(col));
  const roofs = ROOF_COLORS.map((col) => new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 }));
  const manual = new THREE.MeshStandardMaterial({ color: '#d9c7a8', roughness: 0.9 });
  const planned = [new THREE.MeshStandardMaterial({ color: PLANNED_COLORS.roof, roughness: 0.75 }), new THREE.MeshStandardMaterial({ color: PLANNED_COLORS.wall, roughness: 0.85 })];
  c.neighbors.forEach((n, i) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(n.pos, 3));
    for (const gr of n.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
    if (!n.groups.length) geo.addGroup(0, n.pos.length / 3, 1);
    geo.computeVertexNormals();
    const mats = n.planned ? planned : [roofs[(i * 7 + 3) % roofs.length], n.manual ? manual : walls[i % walls.length]];
    const mesh = new THREE.Mesh(geo, mats);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = n.label ?? '隣家';
    g.add(mesh);
  });
  if (c.aerial) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(c.aerial.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(c.aerial.uv, 2));
    geo.computeVertexNormals();
    const tex = new THREE.TextureLoader().load(c.aerial.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.name = 'aerial';
    g.add(mesh);
  }
  for (const s of c.streets ?? []) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.9, side: s.leaf ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = s.leaf || s.key === 'l.trunk' || s.key === 'l.curb';
    mesh.receiveShadow = !s.leaf;
    mesh.name = s.key;
    g.add(mesh);
  }
  return g;
}
