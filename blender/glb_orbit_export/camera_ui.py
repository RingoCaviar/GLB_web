# SPDX-License-Identifier: GPL-3.0-or-later

import json
import math
from dataclasses import asdict

import bpy
from bpy.props import BoolProperty, EnumProperty, IntProperty
from bpy.types import Menu, Operator

from .framing import apply_camera_framing, is_framed, target_bounds
from .rig import (
    confirmed_framing, current_framing, ensure_preview_camera, ensure_rig, get_framing_setup, get_rig,
    is_framing_target, is_view_active, restore_view, select_rig_object, show_camera,
)
from .sequence import MAX_ANGLES, format_angle, parse_angles, select_pose
from .sequence_help import MOTION_LABELS, MOTION_NOTES, draw_notes
from .viewport_preview import end_object_preview, pose_object_preview


_last_inspection = None


def clear_inspection():
    global _last_inspection
    _last_inspection = None


def change_product(settings, context):
    end_object_preview()
    clear_inspection()
    if context.scene == settings.id_data:
        restore_view(context)


def is_inspection_active(context, settings):
    space = context.space_data
    return (
        settings.preview_camera is not None and space is not None and space.type == "VIEW_3D"
        and space.region_3d is not None and space.use_local_camera
        and space.region_3d.view_perspective == "CAMERA" and space.camera == settings.preview_camera
    )


def change_motion_mode(settings, context):
    inspecting = context.scene == settings.id_data and is_inspection_active(context, settings)
    end_object_preview()
    clear_inspection()
    if not inspecting:
        return
    try:
        angles = parse_angles(settings.angles)
        angle_index, frame = inspection_indices(settings, angles)
        bpy.ops.glb_orbit.inspect_view(angle_index=angle_index, frame_number=frame)
    except (ValueError, RuntimeError):
        restore_view(context)


def active_target(context, settings):
    if settings.target is not None:
        return settings.target
    target = context.active_object
    if target and target.type not in {"CAMERA", "LIGHT"} and not is_framing_target(target) and target.select_get():
        return target
    return None


def inspection_indices(settings, angles):
    return min(settings.inspect_angle_index, len(angles) - 1), min(settings.inspect_frame_number, settings.frame_count)


def inspection_key(scene, settings, pitch, frame):
    setup = get_framing_setup(settings)
    return (
        scene.session_uid, scene.frame_current, scene.frame_subframe, pitch, frame,
        settings.frame_count, settings.width, settings.height, setup.framing_source.session_uid,
        setup.confirmed_framing, settings.motion_mode,
    )


