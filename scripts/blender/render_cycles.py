"""
アプリが書き出した 3D モデル（.glb）とカメラ（.json）を Blender（Cycles）で写真品質に描く。

  静止画:   python render_cycles.py scene.glb camera.json outDir "道路側,ＬＤＫ" 1920 1080 128
  動画:     python render_cycles.py scene.glb camera.json outDir --walk walk.json 24 32 960 540 32
            （walk.json は scripts/blender/export-walk.mjs で書き出す。t0〜t1 秒を連番 PNG に）
  Blender 本体から: blender -b --factory-startup -P render_cycles.py -- scene.glb camera.json outDir ...
  pip の bpy から:   pip install bpy   →  python render_cycles.py ...（Blender のインストール不要）

- 材料: アプリの材料名（ext.wall / int.floor / l.ground …）に public/tex の実写テクスチャ（Poly Haven CC0）を割り当て。
        UV に頼らず物体座標の箱投影で貼る（書き出し元に UV の無い面があっても崩れない）
- 光:   多重散乱の物理空（太陽ディスク無し）＋ 太陽ランプ。直射:天空光 ≈ 6:1 に校正（晴天の写真と同じ比）。
        影は空の青で冷たく、日なたは少し暖色
- 露出: カメラの自動露出（小さな下見レンダーの対数平均輝度を 0.16〜0.2 に）。動画は時定数 0.7 秒で追従
- 仕上げ: AgX（Medium High Contrast）＋ 弱いブルーム
- 外構: three.js では z=0 に重ねて描いている道路・敷地・遠景を、層ごと・島ごとに数 mm ずらす（重なった面が影を遮り合って真っ黒になるのを防ぐ）
- 環境変数: CYCLES_DEVICE=GPU（OptiX/CUDA/HIP/Metal）, LOOK="AgX - Base Contrast", EV_OFFSET=0.5, SUN_STRENGTH, SKY_STRENGTH, NO_GLARE=1,
            MADORI_TEX=<public/tex の場所>, ONLY_MATS / HIDE_MATS=材料名,…（切り分け用）
"""
import bpy, json, math, sys, os, time
from mathutils import Vector

# blender -b -P script -- args の形でも、python script args の形でも同じに読む
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
if len(argv) < 3:
    print(__doc__); sys.exit(1)
argv = [''] + argv  # 以降は sys.argv[1..] と同じ添字で扱う
sys.argv = argv
glb, camjson, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
which = sys.argv[4].split(',') if len(sys.argv) > 4 and sys.argv[4] else ['外観 道路側']
WALK = which and which[0] == '--walk'
W = int(sys.argv[5]) if len(sys.argv) > 5 and not WALK else 960
H = int(sys.argv[6]) if len(sys.argv) > 6 and not WALK else 540
SAMPLES = int(sys.argv[7]) if len(sys.argv) > 7 and not WALK else 96
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# glTF（Y up）→ Blender（Z up）はインポータが変換する
bpy.ops.import_scene.gltf(filepath=glb)
info = json.load(open(camjson, encoding='utf-8'))

def to_b(v):  # three.js (x, y up, z) → Blender (x, -z, y)
    return Vector((v[0], -v[2], v[1]))

# ---- 材料の整え: ガラスは透過、床・壁は粗さを少し ----
glass_n = 0
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        continue
    tr = bsdf.inputs.get('Transmission Weight') or bsdf.inputs.get('Transmission')
    alpha = bsdf.inputs.get('Alpha')
    name = m.name.lower()
    is_glass = (tr and tr.default_value > 0.5) or 'glass' in name or 'ガラス' in name or (alpha and alpha.default_value < 0.6)
    if is_glass:
        glass_n += 1
        if tr: tr.default_value = 1.0
        bsdf.inputs['Roughness'].default_value = 0.02
        if alpha: alpha.default_value = 1.0
        bsdf.inputs['IOR'].default_value = 1.5
        m.blend_method = 'BLEND'
        if hasattr(m, 'use_screen_refraction'): m.use_screen_refraction = True
print('materials', len(bpy.data.materials), 'glass', glass_n)

