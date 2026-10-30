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

export interface ShareContext {
  neighbors: ShareNeighbor[];
  /** 航空写真: 2 枚の三角形（ワールド座標）と画像（JPEG の data URL）、出典 */
  aerial?: { pos: number[]; uv: number[]; image: string; attribution?: string };
}

/** 周辺建物の外壁: 階ごとの窓の帯をシェーダーで描く（UV・テクスチャ不要。ワールド座標から模様を決める） */
export function facadeMaterial(color: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFacadeWp;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFacadeWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFacadeWp;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, facadeWin);')
      .replace(
        '#include <color_fragment>',
        `float facadeWin = 0.0;
        #include <color_fragment>
        {
          vec3 fn = normalize(cross(dFdx(vFacadeWp), dFdy(vFacadeWp)));
          if (abs(fn.y) < 0.5) {
            float along = abs(fn.x) > abs(fn.z) ? vFacadeWp.z : vFacadeWp.x;
            float fy = fract((vFacadeWp.y - 0.9) / 3.0);
            float fx = fract(along / 2.1);
            float win = step(0.42, fy) * step(fy, 0.82) * step(0.2, fx) * step(fx, 0.72);
            win *= step(0.6, vFacadeWp.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.26, 0.31), win * 0.75);
            facadeWin = win;
          }
        }`,
      );
  };
  m.customProgramCacheKey = () => 'facade';
  return m;
}

export const WALL_COLORS = ['#e8e6e1', '#ddd8cf', '#e4e0da', '#d6d3cc', '#e9e4d6'];

/** 体験リンク側: データから周辺環境のグループを組み立てる（影を落とし・受ける） */
export function buildShareContextGroup(c: ShareContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'share-context';
  const walls = WALL_COLORS.map((col) => facadeMaterial(col));
  const roof = new THREE.MeshStandardMaterial({ color: '#8d8f93', roughness: 0.8 });
  const manual = new THREE.MeshStandardMaterial({ color: '#d9c7a8', roughness: 0.9 });
  const planned = [new THREE.MeshStandardMaterial({ color: PLANNED_COLORS.roof, roughness: 0.75 }), new THREE.MeshStandardMaterial({ color: PLANNED_COLORS.wall, roughness: 0.85 })];
  c.neighbors.forEach((n, i) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(n.pos, 3));
    for (const gr of n.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
    if (!n.groups.length) geo.addGroup(0, n.pos.length / 3, 1);
    geo.computeVertexNormals();
    const mats = n.planned ? planned : [roof, n.manual ? manual : walls[i % walls.length]];
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
  return g;
}
