"""
間取りプレゼンの 3D モデル（.glb）を Blender（Cycles）で写真品質にレンダリングする。

  python render.py --glb scene.glb --json scene.json --shot ext-front --out out.png \
      --hdri public/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr --samples 128 --width 1600 --height 900

- カメラ: アプリの見どころカメラ（位置・注視点・画角）をそのまま再現
- 空: 実写の HDRI。HDRI の太陽の向きを、アプリの日照の設定（太陽の方位）に合わせて回転
- ガラス: 建築パースの定番の薄いガラス（光と影はそのまま通し、角度に応じて空を映す）
- 内観: 窓に Cycles のライトポータルを置き、室内の明るさを効率よく計算。ダウンライトを点灯
- ノイズ除去: OpenImageDenoise
"""
import argparse
import json
import math
import sys

import bpy
import numpy as np
from mathutils import Vector


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--json", required=True)
    p.add_argument("--shot", default="ext-front", help="見どころカメラの ID（カンマ区切りで複数、all で全部）")
    p.add_argument("--out", required=True, help="出力ファイル（複数のときはフォルダ）")
    p.add_argument("--gpu", action="store_true", help="GPU（OptiX/CUDA/HIP/Metal）で計算")
    p.add_argument("--hdri", required=True)
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--width", type=int, default=1600)
    p.add_argument("--height", type=int, default=900)
    p.add_argument("--exposure", type=float, default=None)
    p.add_argument("--threads", type=int, default=0)
    p.add_argument("--time-limit", type=float, default=0)
    return p.parse_args(argv)


def three_to_blender(v):
    # three.js（Y 上）→ Blender（Z 上）。glTF の読み込みと同じ変換
    return Vector((v[0], -v[2], v[1]))


