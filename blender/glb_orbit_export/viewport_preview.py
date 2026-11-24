# SPDX-License-Identifier: GPL-3.0-or-later

from dataclasses import dataclass

import bpy

from .rig import preview_collection, restore_view_state
from .turntable import ObjectTurntable


@dataclass
class ObjectPreview:
    turntable: ObjectTurntable
    camera: bpy.types.Object
    view_layer: bpy.types.ViewLayer
    scene_uid: int
    source_uid: int
    center: tuple
    window_pointer: int = 0
    area_pointer: int = 0
    space_pointer: int = 0

    def in_view(self):
        for window in bpy.context.window_manager.windows:
            if window.as_pointer() != self.window_pointer:
                continue
            if window.scene.session_uid != self.scene_uid or window.view_layer != self.view_layer:
                return False
            for area in window.screen.areas:
                if area.as_pointer() != self.area_pointer or area.type != 'VIEW_3D':
                    continue
                space = area.spaces.active
                return (space.as_pointer() == self.space_pointer and space.region_3d is not None
                        and space.use_local_camera and space.region_3d.view_perspective == 'CAMERA'
                        and space.camera == self.camera)
        return False


_object_preview = None


def end_object_preview():
    global _object_preview
    preview, _object_preview = _object_preview, None
    if preview is None:
        return False
    preview.turntable.close()
    if preview.space_pointer:
        restore_view_state(preview.space_pointer)
    try:
        preview.view_layer.update()
    except (ReferenceError, RuntimeError):
        pass  # Blender may be replacing the view layer during cleanup.
    return True


def watch_object_preview():
    preview = _object_preview
    if preview is None:
        return None
    try:
        if preview.turntable.active and preview.in_view():
            return 0.25
    except ReferenceError:
        pass
    end_object_preview()
    return None


def pose_object_preview(context, source, camera, center, frame, frame_count):
    global _object_preview
    scene = context.scene
    area = context.area if context.area and context.area.type == 'VIEW_3D' else None
    if area is None and not bpy.app.background:
        raise ValueError('请从 3D 视图启动转物体预览。')
    area_pointer = area.as_pointer() if area else 0
    preview = _object_preview
    if preview is not None and (
        not preview.turntable.active or preview.scene_uid != scene.session_uid
        or preview.source_uid != source.session_uid or preview.center != center
        or preview.area_pointer != area_pointer or preview.view_layer != context.view_layer
        or preview.camera != camera
    ):
        end_object_preview()
        preview = None
    if preview is None:
        turntable = ObjectTurntable(
            scene, source, center, context.evaluated_depsgraph_get(),
            collection=preview_collection(scene), temporary=True,
        )
        preview = ObjectPreview(turntable, camera, context.view_layer, scene.session_uid, source.session_uid, center)
        if area is not None:
            preview.window_pointer = context.window.as_pointer()
            preview.area_pointer = area_pointer
            preview.space_pointer = area.spaces.active.as_pointer()
        _object_preview = preview
        if area is not None and not bpy.app.background and not bpy.app.timers.is_registered(watch_object_preview):
            bpy.app.timers.register(watch_object_preview, first_interval=0.25)
    preview.turntable.set_frame(frame, frame_count)
