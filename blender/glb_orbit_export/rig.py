# SPDX-License-Identifier: GPL-3.0-or-later

import json
from dataclasses import asdict, dataclass

import bpy

from .framing import apply_camera_framing, framing_from_camera, initial_framing


_ROLE = "glb_web_orbit_role"
_TRACK_NAME = "GLB Web 目标点"
_CYCLES_CAMERA_OVERRIDE = "glb_web_cycles_camera_override"
_CYCLES_LOCAL_CAMERA_BUG = bpy.app.version[:2] == (5, 1)


def _owned(item, role):
    return item is not None and item.library is None and item.get(_ROLE) == role


def _collection(parent, role, name):
    for child in parent.children:
        if _owned(child, role):
            return child
    child = bpy.data.collections.new(name)
    child[_ROLE] = role
    parent.children.link(child)
    return child


def _rig_collection(scene, role, name):
    root = _collection(scene.collection, "root", "GLB Web · 360°")
    return _collection(root, role, name)


def _rig_object(obj, role, obj_type):
    return _owned(obj, role) and obj.type == obj_type


def _find_object(collection, pointer, role, obj_type):
    if _rig_object(pointer, role, obj_type):
        return pointer
    return next((obj for obj in collection.objects if _rig_object(obj, role, obj_type)), None)


def _new_camera(name, role):
    data = bpy.data.cameras.new(name)
    camera = bpy.data.objects.new(name, data)
    camera[_ROLE] = role
    return camera


def _link_object(collection, obj):
    if collection.objects.get(obj.name) != obj:
        collection.objects.link(obj)


def _track_target(camera, point):
    constraint = camera.constraints.get(_TRACK_NAME)
    if constraint is None or constraint.type != "TRACK_TO":
        constraint = camera.constraints.new("TRACK_TO")
        constraint.name = _TRACK_NAME
    constraint.target = point
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"


def get_framing_setup(settings, source=None):
    source = source or settings.target or settings.framing_source
    if source is None:
        return None
    for setup in settings.framings:
        if setup.framing_source == source:
            return setup
    if settings.framing_source == source:
        return settings
    return None


def is_framing_target(obj):
    return _owned(obj, "rig_target")


def _scene_rig_object(scene, obj, role, obj_type):
    if _rig_object(obj, role, obj_type) and scene.objects.get(obj.name) == obj:
        return obj
    return None


def get_rig(setup):
    if setup is None:
        return None
    scene = setup.id_data
    camera = _scene_rig_object(scene, setup.rig_camera, "rig_camera", "CAMERA")
    point = _scene_rig_object(scene, setup.rig_target, "rig_target", "EMPTY")
    return (camera, point) if camera is not None and point is not None else None


def current_framing(setup, depsgraph):
    pair = get_rig(setup)
    if pair is None:
        raise ValueError("请先添加取景相机和目标点。")
    source = setup.framing_source
    objects = depsgraph.view_layer.objects
    if source is None or objects.get(source.name) != source:
        raise ValueError("请在当前视图层显示拍摄对象，或为当前产品重新取景。")
    camera, point = pair
    if objects.get(camera.name) != camera or objects.get(point.name) != point:
        raise ValueError("请在当前视图层显示取景集合。")
    return framing_from_camera(camera, point, depsgraph)


def confirmed_framing(setup, depsgraph):
    if setup is None:
        raise ValueError("请先为当前产品添加取景相机。")
    if setup.reframing:
        raise ValueError("正在重新取景，请先确认新构图。")
    if not setup.confirmed_framing:
        raise ValueError("请先确认取景，再预览或渲染序列。")
    framing = current_framing(setup, depsgraph)
    values = asdict(framing)
    values["center"] = list(framing.center)
    try:
        confirmed = json.loads(setup.confirmed_framing)
    except ValueError:
        confirmed = None
    if values != confirmed:
        raise ValueError("相机或目标点已调整，请重新确认取景。")
    return framing