# ---- 実写テクスチャ（Poly Haven CC0。アプリの public/tex と同じもの）を材料名で割り当て ----
TEX = os.environ.get('MADORI_TEX', '/home/user/presentation-/public/tex')
# 材料名 → (テクスチャ, 1 枚の大きさ m, 色味 (乗算), 粗さの補正)
ASSIGN = {
    'l.ground': ('leafy_grass', 2.5, (0.62, 0.9, 0.62), 1.0),
    'l.far': ('leafy_grass', 3.0, (0.58, 0.86, 0.6), 1.0),
    'l.road': ('asphalt_02', 5.0, (0.9, 0.9, 0.92), 1.0),
    'l.driveway': ('concrete_floor_02', 2.5, (0.95, 0.95, 0.95), 1.0),
    'l.approach': ('large_floor_tiles_02', 1.2, (0.9, 0.88, 0.85), 1.0),
    'ext.wall': ('painted_plaster_wall', 1.6, (1.28, 1.26, 1.22), 1.0),
    'ext.wallTop': ('painted_plaster_wall', 1.6, (1.28, 1.26, 1.22), 1.0),
    'ext.foundation': ('concrete_floor_02', 2.0, (0.7, 0.7, 0.7), 1.0),
    'int.wall': ('painted_plaster_wall', 2.2, (1.08, 1.06, 1.03), 1.0),
    'int.wallTop': ('painted_plaster_wall', 2.2, (1.08, 1.06, 1.03), 1.0),
    'int.accent': ('white_plaster_02', 2.0, (0.6, 0.6, 0.6), 1.0),
    'int.floor': ('wood_floor', 2.0, (1.0, 0.96, 0.9), 0.85),
    'f.wood': ('wood_planks', 1.5, (0.95, 0.9, 0.84), 0.8),
    'int.entranceFloor': ('large_floor_tiles_02', 1.2, (0.75, 0.74, 0.72), 0.8),
    'int.wetFloor': ('large_floor_tiles_02', 1.2, (0.9, 0.9, 0.9), 0.8),
    'int.bathWall': ('large_floor_tiles_02', 1.2, (0.95, 0.95, 0.95), 0.7),
    # 家具・布もの（Poly Haven の布・革・ウール）
    'f.fabric': ('poly_wool_herringbone', 0.5, (0.95, 0.93, 0.9), 1.0),
    'f.fabric2': ('rough_linen', 0.5, (0.62, 0.58, 0.52), 1.0),
    'f.bedding': ('rough_linen', 0.8, (0.97, 0.96, 0.94), 1.0),
    'f.curtain': ('rough_linen', 0.8, (0.95, 0.94, 0.92), 1.0),
    'f.rug': ('poly_wool_herringbone', 0.8, (0.7, 0.68, 0.64), 1.0),
    'f.wood': ('wood_planks', 1.2, (0.95, 0.9, 0.84), 0.8),
    'f.cabinet': ('laminate_floor_02', 1.5, (0.92, 0.9, 0.86), 0.7),
    'f.counter': ('marble_01', 1.0, (0.98, 0.97, 0.95), 0.6),
}
BUMP = {'rough_linen': 0.15, 'poly_wool_herringbone': 0.25, 'marble_01': 0.0, 'laminate_floor_02': 0.03, 'leafy_grass': 0.25, 'white_plaster_02': 0.12, 'painted_plaster_wall': 0.05, 'asphalt_02': 0.15, 'concrete_floor_02': 0.1, 'wood_floor': 0.04, 'wood_planks': 0.06, 'large_floor_tiles_02': 0.03}
EMISSIVE = {'f.downlight': ((1.0, 0.86, 0.68), 60.0), 'f.cove': ((1.0, 0.86, 0.68), 12.0), 'f.lampShade': ((1.0, 0.9, 0.75), 3.0)}

def load_img(path):
    # 同じファイル名（diff.jpg）が素材ごとにあるので、フォルダ名込みで区別する
    key = os.path.basename(os.path.dirname(path)) + '/' + os.path.basename(path)
    im = bpy.data.images.get(key)
    if im is None:
        im = bpy.data.images.load(path); im.name = key
    return im

