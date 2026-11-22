"""Rig the local AI Girls pack and export its articulated VRM 1.0 avatars."""

import argparse
from math import cos, pi, sin
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vrm_avatar import bake_t_pose, configure_vrm, export_vrm, orient_front, set_active


# Landmarks on 400 × 600 orthographic views, with 1.12 units of vertical coverage.
# Each body gives the center, the lateral offsets/rows of the arm and leg joints,
# and the pelvis row. DeepSeek uses the armature supplied by the source pack.
PROFILES = {
    '01_DeepSeek_V7': ('DeepSeek', None, ((185, 98), (212, 98), (198, 115))),
    '02_Claude_V3': ('Claude', (199, ((44, 147), (78, 207), (104, 260), (128, 290)),
                               ((23, 261), (33, 399), (40, 539), (39, 560)), 247), ((184, 86), (212, 85), (199, 103))),
    '03_GPT_V2': ('GPT', (194, ((43, 163), (75, 224), (111, 272), (126, 306)),
                          ((22, 266), (30, 396), (27, 533), (27, 555)), 246), ((179, 105), (205, 104), (193, 122))),
    '04_Gemini_V2': ('Gemini 娘', (200, ((46, 159), (73, 213), (116, 261), (141, 299)),
                                  ((26, 265), (35, 397), (42, 532), (42, 552)), 242), ((186, 104), (213, 103), (201, 120))),
    '05_GLM_V1': ('GLM', (199, ((49, 151), (76, 216), (105, 263), (126, 296)),
                          ((24, 257), (40, 405), (47, 534), (51, 556)), 236), ((184, 94), (210, 93), (199, 107))),
    '06_Grok_V1': ('Grok', (197, ((45, 166), (77, 219), (103, 260), (132, 289)),
                            ((24, 267), (30, 404), (35, 533), (34, 555)), 248), ((184, 104), (207, 102), (196, 118))),
    '07_Qwen_V1': ('Qwen', (198, ((44, 155), (75, 206), (108, 251), (134, 285)),
                            ((24, 258), (34, 402), (44, 526), (46, 553)), 238), ((185, 97), (211, 96), (198, 112))),
    '08_Kimi_V1': ('Kimi', (198, ((43, 155), (76, 210), (108, 253), (129, 284)),
                            ((23, 264), (30, 392), (31, 526), (35, 554)), 240), ((186, 94), (212, 91), (201, 108))),
    '09_MiniMax_V2': ('MiniMax', (201, ((45, 155), (69, 218), (103, 263), (122, 306)),
                                  ((20, 266), (23, 405), (22, 525), (22, 553)), 253), ((187, 96), (212, 96), (200, 114))),
    '10_豆包_V2': ('豆包', (200, ((48, 164), (75, 226), (99, 285), (104, 323)),
                            ((26, 273), (38, 412), (47, 527), (48, 553)), 251), ((182, 96), (216, 97), (199, 118))),
}

PIXEL = 1.12 / 600
VOWELS = {'aa': (5.5, 4.6), 'ih': (6.0, 2.2), 'ou': (3.5, 3.7), 'ee': (6.4, 2.5), 'oh': (4.3, 4.7)}
# Side-view columns disambiguate arms that overlap hair, wings or fabric in the front view.
ARM_SIDE_COLUMNS = {
    'GPT': (259, 257, 260, 264),
    'GLM': (222, 222, 228, 228),
    'Qwen': (226, 237, 245, 249),
    'Kimi': (230, 235, 242, 247),
    'MiniMax': (192, 201, 210, 215),
}


def surface(mesh):
    return BVHTree.FromPolygons([mesh.matrix_world @ v.co for v in mesh.data.vertices],
                                [tuple(p.vertices) for p in mesh.data.polygons])


def depth_hits(tree, lateral, height):
    ray = Vector((-1, 0, 0))
    point = Vector((2, lateral, height))
    for _ in range(12):
        hit = tree.ray_cast(point, ray)[0]
        if hit is None:
            break
        yield hit.x
        point = hit + ray * .00035


