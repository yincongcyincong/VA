"""Blender helpers shared by the local AI Girls avatar exporters."""

from math import pi
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import bpy
from mathutils import Matrix, Vector


def set_active(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def bake_t_pose(armature, meshes):
    # The source faces +X in Blender and its arms angle downward from +/-Y.
    for side, sign in [('Left', 1), ('Right', -1)]:
        direction = armature.matrix_world.to_3x3().inverted() @ Vector((0, sign, 0))
        for segment in ('Arm', 'ForeArm', 'Hand'):
            bone = armature.pose.bones['mixamorig:' + side + segment]
            rotation = (bone.tail - bone.head).rotation_difference(direction).to_matrix().to_4x4()
            head = bone.head.copy()
            bone.matrix = Matrix.Translation(head) @ rotation @ Matrix.Translation(-head) @ bone.matrix
            bpy.context.view_layer.update()

    # Move the mesh into the new bind pose before changing the armature rest pose.
    for mesh, modifier in meshes:
        set_active(mesh)
        name = modifier.name
        preserve_volume = modifier.use_deform_preserve_volume
        bpy.ops.object.modifier_apply(modifier=name)
        skin = mesh.modifiers.new(name, 'ARMATURE')
        skin.object = armature
        skin.use_deform_preserve_volume = preserve_volume
        if mesh.parent != armature:
            world = mesh.matrix_world.copy()
            mesh.parent = armature
            mesh.matrix_world = world
    set_active(armature)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def orient_front(armature):
    # Blender -Y is glTF +Z, the front direction for VRM 1.0.
    armature.matrix_world = Matrix.Rotation(-pi / 2, 4, 'Z') @ armature.matrix_world
    bpy.context.view_layer.update()


def configure_vrm(armature, name, version):
    extension = armature.data.vrm_addon_extension
    extension.spec_version = '1.0'
    vrm = extension.vrm1
    names = {'hips': 'Hips', 'spine': 'Spine', 'chest': 'Spine1',
             'upperChest': 'Spine2', 'neck': 'Neck', 'head': 'Head'}
    limbs = {'Shoulder': 'Shoulder', 'UpperArm': 'Arm', 'LowerArm': 'ForeArm',
             'Hand': 'Hand', 'UpperLeg': 'UpLeg', 'LowerLeg': 'Leg', 'Foot': 'Foot', 'Toes': 'ToeBase'}
    for side in ('Left', 'Right'):
        names.update({side.lower() + key: side + value for key, value in limbs.items()})
    for human_bone, mapping in vrm.humanoid.human_bones.human_bone_name_to_human_bone().items():
        if human_bone.value in names:
            bone_name = 'mixamorig:' + names[human_bone.value]
            if bone_name not in armature.data.bones:
                raise ValueError(f'Avatar rig is missing {bone_name}')
            mapping.node.bone_name = bone_name

    vrm.meta.vrm_name = name
    vrm.meta.version = version
    vrm.meta.authors.add().value = 'ApprenTice (model source)'
    vrm.meta.authors.add().value = 'ZipZipPipe (character design)'
    if name == 'DeepSeek':
        vrm.meta.authors.add().value = '上善无形 (original whale girl design)'
    vrm.meta.authors.add().value = 'VA contributors (VRM adaptation)'
    vrm.meta.references.add().value = 'https://www.aplaybox.com/details/model/3uR3BbUTlkUW'
    vrm.meta.references.add().value = 'https://www.bilibili.com/video/BV1tE9XBbErS/'
    vrm.meta.other_license_url = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
    vrm.meta.avatar_permission = 'everyone'
    vrm.meta.commercial_usage = 'personalNonProfit'
    vrm.meta.credit_notation = 'required'
    vrm.meta.allow_redistribution = True
    vrm.meta.modification = 'allowModificationRedistribution'
    return vrm


def export_vrm(armature, output):
    with TemporaryDirectory(dir=output.parent) as stage:
        exported = Path(stage) / output.name
        result = bpy.ops.export_scene.vrm(filepath=str(exported), armature_object_name=armature.name,
                                         export_only_selections=True)
        if 'FINISHED' not in result or not exported.is_file():
            raise RuntimeError('VRM export failed')
        os.link(exported, output)
    print(output)
