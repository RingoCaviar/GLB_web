# SPDX-License-Identifier: GPL-3.0-or-later

from bpy.types import Operator


MOTION_LABELS = {"CAMERA": "转相机", "OBJECT": "转物体"}
MOTION_NOTES = {
    "CAMERA": "产品固定，相机围绕目标点拍摄。",
    "OBJECT": "同一俯角内相机固定，产品绕目标点旋转。",
}


def draw_notes(layout, *lines):
    column = layout.column(align=True)
    for line in lines:
        column.label(text=line)


class GLB_ORBIT_OT_sequence_help(Operator):
    bl_idname = "glb_orbit.sequence_help"
    bl_label = "序列设置说明"
    bl_description = "查看两种拍摄方式、俯角和每圈帧数的用法"
    bl_options = {"INTERNAL"}

    def invoke(self, context, _event):
        return context.window_manager.invoke_popup(self, width=380)

    def draw(self, _context):
        self.layout.label(text=self.bl_label, icon="INFO")
        self.layout.separator()
        draw_notes(self.layout, f"转相机：{MOTION_NOTES['CAMERA']}", f"转物体：{MOTION_NOTES['OBJECT']}")
        self.layout.separator()
        draw_notes(
            self.layout,
            "俯角是相机相对水平面的角度，正值向下看。",
            "用逗号输入多个俯角，例如 -10, 5, 30。",
            "每个俯角拍一整圈，帧数越多旋转越细腻。",
        )

    def execute(self, _context):
        return {"FINISHED"}