def create_armature(mesh, profile, face, label):
    center, arm, leg, pelvis = profile
    tree = surface(mesh)
    skeleton = bpy.data.armatures.new('AI Girls Humanoid')
    rig = bpy.data.objects.new('AI Girls Humanoid', skeleton)
    bpy.context.collection.objects.link(rig)
    set_active(rig)
    bpy.ops.object.mode_set(mode='EDIT')

    def point(column, row):
        lateral, height = (column - 200) * PIXEL, (300 - row) * PIXEL
        depths = list(depth_hits(tree, lateral, height))
        layers = list(zip(depths[:1], depths[-1:]))
        layers = list(zip(depths[::2], depths[1::2])) or layers
        front, back = max(layers, key=lambda pair: pair[0] - pair[1], default=(0, 0))
        return Vector(((front + back) / 2, lateral, height))

    def bone(name, head, tail, parent=None):
        joint = skeleton.edit_bones.new('mixamorig:' + name)
        joint.head = head
        joint.tail = tail
        joint.parent = parent
        joint.use_connect = bool(parent and (parent.tail - head).length < .0001)
        return joint

    shoulder_row = arm[0][1]
    neck_row = face[2][1] + 23
    spine_rows = (pelvis, pelvis - 23, (pelvis + shoulder_row) / 2, shoulder_row + 10, neck_row,
                  neck_row - 11, min(face[0][1], face[1][1]) - 15)
    spine_points = [point(center, row) for row in spine_rows]
    root = None
    torso = {}
    for index, name in enumerate(('Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head')):
        root = bone(name, spine_points[index], spine_points[index + 1], root)
        torso[name] = root
    for side, sign in (('Left', 1), ('Right', -1)):
        arm_points = [point(center + sign * column, row) for column, row in arm]
        for joint, side_column in zip(arm_points, ARM_SIDE_COLUMNS.get(label, ())):
            joint.x = (side_column - 200) * PIXEL
        clavicle = spine_points[3].lerp(arm_points[0], .25)
        root = bone(side + 'Shoulder', clavicle, arm_points[0], torso['Spine2'])
        for index, name in enumerate(('Arm', 'ForeArm', 'Hand')):
            root = bone(side + name, arm_points[index], arm_points[index + 1], root)
        leg_points = [point(center + sign * column, row) for column, row in leg]
        sole = leg_points[-1].copy()
        sole.x += .035
        root = torso['Hips']
        for index, name in enumerate(('UpLeg', 'Leg', 'Foot', 'ToeBase')):
            root = bone(side + name, leg_points[index], (leg_points + [sole])[index + 1], root)
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def smooth(amount):
    t = np.clip(amount, 0, 1)
    return t * t * (3 - 2 * t)


def skin_mesh(mesh, rig, automatic_weights=False):
    if automatic_weights:
        set_active(rig)
        mesh.select_set(True)
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        modifier = next(modifier for modifier in mesh.modifiers if modifier.type == 'ARMATURE' and modifier.object == rig)
        if all(any(group.weight > .001 for group in vertex.groups) for vertex in mesh.data.vertices):
            return modifier
        mesh.modifiers.remove(modifier)
        mesh.vertex_groups.clear()
    world = mesh.matrix_world.copy()
    mesh.parent = rig
    mesh.matrix_world = world
    modifier = mesh.modifiers.new('Avatar Skeleton', 'ARMATURE')
    modifier.object = rig
    coordinates = np.array([world @ vertex.co for vertex in mesh.data.vertices])
    joints = {bone.name.split(':')[1]: bone for bone in rig.data.bones}

    def distance(name):
        bone = joints[name]
        head = np.array(bone.head_local)
        direction = np.array(bone.tail_local) - head
        delta = coordinates - head
        offset = np.clip((delta @ direction) / (direction @ direction), 0, 1)
        return np.linalg.norm(delta - offset[:, None] * direction, axis=1)

    def distribute(names, amount):
        distances = np.array([distance(name) for name in names])
        weights = 1 / (distances ** 2 + .0003) ** 2
        return {name: weight * amount for name, weight in zip(names, weights / weights.sum(axis=0))}

    height = coordinates[:, 2]
    pelvis = joints['Hips'].head_local.z
    head = joints['Head'].head_local.z
    remaining = np.ones(len(coordinates))
    weights = {}
    for side in ('Left', 'Right'):
        arms = [side + part for part in ('Shoulder', 'Arm', 'ForeArm', 'Hand')]
        upper, lower, hand = [distance(name) for name in arms[1:]]
        # Isolate the sleeves and hands before blending. A dress can extend
        # laterally beyond a wrist but should follow the pelvis.
        arm = np.maximum.reduce([smooth((.065 - upper) / .033), smooth((.060 - lower) / .033),
                                 smooth((.040 - hand) / .022)])
        arm *= smooth((head - height + .026) / .045)
        wrist = joints[side + 'Hand']
        direction = (np.array(wrist.tail_local)[1:] - np.array(wrist.head_local)[1:])
        direction /= np.linalg.norm(direction)
        radial = coordinates[:, 1:] - np.array(wrist.head_local)[1:]
        forward = radial @ direction
        transverse = np.abs(radial[:, 0] * direction[1] - radial[:, 1] * direction[0])
        hand_length = (wrist.tail_local - wrist.head_local).length
        palm = smooth((.048 - transverse) / .017) * smooth((forward + .027) / .020)
        palm *= smooth((hand_length + .055 - forward) / .027)
        palm *= smooth((.100 - np.abs(coordinates[:, 0] - wrist.head_local.x)) / .035)
        arm = np.maximum(arm, palm)
        arm = np.minimum(arm, remaining)
        grip = np.minimum(arm, palm * smooth((forward + .004) / .025))
        weights.update(distribute(arms, arm - grip))
        weights[side + 'Hand'] += grip
        remaining -= arm
    for side in ('Left', 'Right'):
        legs = [side + part for part in ('UpLeg', 'Leg', 'Foot', 'ToeBase')]
        nearest = np.minimum.reduce([distance(name) for name in legs])
        leg = smooth((.069 - nearest) / .035) * smooth((pelvis + .01 - height) / .065)
        leg = np.minimum(leg, remaining)
        weights.update(distribute(legs, leg))
        remaining -= leg

    # Below the waist, cloth stays on the pelvis when outside either leg.
    torso = smooth((height - pelvis + .025) / .10) * remaining
    weights['Hips'] = remaining - torso
    skull = smooth((height - head + .018) / .039) * torso
    weights['Head'] = skull
    weights.update(distribute(('Spine', 'Spine1', 'Spine2', 'Neck'), torso - skull))
    names = list(weights)
    values = np.array(list(weights.values()))
    top = np.argsort(values, axis=0)[-4:]
    retained = np.zeros_like(values)
    np.put_along_axis(retained, top, np.take_along_axis(values, top, axis=0), axis=0)
    quantized = np.round(255 * retained / retained.sum(axis=0)).astype(np.uint8)
    for name, vertex_weights in zip(names, quantized):
        group = mesh.vertex_groups.new(name='mixamorig:' + name)
        for amount in np.unique(vertex_weights):
            if amount:
                group.add(np.flatnonzero(vertex_weights == amount).tolist(), int(amount) / 255, 'REPLACE')
    return modifier


