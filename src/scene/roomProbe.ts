/**
 * 部屋の映り込み（室内の反射）。
 *
 * 室内の視点では、環境光に「無地の暖かいグラデーション」を使っている（空の青が壁にかぶらないように）。
 * そのままだと、床の艶・石の天板・ガラス・金物に映るのも無地のグラデーションで、窓も照明も映らない = 平板に見える。
 *
 * ここでは、いまカメラのいる部屋の中心から 6 方向を撮った絵（キューブマップ）を作り、その部屋の中の面の「反射」にだけ使う。
 *  - 拡散光（面の明るさ）は今までどおり（無地の環境光＋太陽・空・照り返しの光）。変えるのは映り込みだけ
 *  - 部屋を箱とみなして、映る位置を合わせる（箱投影）。合わせないと、床に映る窓が実際の窓の位置からずれる
 *  - 部屋の箱の外の面（ほかの部屋・屋外）は今までどおり
 *
 * 素材側は onBeforeCompile で three.js の標準シェーダーに数行を足す（patchRoomProbe）。
 * 値（絵・箱の位置）は全素材で共有し、viewer が部屋を移るたびに差し替える。
 */
import * as THREE from 'three';

export const roomProbeUniforms = {
  roomProbeMap: { value: null as THREE.Texture | null },
  /** 1 = 映り込みを使う */
  roomProbeOn: { value: 0 },
  /** 撮った位置 */
  roomProbePos: { value: new THREE.Vector3() },
  /** 部屋の箱 */
  roomProbeMin: { value: new THREE.Vector3() },
  roomProbeMax: { value: new THREE.Vector3() },
  /** 映り込みの強さ（撮った絵の明るさに掛ける） */
  roomProbeGain: { value: 1 },
};

const PARS = /* glsl */ `
#ifdef ROOM_PROBE
	uniform sampler2D roomProbeMap;
	uniform float roomProbeOn;
	uniform vec3 roomProbePos;
	uniform vec3 roomProbeMin;
	uniform vec3 roomProbeMax;
	uniform float roomProbeGain;
	varying vec3 vRoomProbeWP;
	// 部屋の箱の中の面なら、反射の向きを箱の壁まで伸ばし、撮った位置から見た向きに直して絵を引く
	vec3 roomProbeRadiance( vec3 fallback, vec3 reflectVec, float roughness ) {
		if ( roomProbeOn < 0.5 ) return fallback;
		vec3 p = vRoomProbeWP;
		vec3 inside = step( roomProbeMin - 0.3, p ) * step( p, roomProbeMax + 0.3 );
		if ( inside.x * inside.y * inside.z < 0.5 ) return fallback;
		vec3 d = normalize( reflectVec );
		d = mix( d, vec3( 1e-4 ), vec3( lessThan( abs( d ), vec3( 1e-4 ) ) ) );
		vec3 tMax = ( roomProbeMax - p ) / d;
		vec3 tMin = ( roomProbeMin - p ) / d;
		vec3 t = vec3( d.x > 0.0 ? tMax.x : tMin.x, d.y > 0.0 ? tMax.y : tMin.y, d.z > 0.0 ? tMax.z : tMin.z );
		float k = max( min( min( t.x, t.y ), t.z ), 0.0 );
		vec3 dir = p + d * k - roomProbePos;
		return textureCubeUV( roomProbeMap, dir, roughness ).rgb * roomProbeGain;
	}
#endif
`;

// getIBLRadiance（反射の明るさを環境マップから引く関数）の最後の 2 行。空行の有無は three.js の配布形で違うので、空白は問わない
const RADIANCE_FROM = /vec4 envMapColor = textureCubeUV\( envMap, envMapRotation \* reflectVec, roughness \);\s*return envMapColor\.rgb \* envMapIntensity;/;
const RADIANCE_TO = /* glsl */ `vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );

			#ifdef ROOM_PROBE
				return roomProbeRadiance( envMapColor.rgb * envMapIntensity, reflectVec, roughness );
			#else
				return envMapColor.rgb * envMapIntensity;
			#endif`;

let warned = false;

/** 標準・物理マテリアルに、部屋の映り込みを足す（何度呼んでも 1 回だけ） */
export function patchRoomProbe<T extends THREE.Material>(mat: T): T {
  const m = mat as unknown as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.userData.roomProbe) return mat;
  m.userData.roomProbe = true;
  m.defines = { ...(m.defines ?? {}), ROOM_PROBE: '' };
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    const chunk = THREE.ShaderChunk.envmap_physical_pars_fragment;
    if (!RADIANCE_FROM.test(chunk) || !shader.fragmentShader.includes('#include <envmap_physical_pars_fragment>') || !shader.vertexShader.includes('#include <project_vertex>')) {
      // three.js の版が変わってシェーダーの形が違うときは、映り込みなしで今までどおり描く
      if (!warned) console.warn('部屋の映り込み: シェーダーの形が想定と違うため無効にしました');
      warned = true;
      delete (m.defines as Record<string, unknown>).ROOM_PROBE;
      return;
    }
    Object.assign(shader.uniforms, roomProbeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n#ifdef ROOM_PROBE\n\tvarying vec3 vRoomProbeWP;\n#endif')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
	#ifdef ROOM_PROBE
		vec4 roomProbeW = vec4( transformed, 1.0 );
		#ifdef USE_BATCHING
			roomProbeW = batchingMatrix * roomProbeW;
		#endif
		#ifdef USE_INSTANCING
			roomProbeW = instanceMatrix * roomProbeW;
		#endif
		vRoomProbeWP = ( modelMatrix * roomProbeW ).xyz;
	#endif`,
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', PARS + chunk.replace(RADIANCE_FROM, RADIANCE_TO));
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : '') + '|roomProbe';
  m.needsUpdate = true;
  return mat;
}

/** オブジェクト以下の標準マテリアルすべてに足す（読み込んだ 3D モデルなど） */
export function patchRoomProbeIn(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m) patchRoomProbe(m);
  });
}