for m in bpy.data.materials:
    a = ASSIGN.get(m.name)
    e = EMISSIVE.get(m.name)
    if not a and not e:
        continue
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        continue
    if e:
        bsdf.inputs['Emission Color'].default_value = (*e[0], 1)
        bsdf.inputs['Emission Strength'].default_value = e[1]
        continue
    folder, tile, tint, rough_k = a
    d = os.path.join(TEX, folder)
    if not os.path.isdir(d):
        print('no tex', folder); continue
    # 既存の画像ノード・マッピングは外して組み直す（UV は m 単位で入っているので 1/tile で繰り返し）
    for n in [n for n in nt.nodes if n.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL')]:
        nt.nodes.remove(n)
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Alpha'].default_value = 1.0
    # UV は書き出し元によって無い面があり（道路の一部が真っ黒になった原因）、物体座標の箱投影で貼る
    tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = (1 / tile, 1 / tile, 1 / tile)
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    def tex(name, cs):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = load_img(os.path.join(d, name)); t.image.colorspace_settings.name = cs
        t.projection = 'BOX'; t.projection_blend = 0.25
        nt.links.new(mp.outputs['Vector'], t.inputs['Vector']); return t
    diff = tex('diff.jpg', 'sRGB')
    # 色味の乗算（ベクトル演算なら入力の取り違えが無い）
    mix = nt.nodes.new('ShaderNodeVectorMath'); mix.operation = 'MULTIPLY'; mix.inputs[1].default_value = tint
    nt.links.new(diff.outputs['Color'], mix.inputs[0]); nt.links.new(mix.outputs['Vector'], bsdf.inputs['Base Color'])
    if os.path.exists(os.path.join(d, 'rough.jpg')):
        r = tex('rough.jpg', 'Non-Color')
        mr = nt.nodes.new('ShaderNodeMath'); mr.operation = 'MULTIPLY'; mr.inputs[1].default_value = rough_k
        nt.links.new(r.outputs['Color'], mr.inputs[0]); nt.links.new(mr.outputs[0], bsdf.inputs['Roughness'])
    # 凹凸: 法線マップは UV の接線が要るので使わず、拡散画像の明暗からバンプ（弱め）
    bump_k = BUMP.get(folder, 0.08)
    if bump_k > 0:
        bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = bump_k; bump.inputs['Distance'].default_value = 0.02
        nt.links.new(diff.outputs['Color'], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
print('textures assigned')
if os.environ.get('ONLY_MATS') or os.environ.get('HIDE_MATS'):
    only = set(os.environ.get('ONLY_MATS', '').split(',')) - {''}; hide = set(os.environ.get('HIDE_MATS', '').split(',')) - {''}
    for o in bpy.data.objects:
        if o.type != 'MESH': continue
        names = {mm.name for mm in o.data.materials if mm}
        if (only and not (names & only)) or (names & hide): o.hide_render = True
if os.environ.get('GROUND_ONLY'):
    for o in bpy.data.objects:
        if o.type == 'MESH' and not any(mm and mm.name in ('l.far', 'l.ground') for mm in o.data.materials): o.hide_render = True

# ---- 同一平面の重なりをほどく ----
# 外構（道路・敷地・遠景・車路）は three.js では全部 z=0 で重ねて描いている（描画順で済む）が、
# Cycles では重なった面同士が影のレイを遮り合って真っ黒な区画になる。層ごと・島ごとに数 mm ずらす
import bmesh
BASE_Z = {'l.far': -0.03, 'l.ground': -0.012, 'l.road': 0.0, 'l.curb': 0.0, 'l.driveway': 0.004, 'l.approach': 0.006, 'l.deck': 0.006}
for o in bpy.data.objects:
    if o.type != 'MESH' or not o.data.materials: continue
    mat = o.data.materials[0].name if o.data.materials[0] else ''
    if not mat.startswith('l.') or mat == 'l.curb': continue
    bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
    seen = set(); k = 0
    for f in bm.faces:
        if f.index in seen: continue
        stack = [f]; verts = set()
        while stack:
            g = stack.pop()
            if g.index in seen: continue
            seen.add(g.index); verts.update(g.verts)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen: stack.append(h)
        dz = BASE_Z.get(mat, 0.0) + 0.0025 * k
        for v in verts: v.co.z += dz
        k += 1
    bm.to_mesh(o.data); bm.free()
    print('layered', mat, 'islands', k)

# ---- 空と太陽 ----
# 空テクスチャ（多重散乱）は空の明るさと色だけに使い、太陽ディスクは切る（ディスク込みだと太陽ランプが効かず、影の明るさを調整できない）
# 校正値: 空だけで白い水平面が (2.1, 3.9, 7.0)、太陽ランプ強さ 1 で高度 38° の白い水平面が 0.196（= sinθ/π）
#   晴天の直射:天空光 ≈ 6:1 になるよう、昼は太陽 120 W/m²（白面 ≈ 23）、夕方は 40
HDRI_BY_TOD = {'evening': 'belfast_sunset_puresky_2k.hdr', 'morning': 'kloofendal_misty_morning_puresky_2k.hdr'}
sun = None

def setup_sky(sun_dir3, tod):
    """カットごとの太陽の向き・時間帯で空と太陽ランプを作り直す"""
    global sun
    world = bpy.data.worlds.new('World'); scene.world = world; world.use_nodes = True
    nt = world.node_tree; nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky'); sky.sky_type = 'MULTIPLE_SCATTERING'
    sd = to_b(sun_dir3); sd.normalize()
    elev = math.asin(max(-1, min(1, sd.z)))
    rot = math.atan2(sd.y, sd.x)
    sky.sun_elevation = max(math.radians(3), elev)
    sky.sun_rotation = rot
    sky.sun_intensity = 1.0
    sky.sun_size = math.radians(1.0)
    sky.sun_disc = False
    for attr, val in [('altitude', 50), ('air_density', 1.0), ('aerosol_density', 1.6 if tod == 'evening' else 0.9), ('ozone_density', 1.0)]:
        if hasattr(sky, attr):
            try: setattr(sky, attr, val)
            except Exception as e: print('sky attr', attr, e)
    bg = nt.nodes.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = float(os.environ.get('SKY_STRENGTH', '1.0')) * (0.35 if tod == 'night' else 1.0)
    outn = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    # 空の見え方だけ実写の HDRI（雲）に: カメラから直接見える光線だけ HDRI、照明は上の物理空のまま。
    # 明るさは「上半球の余弦加重平均」を物理空の実測（白い水平面 ≈ 3.9）に合わせ、太陽の方位も合わせて回す
    HDRI = os.environ.get('HDRI', os.path.join(os.path.dirname(TEX), 'hdri', HDRI_BY_TOD.get(tod, 'kloofendal_48d_partly_cloudy_puresky_2k.hdr')))
    linked = False
    if not os.environ.get('NO_HDRI') and os.path.exists(HDRI) and tod != 'night':
        try:
            img = bpy.data.images.get(os.path.basename(HDRI)) or bpy.data.images.load(HDRI); iw, ih = img.size
            px = img.pixels[:]
            vals = []; sun_lon = 0.0; best = -1.0
            step = max(1, iw // 256)
            for y in range(0, ih // 2, step):
                cosw = math.cos((0.5 - (y + 0.5) / ih) * math.pi)
                sinw = math.sin((0.5 - (y + 0.5) / ih) * math.pi)
                for x in range(0, iw, step):
                    i = ((ih - 1 - y) * iw + x) * 4
                    g = px[i + 1]
                    if g > best: best, sun_lon = g, (x / iw) * 2 * math.pi
                    vals.append((g, cosw * sinw))
            vals.sort(key=lambda t: t[0]); cut = int(len(vals) * 0.9995)
            num = sum(g * w for g, w in vals[:cut]); den = sum(w for _, w in vals[:cut])
            mean_g = (num / den) * 2.0
            k = 3.9 / max(1e-6, mean_g)
            env = nt.nodes.new('ShaderNodeTexEnvironment'); env.image = img
            mp = nt.nodes.new('ShaderNodeMapping'); tc = nt.nodes.new('ShaderNodeTexCoord')
            mp.inputs['Rotation'].default_value = (0, 0, rot - (sun_lon - math.pi))
            nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], env.inputs['Vector'])
            bg2 = nt.nodes.new('ShaderNodeBackground'); bg2.inputs['Strength'].default_value = k * float(os.environ.get('HDRI_GAIN', '1.4'))
            nt.links.new(env.outputs['Color'], bg2.inputs['Color'])
            lp = nt.nodes.new('ShaderNodeLightPath'); mix = nt.nodes.new('ShaderNodeMixShader')
            nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac']); nt.links.new(bg.outputs['Background'], mix.inputs[1]); nt.links.new(bg2.outputs['Background'], mix.inputs[2])
            nt.links.new(mix.outputs['Shader'], outn.inputs['Surface']); linked = True
            print('hdri background', os.path.basename(HDRI), 'gain %.2f' % k, 'sun lon %.0f deg' % math.degrees(sun_lon))
        except Exception as e:
            print('hdri skipped', e)
    if not linked: nt.links.new(bg.outputs['Background'], outn.inputs['Surface'])
    # 太陽光（空テクスチャの太陽と同じ向き）。少し暖色、影は空の青で冷たく＝写真の見え方
    if sun is None:
        sun_data = bpy.data.lights.new('Sun', 'SUN'); sun_data.angle = math.radians(1.2)
        sun = bpy.data.objects.new('Sun', sun_data); scene.collection.objects.link(sun)
    strength = {'evening': 40.0, 'morning': 70.0, 'night': 0.0}.get(tod, 120.0)
    sun.data.energy = float(os.environ.get('SUN_STRENGTH', strength))
    sun.data.color = {'evening': (1.0, 0.72, 0.5), 'morning': (1.0, 0.85, 0.7)}.get(tod, (1.0, 0.93, 0.84))
    sun.rotation_euler = (-sd).to_track_quat('-Z', 'Y').to_euler()

tod = info.get('timeOfDay', 'day')
setup_sky(info['sunDir'], tod)

# ---- 地面（モデルに無ければ） ----
bb = info.get('bbox')
if bb and os.environ.get('ADD_GROUND'):
    mn, mx = to_b(bb['min']), to_b(bb['max'])
    bpy.ops.mesh.primitive_plane_add(size=1, location=((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, min(mn.z, mx.z) - 0.02))
    g = bpy.context.active_object; g.scale = (max(400, (mx.x - mn.x) * 20), max(400, (mx.y - mn.y) * 20), 1)
    gm = bpy.data.materials.new('Ground'); gm.use_nodes = True
    b = gm.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (0.32, 0.36, 0.22, 1); b.inputs['Roughness'].default_value = 0.95
    g.data.materials.append(gm)

# ---- 角の面取り: CG の鋭い角にハイライトが乗る。外構（地面・道路）とガラスには付けない ----
if not os.environ.get('NO_BEVEL'):
    nb = 0
    for o in bpy.data.objects:
        if o.type != 'MESH' or not o.data.materials: continue
        mat = o.data.materials[0].name if o.data.materials[0] else ''
        if mat.startswith('l.') or 'glass' in mat.lower() or mat == 'distant': continue
        m = o.modifiers.new('bevel', 'BEVEL'); m.width = 0.004; m.segments = 2; m.limit_method = 'ANGLE'; m.angle_limit = math.radians(40)
        m.use_clamp_overlap = True; m.harden_normals = True; nb += 1
    print('bevel on', nb, 'objects')

# ---- ダウンライト: 発光する円盤の位置にスポットライトを置き、配光データ（IES）で本物の光だまりに ----
IES = os.environ.get('IES', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'downlight_36.ies'))
if not os.environ.get('NO_IES') and os.path.exists(IES):
    import bmesh as _bm
    spots = []
    for o in bpy.data.objects:
        if o.type != 'MESH' or not o.data.materials: continue
        if not any(mm and mm.name == 'f.downlight' for mm in o.data.materials): continue
        bm = _bm.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
        seen = set()
        for f in bm.faces:
            if f.index in seen: continue
            stack = [f]; verts = set()
            while stack:
                g = stack.pop()
                if g.index in seen: continue
                seen.add(g.index); verts.update(g.verts)
                for e in g.edges:
                    for h in e.link_faces:
                        if h.index not in seen: stack.append(h)
            c = sum((o.matrix_world @ v.co for v in verts), Vector()) / len(verts)
            # 書き出しで面ごとに頂点が分かれているので、近い中心（15cm 以内）は同じ器具としてまとめる
            for sp in spots:
                if (sp[0] - c).length < 0.15:
                    sp[0] = (sp[0] * sp[1] + c) / (sp[1] + 1); sp[1] += 1; break
            else:
                spots.append([c, 1])
        bm.free()
    spots = [sp[0] for sp in spots]
    ies_txt = bpy.data.texts.load(IES) if os.path.exists(IES) else None
    for i, c in enumerate(spots):
        ld = bpy.data.lights.new(f'DL{i}', 'SPOT'); ld.energy = float(os.environ.get('DL_POWER', '30')); ld.color = (1.0, 0.86, 0.72)  # 約 3000K
        ld.spot_size = math.radians(80); ld.spot_blend = 1.0; ld.shadow_soft_size = 0.04
        ld.use_nodes = True; lnt = ld.node_tree
        ies = lnt.nodes.new('ShaderNodeTexIES'); ies.mode = 'INTERNAL'; ies.ies = ies_txt; ies.inputs['Strength'].default_value = 1.0
        emit = next(n for n in lnt.nodes if n.type == 'EMISSION')
        lnt.links.new(ies.outputs['Fac'], emit.inputs['Strength'])
        lo = bpy.data.objects.new(f'DL{i}', ld); scene.collection.objects.link(lo)
        lo.location = (c.x, c.y, c.z - 0.03); lo.rotation_euler = (0, 0, 0)  # -Z（真下）に照らす
    print('downlight spots', len(spots))
    # 発光する円盤自体は弱めに（光はスポットが担う）
    m = bpy.data.materials.get('f.downlight')
    if m and m.use_nodes:
        b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if b: b.inputs['Emission Strength'].default_value = 12.0

# ---- レンダー設定 ----
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
if os.environ.get('CYCLES_DEVICE', '').upper() == 'GPU':
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    for d in prefs.devices: d.use = (d.type == kind or d.type == 'CPU')
                    scene.cycles.device = 'GPU'; print('GPU', kind); break
            except Exception: continue
    except Exception as e: print('GPU 設定に失敗、CPU で描きます', e)
scene.cycles.samples = SAMPLES
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.05
scene.cycles.use_denoising = True
scene.cycles.denoiser = 'OPENIMAGEDENOISE'
scene.cycles.max_bounces = 8; scene.cycles.diffuse_bounces = 4; scene.cycles.glossy_bounces = 4; scene.cycles.transmission_bounces = 8
scene.cycles.caustics_reflective = False; scene.cycles.caustics_refractive = False
scene.cycles.blur_glossy = 1.0
scene.render.resolution_x = W; scene.render.resolution_y = H; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Base Contrast'
scene.view_settings.exposure = 0.0
scene.render.film_transparent = False
scene.render.threads_mode = 'AUTO'

cam_data = bpy.data.cameras.new('Cam'); cam = bpy.data.objects.new('Cam', cam_data); scene.collection.objects.link(cam); scene.camera = cam
cam_data.sensor_fit = 'VERTICAL'; cam_data.sensor_height = 24.0; cam_data.clip_start = 0.05; cam_data.clip_end = 2000

def set_cam(pos3, tgt3, fov, architectural=False):
    """カメラを置く。architectural なら水平に構えてレンズシフトで上下を見せる（垂直線が垂直のまま＝建築写真の 2 点透視）"""
    pos, tgt = to_b(pos3), to_b(tgt3)
    cam.location = pos
    cam_data.lens = (cam_data.sensor_height / 2) / math.tan(math.radians(fov) / 2)
    cam_data.shift_y = 0.0
    d = tgt - pos
    horiz = math.hypot(d.x, d.y)
    if architectural and horiz > 0.3:
        # 画面中心が注視点を向くシフト量（画面の長辺に対する比）。大きすぎる仰角は残りを傾きで
        tan_t = d.z / horiz
        half = math.tan(math.radians(fov) / 2)
        lim = half * 0.9
        use = max(-lim, min(lim, tan_t))
        aspect = scene.render.resolution_x / scene.render.resolution_y
        cam_data.shift_y = (use / half) * 0.5 / max(1.0, aspect)
        rest = math.atan(tan_t) - math.atan(use)
        flat = Vector((d.x, d.y, 0)).normalized()
        q = flat.to_track_quat('-Z', 'Y').to_euler()
        cam.rotation_euler = q
        if abs(rest) > 1e-4:
            cam.rotation_euler.rotate_axis('X', rest)
    else:
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

def exposure_blend(exr_path, out_png, ev0, strong=2.2):
    """窓の白飛びを建築写真の露出ブレンドで抑える: 同じ EXR を EV0 と EV-strong で現像し、明るい所だけ暗い方を混ぜる"""
    try:
        import numpy as np
        from PIL import Image, ImageFilter
        img = bpy.data.images.load(exr_path)
        w, h = img.size
        lin = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1, :, :3]
        lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]) * (2.0 ** ev0)
        # 現像後に白く飛ぶ領域（リニア 1.2 以上）をなだらかに選ぶ
        mask = np.clip((lum - 1.2) / 2.5, 0, 1)
        frac = float((mask > 0.5).mean())
        if frac < 0.004:
            bpy.data.images.remove(img); return False
        mimg = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=max(2, w // 140)))
        mask = np.asarray(mimg, dtype=np.float32) / 255.0
        mask = np.clip(mask * 1.15, 0, 1)
        # save_render はシーンの出力形式で書くので PNG に戻してから現像する
        scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_depth = '8'
        scene.view_settings.exposure = ev0
        base_p = exr_path[:-4] + '_ev0.png'; dark_p = exr_path[:-4] + '_dark.png'
        img.save_render(base_p, scene=scene)
        scene.view_settings.exposure = ev0 - strong
        img.save_render(dark_p, scene=scene)
        scene.view_settings.exposure = ev0
        base = np.asarray(Image.open(base_p).convert('RGB'), dtype=np.float32)
        dark = np.asarray(Image.open(dark_p).convert('RGB'), dtype=np.float32)
        out = base * (1 - mask[..., None]) + dark * mask[..., None]
        Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(out_png)
        for pth in (base_p, dark_p):
            try: os.remove(pth)
            except Exception: pass
        bpy.data.images.remove(img)
        print('exposure blend', os.path.basename(out_png), 'highlight %.1f%%' % (frac * 100))
        return True
    except Exception as e:
        print('exposure blend skipped', e); return False

def auto_exposure(target=0.18, probe_px=48):
    """カメラの自動露出: 小さな下見（EXR・リニア）の対数平均輝度が target になる露出値（EV）を返す"""
    rx, ry, smp, den, fmt, vt = scene.render.resolution_x, scene.render.resolution_y, scene.cycles.samples, scene.cycles.use_denoising, scene.render.image_settings.file_format, scene.view_settings.view_transform
    fp = scene.render.filepath; comp = scene.render.use_compositing; scene.render.use_compositing = False
    scene.render.resolution_x = probe_px; scene.render.resolution_y = max(8, round(probe_px * ry / rx))
    scene.cycles.samples = 6; scene.cycles.use_denoising = False
    scene.render.image_settings.file_format = 'OPEN_EXR'; scene.render.image_settings.color_depth = '32'
    scene.view_settings.view_transform = 'Standard'
    scene.render.filepath = os.path.join(out_dir, '_probe.exr')
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(scene.render.filepath); px = img.pixels[:]
    lum = [0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] for i in range(0, len(px), 4)]
    logavg = math.exp(sum(math.log(1e-4 + l) for l in lum) / len(lum))
    bpy.data.images.remove(img)
    scene.render.resolution_x, scene.render.resolution_y, scene.cycles.samples, scene.cycles.use_denoising = rx, ry, smp, den
    scene.render.image_settings.file_format = fmt; scene.view_settings.view_transform = vt; scene.render.filepath = fp; scene.render.use_compositing = comp
    ev = math.log2(target / max(1e-6, logavg))
    return max(-9.0, min(8.0, ev))

