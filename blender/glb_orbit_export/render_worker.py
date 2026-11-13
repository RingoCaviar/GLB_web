# SPDX-License-Identifier: GPL-3.0-or-later

import json
import os
from pathlib import Path
import sys
import time

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from framing import OrbitFraming, apply_camera_framing
from sequence import frame_filename
from turntable import ObjectTurntable


def configure_output(scene, job):
    render = scene.render
    width, height = job['width'], job['height']
    if job['mode'] == 'preview' and max(width, height) > 640:
        scale = 640 / max(width, height)
        width, height = max(4, round(width * scale)), max(4, round(height * scale))

    render.resolution_x = width
    render.resolution_y = height
    render.resolution_percentage = 100
    # Preview downscaling rounds to whole pixels. Keep the output frustum exact.
    aspect_correction = (job['width'] * height) / (job['height'] * width)
    render.pixel_aspect_x = max(1.0, aspect_correction)
    render.pixel_aspect_y = max(1.0, 1.0 / aspect_correction)
    render.use_border = False
    render.use_crop_to_border = False
    render.use_sequencer = False
    render.use_file_extension = True
    # Blender preserves compatible channel settings and bit depth when changing formats.
    render.image_settings.media_type = 'IMAGE'
    render.image_settings.file_format = 'PNG'


def mute_compositor_file_outputs(node_tree):
    # Each orbit view shares the same timeline frame. File Output nodes could overwrite
    # unrelated files on every view; the compositor's Group Output still supplies the PNG.
    pending = [node_tree]
    visited = set()
    while pending:
        tree = pending.pop()
        if tree in visited:
            continue
        visited.add(tree)
        for node in tree.nodes:
            if node.bl_idname == 'CompositorNodeOutputFile':
                node.mute = True
            elif (child := getattr(node, 'node_tree', None)) is not None:
                pending.append(child)


def create_camera(scene):
    data = bpy.data.cameras.new('GLB 360° Camera')
    camera = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(camera)
    for marker in scene.timeline_markers:
        marker.camera = None
    scene.camera = camera

    return camera


def render_job(job, report):
    preview = job['mode'] == 'preview'
    angles = job['angles']
    frame_count = job['frame_count']
    if preview:
        angle = job['preview_angle']
        frame = job['preview_frame']
        if angle not in angles or frame not in range(1, frame_count + 1):
            raise ValueError('所选预览画面已不在当前序列中。')
        views = ((angle, frame),)
    else:
        views = ((angle, frame) for angle in angles for frame in range(1, frame_count + 1))
    report(message='正在取景…')

    scene = bpy.data.scenes.get(job['scene'])
    if scene is None:
        raise ValueError('找不到要渲染的场景。')
    view_layer = scene.view_layers.get(job['view_layer'])
    if view_layer is None:
        raise ValueError('找不到要渲染的视图层。')
    window = bpy.context.window
    window.scene = scene
    window.view_layer = view_layer
    framing = OrbitFraming(**job['framing'])
    configure_output(scene, job)
    render_layer = view_layer.name
    if scene.render.use_compositing and scene.compositing_node_group is not None:
        mute_compositor_file_outputs(scene.compositing_node_group)
        # Let Blender resolve the compositor's render layers and referenced scenes.
        render_layer = ''
    camera = create_camera(scene)
    stage = Path(job['stage'])
    turntable = None
    if job.get('motion_mode', 'CAMERA') == 'OBJECT':
        target = view_layer.objects.get(job['target'])
        turntable = ObjectTurntable(scene, target, framing.center, bpy.context.evaluated_depsgraph_get())

    if scene.animation_data is not None:
        for driver in scene.animation_data.drivers:
            if driver.data_path == 'render.use_multiview':
                driver.mute = True

    def enforce_single_view(render_scene, depsgraph):
        if render_scene == scene and depsgraph.mode == 'RENDER':
            # A render can reapply animated multiview while evaluating the current frame.
            scene.render.use_multiview = False

    frame_handlers = bpy.app.handlers.frame_change_post
    frame_handlers.append(enforce_single_view)
    try:
        completed = 0
        for angle, frame in views:
            apply_camera_framing(camera, framing, angle, 1 if turntable else frame, frame_count)
            if turntable is not None:
                turntable.set_frame(frame, frame_count)
            filename = 'preview.png' if preview else frame_filename(job['product'], angle, frame)
            destination = stage / filename
            scene.render.filepath = str(destination)
            report(completed=completed, message=f'俯角 {angle:g}° · 第 {frame} 帧')
            scene.render.use_multiview = False
            result = bpy.ops.render.render(write_still=True, scene=scene.name, layer=render_layer)
            if 'FINISHED' not in result or not destination.is_file() or destination.stat().st_size == 0:
                raise RuntimeError(f'渲染未生成图片：{filename}')
            completed += 1
        report(completed=completed)
    finally:
        frame_handlers.remove(enforce_single_view)


def write_status(path, status):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(status, ensure_ascii=False), encoding='utf-8')
    for attempt in range(5):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.02)


def main(job_path):
    status_path = job_path.with_name('status.json')
    status = {'completed': 0}

    def report(**changes):
        status.update(changes)
        write_status(status_path, status)

    try:
        job = json.loads(job_path.read_text(encoding='utf-8'))
        render_job(job, report)
    except Exception as error:
        try:
            report(error=str(error))
        except OSError:
            pass
        raise


if __name__ == '__main__':
    main(Path(sys.argv[sys.argv.index('--') + 1]))
