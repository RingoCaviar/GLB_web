# SPDX-License-Identifier: GPL-3.0-or-later

import atexit
import shutil
import textwrap
from dataclasses import dataclass
from pathlib import Path

import bpy
import bpy.utils.previews
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, EnumProperty, IntProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup

from .camera_ui import CAMERA_CLASSES, clear_inspection, draw_inspection, draw_rig
from .jobs import start_job
from .rig import clear_view_state
from .sequence import DEFAULT_ANGLES, DEFAULT_FRAMES, MAX_ANGLES, parse_angles


@dataclass
class RenderResult:
    scene_uid: int
    title: str
    icon: str
    path: Path | None = None
    preview: bool = False
    error: str = ""


_active_job = None
_active_status = {}
_last_result = None
_previews = None


def discard_result():
    global _last_result
    if _last_result and _last_result.preview and _last_result.path:
        shutil.rmtree(_last_result.path.parent, ignore_errors=True)
    _last_result = None


def redraw_panels():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


def finish_job(job):
    try:
        path = job.collect()
        if path is None:
            return RenderResult(job.scene_uid, "渲染已取消", "INFO")
        if job.destination is not None:
            return RenderResult(job.scene_uid, f"已导出 {job.total} 帧 PNG", "CHECKMARK", path)
        if not bpy.app.background:
            try:
                _previews.load("preview_frame", str(path), "IMAGE")
            except (OSError, RuntimeError):
                pass  # The full-size preview can still be opened from disk.
        return RenderResult(job.scene_uid, job.preview_title, "IMAGE_DATA", path, preview=True)
    except (OSError, RuntimeError, ValueError) as error:
        return RenderResult(job.scene_uid, "渲染失败", "ERROR", error=str(error))
    finally:
        job.close()


def poll_job():
    global _active_job, _active_status, _last_result
    if _active_job is None:
        return None
    if _active_job.running():
        _active_status = _active_job.status()
        redraw_panels()
        return 0.35
    _last_result = finish_job(_active_job)
    _active_job = None
    _active_status = {}
    redraw_panels()
    return None


def cleanup_on_exit():
    global _active_job, _active_status
    if _active_job is not None:
        _active_job.close()
        _active_job = None
        _active_status = {}
    discard_result()


@persistent
def reset_on_load(_):
    if bpy.app.timers.is_registered(poll_job):
        bpy.app.timers.unregister(poll_job)
    cleanup_on_exit()
    clear_view_state()
    clear_inspection()
    _previews.clear()


class GLBOrbitSettings(PropertyGroup):
    target: PointerProperty(
        name="拍摄对象", type=bpy.types.Object,
        description="使用此物体及其可渲染子级自动取景。留空时使用当前选中的活动物体",
    )
    motion_mode: EnumProperty(
        name="拍摄方式",
        items=(
            ("CAMERA", "转相机", "产品和灯光留在原位，相机围绕目标点移动"),
            ("OBJECT", "转物体", "每组俯角固定相机方位，产品围绕目标点转动，摄影棚灯光留在原位"),
        ),
        default="CAMERA",
    )
    angles: StringProperty(
        name="俯角（°）", default=DEFAULT_ANGLES,
        description="用逗号分隔多个俯角，例如 5, 15, 30。正值向下看，负值向上看，支持小数",
    )
    frame_count: IntProperty(
        name="每圈帧数", default=DEFAULT_FRAMES, min=2, max=720,
        description="每个俯角绕拍一圈的帧数。所有俯角使用相同的方位间隔",
    )
    product_name: StringProperty(
        name="产品名称", description="用于网页产品名称、输出子目录和 PNG 文件名前缀",
    )
    output_directory: StringProperty(
        name="保存到", subtype="DIR_PATH",
        description="选择 GLB Web 项目根目录、image_sequence 或其中的分类目录",
    )
    width: IntProperty(name="宽", default=1200, min=16, max=8192, soft_max=4096)
    height: IntProperty(name="高", default=1200, min=16, max=8192, soft_max=4096)
    rig_camera: PointerProperty(type=bpy.types.Object)
    rig_target: PointerProperty(type=bpy.types.Object)
    preview_camera: PointerProperty(type=bpy.types.Object)
    framing_source: PointerProperty(type=bpy.types.Object)
    confirmed_framing: StringProperty()
    inspect_angle_index: IntProperty(default=0, min=0, max=MAX_ANGLES - 1)
    inspect_frame_number: IntProperty(default=1, min=1, max=720)