# グレア（ハイライトのにじみ）: 写真のレンズの柔らかさ。無ければ素通し
def setup_glare(strength=0.012):
    try:
        if hasattr(scene, 'compositing_node_group'):
            ct = bpy.data.node_groups.new('Comp', 'CompositorNodeTree'); scene.compositing_node_group = ct
        else:
            scene.use_nodes = True; ct = scene.node_tree; ct.nodes.clear()
        rl = ct.nodes.new('CompositorNodeRLayers')
        try:
            comp = ct.nodes.new('CompositorNodeComposite')
        except Exception:
            # Blender 5: 出力はグループ出力ノード（インターフェースに Image を作る）
            ct.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
            comp = ct.nodes.new('NodeGroupOutput')
        gl = ct.nodes.new('CompositorNodeGlare')
        if 'Type' in gl.inputs:  # Blender 5: 種類はソケット（メニュー）
            for v in ('Bloom', 'BLOOM', 'Fog Glow', 'FOG_GLOW'):
                try: gl.inputs['Type'].default_value = v; break
                except Exception: pass
        else:
            kinds = [e.identifier for e in gl.bl_rna.properties['glare_type'].enum_items]
            gl.glare_type = 'BLOOM' if 'BLOOM' in kinds else 'FOG_GLOW'
        for nm, val in (('Threshold', 2.0), ('Strength', strength), ('Size', 0.35), ('Saturation', 0.9)):
            if nm in gl.inputs:
                try: gl.inputs[nm].default_value = val
                except Exception as e: print('glare input', nm, e)
        if hasattr(gl, 'mix'): gl.mix = -0.9
        if hasattr(gl, 'size'): gl.size = 8
        if hasattr(gl, 'threshold'): gl.threshold = 1.0
        ct.links.new(rl.outputs['Image'], gl.inputs['Image']); ct.links.new(gl.outputs['Image'], comp.inputs['Image'])
        scene.render.use_compositing = True
        print('glare ok')
    except Exception as e:
        print('glare skipped', e)
        try: scene.compositing_node_group = None
        except Exception: pass
