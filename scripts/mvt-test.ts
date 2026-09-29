import { decodeMvt } from '../src/sun/mvt';
import { lonLatToTile } from '../src/sun/geo';
for (const z of [16, 17]) {
  const t = lonLatToTile(139.767125, 35.681236, z);
  const url = `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${Math.floor(t.x)}/${Math.floor(t.y)}.pbf`;
  const res = await fetch(url);
  console.log(z, url, res.status);
  if (!res.ok) continue;
  const layers = decodeMvt(new Uint8Array(await res.arrayBuffer()));
  for (const [k, l] of Object.entries(layers)) console.log('  ', k, l.features.length, l.extent, JSON.stringify(l.features[0]?.props), l.features[0]?.type, l.features[0]?.rings[0]?.slice(0, 3));
}
import { fetchGsiBuildings } from '../src/sun/geo';
const b = await fetchGsiBuildings(35.681236, 139.767125, 110);
console.log('buildings', b.length, b.slice(0, 2).map((x) => [x.height, x.ring.length, x.ring[0]]));
