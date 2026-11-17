"""高品質パース: プレゼンツールの「レンダリングの依頼」（GLB＋job.json）を Blender の Cycles で描く。

使い方（どちらでも同じ結果）:
    blender --background --python tools/blender/render_job.py -- --glb house.glb --job job.json --out out.png
    python tools/blender/render_job.py --glb house.glb --job job.json --out out.png      （pip の bpy を使う場合）

決まり:
  - 形は一切編集しない。触るのは素材・光・カメラ・描画の設定だけ。
  - 読み込んだ形を、依頼に入っている検算値（全体と材料キーごとの外形の大きさ・三角形の数）と突き合わせる。
    1mm を超えて違えば、描かずに終了する（終了コード 2）。結果は <out>.report.json に書く。
  - 同じ依頼・同じ設定なら同じ絵になるよう、乱数の種は固定。ネットワークは使わない。

座標: three.js（Y 上）→ Blender（Z 上）は (x, y, z) → (x, −z, y)。glTF の読み込みが同じ変換をするので、
カメラ・太陽も同じ式で写す。
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
from mathutils import Matrix, Vector

TOL = 0.001  # 形の検算の許容差 (m) = 1mm


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument('--glb', required=True)
    p.add_argument('--job', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--width', type=int, default=1920)
    p.add_argument('--samples', type=int, default=256)
    p.add_argument('--check-only', action='store_true', help='形の検算だけして描かない')
    p.add_argument('--threads', type=int, default=0)
    return p.parse_args(argv)


def to_blender(v):
    """three.js の座標 (x, y, z) → Blender (x, −z, y)"""
    return Vector((v[0], -v[2], v[1]))


def to_three(v):
    """Blender の座標 → three.js"""
    return (v.x, v.z, -v.y)


# ---------------------------------------------------------------- 形の検算
def measure_scene():
    """読み込んだメッシュの外形（three.js の座標で）と三角形の数を、材料キーごとに集める"""
    total = [[math.inf] * 3, [-math.inf] * 3]
    parts = {}
    meshes = 0
    for ob in bpy.context.scene.objects:
        if ob.type != 'MESH':
            continue
        meshes += 1
        key = str(ob.get('matKey', '(none)'))
        part = parts.setdefault(key, {'min': [math.inf] * 3, 'max': [-math.inf] * 3, 'triangles': 0, 'vertices': 0})
        mw = ob.matrix_world
        me = ob.data
        for v in me.vertices:
            p = to_three(mw @ v.co)
            for i in range(3):
                if p[i] < part['min'][i]:
                    part['min'][i] = p[i]
                if p[i] > part['max'][i]:
                    part['max'][i] = p[i]
        part['vertices'] += len(me.vertices)
        part['triangles'] += sum(len(pl.vertices) - 2 for pl in me.polygons)
    for part in parts.values():
        for i in range(3):
            total[0][i] = min(total[0][i], part['min'][i])
            total[1][i] = max(total[1][i], part['max'][i])
    return {'bbox': {'min': total[0], 'max': total[1]}, 'parts': parts, 'meshes': meshes}


def verify(job, got):
    """依頼の検算値と突き合わせる。戻り値: (合格か, 違いの一覧, 最大のずれ m)"""
    want = job['fingerprint']
    issues = []
    worst = 0.0

    def cmp_box(name, a, b):
        nonlocal worst
        for k in ('min', 'max'):
            for i, ax in enumerate('xyz'):
                d = abs(a[k][i] - b[k][i])
                worst = max(worst, d)
                if d > TOL:
                    issues.append(f'{name}: 外形の {k}.{ax} が {d * 1000:.2f} mm ずれている（依頼 {a[k][i]:.4f} / 読み込み後 {b[k][i]:.4f}）')

    cmp_box('全体', want['bbox'], got['bbox'])
    for key, w in want['parts'].items():
        g = got['parts'].get(key)
        if g is None:
            issues.append(f'{key}: 読み込んだ形に無い（書き出しで欠けた）')
            continue
        cmp_box(key, w['bbox'], {'min': g['min'], 'max': g['max']})
        if w['triangles'] != g['triangles']:
            issues.append(f'{key}: 三角形の数が違う（依頼 {w["triangles"]} / 読み込み後 {g["triangles"]}）')
    for key in got['parts']:
        if key not in want['parts']:
            issues.append(f'{key}: 依頼に無い形が入っている')
    return (not issues, issues, worst)


# ---------------------------------------------------------------- カメラ・光
def setup_camera(job, width):
    c = job['camera']
    scene = bpy.context.scene
    height = round(width / c['aspect'])
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    cam_data = bpy.data.cameras.new('JobCamera')
    cam = bpy.data.objects.new('JobCamera', cam_data)
    scene.collection.objects.link(cam)
    pos = to_blender(c['pos'])
    tgt = to_blender(c['target'])
    cam.location = pos
    # カメラは −Z を向く・+Y が上
    cam.rotation_euler = (tgt - pos).to_track_quat('-Z', 'Y').to_euler()
    # 縦の画角をそのまま写す（センサーの縦 24mm を基準に焦点距離を決める）
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.sensor_height = 24.0
    cam_data.lens = (24.0 / 2) / math.tan(math.radians(c['fovY']) / 2)
    # 2 点透視のレンズシフト: three.js は「画面の高さの半分 = 1」。Blender は、センサーを縦で合わせているときは「画面の高さ = 1」
    # （最初の試作では「長い辺 = 1」として計算し、地平線が約 70px 高くずれた。同じ構図の three.js の絵と重ねて確かめた）
    cam_data.shift_y = c.get('shiftY', 0.0) * 0.5
    cam_data.clip_start = 0.05
    cam_data.clip_end = 3000
    scene.camera = cam
    return cam


def setup_light(job):
    """空と太陽。太陽の向きは依頼の値そのまま（日照の設定と同じ向き）"""
    scene = bpy.context.scene
    tod = job['sun'].get('timeOfDay', 'day')
    d = to_blender(job['sun']['dir']).normalized()
    elevation = math.asin(max(-1.0, min(1.0, d.z)))
    # 方位: Blender の空は +Y を 0 として、上から見て時計回り
    rotation = math.atan2(d.x, d.y)
    world = bpy.data.worlds.new('JobWorld')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    sky_ok = False
    if tod != 'night':
        try:
            sky = nt.nodes.new('ShaderNodeTexSky')
            # 版によって空の種類の名前が違う。太陽の円盤つきの物理の空を選ぶ
            kinds = [e.identifier for e in sky.bl_rna.properties['sky_type'].enum_items]
            for want in ('MULTIPLE_SCATTERING', 'NISHITA', 'SINGLE_SCATTERING'):
                if want in kinds:
                    sky.sky_type = want
                    break
            sky.sun_elevation = max(elevation, math.radians(2))
            sky.sun_rotation = rotation
            if hasattr(sky, 'sun_disc'):
                sky.sun_disc = True
            if hasattr(sky, 'sun_size'):
                sky.sun_size = math.radians(1.2)  # 影の縁をわずかにやわらげる
            nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
            # 物理の空は実際の明るさ（とても明るい）。露出で写真の明るさに合わせる
            bg.inputs['Strength'].default_value = 0.12 if tod == 'day' else 0.2
            sky_ok = True
        except Exception as e:  # noqa: BLE001
            print('sky texture unavailable:', e)
    if not sky_ok:
        bg.inputs['Color'].default_value = (0.02, 0.03, 0.06, 1) if tod == 'night' else (0.6, 0.75, 1.0, 1)
        bg.inputs['Strength'].default_value = 0.05 if tod == 'night' else 1.0
        if tod != 'night':
            sun_data = bpy.data.lights.new('JobSun', 'SUN')
            sun_data.energy = 4.0
            sun_data.angle = math.radians(1.2)
            sun = bpy.data.objects.new('JobSun', sun_data)
            scene.collection.objects.link(sun)
            sun.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return {'sky': sky_ok, 'elevationDeg': math.degrees(elevation), 'rotationDeg': math.degrees(rotation)}


# ---------------------------------------------------------------- 素材（形には触らない）
def principled(mat):
    if not mat.use_nodes:
        return None
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    return None


def harden_material(mat, single_sided):
    """three.js と同じ見え方になるよう、素材に 2 つの決まりを足す（形は変えない）。

    1. 重なった面: three.js の形には、同じ平面に面が二重に重なる所がある（つながった 2 枚の壁の重なり、
       厚みの無い板の表と裏）。three.js では見えないが、Cycles では面から出た光の線がすぐ隣の重なった面に当たり、
       そこが真っ黒になる（吉田様邸の車庫の袖壁とシャッターの上の壁の重なりで確認）。
       → カメラ以外の光の線が 2mm 以内で当たった面は素通しにする（影・照り返しの計算だけ。見た目の面はそのまま）。
    2. 片面の素材（three.js では裏面を描かない）は、カメラから見た裏面を描かない。影は落とす。
    """
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    if out is None or not out.inputs['Surface'].is_linked:
        return False
    src = out.inputs['Surface'].links[0].from_socket
    lp = nt.nodes.new('ShaderNodeLightPath')
    near = nt.nodes.new('ShaderNodeMath')
    near.operation = 'LESS_THAN'
    near.inputs[1].default_value = 0.002
    nt.links.new(lp.outputs['Ray Length'], near.inputs[0])
    not_cam = nt.nodes.new('ShaderNodeMath')
    not_cam.operation = 'SUBTRACT'
    not_cam.inputs[0].default_value = 1.0
    nt.links.new(lp.outputs['Is Camera Ray'], not_cam.inputs[1])
    fac = nt.nodes.new('ShaderNodeMath')
    fac.operation = 'MULTIPLY'
    nt.links.new(near.outputs['Value'], fac.inputs[0])
    nt.links.new(not_cam.outputs['Value'], fac.inputs[1])
    last = fac
    if single_sided:
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        back = nt.nodes.new('ShaderNodeMath')
        back.operation = 'MULTIPLY'
        nt.links.new(geo.outputs['Backfacing'], back.inputs[0])
        nt.links.new(lp.outputs['Is Camera Ray'], back.inputs[1])
        both = nt.nodes.new('ShaderNodeMath')
        both.operation = 'MAXIMUM'
        nt.links.new(fac.outputs['Value'], both.inputs[0])
        nt.links.new(back.outputs['Value'], both.inputs[1])
        last = both
    transp = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(last.outputs['Value'], mix.inputs['Fac'])
    nt.links.new(src, mix.inputs[1])
    nt.links.new(transp.outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    return True


def setup_materials(job):
    """材料キーの種類に合わせて、素材の光り方だけを整える"""
    kinds = job.get('materials', {})
    seen = set()
    counts = {}
    for ob in bpy.context.scene.objects:
        if ob.type != 'MESH':
            continue
        info = kinds.get(str(ob.get('matKey', '')), {})
        kind = info.get('kind', 'other')
        for slot in ob.material_slots:
            mat = slot.material
            if mat is None or mat.name in seen:
                continue
            seen.add(mat.name)
            counts[kind] = counts.get(kind, 0) + 1
            p = principled(mat)
            if p is None:
                continue
            if os.environ.get('RJ_NO_NORMALMAP'):
                for l in list(mat.node_tree.links):
                    if l.to_node == p and l.to_socket.name == 'Normal':
                        mat.node_tree.links.remove(l)
            if info.get('glass') or kind == 'glass':
                # 建築のガラス: 1 枚の面なので屈折させず、透過＋映り込みの薄いガラスにする
                nt = mat.node_tree
                out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
                if out is None:
                    continue
                transp = nt.nodes.new('ShaderNodeBsdfTransparent')
                transp.inputs['Color'].default_value = (0.93, 0.96, 0.95, 1)
                gloss = nt.nodes.new('ShaderNodeBsdfGlossy')
                gloss.inputs['Roughness'].default_value = 0.02
                fres = nt.nodes.new('ShaderNodeFresnel')
                fres.inputs['IOR'].default_value = 1.5
                mix = nt.nodes.new('ShaderNodeMixShader')
                nt.links.new(fres.outputs['Fac'], mix.inputs['Fac'])
                nt.links.new(transp.outputs['BSDF'], mix.inputs[1])
                nt.links.new(gloss.outputs['BSDF'], mix.inputs[2])
                nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
                mat.blend_method = 'BLEND' if hasattr(mat, 'blend_method') else mat.blend_method
            elif kind == 'floor':
                # 塗装の床: うっすら艶の層
                for name in ('Coat Weight', 'Clearcoat'):
                    if name in p.inputs:
                        p.inputs[name].default_value = 0.25
                        break
    # 重なった面・片面の素材の扱い（three.js と同じ見え方にする。形は変えない）
    culled = 0
    for mat in bpy.data.materials:
        if mat.node_tree is None:
            continue
        single = bool(getattr(mat, 'use_backface_culling', False))
        if harden_material(mat, single) and single:
            culled += 1
    counts['singleSided'] = culled
    return counts


def setup_render(job, samples, threads):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    cy = scene.cycles
    cy.device = 'CPU'
    cy.samples = samples
    cy.seed = 0
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.02
    cy.max_bounces = 10 if job.get('interior') else 6
    cy.diffuse_bounces = 6 if job.get('interior') else 3
    cy.sample_clamp_indirect = 8.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    try:
        cy.use_denoising = True
        cy.denoiser = 'OPENIMAGEDENOISE'
        # 色・法線の下絵も渡すと、素材の模様を残したままノイズだけ消える
        cy.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    except Exception as e:  # noqa: BLE001
        print('denoiser unavailable:', e)
        cy.use_denoising = False
    if threads:
        scene.render.threads_mode = 'FIXED'
        scene.render.threads = threads
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    vs = scene.view_settings
    try:
        vs.view_transform = 'AgX'
        vs.look = 'AgX - Medium High Contrast'
    except Exception:  # noqa: BLE001
        pass
    # 室内は室内の明るさに合わせて露出を上げる（写真と同じ）
    vs.exposure = 2.6 if job.get('interior') else 0.0


def main():
    a = parse_args()
    t0 = time.time()
    job = json.load(open(a.job, encoding='utf8'))
    report = {'job': a.job, 'glb': a.glb, 'blender': bpy.app.version_string}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=a.glb)
    report['importSec'] = round(time.time() - t0, 1)
    bpy.context.view_layer.update()
    got = measure_scene()
    ok, issues, worst = verify(job, got)
    report['geometry'] = {
        'ok': ok,
        'worstDeviationMm': round(worst * 1000, 4),
        'issues': issues[:40],
        'issueCount': len(issues),
        'meshes': got['meshes'],
        'parts': len(got['parts']),
        'bbox': got['bbox'],
    }
    report['inferred'] = job.get('inferred', [])
    out_report = a.out + '.report.json'
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    if not ok:
        json.dump(report, open(out_report, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        print('GEOMETRY CHECK FAILED:', len(issues), 'issues. worst', worst * 1000, 'mm')
        for line in issues[:12]:
            print('  ', line)
        sys.exit(2)
    print('geometry check OK. worst deviation %.4f mm, %d parts, %d meshes' % (worst * 1000, len(got['parts']), got['meshes']))
    cam = setup_camera(job, a.width)
    report['camera'] = {'location': list(cam.location), 'lensMm': cam.data.lens, 'shiftY': cam.data.shift_y, 'threePos': list(to_three(cam.location))}
    report['light'] = setup_light(job)
    report['materials'] = setup_materials(job)
    setup_render(job, a.samples, a.threads)
    if not a.check_only:
        bpy.context.scene.render.filepath = a.out
        t1 = time.time()
        bpy.ops.render.render(write_still=True)
        report['renderSec'] = round(time.time() - t1, 1)
        report['samples'] = a.samples
        report['size'] = [bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y]
    report['totalSec'] = round(time.time() - t0, 1)
    json.dump(report, open(out_report, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print('done', json.dumps({k: report[k] for k in ('importSec', 'totalSec') if k in report}))


if __name__ == '__main__':
    main()