if not os.environ.get('NO_GLARE'): setup_glare()

LOOK = os.environ.get('LOOK', 'AgX - Medium High Contrast')
try: scene.view_settings.look = LOOK
except Exception: scene.view_settings.look = 'AgX - Base Contrast'

if which and which[0] == '--walk':
    # ウォークスルー: アプリが書き出したカメラ経路（export-walk.mjs）の t0〜t1 秒をコマ送りで描く
    walk = json.load(open(sys.argv[5], encoding='utf-8'))
    t0 = float(sys.argv[6]) if len(sys.argv) > 6 else 0
    t1 = float(sys.argv[7]) if len(sys.argv) > 7 else walk['duration']
    W = int(sys.argv[8]) if len(sys.argv) > 8 else 640
    H = int(sys.argv[9]) if len(sys.argv) > 9 else 360
    SAMPLES = int(sys.argv[10]) if len(sys.argv) > 10 else 24
    scene.render.resolution_x = W; scene.render.resolution_y = H
    scene.cycles.samples = SAMPLES
    scene.render.use_motion_blur = False
    n = 0; ev = None
    for f in walk['frames']:
        if f['t'] < t0 or f['t'] > t1:
            continue
        set_cam(f['pos'], f['target'], f['fov'])
        target = auto_exposure(0.10)
        ev = target if ev is None else ev + (target - ev) * min(1.0, 1.5 / walk['fps'])
        scene.view_settings.exposure = ev
        scene.render.filepath = os.path.join(out_dir, f'frame_{n:04d}.png')
        bpy.ops.render.render(write_still=True)
        n += 1
        if n % 10 == 0: print('frame', n, 't', f['t'], flush=True)
    print('walk frames', n, 'fps', walk['fps'])
    sys.exit(0)

