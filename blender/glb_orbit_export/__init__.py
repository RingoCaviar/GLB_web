# SPDX-License-Identifier: GPL-3.0-or-later

import atexit
import shutil
import textwrap
from dataclasses import dataclass
from pathlib import Path

import bpy
import bpy.utils.previews
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, CollectionProperty, EnumProperty, IntProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup

from .camera_ui import CAMERA_CLASSES, change_motion_mode, change_product, clear_inspection, draw_inspection, draw_rig
from .jobs import start_job
from .rig import clear_cycles_cameras, clear_view_state, restore_cycles_camera, sync_cycles_cameras
from .sequence import DEFAULT_ANGLES, DEFAULT_FRAMES, MAX_ANGLES, format_angle, parse_angles, select_pose
from .sequence_help import GLB_ORBIT_OT_sequence_help, MOTION_LABELS, draw_notes
from .turntable import clear_saved_turntables
from .viewport_preview import end_object_preview, watch_object_preview


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
def stop_preview(_):
    if end_object_preview():
        clear_inspection()
    clear_cycles_cameras()


@persistent
def recover_preview(_):
    clear_saved_turntables()
    clear_cycles_cameras()


@persistent
def restore_camera_for_render(scene):
    restore_cycles_camera(scene)


@persistent
def reset_on_load(_):
    if bpy.app.timers.is_registered(poll_job):
        bpy.app.timers.unregister(poll_job)
    cleanup_on_exit()
    stop_preview(None)
    clear_view_state()
    clear_inspection()
    _previews.clear()


class GLBOrbitFraming(PropertyGroup):
    framing_source: PointerProperty(type=bpy.types.Object)
    rig_camera: PointerProperty(type=bpy.types.Object)
    rig_target: PointerProperty(type=bpy.types.Object)
    confirmed_framing: StringProperty()
    reframing: BoolProperty(default=False)


class GLBOrbitSettings(PropertyGroup):
    target: PointerProperty(
        name="拍摄对象", type=bpy.types.Object,
        description="切换到此产品的取景相机。添加相机时留空可使用当前选中的活动物体",
        update=change_product,
    )
    motion_mode: EnumProperty(
        name="拍摄方式",
        items=(
            ("CAMERA", MOTION_LABELS["CAMERA"], "产品和灯光留在原位，相机围绕目标点移动"),
            ("OBJECT", MOTION_LABELS["OBJECT"], "每组俯角固定相机方位，产品围绕目标点转动，摄影棚灯光留在原位"),
        ),
        default="CAMERA",
        update=change_motion_mode,
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
    framings: CollectionProperty(type=GLBOrbitFraming)
    preview_camera: PointerProperty(type=bpy.types.Object)
    # The original single-product setup is also readable in older .blend files.
    framing_source: PointerProperty(type=bpy.types.Object)
    rig_camera: PointerProperty(type=bpy.types.Object)
    rig_target: PointerProperty(type=bpy.types.Object)
    confirmed_framing: StringProperty()
    reframing: BoolProperty(default=False)
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

    def invoke(self, context, _event):
        title = "渲染此帧" if self.preview else "渲染完整序列"
        confirm = "渲染预览" if self.preview else "开始渲染"
        return context.window_manager.invoke_props_dialog(self, width=380, title=title, confirm_text=confirm)

    def draw(self, context):
        settings = context.scene.glb_orbit_export
        mode = MOTION_LABELS[settings.motion_mode]
        try:
            angles = parse_angles(settings.angles)
            if self.preview:
                pitch, frame = select_pose(angles, settings.frame_count, self.angle_index, self.frame_number)
                summary = f"{mode} · 俯角 {format_angle(pitch)}° · 第 {frame} 帧"
            else:
                summary = f"{mode} · {len(angles)} 个俯角 × {settings.frame_count} 帧 = {len(angles) * settings.frame_count} 帧"
        except ValueError:
            self.layout.label(text="请检查序列设置。", icon="ERROR")
            return

        self.layout.label(text=summary)
        self.layout.separator()
        if self.preview:
            draw_notes(
                self.layout,
                "使用场景的灯光、材质和合成设置渲染一张。",
                "预览最长边 640 像素，结果显示在插件面板。",
            )
        else:
            draw_notes(
                self.layout,
                f"以 {settings.width} × {settings.height} 输出 PNG。",
                "保存目录下会创建以产品名称命名的文件夹。",
                "后台渲染，可在面板查看进度或取消。",
            )
            if not settings.product_name.strip() or not settings.output_directory.strip():
                self.layout.label(text="请先在「输出」中填写产品名称和保存目录。", icon="INFO")

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
        header = capture.row()
        header.operator_context = "INVOKE_DEFAULT"
        header.label(text="序列设置", icon="RENDER_ANIMATION")
        help_button = header.row()
        help_button.alignment = "RIGHT"
        help_button.operator(GLB_ORBIT_OT_sequence_help.bl_idname, text="", icon="QUESTION")
        modes = capture.row(align=True)
        for mode, label in MOTION_LABELS.items():
            modes.prop_enum(settings, "motion_mode", mode, text=label)
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
        primary.operator_context = "INVOKE_DEFAULT"
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


CLASSES = (
    GLBOrbitFraming, GLBOrbitSettings, *CAMERA_CLASSES, GLB_ORBIT_OT_sequence_help,
    GLB_ORBIT_OT_render_sequence, GLB_ORBIT_OT_cancel, GLB_ORBIT_PT_sequence,
)
HANDLERS = (
    (bpy.app.handlers.load_pre, reset_on_load),
    (bpy.app.handlers.save_pre, stop_preview),
    (bpy.app.handlers.undo_pre, stop_preview),
    (bpy.app.handlers.redo_pre, stop_preview),
    (bpy.app.handlers.render_init, restore_camera_for_render),
    (bpy.app.handlers.load_post, recover_preview),
    (bpy.app.handlers.undo_post, recover_preview),
    (bpy.app.handlers.redo_post, recover_preview),
)


def register():
    global _previews
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.glb_orbit_export = PointerProperty(type=GLBOrbitSettings)
    _previews = bpy.utils.previews.new()
    for handlers, callback in HANDLERS:
        handlers.append(callback)
    bpy.app.timers.register(clear_saved_turntables)
    atexit.register(cleanup_on_exit)


def unregister():
    global _previews
    atexit.unregister(cleanup_on_exit)
    for handlers, callback in HANDLERS:
        handlers.remove(callback)
    for timer in (clear_saved_turntables, watch_object_preview, sync_cycles_cameras):
        if bpy.app.timers.is_registered(timer):
            bpy.app.timers.unregister(timer)
    reset_on_load(None)
    bpy.utils.previews.remove(_previews)
    _previews = None
    del bpy.types.Scene.glb_orbit_export
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
