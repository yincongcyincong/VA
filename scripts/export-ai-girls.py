"""Export the three Blender-only models in this pack for the VA model gallery."""

import argparse
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import bpy


def export_model(directory):
    source = directory / 'model.blend'
    destination = directory / 'model.glb'
    if destination.exists():
        print(f'Keeping existing GLB for {directory.name}')
        return
    if not source.is_file():
        raise FileNotFoundError(source)

    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False, load_ui=False)
    with TemporaryDirectory(dir=directory) as staging:
        exported = Path(staging) / destination.name
        result = bpy.ops.export_scene.gltf(filepath=str(exported), export_format='GLB',
                                          use_visible=True, use_active_scene=True)
        if 'FINISHED' not in result or not exported.is_file():
            raise RuntimeError(f'GLB export failed for {directory.name}')
        os.link(exported, destination)
    print(f'Exported {directory.name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pack', type=Path, help='Extracted AI Girls pack directory')
    arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    root = parser.parse_args(arguments).pack.resolve()
    if (root / '模型').is_dir():
        root /= '模型'
    for variant in ('01_DeepSeek_V7', '02_Claude_V3', '03_GPT_V2'):
        export_model(root / variant)


if __name__ == '__main__':
    main()