def rigid_skin(mesh, rig, joint):
    world = mesh.matrix_world.copy()
    mesh.parent = rig
    mesh.matrix_world = world
    group = mesh.vertex_groups.new(name='mixamorig:' + joint)
    group.add(list(range(len(mesh.data.vertices))), 1.0, 'REPLACE')
    modifier = mesh.modifiers.new('Avatar Skeleton', 'ARMATURE')
    modifier.object = rig
    return modifier


def face_features(mesh, rig, vrm, landmarks, center_height):
    tree = surface(mesh)
    left_screen, right_screen, mouth = landmarks
    scale = (right_screen[0] - left_screen[0]) / 27

    def locate(section, radius_x, radius_y):
        cx, cy = section
        y, z = (cx - 200) * PIXEL, center_height + (300 - cy) * PIXEL
        thickness = next(depth_hits(tree, y, z), None)
        if thickness is None:
            raise ValueError(f'Face landmark does not intersect the mesh: {section}')
        hits = []
        for v in mesh.data.vertices:
            co = mesh.matrix_world @ v.co
            dy, dz = (co.y - y) / PIXEL, (co.z - z) / PIXEL
            distance = (dy / radius_x) ** 2 + (dz / radius_y) ** 2
            if distance >= 1 or abs(co.x - thickness) > .041:
                continue
            front = next(depth_hits(tree, co.y, co.z), None)
            if front is not None and abs(co.x - front) <= .009:
                hits.append((v.index, dy, dz, (1 - distance) ** 1.4))
        if len(hits) < 4:
            raise ValueError(f'Too few visible facial vertices at {section}')
        return hits

    eyes = [locate(p, 12 * scale, 10 * scale) for p in (left_screen, right_screen)]
    lips = locate(mouth, 12 * scale, 9 * scale)
    mesh.shape_key_add(name='Basis', from_mix=False)
    inverse = mesh.matrix_world.to_3x3().inverted()

    def expression(name, eye_amounts=(0, 0), mouth_width=0, mouth_open=0, smile=0):
        key = mesh.shape_key_add(name=name, from_mix=False)
        for eye, amount in zip(eyes, eye_amounts):
            for index, _, z, weight in eye:
                key.data[index].co += inverse @ Vector((0, 0, -z * weight * amount * PIXEL))
        for index, y, z, weight in lips:
            delta_y = y * mouth_width
            delta_z = z * mouth_open + smile * abs(y) / 5
            key.data[index].co += inverse @ Vector((0, delta_y * weight * PIXEL, delta_z * weight * PIXEL))
        bind = getattr(vrm.expressions.preset, name).morph_target_binds.add()
        bind.node.mesh_object_name = mesh.name
        bind.index = key.name
        bind.weight = 1.0

    expression('blink', (1.12, 1.12))
    expression('blink_left', (0, 1.12))
    expression('blink_right', (1.12, 0))
    expression('happy', (.32, .32), .18, .18, 2.3)
    expression('sad', (.2, .2), -.12, 0, -2.4)
    expression('angry', (.43, .43), -.13, 0, -.9)
    expression('relaxed', (.25, .25), 0, 0, 1.35)
    expression('surprised', (-.24, -.24), -.10, .68)
    for name, (width, height) in VOWELS.items():
        expression(name, (0, 0), (width - 5) / 12, height / 9)

    # The scanned lips are a continuous surface. Add a thin mouth interior that
    # follows that surface and is driven by the same mouth-shape weights.
    cy, cz = (mouth[0] - 200) * PIXEL, center_height + (300 - mouth[1]) * PIXEL
    center_depth = next(depth_hits(tree, cy, cz))
    circle = [(0, 0)] + [(cos(i * pi / 12), sin(i * pi / 12)) for i in range(24)]

    def mouth_vertices(width, height):
        vertices = []
        for u, v in circle:
            y, z = cy + u * width * scale * PIXEL, cz + v * height * scale * PIXEL
            depth = next(depth_hits(tree, y, z), center_depth)
            vertices.append((min(depth, center_depth + .009) + .0016, y, z))
        return vertices

    geometry = bpy.data.meshes.new('Mouth interior')
    geometry.from_pydata(mouth_vertices(.075, .075), [], [(0, i + 1, (i + 1) % 24 + 1) for i in range(24)])
    interior = bpy.data.objects.new('Mouth interior', geometry)
    bpy.context.collection.objects.link(interior)
    material = bpy.data.materials.new('Mouth shadow')
    material.use_nodes = True
    material.node_tree.nodes.clear()
    emission = material.node_tree.nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = (.018, .0018, .004, 1)
    output = material.node_tree.nodes.new('ShaderNodeOutputMaterial')
    material.node_tree.links.new(emission.outputs[0], output.inputs['Surface'])
    geometry.materials.append(material)
    interior.shape_key_add(name='Basis', from_mix=False)
    for name, (width, height) in {**VOWELS, 'surprised': (4.6, 4.4)}.items():
        key = interior.shape_key_add(name=name, from_mix=False)
        for vertex, co in zip(key.data, mouth_vertices(width, height)):
            vertex.co = co
        bind = getattr(vrm.expressions.preset, name).morph_target_binds.add()
        bind.node.mesh_object_name = interior.name
        bind.index = key.name
        bind.weight = 1.0
    rigid_skin(interior, rig, 'Head')
    return interior


