"""Export the AI Girls DeepSeek V7 Blender model as a local VRM 1.0 avatar."""

import argparse
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vrm_avatar import bake_t_pose, configure_vrm, export_vrm, orient_front



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='01_DeepSeek_V7/model.blend')
    parser.add_argument('output', type=Path, help='Destination VRM file')
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    args = parser.parse_args(arguments)
    source, output = args.source.resolve(), args.output.resolve()
    if output.suffix.lower() != '.vrm' or output.exists():
        raise ValueError('Choose a new .vrm destination')
    if not hasattr(bpy.types.Armature, 'vrm_addon_extension'):
        bpy.ops.preferences.addon_enable(module='io_scene_vrm')

    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False, load_ui=False)
    armature = bpy.context.scene.objects.get('Armature')
    if armature is None or armature.type != 'ARMATURE' or 'mixamorig:Hips' not in armature.pose.bones:
        raise ValueError('Expected the DeepSeek V7 Mixamo armature')
    meshes = [(obj, modifier) for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj.visible_get()
              for modifier in obj.modifiers if modifier.type == 'ARMATURE' and modifier.object == armature]
    if not meshes:
        raise ValueError('No visible mesh uses the DeepSeek armature')
    bake_t_pose(armature, meshes)
    orient_front(armature)
    configure_vrm(armature, 'DeepSeek', 'DeepSeek V7, VA body-motion adaptation')
    for mesh, _ in meshes:
        mesh.select_set(True)

    export_vrm(armature, output)

if __name__ == '__main__':
    main()