class GLB_ORBIT_OT_add_rig(Operator):
    bl_idname = "glb_orbit.add_rig"
    bl_label = "添加取景相机"
    bl_description = "自动给产品建立起始取景，之后可移动相机和目标点"
    bl_options = {"INTERNAL", "UNDO"}

    reset: BoolProperty(default=False, options={"SKIP_SAVE"})

    def invoke(self, context, _event):
        title = "为此产品重新取景" if self.reset else self.bl_label
        return context.window_manager.invoke_props_dialog(self, width=380, title=title, confirm_text=title)

    def draw(self, _context):
        action = "重设相机和目标点，并清除原取景确认。" if self.reset else "按产品边界放置取景相机和目标点。"
        draw_notes(
            self.layout, action,
            "用「选中相机」或「选中目标点」，按 G 调整。",
            "查看相机取景，满意后点击「确认取景」。",
        )

    def execute(self, context):
        end_object_preview()
        settings = context.scene.glb_orbit_export
        target = active_target(context, settings)
        try:
            angles = parse_angles(settings.angles)
        except ValueError:
            angles = (5.0,)
        pitch = min(angles, key=lambda value: (abs(value - 5), value))
        try:
            rig = ensure_rig(context, settings, target, pitch, reset=self.reset)
        except (RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        if target is not None and settings.target != target:
            settings.target = target
        clear_inspection()
        show_camera(context, rig[0])
        return {"FINISHED"}


class GLB_ORBIT_OT_rig_view(Operator):
    bl_idname = "glb_orbit.rig_view"
    bl_label = "操作取景相机"
    bl_options = {"INTERNAL"}

    action: EnumProperty(items=(
        ("CAMERA", "选中相机", "选中取景相机，可按 G 移动"),
        ("TARGET", "选中目标点", "选中目标点，可按 G 移动"),
        ("VIEW", "查看相机取景", "通过取景相机查看当前构图"),
    ), options={"SKIP_SAVE"})

    def execute(self, context):
        end_object_preview()
        rig = get_rig(get_framing_setup(context.scene.glb_orbit_export))
        if rig is None:
            return {"CANCELLED"}
        camera, target = rig
        try:
            if self.action == "VIEW":
                show_camera(context, camera)
            else:
                select_rig_object(context, camera if self.action == "CAMERA" else target)
        except (RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        return {"FINISHED"}


class GLB_ORBIT_OT_reframe(Operator):
    bl_idname = "glb_orbit.reframe"
    bl_label = "重新取景"
    bl_description = "从现有构图开始，调整取景相机和目标点后再次确认"
    bl_options = {"INTERNAL", "UNDO"}

    def execute(self, context):
        end_object_preview()
        setup = get_framing_setup(context.scene.glb_orbit_export)
        try:
            context.view_layer.update()
            confirmed_framing(setup, context.evaluated_depsgraph_get())
            show_camera(context, setup.rig_camera)
        except (RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        setup.reframing = True
        clear_inspection()
        return {"FINISHED"}


class GLB_ORBIT_OT_confirm_framing(Operator):
    bl_idname = "glb_orbit.confirm_framing"
    bl_label = "确认取景"
    bl_description = "记录相机到目标点的距离、起始方位和镜头设置，用于整组序列"
    bl_options = {"INTERNAL", "UNDO"}

    def invoke(self, context, _event):
        return context.window_manager.invoke_props_dialog(
            self, width=380, title=self.bl_label, confirm_text="记录取景",
        )

    def draw(self, _context):
        draw_notes(
            self.layout,
            "目标点是 360° 旋转的中心。",
            "记录当前相机距离、起始方位和镜头设置。",
            "调整相机或目标点后，可以重新确认。",
        )

    def execute(self, context):
        end_object_preview()
        settings = context.scene.glb_orbit_export
        setup = get_framing_setup(settings)
        try:
            context.view_layer.update()
            framing = current_framing(setup, context.evaluated_depsgraph_get())
        except (RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        if not setup.confirmed_framing:
            try:
                angles = parse_angles(settings.angles)
                settings.inspect_angle_index = min(range(len(angles)), key=lambda index: (abs(angles[index] - 5), angles[index]))
            except ValueError:
                settings.inspect_angle_index = 0
            settings.inspect_frame_number = 1
        setup.confirmed_framing = json.dumps(asdict(framing))
        setup.reframing = False
        clear_inspection()
        if settings.preview_camera is not None and getattr(context.space_data, "camera", None) == settings.preview_camera:
            restore_view(context)
        return {"FINISHED"}


class GLB_ORBIT_OT_inspect_view(Operator):
    bl_idname = "glb_orbit.inspect_view"
    bl_label = "视口预览"
    bl_description = "在相机视口中按所选拍摄方式预览当前帧"
    bl_options = {"INTERNAL"}

    angle_index: IntProperty(default=0, min=0, max=MAX_ANGLES - 1, options={"SKIP_SAVE"})
    frame_number: IntProperty(name="帧号", default=1, min=1, max=720, options={"SKIP_SAVE"})
    enter_view: BoolProperty(default=True, options={"SKIP_SAVE"})
    jump: BoolProperty(default=False, options={"SKIP_SAVE"})
    explain: BoolProperty(default=False, options={"SKIP_SAVE"})

    def invoke(self, context, _event):
        if self.jump:
            return context.window_manager.invoke_props_dialog(self, width=320, title="跳转到帧", confirm_text="查看此帧")
        if self.explain:
            return context.window_manager.invoke_props_dialog(self, width=400, title=self.bl_label, confirm_text="进入预览")
        return self.execute(context)

    def draw(self, context):
        settings = context.scene.glb_orbit_export
        if self.jump:
            self.layout.prop(self, "frame_number")
            self.layout.label(text=f"当前俯角的序列帧号，范围 1–{settings.frame_count}")
            return
        draw_notes(
            self.layout,
            f"在 Blender 3D 视图中检查第 {self.frame_number} 帧的构图。",
            f"{MOTION_LABELS[settings.motion_mode]}：{MOTION_NOTES[settings.motion_mode]}",
            "用左右箭头切换帧，点帧号可直接跳转。",
            "再次点击「检查视角」返回原视图。",
            "需要检查最终光照和合成时，点「渲染此帧」。",
        )

    def execute(self, context):
        global _last_inspection
        scene = context.scene
        settings = scene.glb_orbit_export
        setup = get_framing_setup(settings)
        try:
            pitch, frame = select_pose(parse_angles(settings.angles), settings.frame_count, self.angle_index, self.frame_number)
            if not self.enter_view and not is_inspection_active(context, settings):
                settings.inspect_angle_index = self.angle_index
                settings.inspect_frame_number = frame
                clear_inspection()
                return {"FINISHED"}
            context.view_layer.update()
            framing = confirmed_framing(setup, context.evaluated_depsgraph_get())
            camera = ensure_preview_camera(context, settings)
            context.view_layer.update()
            if context.view_layer.objects.get(camera.name) != camera:
                raise ValueError("请在当前视图层显示预览集合。")
            if settings.motion_mode == "OBJECT":
                pose_object_preview(context, setup.framing_source, camera, framing.center, frame, settings.frame_count)
                camera_frame = 1
            else:
                end_object_preview()
                camera_frame = frame
            apply_camera_framing(camera, framing, pitch, camera_frame, settings.frame_count)
            context.view_layer.update()
            show_camera(context, camera)
        except (RuntimeError, ValueError) as error:
            end_object_preview()
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        try:
            points = target_bounds(setup.framing_source, context.view_layer)
            coverage = is_framed(camera, points, context.evaluated_depsgraph_get(), settings.width, settings.height)
        except ValueError:
            coverage = None
        settings.inspect_angle_index = self.angle_index
        settings.inspect_frame_number = frame
        _last_inspection = (inspection_key(scene, settings, pitch, frame), coverage)
        return {"FINISHED"}


class GLB_ORBIT_OT_exit_view(Operator):
    bl_idname = "glb_orbit.exit_view"
    bl_label = "退出相机视图"
    bl_options = {"INTERNAL"}

    def execute(self, context):
        end_object_preview()
        restore_view(context)
        clear_inspection()
        return {"FINISHED"}


def view_button(layout, angle_index, frame, text, icon="NONE", *, jump=False, enter_view=False, explain=False):
    action = layout.operator(GLB_ORBIT_OT_inspect_view.bl_idname, text=text, icon=icon)
    action.angle_index = angle_index
    action.frame_number = frame
    action.enter_view = enter_view
    action.jump = jump
    action.explain = explain


class GLB_ORBIT_MT_angles(Menu):
    bl_idname = "GLB_ORBIT_MT_angles"
    bl_label = "选择俯角"

    def draw(self, context):
        settings = context.scene.glb_orbit_export
        try:
            angles = parse_angles(settings.angles)
        except ValueError:
            return
        _, frame = inspection_indices(settings, angles)
        for index, pitch in enumerate(angles):
            view_button(self.layout, index, frame, f"{format_angle(pitch)}°")


def draw_rig(layout, context, settings):
    layout.operator_context = "INVOKE_DEFAULT"
    layout.label(text="取景相机", icon="OUTLINER_OB_CAMERA")
    layout.prop(settings, "target", text="产品")
    if is_view_active(context):
        layout.operator(GLB_ORBIT_OT_exit_view.bl_idname, icon="LOOP_BACK")
    setup = get_framing_setup(settings)
    if get_rig(setup) is None:
        if settings.target is None:
            layout.label(text="可使用当前选中的产品", icon="INFO")
        layout.operator(GLB_ORBIT_OT_add_rig.bl_idname, icon="ADD").reset = False
        return False

    parts = layout.row(align=True)
    parts.operator(GLB_ORBIT_OT_rig_view.bl_idname, text="选中相机", icon="CAMERA_DATA").action = "CAMERA"
    parts.operator(GLB_ORBIT_OT_rig_view.bl_idname, text="选中目标点", icon="EMPTY_DATA").action = "TARGET"
    layout.operator(GLB_ORBIT_OT_rig_view.bl_idname, text="查看相机取景", icon="VIEW_CAMERA").action = "VIEW"
    try:
        confirmed_framing(setup, context.evaluated_depsgraph_get())
    except (RuntimeError, ValueError):
        if setup.reframing:
            layout.label(text="正在重新取景", icon="INFO")
        if setup.reframing or not setup.confirmed_framing:
            layout.label(text="按 G 移动相机或目标点", icon="INFO")
        text = "重新确认取景" if setup.confirmed_framing and not setup.reframing else "确认取景"
        layout.operator(GLB_ORBIT_OT_confirm_framing.bl_idname, text=text, icon="CHECKMARK")
        return False
    status = layout.row(align=True)
    status.label(text="已确认取景", icon="CHECKMARK")
    status.operator(GLB_ORBIT_OT_reframe.bl_idname, icon="FILE_REFRESH")
    return True


def draw_inspection(layout, context, settings, angles):
    layout.operator_context = "INVOKE_DEFAULT"
    angle_index, frame = inspection_indices(settings, angles)
    pitch = angles[angle_index]
    count = settings.frame_count
    inspecting = is_inspection_active(context, settings)
    if inspecting:
        layout.operator(GLB_ORBIT_OT_exit_view.bl_idname, text="检查视角 · 已开启", icon="HIDE_OFF", depress=True)
    else:
        view_button(layout, angle_index, frame, "检查视角 · 已关闭", "HIDE_ON", enter_view=True, explain=True)
    layout.menu(GLB_ORBIT_MT_angles.bl_idname, text=f"俯角 {format_angle(pitch)}°")
    navigation = layout.row(align=True)
    index = angle_index * count + frame - 1
    previous_ring, previous_offset = divmod((index - 1) % (count * len(angles)), count)
    next_ring, next_offset = divmod((index + 1) % (count * len(angles)), count)
    view_button(navigation, previous_ring, previous_offset + 1, "", "TRIA_LEFT")
    view_button(navigation, angle_index, frame, f"第 {frame} / {count} 帧", jump=True)
    view_button(navigation, next_ring, next_offset + 1, "", "TRIA_RIGHT")
    render = layout.operator("glb_orbit.render_sequence", text="渲染此帧", icon="RENDER_STILL")
    render.preview = True
    render.angle_index = angle_index
    render.frame_number = frame

    key = inspection_key(context.scene, settings, pitch, frame)
    if _last_inspection and _last_inspection[0] == key:
        coverage = _last_inspection[1]
        if coverage is None:
            layout.label(text="无法读取产品边界", icon="INFO")
        elif coverage:
            layout.label(text="上次检查在画幅内", icon="CHECKMARK")
        else:
            layout.label(text="此角度可能裁切产品", icon="ERROR")
    elif inspecting:
        view_button(layout, angle_index, frame, "刷新当前视角", "FILE_REFRESH")
    scene_render = context.scene.render
    scene_aspect = scene_render.resolution_x * scene_render.pixel_aspect_x / (scene_render.resolution_y * scene_render.pixel_aspect_y)
    if not math.isclose(scene_aspect, settings.width / settings.height, rel_tol=0.001):
        layout.label(text="用「渲染此帧」核对画幅", icon="INFO")


CAMERA_CLASSES = (
    GLB_ORBIT_OT_add_rig, GLB_ORBIT_OT_rig_view, GLB_ORBIT_OT_reframe, GLB_ORBIT_OT_confirm_framing,
    GLB_ORBIT_OT_inspect_view, GLB_ORBIT_OT_exit_view, GLB_ORBIT_MT_angles,
)
