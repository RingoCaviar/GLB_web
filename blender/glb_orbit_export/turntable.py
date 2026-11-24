# SPDX-License-Identifier: GPL-3.0-or-later

"""Apply a reversible turntable pose for viewport previews and rendering."""

import math
from uuid import uuid4

import bpy
from mathutils import Matrix, Vector


FIXED_TYPES = {'CAMERA', 'LIGHT'}
_TEMPORARY_TURNTABLE = '_glb_web_360_temporary_turntable'
_PREVIEW_CONSTRAINT_PREFIX = 'GLB Web Preview '


def clear_saved_turntables():
    """Discard any temporary turntable data restored from a file or undo step."""
    helpers = {
        obj: _PREVIEW_CONSTRAINT_PREFIX + marker
        for obj in bpy.data.objects
        if obj.type == 'EMPTY' and obj.library is None
        and isinstance(marker := obj.get(_TEMPORARY_TURNTABLE), str)
    }
    if not helpers:
        return
    for obj in bpy.data.objects:
        if not obj.is_editable:
            continue
        for constraint in list(obj.constraints):
            if constraint.type in {'CHILD_OF', 'COPY_TRANSFORMS'} and helpers.get(constraint.target) == constraint.name:
                obj.constraints.remove(constraint)
    for helper in helpers:
        bpy.data.objects.remove(helper, do_unlink=True)


def check_product(scene, target, descendants, depsgraph):
    if target is None or target.type in FIXED_TYPES:
        raise ValueError('找不到可旋转的产品。请选择产品物体或其父级。')
    if not target.is_editable:
        raise ValueError('产品物体来自外部链接库。请使用本地实例、设为本地对象，或切换到「转相机」。')

    product = {target, *descendants}
    for item in depsgraph.object_instances:
        if item.is_instance and item.object.type in FIXED_TYPES and item.parent and item.parent.original in product:
            raise ValueError('产品实例内含灯光或相机。请将它们移出实例，或切换到「转相机」。')

    if scene.rigidbody_world is not None and scene.rigidbody_world.enabled:
        for obj in product:
            body = obj.evaluated_get(depsgraph).rigid_body
            if body and body.type == 'ACTIVE' and body.enabled and not body.kinematic:
                raise ValueError(f'「{obj.name}」受活动刚体模拟控制。请先将姿势转成可编辑物体，或切换到「转相机」。')


class ObjectTurntable:
    def __init__(self, scene, target, center, depsgraph, *, collection=None, temporary=False):
        descendants = target.children_recursive if target is not None else ()
        check_product(scene, target, descendants, depsgraph)
        stationary = []
        for obj in descendants:
            if obj.type in FIXED_TYPES:
                if not obj.is_editable:
                    raise ValueError(f'无法固定链接的「{obj.name}」。请将其移出产品层级，或切换到「转相机」。')
                stationary.append((obj, obj.evaluated_get(depsgraph).matrix_world.copy()))

        self.collection = scene.collection if collection is None else collection
        self._temporary_id = uuid4().hex if temporary else None
        self._helpers = []
        self._constraints = []
        self.to_center = Matrix.Translation(Vector(center))
        self.from_center = self.to_center.inverted()
        try:
            if stationary:
                identity = self._add_empty('GLB 360° Fixed Transforms')
                for obj, matrix in stationary:
                    # Preserve the evaluated world matrix, including parent shear.
                    anchor = self._add_empty('GLB 360° Fixed Transform')
                    anchor.parent = identity
                    anchor.matrix_parent_inverse = matrix
                    self._add_constraint(obj, 'COPY_TRANSFORMS', anchor)

            self.transform = self._add_empty('GLB 360° Turntable')
            self._add_constraint(target, 'CHILD_OF', self.transform).inverse_matrix = Matrix.Identity(4)
        except Exception:
            self.close()
            raise

    def _add_empty(self, name):
        obj = bpy.data.objects.new(name, None)
        self._helpers.append(obj)
        if self._temporary_id is not None:
            obj[_TEMPORARY_TURNTABLE] = self._temporary_id
        obj.hide_select = True
        obj.empty_display_size = 0.01
        self.collection.objects.link(obj)
        return obj

    def _add_constraint(self, obj, constraint_type, target):
        constraint = obj.constraints.new(constraint_type)
        self._constraints.append((obj, constraint))
        if self._temporary_id is not None:
            constraint.name = _PREVIEW_CONSTRAINT_PREFIX + self._temporary_id
        constraint.target = target
        constraint.owner_space = constraint.target_space = 'WORLD'
        return constraint

    @property
    def active(self):
        try:
            return bool(self._helpers) and all(obj.name for obj in self._helpers) and all(
                constraint in owner.constraints[:] for owner, constraint in self._constraints
            )
        except ReferenceError:
            return False

    def set_frame(self, frame, frame_count):
        azimuth = -math.tau * (frame - 1) / frame_count
        self.transform.matrix_world = self.to_center @ Matrix.Rotation(azimuth, 4, 'Z') @ self.from_center

    def close(self):
        for owner, constraint in reversed(self._constraints):
            try:
                if constraint in owner.constraints[:]:
                    owner.constraints.remove(constraint)
            except ReferenceError:
                continue
        self._constraints.clear()
        for obj in reversed(self._helpers):
            try:
                bpy.data.objects.remove(obj, do_unlink=True)
            except ReferenceError:
                continue
        self._helpers.clear()
