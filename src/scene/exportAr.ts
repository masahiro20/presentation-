/**
 * AR 用の 3D データ（体験リンクで、お客様のスマホのカメラの中に家を置く）。
 * 建物・屋根・家具だけを、建物の中心が原点・地盤面（いちばん低い所）が高さ 0 になるように置き直して書き出す。
 * 外構（地面・道路・木）は入れない（敷地では本物の地面の上に建てる）。
 *  - Android（Scene Viewer）: .glb。アプリの外で開くので、公開 URL に置いたファイルを渡す
 *  - iPhone（Quick Look）: .usdz
 * 1/50 の模型は scale = 0.02 で縮めたファイルを別に作る（Scene Viewer・Quick Look は最初の大きさを指定できない）
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import type { Viewer } from "./viewer";
import { prepareMaterials, restoreMaterials } from "./photoFinish";

const MAP_KEYS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
] as const;

/**
 * USDZ の書き出しは、画像として読めるテクスチャ（img・canvas・ImageBitmap）しか扱えず、
 * 読み込み途中のテクスチャや計算で作ったテクスチャが 1 枚でもあると全体が失敗する（以前、iPhone の AR が開かなかった原因）。
 * そういうテクスチャは書き出しの間だけ外す。戻すための関数を返す
 */
export function stripUnexportableTextures(root: THREE.Object3D): () => void {
  const undo: (() => void)[] = [];
  const ok = (t: THREE.Texture) => {
    const im = t.image as { width?: number; height?: number } | undefined;
    if (!im || !im.width || !im.height) return false;
    return (
      (typeof HTMLImageElement !== "undefined" &&
        im instanceof HTMLImageElement &&
        (im as HTMLImageElement).complete) ||
      (typeof HTMLCanvasElement !== "undefined" &&
        im instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== "undefined" &&
        im instanceof OffscreenCanvas) ||
      (typeof ImageBitmap !== "undefined" && im instanceof ImageBitmap)
    );
  };
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const rec = m as unknown as Record<string, THREE.Texture | null>;
      for (const k of MAP_KEYS) {
        const t = rec[k];
        if (t && !ok(t)) {
          rec[k] = null;
          undo.push(() => (rec[k] = t));
        }
      }
    }
  });
  return () => undo.forEach((f) => f());
}

export async function exportAr(
  viewer: Viewer,
  format: "glb" | "usdz",
  scale = 1,
  opts: { furniture?: boolean; tex?: number } = {},
): Promise<Uint8Array> {
  const g = viewer.groups;
  const roots = [
    g.building,
    g.roof,
    ...(opts.furniture === false ? [] : [g.furniture]),
  ].filter((o) => o.visible);
  const saved = prepareMaterials(viewer.scene);
  // glTF の書き出しはシーン自体の変形を無視するので、縮尺は中の入れ物に掛ける
  const holder = new THREE.Scene();
  const scaler = new THREE.Group();
  const inner = new THREE.Group();
  holder.add(scaler);
  scaler.add(inner);
  const parents = roots.map((r) => r.parent);
  try {
    for (const r of roots) inner.add(r);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const r of roots) box.expandByObject(r);
    if (box.isEmpty()) throw new Error("建物がありません");
    const c = box.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -box.min.y, -c.z);
    inner.scale.setScalar(1);
    scaler.scale.setScalar(scale);
    holder.updateMatrixWorld(true);
    // スマホで開く重さにする: 色の画像だけ残し（凹凸・艶の画像は外す）、glb は JPEG で小さく
    const undo: (() => void)[] = [];
    holder.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        const rec = m as unknown as Record<string, THREE.Texture | null>;
        for (const k of [
          "normalMap",
          "roughnessMap",
          "metalnessMap",
          "aoMap",
          "bumpMap",
        ] as const) {
          const t = rec[k];
          if (t) {
            rec[k] = null;
            undo.push(() => (rec[k] = t));
          }
        }
        const map = rec.map;
        if (
          map &&
          format === "glb" &&
          !(m as THREE.Material).transparent &&
          map.userData.mimeType !== "image/jpeg"
        ) {
          const prev = map.userData.mimeType;
          map.userData.mimeType = "image/jpeg";
          undo.push(() => (map.userData.mimeType = prev));
        }
      }
    });
    try {
      if (format === "usdz") {
        const restore = stripUnexportableTextures(holder);
        try {
          return await new USDZExporter().parseAsync(holder, {
            maxTextureSize: opts.tex ?? 1024,
            quickLookCompatible: true,
          });
        } finally {
          restore();
        }
      }
      const out = await new GLTFExporter().parseAsync(holder, {
        binary: true,
        onlyVisible: true,
        maxTextureSize: opts.tex ?? 1024,
      });
      return new Uint8Array(out as ArrayBuffer);
    } finally {
      undo.forEach((f) => f());
    }
  } finally {
    roots.forEach((r, i) => parents[i]?.add(r));
    restoreMaterials(saved);
    viewer.invalidate();
  }
}

export interface ArFiles {
  /** 原寸 */
  glb?: string;
  usdz?: string;
  /** 1/50 の模型 */
  glbModel?: string;
  usdzModel?: string;
}

/** Android の Scene Viewer を開く intent URL（Chrome から開く。入っていなければ fallback へ） */
export function sceneViewerUrl(
  fileUrl: string,
  title: string,
  fallback: string,
): string {
  const q = new URLSearchParams({
    file: fileUrl,
    mode: "ar_preferred",
    title,
    resizable: "false",
  });
  return `intent://arvr.google.com/scene-viewer/1.2?${q.toString()}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(fallback)};end;`;
}