for s in info['shots']:
    if not any(w in s['title'] for w in which):
        continue
    stod = s.get('timeOfDay') or tod
    if s.get('sunDir') or stod != tod:
        setup_sky(s.get('sunDir') or info['sunDir'], stod)
    interior = s['kind'] == 'interior' or '内観' in s['title']
    scene.cycles.samples = SAMPLES * 2 if interior else SAMPLES
    set_cam(s['pos'], s['target'], s['fov'], architectural=bool(s.get('architectural', (not interior) and '鳥瞰' not in s['title'])))
    ev = auto_exposure(0.10 if interior else 0.15) + float(os.environ.get('EV_OFFSET', '0'))
    scene.view_settings.exposure = ev
    print('exposure', s['title'], round(ev, 2), 'shift_y %.3f' % cam_data.shift_y)
    safe = ''.join(c if c.isalnum() else '_' for c in s['title'])[:40]
    t0 = time.time()
    if interior and not os.environ.get('NO_BLEND'):
        # 内観は EXR に描いてから現像（窓の露出ブレンド）
        scene.render.image_settings.file_format = 'OPEN_EXR'; scene.render.image_settings.color_depth = '16'
        exr = os.path.join(out_dir, f'{safe}.exr'); scene.render.filepath = exr
        bpy.ops.render.render(write_still=True)
        png = os.path.join(out_dir, f'{safe}.png')
        if not exposure_blend(exr, png, ev):
            img = bpy.data.images.load(exr); img.save_render(png, scene=scene); bpy.data.images.remove(img)
        try: os.remove(exr)
        except Exception: pass
        scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_depth = '8'
        scene.render.filepath = png
    else:
        scene.render.filepath = os.path.join(out_dir, f'{safe}.png')
        bpy.ops.render.render(write_still=True)
    print('rendered', s['title'], '->', scene.render.filepath, f'{time.time() - t0:.0f}s')