class GLB_ORBIT_OT_render_sequence(Operator):
    bl_idname = "glb_orbit.render_sequence"
    bl_label = "渲染 360° 产品序列"

    preview: BoolProperty(default=False, options={"SKIP_SAVE"})
    angle_index: IntProperty(default=0, min=0, max=MAX_ANGLES - 1, options={"SKIP_SAVE"})
    frame_number: IntProperty(default=1, min=1, max=720, options={"SKIP_SAVE"})

    @classmethod
    def description(cls, _context, properties):
        if properties.preview:
            return "按导出画幅渲染当前选择的俯角和帧，最长边 640 像素"
        return "使用当前场景和视图层，在后台渲染整组 PNG"

    @classmethod
    def poll(cls, context):
        return context.scene is not None and _active_job is None

    def execute(self, context):
        global _active_job, _last_result
        settings = context.scene.glb_orbit_export
        try:
            job = start_job(context.scene, context.view_layer, settings, self.preview, self.angle_index, self.frame_number)
        except (OSError, RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        discard_result()
        _previews.clear()
        if bpy.app.background:
            job.process.wait()
            _last_result = finish_job(job)
            if _last_result.error:
                self.report({"ERROR"}, _last_result.error)
                return {"CANCELLED"}
        else:
            _active_job = job
            bpy.app.timers.register(poll_job, first_interval=0.1)
            redraw_panels()
        return {"FINISHED"}


class GLB_ORBIT_OT_cancel(Operator):
    bl_idname = "glb_orbit.cancel"
    bl_label = "取消渲染"
    bl_description = "停止后台任务并删除此次任务生成的临时帧"

    @classmethod
    def poll(cls, _context):
        return _active_job is not None and _active_job.cancel_deadline is None

    def execute(self, _context):
        _active_job.request_cancel()
        redraw_panels()
        return {"FINISHED"}


class GLB_ORBIT_PT_sequence(Panel):
    bl_label = "360° 产品序列"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "GLB Web"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.glb_orbit_export
        fields = layout.column()
        fields.enabled = _active_job is None
        fields.use_property_decorate = False

        ready = draw_rig(fields.box(), context, settings)

        capture = fields.box()
        capture.label(text="序列设置", icon="RENDER_ANIMATION")
        capture.row(align=True).prop(settings, "motion_mode", text="", expand=True)
        controls = capture.column(align=True)
        controls.use_property_split = True
        controls.prop(settings, "angles")
        controls.prop(settings, "frame_count")
        try:
            angles = parse_angles(settings.angles)
            capture.label(text=f"{len(angles)} 个俯角 · 共 {len(angles) * settings.frame_count} 帧")
        except ValueError:
            angles = ()
            capture.label(text="请检查俯角格式", icon="ERROR")

        output = fields.box()
        output.label(text="输出", icon="OUTPUT")
        product = output.column(align=True)
        product.use_property_split = True
        product.prop(settings, "product_name", placeholder="例如 产品 A")
        output.label(text="保存到")
        output.prop(settings, "output_directory", text="", placeholder="选择输出目录")
        resolution = output.row(align=True)
        resolution.prop(settings, "width")
        resolution.prop(settings, "height")

        if ready and angles:
            draw_inspection(fields.box(), context, settings, angles)

        if _active_job is not None:
            self.draw_progress(layout)
            return

        layout.separator()
        primary = layout.row(align=True)
        primary.enabled = ready and bool(angles)
        primary.scale_y = 1.35
        primary.operator(GLB_ORBIT_OT_render_sequence.bl_idname, text="渲染完整序列", icon="RENDER_ANIMATION").preview = False
        if _last_result and _last_result.scene_uid == context.scene.session_uid:
            self.draw_result(layout, _last_result)

    def draw_progress(self, layout):
        status = layout.box()
        if _active_job.cancel_deadline is not None:
            status.label(text="正在取消渲染…", icon="TIME")
            return
        completed = _active_status.get("completed", 0)
        title = "正在渲染预览" if _active_job.destination is None else "正在渲染序列"
        status.label(text=title, icon="TIME")
        if message := _active_status.get("message"):
            status.label(text=message)
        status.progress(factor=completed / _active_job.total, type="BAR", text=f"{completed} / {_active_job.total} 帧")
        status.operator(GLB_ORBIT_OT_cancel.bl_idname, icon="CANCEL")

    def draw_result(self, layout, result):
        box = layout.box()
        box.label(text=result.title, icon=result.icon)
        if result.error:
            for line in textwrap.wrap(result.error, width=22):
                box.label(text=line)
        if result.path is None:
            return
        if result.preview:
            icon = _previews.get("preview_frame")
            if icon is not None:
                box.template_icon(icon_value=icon.icon_id, scale=5)
            box.operator("wm.path_open", text="打开预览图", icon="IMAGE_DATA").filepath = str(result.path)
        else:
            box.operator("wm.path_open", text="打开产品目录", icon="FILE_FOLDER").filepath = str(result.path)


CLASSES = (GLBOrbitSettings, *CAMERA_CLASSES, GLB_ORBIT_OT_render_sequence, GLB_ORBIT_OT_cancel, GLB_ORBIT_PT_sequence)


def register():
    global _previews
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.glb_orbit_export = PointerProperty(type=GLBOrbitSettings)
    _previews = bpy.utils.previews.new()
    bpy.app.handlers.load_pre.append(reset_on_load)
    atexit.register(cleanup_on_exit)


def unregister():
    global _previews
    atexit.unregister(cleanup_on_exit)
    bpy.app.handlers.load_pre.remove(reset_on_load)
    reset_on_load(None)
    bpy.utils.previews.remove(_previews)
    _previews = None
    del bpy.types.Scene.glb_orbit_export
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