def ensure_rig(context, settings, target, pitch, *, reset=False):
    setup = get_framing_setup(settings, target)
    existing = get_rig(setup)
    if existing is not None and not reset:
        return existing

    source = target or (setup.framing_source if setup is not None else None)
    if source is None or context.view_layer.objects.get(source.name) != source:
        raise ValueError("请在当前视图层选择产品物体或其父级。")
    if source.type in {"CAMERA", "LIGHT"} or is_framing_target(source):
        raise ValueError("请选择产品物体或其父级作为拍摄对象。")
    framing = initial_framing(source, context.view_layer, settings.width, settings.height)
    scene = context.scene
    collection = _rig_collection(scene, "framing", "取景")

    camera = point = None
    if setup is not None:
        camera = _scene_rig_object(scene, setup.rig_camera, "rig_camera", "CAMERA")
        point = _scene_rig_object(scene, setup.rig_target, "rig_target", "EMPTY")
    if camera is None:
        camera = _new_camera(f"取景相机 · {source.name}", "rig_camera")
        camera.data.display_size = framing.distance * 0.12
    apply_camera_framing(camera, framing, pitch, 1, 1)

    if point is None:
        point = bpy.data.objects.new(f"目标点 · {source.name}", None)
        point[_ROLE] = "rig_target"
        point.empty_display_type = "SPHERE"
        point.empty_display_size = framing.distance * 0.035
        point.location = framing.center
    else:
        transform = point.matrix_world.copy()
        transform.translation = framing.center
        point.matrix_world = transform

    _link_object(collection, camera)
    _link_object(collection, point)
    _track_target(camera, point)
    if setup is None:
        setup = settings.framings.add()
        setup.framing_source = source
    setup.rig_camera = camera
    setup.rig_target = point
    setup.confirmed_framing = ""
    setup.reframing = False
    context.view_layer.update()
    return camera, point


def preview_collection(scene):
    return _rig_collection(scene, "preview", "预览")


def ensure_preview_camera(context, settings):
    camera = settings.preview_camera
    if _rig_object(camera, "preview_camera", "CAMERA") and context.scene.objects.get(camera.name) == camera:
        return camera
    collection = preview_collection(context.scene)
    camera = _find_object(collection, camera, "preview_camera", "CAMERA")
    if camera is None:
        camera = _new_camera("预览相机", "preview_camera")
        camera.data.display_size = 0.12
        camera.data.passepartout_alpha = 0.8
        camera.hide_select = True
    _link_object(collection, camera)
    settings.preview_camera = camera
    return camera


@dataclass
class _ViewState:
    space: bpy.types.SpaceView3D
    local_camera: bool
    camera: bpy.types.Object | None
    perspective: str
    lock_camera: bool
    offset: tuple[float, float]
    zoom: float

    def restore(self):
        space = self.space
        try:
            region = space.region_3d
        except ReferenceError:
            return
        try:
            space.camera = self.camera
        except ReferenceError:
            space.camera = None
        space.use_local_camera = self.local_camera
        space.lock_camera = self.lock_camera
        if region is not None:
            region.view_camera_offset = self.offset
            region.view_camera_zoom = self.zoom
            region.view_perspective = self.perspective


_view_states = {}


def _viewport(context):
    area = context.area
    if area is None or area.type != "VIEW_3D":
        return None
    space = area.spaces.active
    return space if space.region_3d is not None else None


def _saved_camera_view(space):
    return (
        space.use_local_camera and space.region_3d.view_perspective == "CAMERA"
        and (_owned(space.camera, "rig_camera") or _owned(space.camera, "preview_camera"))
    )


def restore_cycles_camera(scene):
    override = scene.get(_CYCLES_CAMERA_OVERRIDE)
    if override is None:
        return
    if scene.camera == override.get("preview"):
        scene.camera = override.get("original")
    del scene[_CYCLES_CAMERA_OVERRIDE]


