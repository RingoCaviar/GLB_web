# SPDX-License-Identifier: GPL-3.0-or-later

"""Camera geometry shared by the editing rig, previews and export."""

from dataclasses import dataclass
import math

import bpy
from mathutils import Vector


GEOMETRY_TYPES = {
    'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'VOLUME', 'CURVES',
    'POINTCLOUD', 'GREASEPENCIL',
}
DEFAULT_LENS = 50.0
DEFAULT_SENSOR_WIDTH = 36.0


@dataclass(frozen=True)
class OrbitFraming:
    center: tuple[float, float, float]
    distance: float
    start_azimuth: float
    lens: float = DEFAULT_LENS
    sensor_fit: str = 'AUTO'
    sensor_width: float = DEFAULT_SENSOR_WIDTH
    sensor_height: float = 24.0
    shift_x: float = 0.0
    shift_y: float = 0.0
    clip_start: float = 0.1
    clip_end: float = 1000.0


def renderable_objects(layer_collection):
    collection = layer_collection.collection
    if layer_collection.exclude or collection.hide_render:
        return
    yield from collection.objects
    for child in layer_collection.children:
        yield from renderable_objects(child)


def target_bounds(target, view_layer) -> list[Vector]:
    targets = {target, *target.children_recursive}
    renderable_targets = targets.intersection(
        obj for obj in renderable_objects(view_layer.layer_collection) if not obj.hide_render
    )
    points = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for instance in depsgraph.object_instances:
        obj = instance.object
        owner = instance.parent if instance.is_instance else obj
        if obj is None or owner is None or owner.original not in renderable_targets:
            continue
        if obj.type not in GEOMETRY_TYPES or obj.hide_render or not instance.show_self:
            continue
        bounds = obj.bound_box
        if all(tuple(point) == (-1.0, -1.0, -1.0) for point in bounds):
            continue
        matrix = instance.matrix_world
        points.extend(matrix @ Vector(point) for point in bounds)

    if not points:
        raise ValueError('目标没有可用于取景的几何体。请检查产品及其子物体的可见性。')
    return points


def initial_framing(target, view_layer, width, height) -> OrbitFraming:
    points = target_bounds(target, view_layer)
    center = Vector(tuple(
        (min(point[axis] for point in points) + max(point[axis] for point in points)) / 2
        for axis in range(3)
    ))
    radius = max((point - center).length for point in points)
    if not math.isfinite(radius) or radius <= 0:
        raise ValueError('目标尺寸为零或无效，无法自动取景。')

    # Auto sensor fit uses sensor width on the long edge of the frame.
    short_edge = min(width, height) / max(width, height)
    half_fov = math.atan(short_edge * DEFAULT_SENSOR_WIDTH / (2 * DEFAULT_LENS))
    distance = radius * 1.15 / math.sin(half_fov)
    return OrbitFraming(
        center=tuple(center),
        distance=distance,
        start_azimuth=0.0,
        clip_start=max(1e-6, min(0.1, (distance - radius) * 0.01)),
        clip_end=max(1000.0, distance + radius * 100),
    )


def framing_from_camera(camera, target_point, depsgraph) -> OrbitFraming:
    evaluated = camera.evaluated_get(depsgraph)
    data = evaluated.data
    if data.type != 'PERSP':
        raise ValueError('请将取景相机设为透视相机。')
    center = target_point.evaluated_get(depsgraph).matrix_world.translation
    offset = evaluated.matrix_world.translation - center
    distance = offset.length
    if not all(math.isfinite(value) for value in (*center, *offset, distance)) or distance <= 0:
        raise ValueError('请将取景相机与目标点移到不同的位置。')
    if math.hypot(offset.x, offset.y) <= distance * 1e-7:
        raise ValueError('请将取景相机移出目标点的正上方或正下方，以确定起始方位。')
    optics = (data.lens, data.sensor_width, data.sensor_height, data.shift_x, data.shift_y, data.clip_start, data.clip_end)
    if not all(map(math.isfinite, optics)) or data.clip_end <= data.clip_start:
        raise ValueError('请检查取景相机的镜头设置和裁剪范围。')
    return OrbitFraming(
        center=tuple(center),
        distance=distance,
        start_azimuth=math.atan2(offset.x, -offset.y),
        lens=data.lens,
        sensor_fit=data.sensor_fit,
        sensor_width=data.sensor_width,
        sensor_height=data.sensor_height,
        shift_x=data.shift_x,
        shift_y=data.shift_y,
        clip_start=data.clip_start,
        clip_end=data.clip_end,
    )


def apply_camera_framing(camera_object, framing, pitch_degrees, frame_number, frame_count):
    camera = camera_object.data
    camera.type = 'PERSP'
    camera.lens = framing.lens
    camera.sensor_fit = framing.sensor_fit
    camera.sensor_width = framing.sensor_width
    camera.sensor_height = framing.sensor_height
    camera.shift_x = framing.shift_x
    camera.shift_y = framing.shift_y
    camera.clip_start = framing.clip_start
    camera.clip_end = framing.clip_end

    elevation = math.radians(pitch_degrees)
    azimuth = framing.start_azimuth + (frame_number - 1) * math.tau / frame_count
    radial = Vector((
        math.sin(azimuth) * math.cos(elevation),
        -math.cos(azimuth) * math.cos(elevation),
        math.sin(elevation),
    ))
    camera_object.location = Vector(framing.center) + framing.distance * radial
    camera_object.rotation_mode = 'XYZ'
    camera_object.rotation_euler = (math.pi / 2 - elevation, 0.0, azimuth)


def is_framed(camera, points, depsgraph, width, height) -> bool:
    """Check conservative bounds against all six planes of the output camera."""
    evaluated = camera.evaluated_get(depsgraph)
    projection = camera.calc_matrix_camera(depsgraph, x=width, y=height)
    world_to_clip = projection @ evaluated.matrix_world.normalized().inverted()
    for point in points:
        clip = world_to_clip @ point.to_4d()
        # Perspective clip W is the view-space depth, even when Z loses precision.
        if not evaluated.data.clip_start <= clip.w <= evaluated.data.clip_end:
            return False
        if max(abs(clip.x), abs(clip.y)) > clip.w:
            return False
    return True