def process(source, label, profile, face, output):
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False, load_ui=False)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.visible_get()]
    body = max(meshes, key=lambda obj: len(obj.data.vertices))
    if profile is None:
        rig = bpy.context.scene.objects['Armature']
        skinned = [(o, next(m for m in o.modifiers if m.type == 'ARMATURE' and m.object == rig)) for o in meshes]
    else:
        body.data.validate(verbose=False)
        rig = create_armature(body, profile, face, label)
        skinned = [(body, skin_mesh(body, rig, automatic_weights=label == '豆包'))]
        skinned += [(o, rigid_skin(o, rig, 'Spine2')) for o in meshes if o != body]
    bake_t_pose(rig, skinned)
    vrm = configure_vrm(rig, label, 'AI Girls, VA body and face adaptation')
    interior = face_features(body, rig, vrm, face, .5 if profile is None else 0)
    orient_front(rig)
    set_active(rig)
    for mesh in [*meshes, interior]:
        mesh.select_set(True)
    output.parent.mkdir(parents=True, exist_ok=True)
    export_vrm(rig, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Extracted AI Girls pack directory')
    parser.add_argument('output', type=Path, help='Separate directory for the new VRMs')
    parser.add_argument('--only', choices=PROFILES)
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    options = parser.parse_args(arguments)
    source, output = options.source.resolve(), options.output.resolve()
    if (source / '模型').is_dir():
        source /= '模型'
    if not hasattr(bpy.types.Armature, 'vrm_addon_extension'):
        bpy.ops.preferences.addon_enable(module='io_scene_vrm')
    for variant, (label, body, face) in PROFILES.items():
        if options.only and options.only != variant:
            continue
        destination = output / variant / 'model.vrm'
        if destination.exists():
            print(f'Keeping existing {destination}')
            continue
        process(source / variant / 'model.blend', label, body, face, destination)


if __name__ == '__main__':
    main()