def clear_cycles_cameras():
    for scene in bpy.data.scenes:
        restore_cycles_camera(scene)


def sync_cycles_cameras():
    if not _CYCLES_LOCAL_CAMERA_BUG:
        return None

    # Cycles 5.1 uses the scene camera optics with the local camera's view matrix.
    # Keep the original camera in the undo snapshot so undo/redo can recover it.
    desired = {}
    if not bpy.app.is_job_running("RENDER"):
        for window in bpy.context.window_manager.windows:
            if window.scene.render.engine != "CYCLES":
                continue
            for area in window.screen.areas:
                if area.type != "VIEW_3D":
                    continue
                space = area.spaces.active
                if (space.as_pointer() in _view_states and space.region_3d is not None
                        and space.shading.type == "RENDERED" and _saved_camera_view(space)):
                    desired[window.scene] = space.camera

    for scene in bpy.data.scenes:
        camera = desired.get(scene)
        if camera is None:
            restore_cycles_camera(scene)
        elif camera != scene.camera:
            override = scene.get(_CYCLES_CAMERA_OVERRIDE)
            if override is not None and scene.camera == override.get("preview"):
                override["preview"] = camera
            else:
                state = {"preview": camera}
                if scene.camera is not None:
                    state["original"] = scene.camera
                scene[_CYCLES_CAMERA_OVERRIDE] = state
            scene.camera = camera
    return 0.15 if _view_states else None


def _leave_saved_camera_view(context, space):
    space.camera = context.scene.camera
    space.use_local_camera = False
    space.region_3d.view_perspective = "PERSP"


def show_camera(context, camera):
    space = _viewport(context)
    if space is None:
        return False
    region = space.region_3d
    key = space.as_pointer()
    if key not in _view_states:
        if _saved_camera_view(space):
            _leave_saved_camera_view(context, space)
        _view_states[key] = _ViewState(
            space, space.use_local_camera, space.camera, region.view_perspective,
            space.lock_camera, tuple(region.view_camera_offset), region.view_camera_zoom,
        )
        region.view_camera_offset = (0.0, 0.0)
        region.view_camera_zoom = 0.0
    space.use_local_camera = True
    space.camera = camera
    space.lock_camera = False
    region.view_perspective = "CAMERA"
    if sync_cycles_cameras() is not None and not bpy.app.background:
        if not bpy.app.timers.is_registered(sync_cycles_cameras):
            bpy.app.timers.register(sync_cycles_cameras, first_interval=0.15)
    context.area.tag_redraw()
    return True


def is_view_active(context):
    space = _viewport(context)
    return space is not None and (space.as_pointer() in _view_states or _saved_camera_view(space))


def restore_view(context):
    space = _viewport(context)
    if space is None:
        return False
    if restore_view_state(space.as_pointer()):
        context.area.tag_redraw()
        return True
    if _saved_camera_view(space):
        _leave_saved_camera_view(context, space)
    else:
        return False
    context.area.tag_redraw()
    return True


def restore_view_state(space_pointer):
    state = _view_states.pop(space_pointer, None)
    if state is None:
        return False
    state.restore()
    sync_cycles_cameras()
    return True


def clear_view_state():
    clear_cycles_cameras()
    for state in _view_states.values():
        state.restore()
    _view_states.clear()


def select_rig_object(context, obj):
    if context.mode != "OBJECT":
        raise ValueError("请切换到物体模式后调整取景相机或目标点。")
    layer = context.view_layer
    if layer.objects.get(obj.name) != obj or not obj.visible_get(view_layer=layer, viewport=_viewport(context)):
        raise ValueError("请先在当前视图层显示取景集合。")
    obj.select_set(True, view_layer=layer)
    if not obj.select_get(view_layer=layer):
        raise ValueError("请允许在当前视图层选中取景对象。")
    for other in context.selected_objects:
        if other != obj:
            other.select_set(False, view_layer=layer)
    layer.objects.active = obj
    restore_view(context)
