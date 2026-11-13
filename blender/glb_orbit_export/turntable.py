# SPDX-License-Identifier: GPL-3.0-or-later

"""Apply a turntable pose in the background render scene."""

import math

import bpy
from mathutils import Matrix, Vector


FIXED_TYPES = {'CAMERA', 'LIGHT'}


def add_empty(scene, name):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    return obj


def keep_stationary(scene, identity, obj, matrix):
    # Store the evaluated world matrix without losing shear from scaled ancestors.
    anchor = add_empty(scene, 'GLB 360° Fixed Transform')
    anchor.parent = identity
    anchor.matrix_parent_inverse = matrix
    constraint = obj.constraints.new('COPY_TRANSFORMS')
    constraint.target = anchor
    constraint.owner_space = constraint.target_space = 'WORLD'


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
    def __init__(self, scene, target, center, depsgraph):
        descendants = target.children_recursive if target is not None else ()
        check_product(scene, target, descendants, depsgraph)
        stationary = []
        for obj in descendants:
            if obj.type in FIXED_TYPES:
                if not obj.is_editable:
                    raise ValueError(f'无法固定链接的「{obj.name}」。请将其移出产品层级，或切换到「转相机」。')
                stationary.append((obj, obj.evaluated_get(depsgraph).matrix_world.copy()))

        if stationary:
            identity = add_empty(scene, 'GLB 360° Fixed Transforms')
            for obj, matrix in stationary:
                keep_stationary(scene, identity, obj, matrix)

        self.transform = add_empty(scene, 'GLB 360° Turntable')
        self.to_center = Matrix.Translation(Vector(center))
        self.from_center = self.to_center.inverted()
        constraint = target.constraints.new('CHILD_OF')
        constraint.target = self.transform
        constraint.inverse_matrix = Matrix.Identity(4)
        constraint.owner_space = constraint.target_space = 'WORLD'

    def set_frame(self, frame, frame_count):
        azimuth = -math.tau * (frame - 1) / frame_count
        self.transform.matrix_world = self.to_center @ Matrix.Rotation(azimuth, 4, 'Z') @ self.from_center