def setup_world(hdri_path, sun_dir_three, night=False):
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    mapping = nt.nodes.new("ShaderNodeMapping")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    img = bpy.data.images.load(hdri_path)
    env.image = img
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs["Strength"].default_value = 0.35 if night else 1.0
    # HDRI の太陽（上半分で最も明るい画素）の方位を求め、アプリの太陽の方位に合わせる
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)  # 1 行目 = 画像の下
    lum = px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722
    upper = lum[h // 2:, :]
    r, c = np.unravel_index(np.argmax(upper), upper.shape)
    u = (c + 0.5) / w
    theta = (u - 0.5) * 2 * math.pi  # Blender の正距円筒: atan2(y, -x) = theta
    phi_h = math.atan2(math.sin(theta), -math.cos(theta))
    sd = three_to_blender(sun_dir_three)
    phi_d = math.atan2(sd.y, sd.x)
    mapping.inputs["Rotation"].default_value[2] = phi_h - phi_d
    print(f"HDRI sun az {math.degrees(phi_h):.1f} -> target {math.degrees(phi_d):.1f}")


def clean_meshes():
    """重なった面（同じ位置の面が2枚）を1枚にする。光の計算では重なった面が互いに影を落として真っ黒になるため"""
    import bmesh

    removed = 0
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
        seen = set()
        dup = []
        for f in bm.faces:
            key = tuple(sorted(v.index for v in f.verts))
            if key in seen:
                dup.append(f)
            else:
                seen.add(key)
        if dup:
            bmesh.ops.delete(bm, geom=dup, context="FACES")
            removed += len(dup)
        bm.to_mesh(ob.data)
        bm.free()
    print("duplicate faces removed", removed)
    # 建物の面は、書き出した頂点の法線が裏向きのことがある（three.js は両面表示で目立たないが、
    # Cycles では光が当たらず真っ黒になる）。面の向きから法線を作り直し、平らに陰影を付ける
    fixed = 0
    for ob in bpy.data.objects:
        if ob.type != "MESH" or not any(m and (m.name.startswith("ext.") or m.name.startswith("int.")) for m in ob.data.materials):
            continue
        me = ob.data
        if me.has_custom_normals:
            bpy.context.view_layer.objects.active = ob
            with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
            fixed += 1
        for poly in me.polygons:
            poly.use_smooth = False
    print("normals reset", fixed)


def fix_materials(interior):
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        nt = mat.node_tree
        name = mat.name
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if bsdf is None or out is None:
            continue
        if name.startswith("ext.glass"):
            # 建築パースの定番の薄いガラス: 光はそのまま通し（影も落とさない）、角度に応じて空を映す。
            # 窓は表裏2枚の面が重なっているので、屈折のガラスだと計算が破綻して黒くなる
            frosted = "Frosted" in name
            nt.nodes.clear()
            out = nt.nodes.new("ShaderNodeOutputMaterial")
            tr = nt.nodes.new("ShaderNodeBsdfTransparent")
            tr.inputs["Color"].default_value = (0.92, 0.95, 0.94, 1) if not frosted else (0.55, 0.57, 0.57, 1)
            gl = nt.nodes.new("ShaderNodeBsdfGlossy")
            gl.inputs["Roughness"].default_value = 0.02 if not frosted else 0.3
            fr = nt.nodes.new("ShaderNodeLayerWeight")
            fr.inputs["Blend"].default_value = 0.3
            mix = nt.nodes.new("ShaderNodeMixShader")
            if frosted:
                df = nt.nodes.new("ShaderNodeBsdfDiffuse")
                df.inputs["Color"].default_value = (0.85, 0.87, 0.87, 1)
                m2 = nt.nodes.new("ShaderNodeMixShader")
                m2.inputs["Fac"].default_value = 0.5
                nt.links.new(tr.outputs["BSDF"], m2.inputs[1])
                nt.links.new(df.outputs["BSDF"], m2.inputs[2])
                nt.links.new(m2.outputs["Shader"], mix.inputs[1])
            else:
                nt.links.new(tr.outputs["BSDF"], mix.inputs[1])
            nt.links.new(fr.outputs["Fresnel"], mix.inputs["Fac"])
            nt.links.new(gl.outputs["BSDF"], mix.inputs[2])
            nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        elif name in ("f.downlight", "f.lamp", "int.cove") or name.startswith("f.lampShade"):
            if name == "f.lampShade":
                continue
            bsdf.inputs["Emission Color"].default_value = (1.0, 0.82, 0.62, 1)
            bsdf.inputs["Emission Strength"].default_value = 18.0 if interior else 4.0


def add_portals(center_bl):
    """窓ガラスの位置に、Cycles のライトポータル（窓から入る空の光を効率よく計算するための目印）を置く"""
    n = 0
    for ob in list(bpy.data.objects):
        if ob.type != "MESH" or not any(m and m.name.startswith("ext.glass") for m in ob.data.materials):
            continue
        me = ob.data
        mw = ob.matrix_world
        # ガラスの面を、法線の向きと位置でまとめて 1 枚ずつのポータルに
        groups = {}
        for poly in me.polygons:
            nrm = (mw.to_3x3() @ poly.normal).normalized()
            if abs(nrm.z) > 0.3:
                continue
            c = mw @ poly.center
            key = (round(nrm.x, 1), round(nrm.y, 1), round(c.dot(nrm) * 5) / 5)
            groups.setdefault(key, []).append(poly)
        for key, polys in groups.items():
            nrm = Vector((key[0], key[1], 0)).normalized()
            side = Vector((-nrm.y, nrm.x, 0))
            # 面ごとの横方向の範囲を求め、重なる・接する面を1つの窓にまとめる
            spans = []
            for p in polys:
                vs = [mw @ me.vertices[i].co for i in p.vertices]
                sv = [v.dot(side) for v in vs]
                spans.append([min(sv), max(sv), min(v.z for v in vs), max(v.z for v in vs), vs[0]])
            spans.sort(key=lambda x: x[0])
            merged = []
            for sp in spans:
                if merged and sp[0] <= merged[-1][1] + 0.15:
                    m = merged[-1]
                    m[1] = max(m[1], sp[1])
                    m[2] = min(m[2], sp[2])
                    m[3] = max(m[3], sp[3])
                else:
                    merged.append(list(sp))
            for s0, s1, z0, z1, base in merged:
                if s1 - s0 < 0.3 or z1 - z0 < 0.3:
                    continue
                d = base.dot(nrm)
                center = side * ((s0 + s1) / 2) + nrm * d + Vector((0, 0, (z0 + z1) / 2))
                center.z = (z0 + z1) / 2
                # ガラスは両面あるので、光を出す向き（-nrm）が建物の内側を向く方だけを使う
                to_c = Vector((center_bl.x - center.x, center_bl.y - center.y, 0))
                if to_c.dot(-nrm) <= 0:
                    continue
                light = bpy.data.lights.new(f"portal{n}", "AREA")
                light.shape = "RECTANGLE"
                light.size = s1 - s0
                light.size_y = z1 - z0
                light.cycles.is_portal = True
                lo = bpy.data.objects.new(f"portal{n}", light)
                bpy.context.collection.objects.link(lo)
                lo.location = center
                # 面光源は -Z 方向に向く。ポータルは室内側を向ける（どちら側でも可）
                lo.rotation_euler = (math.pi / 2, 0, math.atan2(nrm.y, nrm.x) + math.pi / 2)
                n += 1
    print("portals", n)


def use_gpu():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type == kind]
            if devs:
                for d in prefs.devices:
                    d.use = d.type == kind
                print("GPU:", kind, [d.name for d in devs])
                return True
        except Exception:
            continue
    print("GPU が見つからないため CPU で計算します")
    return False


