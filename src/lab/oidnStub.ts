/**
 * AI ノイズ除去（OIDN）の代わり。以前は WebGPU 版の OIDN と重み 3.6MB を同梱していたが、外したままにしている。
 * null を返すと、パストレーシングは簡易のノイズ除去（DenoiseMaterial）で仕上げる。
 */
import type * as THREE from 'three';

export async function oidnDenoise(_input: unknown): Promise<THREE.DataTexture | null> {
  return null;
}