def auto_exposure(scene, a, target=0.42):
    """小さな下書きを描いて、室内の中間の明るさ（輝度の中央値）が写真らしい明るさになる露出を求める"""
    import os
    import tempfile

    keep = (scene.render.resolution_percentage, scene.cycles.samples, scene.render.filepath)
    scene.render.resolution_percentage = 20
    scene.cycles.samples = 24
    ev = scene.view_settings.exposure
    tmp = os.path.join(tempfile.gettempdir(), "madori_preview.png")
    for _ in range(2):
        scene.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(tmp, check_existing=False)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
        bpy.data.images.remove(img)
        lum = px[:, 0] * 0.2126 + px[:, 1] * 0.7152 + px[:, 2] * 0.0722
        med = float(np.median(lum))
        step = math.log2(target / max(0.02, med))
        ev = max(-1.0, min(5.0, ev + max(-2.0, min(2.0, step * 0.9))))
        scene.view_settings.exposure = ev
        if abs(step) < 0.15:
            break
    scene.render.resolution_percentage, scene.cycles.samples, scene.render.filepath = keep
    print(f"exposure {ev:.2f} (median {med:.2f})")
    return ev


def set_camera(scene, shot, a):
    cam = scene.camera
    cam_data = cam.data
    cam_data.sensor_fit = "VERTICAL"
    cam_data.angle_y = math.radians(shot["fov"])
    pos = three_to_blender(shot["pos"])
    tgt = three_to_blender(shot["target"])
    cam.location = pos
    # 建築パースの定石: 縦の線を垂直に（カメラは水平に向け、上下はシフトで調整）
    d = tgt - pos
    horiz = Vector((d.x, d.y, 0))
    pitch = math.atan2(d.z, horiz.length)
    if abs(pitch) > math.radians(15):
        # 鳥瞰など大きく見下ろす構図は、カメラ自体を傾ける
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam_data.shift_y = 0
    else:
        cam.rotation_euler = (math.pi / 2, 0, math.atan2(d.y, d.x) - math.pi / 2)
        # シフトは画像の長辺に対する割合
        cam_data.shift_y = math.tan(pitch) / (2 * math.tan(cam_data.angle_y / 2)) * (a.height / max(a.width, a.height))


def main():
    import os

    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    info = json.load(open(a.json, encoding="utf-8"))
    if a.shot == "all":
        shots = info["shots"]
    else:
        ids = [x.strip() for x in a.shot.split(",") if x.strip()]
        shots = [s for s in info["shots"] if s["id"] in ids]
    if not shots:
        shots = [{"id": "current", "pos": info["current"]["pos"], "target": info["current"]["target"], "fov": info["current"]["fov"], "kind": "exterior", "title": "current"}]
    multi = len(shots) > 1
    if multi:
        os.makedirs(a.out, exist_ok=True)
    any_interior = any(s.get("kind") == "interior" for s in shots)
    bpy.ops.import_scene.gltf(filepath=a.glb)
    clean_meshes()
    fix_materials(any_interior)
    setup_world(a.hdri, info["sunDir"], info.get("timeOfDay") == "night")
    if any_interior and info.get("bbox"):
        mn = three_to_blender(info["bbox"]["min"])
        mx = three_to_blender(info["bbox"]["max"])
        add_portals((mn + mx) / 2)

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("cam")
    cam_data.clip_start = 0.05
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU" if a.gpu and use_gpu() else "CPU"
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.02
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.max_bounces = 8
    scene.cycles.glossy_bounces = 3
    scene.cycles.transmission_bounces = 6
    scene.cycles.transparent_max_bounces = 16
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.blur_glossy = 1.0
    if a.time_limit:
        scene.cycles.time_limit = a.time_limit
    if a.threads:
        scene.render.threads_mode = "FIXED"
        scene.render.threads = a.threads
    scene.render.resolution_x = a.width
    scene.render.resolution_y = a.height
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.image_settings.file_format = "PNG"
    for shot in shots:
        interior = shot.get("kind") == "interior"
        set_camera(scene, shot, a)
        # 室内は光が少ないので計算を多めに、露出を上げる（写真と同じ考え方）
        scene.cycles.samples = a.samples * (2 if interior else 1)
        scene.cycles.diffuse_bounces = 4 if interior else 3
        scene.view_settings.exposure = a.exposure if a.exposure is not None else (2.2 if interior else 0.0)
        if a.exposure is None and interior:
            scene.view_settings.exposure = auto_exposure(scene, a)
        scene.render.filepath = os.path.join(a.out, f"{shot['id']}.png") if multi else a.out
        bpy.ops.render.render(write_still=True)
        print("done", scene.render.filepath)


main()
