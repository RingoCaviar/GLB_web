"""Render an asymmetric fixture with the extension inside Blender."""

import json
from math import atan2, degrees, hypot, isclose, pi
from pathlib import Path
import sys
from types import SimpleNamespace

import bpy
from mathutils import Matrix, Vector


def check_contract():
    from glb_orbit_export.sequence import frame_filename, parse_angles, validate_product_name

    angles = parse_angles("-12.500,\n +5.125； 0，89")
    assert angles == (-12.5, 5.125, 0, 89)
    assert frame_filename("测试 产品", angles[0], 1) == "测试 产品_俯角-12.5_0001.png"
    assert frame_filename("测试 产品", parse_angles("-0")[0], 12) == "测试 产品_俯角0_0012.png"
    assert frame_filename("测试 产品", parse_angles("0.000001")[0], 12345) == "测试 产品_俯角0.000001_12345.png"
    for invalid in ("", "5, 05.0", "-0, 0.00", "90", "-90", "nan", "1e-3", "０", "0.0000001"):
        try:
            parse_angles(invalid)
        except ValueError:
            continue
        raise AssertionError(f"Unexpectedly accepted angles: {invalid!r}")
    for invalid in ("", "../产品", "产品\\成品", "CON.txt", "COM¹", ".Generated", "产品. ", "产品:", "产\u2028品"):
        try:
            validate_product_name(invalid)
        except ValueError:
            continue
        raise AssertionError(f"Unexpectedly accepted product name: {invalid!r}")


def scene_state(scene):
    render = scene.render
    return (
        bpy.data.filepath, scene.camera, scene.frame_current, scene.frame_subframe,
        render.engine, render.filepath, render.resolution_x,
        render.resolution_y, render.resolution_percentage, render.film_transparent, render.use_multiview,
        render.image_settings.file_format, render.image_settings.color_mode, render.use_compositing,
        scene.compositing_node_group,
    )


def expect_cancelled(operator, message):
    try:
        result = operator()
    except RuntimeError as error:
        assert message in str(error), error
    else:
        assert result == {"CANCELLED"}, result


def image_pixels(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        return tuple(image.size), image.pixels[:]
    finally:
        bpy.data.images.remove(image)


def alpha_samples(image):
    (width, height), pixels = image
    center = 4 * ((height // 2) * width + width // 2)
    return pixels[3], pixels[center + 3]


def setup_compositor(scene, side_directory):
    tree = bpy.data.node_groups.new("Test Compositor", "CompositorNodeTree")
    scene.compositing_node_group = tree
    tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    layers = tree.nodes.new("CompositorNodeRLayers")
    output = tree.nodes.new("NodeGroupOutput")

    effect = bpy.data.node_groups.new("Opacity and side output", "CompositorNodeTree")
    effect.interface.new_socket(name="Image", in_out="INPUT", socket_type="NodeSocketColor")
    effect.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    group = tree.nodes.new("CompositorNodeGroup")
    group.node_tree = effect
    tree.links.new(layers.outputs["Image"], group.inputs["Image"])
    tree.links.new(group.outputs["Image"], output.inputs["Image"])

    inputs = effect.nodes.new("NodeGroupInput")
    outputs = effect.nodes.new("NodeGroupOutput")
    alpha = effect.nodes.new("CompositorNodeSetAlpha")
    alpha.inputs["Alpha"].default_value = 0.5
    effect.links.new(inputs.outputs["Image"], alpha.inputs["Image"])
    effect.links.new(alpha.outputs["Image"], outputs.inputs["Image"])

    file_output = effect.nodes.new("CompositorNodeOutputFile")
    file_output.directory = str(side_directory)
    file_output.file_output_items.new("RGBA", "Side")
    effect.links.new(inputs.outputs["Image"], file_output.inputs["Side"])
    return file_output


def check_scene_background(addon, scene):
    render = scene.render
    render.use_compositing = False
    transparent_state = scene_state(scene)
    assert bpy.ops.glb_orbit.render_sequence(preview=True, angle_index=0, frame_number=3) == {"FINISHED"}
    assert alpha_samples(image_pixels(addon._last_result.path)) == (0.0, 1.0)
    assert scene_state(scene) == transparent_state

    scene.frame_set(18)
    assert not render.film_transparent
    opaque_state = scene_state(scene)
    assert bpy.ops.glb_orbit.render_sequence(preview=True, angle_index=0, frame_number=3) == {"FINISHED"}
    assert alpha_samples(image_pixels(addon._last_result.path)) == (1.0, 1.0)
    assert scene_state(scene) == opaque_state

    scene.frame_set(17, subframe=0.25)
    render.use_compositing = True
    render.image_settings.color_mode = "RGB"
    rgb_state = scene_state(scene)
    assert bpy.ops.glb_orbit.render_sequence(preview=True, angle_index=0, frame_number=3) == {"FINISHED"}
    assert alpha_samples(image_pixels(addon._last_result.path)) == (1.0, 1.0)
    assert scene_state(scene) == rgb_state
    render.image_settings.color_mode = "RGBA"


def check_motion_controls(addon):
    labels = {}

    class Layout:
        def column(self, **_options):
            return self

        box = row = column

        def label(self, **_options):
            pass

        def prop(self, _settings, _property, **_options):
            pass

        def prop_enum(self, _settings, property_name, value, *, text, **_options):
            if property_name == "motion_mode":
                labels[value] = text

        def operator(self, _operator, **_options):
            return SimpleNamespace()

        def separator(self):
            pass

    addon.GLB_ORBIT_PT_sequence.draw(SimpleNamespace(layout=Layout()), bpy.context)
    assert labels == {"CAMERA": "转相机", "OBJECT": "转物体"}, labels


def assert_matrix_close(actual, expected):
    assert all(
        isclose(left, right, abs_tol=1e-5)
        for actual_row, expected_row in zip(actual, expected)
        for left, right in zip(actual_row, expected_row)
    ), (actual, expected)


def check_object_motion(addon, scene, project_root):
    from glb_orbit_export.rig import get_framing_setup

    settings = scene.glb_orbit_export
    assert settings.motion_mode == "CAMERA"

    # An offset, animated child makes the silhouette sensitive to orbit direction and pivot.
    target = scene.objects["Cube"]
    product = bpy.data.objects.new("产品父级", None)
    scene.collection.objects.link(product)
    product.location = (4, -3.2, 2)
    product.keyframe_insert(data_path="location", frame=17)
    product.location = (4.4, -2.9, 2)
    product.keyframe_insert(data_path="location", frame=18)
    product.constraints.new("LIMIT_ROTATION").name = "原有产品约束"
    target.parent = product
    target.location = (-0.55, 0.7, 0)
    target.keyframe_insert(data_path="location", frame=17)
    target.location = (-0.35, 0.9, 0)
    target.keyframe_insert(data_path="location", frame=18)
    neutral = bpy.data.materials.new("中性色")
    neutral.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.65, 0.65, 0.65, 1)
    for slot in target.material_slots:
        slot.material = neutral

    # Fixed front lighting and a separate emissive set marker distinguish the two motion modes.
    scene.objects["Light"].hide_render = True
    scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0
    scene.view_settings.view_transform = "Standard"
    sun = bpy.data.objects.new("固定正面灯光", bpy.data.lights.new("固定正面灯光", "SUN"))
    scene.collection.objects.link(sun)
    sun.rotation_euler.x = pi / 2
    sun.data.energy = 2
    sun.data.angle = 0

    pivot = Vector((4, -3, 2))
    bpy.ops.mesh.primitive_cube_add(size=0.3, location=pivot + Vector((2.4, 0, 1.45)))
    marker = bpy.context.object
    marker.name = "固定布景标记"
    green = bpy.data.materials.new("绿色发光标记")
    nodes = green.node_tree.nodes
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0, 1, 0, 1)
    green.node_tree.links.new(emission.outputs[0], nodes.get("Material Output").inputs["Surface"])
    marker.data.materials.append(green)

    scene.frame_set(17, subframe=0.25)
    settings.target = product
    settings.angles = "0"
    settings.frame_count = 4
    settings.output_directory = str(project_root / "object-orbit")
    settings.product_name = "固定灯光"
    assert bpy.ops.glb_orbit.add_rig(reset=True) == {"FINISHED"}
    setup = get_framing_setup(settings)
    setup.rig_target.location = pivot
    setup.rig_camera.location = pivot + Vector((0, -8, 0))
    setup.rig_camera.data.lens = 42
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}

    subjects = (product, target, sun, marker)
    before = scene_state(scene)
    matrices = [obj.matrix_world.copy() for obj in subjects]
    parents = [obj.parent for obj in subjects]
    original_objects = set(scene.objects)
    original_constraints = [tuple(obj.constraints) for obj in subjects]
    constraint_names = [[constraint.name for constraint in constraints] for constraints in original_constraints]
    area = next(area for area in bpy.context.screen.areas if area.type == "VIEW_3D")
    region = next(region for region in area.regions if region.type == "WINDOW")
    space = area.spaces.active
    original_view = (space.use_local_camera, space.camera, space.region_3d.view_perspective)

    def assert_source_restored():
        bpy.context.view_layer.update()
        assert set(scene.objects) == original_objects
        assert [tuple(obj.constraints) for obj in subjects] == original_constraints
        assert [obj.parent for obj in subjects] == parents
        for subject, matrix in zip(subjects, matrices):
            assert_matrix_close(subject.matrix_world, matrix)

    def inspect(frame, angle=0):
        with bpy.context.temp_override(area=area, region=region):
            assert bpy.ops.glb_orbit.inspect_view(angle_index=angle, frame_number=frame) == {"FINISHED"}
        assert space.use_local_camera and space.camera == settings.preview_camera
        assert space.region_3d.view_perspective == "CAMERA"
        bpy.context.view_layer.update()
        return settings.preview_camera.matrix_world.copy()

    def assert_product_rotation(frame):
        angle = -(frame - 1) * pi / 2
        rotation = Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, "Z") @ Matrix.Translation(-pivot)
        for subject, matrix in zip(subjects[:2], matrices[:2]):
            assert_matrix_close(subject.matrix_world, rotation @ matrix)
        for subject, matrix in zip(subjects[2:], matrices[2:]):
            assert_matrix_close(subject.matrix_world, matrix)

    def preview(frame):
        assert bpy.ops.glb_orbit.render_sequence(preview=True, angle_index=0, frame_number=frame) == {"FINISHED"}
        return image_pixels(addon._last_result.path)

    camera_side, camera_back = preview(2), preview(3)
    settings.motion_mode = "OBJECT"
    object_side_preview = preview(2)
    front_view = inspect(1)
    side_view = inspect(2)
    assert_matrix_close(side_view, front_view)
    assert_product_rotation(2)
    settings.angles = "0, 25"
    elevated_view = inspect(2, angle=1)
    assert (elevated_view.translation - front_view.translation).length > 1
    assert_matrix_close(inspect(3, angle=1), elevated_view)
    assert_product_rotation(3)
    settings.angles = "0"
    with bpy.context.temp_override(area=area, region=region):
        assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}
        assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=3, enter_view=False) == {"FINISHED"}
        assert settings.inspect_frame_number == 3
    assert_source_restored()
    assert (space.use_local_camera, space.camera, space.region_3d.view_perspective) == original_view

    inspect(2)
    assert_product_rotation(2)
    with bpy.context.temp_override(area=area, region=region):
        assert bpy.ops.glb_orbit.reframe() == {"FINISHED"}
        assert space.camera == setup.rig_camera
    assert_source_restored()
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}

    inspect(2)
    with bpy.context.temp_override(area=area, region=region):
        settings.motion_mode = "CAMERA"
    assert space.use_local_camera and space.camera == settings.preview_camera
    assert space.region_3d.view_perspective == "CAMERA"
    assert_source_restored()
    assert (inspect(1).translation - inspect(2).translation).length > 1
    assert_source_restored()

    with bpy.context.temp_override(area=area, region=region):
        settings.motion_mode = "OBJECT"
    bpy.context.view_layer.update()
    assert_matrix_close(settings.preview_camera.matrix_world, front_view)
    assert_product_rotation(2)
    inspect(3)
    assert_product_rotation(3)
    assert preview(2) == object_side_preview, "Rendering from a live preview must use the original pose"
    assert_source_restored()
    inspect(3)
    assert bpy.ops.glb_orbit.render_sequence() == {"FINISHED"}
    assert_source_restored()

    folder = Path(settings.output_directory) / settings.product_name
    object_front, object_side, object_back = [
        image_pixels(folder / f"固定灯光_俯角0_{frame:04d}.png") for frame in (1, 2, 3)
    ]
    assert object_side == object_side_preview
    assert scene_state(scene) == before
    assert [obj.matrix_world for obj in subjects] == matrices
    assert [obj.parent for obj in subjects] == parents

    def green_marker(image):
        pixels = image[1]
        return {offset for offset in range(0, len(pixels), 4) if pixels[offset + 1] > 0.35
                and pixels[offset] < 0.1 and pixels[offset + 2] < 0.1}

    fixed_marker = green_marker(object_front)
    side_marker, back_marker = green_marker(object_side), green_marker(object_back)
    assert fixed_marker and side_marker == back_marker == fixed_marker, (
        len(fixed_marker), len(side_marker), len(back_marker), max(object_front[1][1::4]),
    )
    assert green_marker(camera_back) and green_marker(camera_back).isdisjoint(fixed_marker)

    def silhouette(image):
        marker_pixels = green_marker(image)
        return {offset for offset in range(0, len(image[1]), 4) if image[1][offset + 3] > 0.4
                and offset not in marker_pixels}

    camera_silhouette, object_silhouette = silhouette(camera_side), silhouette(object_side)
    assert camera_silhouette and object_silhouette
    assert len(camera_silhouette ^ object_silhouette) < 0.12 * len(camera_silhouette | object_silhouette)
    (width, height), pixels = object_back
    center = 4 * ((height // 2) * width + width // 2)
    assert isclose(pixels[center + 3], 0.5, abs_tol=0.01)
    assert pixels[center] > camera_back[1][center] + 0.3

    inspect(2)
    assert_product_rotation(2)
    saved = str(project_root / "转物体预览.blend")
    object_names = {obj.name for obj in original_objects}
    subject_names = [obj.name for obj in subjects]
    assert bpy.ops.wm.save_as_mainfile(filepath=saved) == {"FINISHED"}
    assert_source_restored()
    assert bpy.ops.wm.open_mainfile(filepath=saved, load_ui=False) == {"FINISHED"}
    reopened = bpy.context.scene
    assert reopened.glb_orbit_export.motion_mode == "OBJECT"
    assert {obj.name for obj in reopened.objects} == object_names
    for name, matrix, expected_constraints in zip(subject_names, matrices, constraint_names):
        obj = reopened.objects[name]
        assert_matrix_close(obj.matrix_world, matrix)
        assert [constraint.name for constraint in obj.constraints] == expected_constraints


def check_viewport(settings):
    from glb_orbit_export import camera_ui
    from glb_orbit_export.rig import get_framing_setup, sync_cycles_cameras
    from glb_orbit_export.sequence import parse_angles

    class Layout:
        def __init__(self):
            self.operators = []

        def row(self, **_options):
            return self

        def label(self, *_args, **_options):
            pass

        menu = label

        def operator(self, operator, *, text="", depress=False, **_options):
            properties = SimpleNamespace()
            self.operators.append((operator, text, depress, properties))
            return properties

    def header():
        layout = Layout()
        camera_ui.draw_inspection(layout, bpy.context, settings, parse_angles(settings.angles))
        buttons = [button for button in layout.operators if button[1].startswith("检查视角 · ")]
        assert len(buttons) == 1, layout.operators
        for operator, text, _depressed, properties in layout.operators:
            if operator == "glb_orbit.inspect_view" and text != buttons[0][1]:
                assert not properties.enter_view
        return buttons[0]

    area = next(area for area in bpy.context.screen.areas if area.type == "VIEW_3D")
    region = next(region for region in area.regions if region.type == "WINDOW")
    space = area.spaces.active
    view = space.region_3d
    space.lock_camera = True
    view.view_camera_offset = (0.1, -0.15)
    view.view_camera_zoom = 12

    def viewport_state():
        return (
            space.use_local_camera, space.camera, view.view_perspective,
            space.lock_camera, tuple(view.view_camera_offset), view.view_camera_zoom,
        )

    before = viewport_state()
    with bpy.context.temp_override(area=area, region=region):
        name, text, depressed, properties = header()
        assert (name, text, depressed) == ("glb_orbit.inspect_view", "检查视角 · 已关闭", False)
        assert properties.enter_view and properties.explain
        assert not camera_ui.is_inspection_active(bpy.context, settings)
        menu = Layout()
        camera_ui.GLB_ORBIT_MT_angles.draw(SimpleNamespace(layout=menu), bpy.context)
        assert len(menu.operators) == 2
        assert all(not properties.enter_view for _, _, _, properties in menu.operators)
        assert bpy.ops.glb_orbit.inspect_view(angle_index=1, frame_number=2, enter_view=False) == {"FINISHED"}
        assert (settings.inspect_angle_index, settings.inspect_frame_number) == (1, 2)
        assert viewport_state() == before

        assert bpy.ops.glb_orbit.inspect_view(angle_index=1, frame_number=2) == {"FINISHED"}
        assert space.use_local_camera and space.camera == settings.preview_camera
        assert view.view_perspective == "CAMERA" and not space.lock_camera
        assert camera_ui.is_inspection_active(bpy.context, settings)
        assert header()[:3] == ("glb_orbit.exit_view", "检查视角 · 已开启", True)
        current = settings.preview_camera.matrix_world.copy()
        assert bpy.ops.glb_orbit.inspect_view(angle_index=1, frame_number=3, enter_view=False) == {"FINISHED"}
        assert settings.inspect_frame_number == 3
        assert settings.preview_camera.matrix_world != current
        assert camera_ui.is_inspection_active(bpy.context, settings)
        assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}
        assert viewport_state() == before

        assert bpy.ops.glb_orbit.rig_view(action="VIEW") == {"FINISHED"}
        assert space.camera == get_framing_setup(settings).rig_camera
        assert header()[1] == "检查视角 · 已关闭"
        assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=1) == {"FINISHED"}
        view.view_perspective = "PERSP"
        assert header()[1] == "检查视角 · 已关闭"
        assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=1) == {"FINISHED"}
        assert header()[1] == "检查视角 · 已开启"
        assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}

        scene = bpy.context.scene
        scene_camera = scene.camera
        original_lens = scene_camera.data.lens
        scene_camera.data.lens = settings.preview_camera.data.lens * 2
        affected = bpy.app.version[:2] == (5, 1)
        try:
            space.shading.type = "RENDERED"
            assert bpy.ops.glb_orbit.inspect_view(angle_index=1, frame_number=2) == {"FINISHED"}
            # Cycles 5.1 reads the scene camera optics even when using the local view matrix.
            preview_camera = space.camera
            assert scene.camera == (preview_camera if affected else scene_camera)
            preview_state = viewport_state()
            preview_pose = preview_camera.matrix_world.copy()
            for shading in ("SOLID", "MATERIAL", "RENDERED"):
                space.shading.type = shading
                sync_cycles_cameras()
                expected = preview_camera if affected and shading == "RENDERED" else scene_camera
                assert scene.camera == expected
                assert viewport_state() == preview_state
                assert preview_camera.matrix_world == preview_pose
            assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}
            assert scene.camera == scene_camera
            assert viewport_state() == before

            engine = scene.render.engine
            try:
                scene.render.engine = "BLENDER_EEVEE"
                assert bpy.ops.glb_orbit.rig_view(action="VIEW") == {"FINISHED"}
                assert scene.camera == scene_camera
                assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}
            finally:
                scene.render.engine = engine
        finally:
            space.shading.type = "SOLID"
            scene_camera.data.lens = original_lens


def check_reframing(scene, settings, camera, focus):
    from glb_orbit_export import camera_ui

    class Layout:
        def __init__(self):
            self.operators = []

        def row(self, **_options):
            return self

        def label(self, **_options):
            pass

        def prop(self, *_args, **_options):
            pass

        def operator(self, operator, **_options):
            self.operators.append(operator)
            return SimpleNamespace()

    setup = camera_ui.get_framing_setup(settings)
    previous = setup.confirmed_framing
    objects = set(scene.objects)
    scene_camera = scene.camera
    location, center = camera.location.copy(), focus.location.copy()
    lens = camera.data.lens
    settings.inspect_angle_index, settings.inspect_frame_number = 1, 3
    panel = Layout()
    assert camera_ui.draw_rig(panel, bpy.context, settings)
    assert "glb_orbit.reframe" in panel.operators

    area = next(area for area in bpy.context.screen.areas if area.type == "VIEW_3D")
    region = next(region for region in area.regions if region.type == "WINDOW")
    with bpy.context.temp_override(area=area, region=region):
        assert bpy.ops.glb_orbit.reframe() == {"FINISHED"}
        space = area.spaces.active
        assert space.use_local_camera and space.camera == camera
        assert space.region_3d.view_perspective == "CAMERA"
        assert scene.camera == scene_camera
        assert setup.rig_camera == camera and setup.rig_target == focus
        assert set(scene.objects) == objects
        assert camera.location == location and focus.location == center and camera.data.lens == lens
        assert setup.reframing and setup.confirmed_framing == previous
        panel = Layout()
        assert not camera_ui.draw_rig(panel, bpy.context, settings)
        assert "glb_orbit.confirm_framing" in panel.operators
        expect_cancelled(bpy.ops.glb_orbit.inspect_view, "确认")
        expect_cancelled(bpy.ops.glb_orbit.render_sequence, "确认")

        camera.location = center
        expect_cancelled(bpy.ops.glb_orbit.confirm_framing, "不同的位置")
        assert setup.reframing and setup.confirmed_framing == previous

        focus.location = center + Vector((0.1, -0.2, 0.15))
        offset = Vector((5, -7, 1))
        camera.location = focus.location + offset
        camera.data.lens = 40
        assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
        updated = json.loads(setup.confirmed_framing)
        assert not setup.reframing and setup.confirmed_framing != previous
        assert (Vector(updated["center"]) - focus.location).length < 1e-6
        assert isclose(updated["distance"], offset.length, abs_tol=1e-5)
        assert isclose(updated["start_azimuth"], atan2(offset.x, -offset.y), abs_tol=1e-6)
        assert updated["lens"] == 40
        assert (settings.inspect_angle_index, settings.inspect_frame_number) == (1, 3)
        assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}

    focus.location, camera.location, camera.data.lens = center, location, lens
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
    assert setup.confirmed_framing == previous


def check_framing(scene, settings, target):
    from glb_orbit_export import camera_ui

    before = set(scene.objects)
    expect_cancelled(bpy.ops.glb_orbit.render_sequence, "取景")
    assert bpy.ops.glb_orbit.add_rig() == {"FINISHED"}
    setup = camera_ui.get_framing_setup(settings)
    camera, focus = setup.rig_camera, setup.rig_target
    assert camera.type == "CAMERA" and camera.data.type == "PERSP"
    assert focus.type == "EMPTY"
    assert setup.framing_source == target
    assert set(scene.objects) - before == {camera, focus}
    collection = scene.collection.children["GLB Web · 360°"]
    assert set(collection.children["取景"].objects) == {camera, focus}

    camera.name = "手动取景相机"
    focus.name = "手动目标点"
    assert bpy.ops.glb_orbit.add_rig() == {"FINISHED"}
    assert setup.rig_camera == camera and setup.rig_target == focus
    assert bpy.ops.glb_orbit.rig_view(action="CAMERA") == {"FINISHED"}
    assert bpy.context.view_layer.objects.active == camera
    assert bpy.ops.glb_orbit.rig_view(action="TARGET") == {"FINISHED"}
    assert bpy.context.view_layer.objects.active == focus
    focus.location = (4.2, -3.05, 2.1)
    camera.location = focus.location + Vector((4, -6, 2))
    camera.data.lens = 42.0
    bpy.context.view_layer.update()
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
    framing = json.loads(setup.confirmed_framing)
    assert (Vector(framing["center"]) - focus.location).length < 1e-6
    assert isclose(framing["distance"], 56 ** 0.5, abs_tol=1e-5)
    assert isclose(framing["start_azimuth"], atan2(4, 6), abs_tol=1e-6)
    assert framing["lens"] == 42.0
    view_direction = camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    assert view_direction.dot((focus.location - camera.location).normalized()) > 0.9999

    check_reframing(scene, settings, camera, focus)
    confirmed_location = camera.location.copy()
    camera.location.x += 0.25
    bpy.context.view_layer.update()
    expect_cancelled(bpy.ops.glb_orbit.inspect_view, "确认")
    camera.location = confirmed_location
    bpy.context.view_layer.update()

    preview = None
    for angle_index, pitch in enumerate((-12.5, 5.125)):
        directions = []
        for frame_number in range(1, 5):
            assert bpy.ops.glb_orbit.inspect_view(angle_index=angle_index, frame_number=frame_number) == {"FINISHED"}
            if preview is None:
                preview = settings.preview_camera
                assert set(collection.children["预览"].objects) == {preview}
            assert settings.preview_camera == preview
            bpy.context.view_layer.update()
            offset = preview.matrix_world.translation - focus.location
            assert isclose(offset.length, framing["distance"], abs_tol=1e-5)
            assert isclose(degrees(atan2(offset.z, hypot(offset.x, offset.y))), pitch, abs_tol=1e-4)
            directions.append(Vector((offset.x, offset.y)).normalized())
        assert directions[0].dot(Vector((4, -6)).normalized()) > 0.9999
        assert directions[0].cross(directions[1]) > 0.9999
        assert directions[0].dot(directions[2]) < -0.9999
        assert directions[1].dot(directions[3]) < -0.9999

    assert set(scene.objects) - before == {camera, focus, preview}
    assert camera_ui._last_inspection[1] is True
    camera.data.lens = 500.0
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
    assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=2) == {"FINISHED"}
    assert camera_ui._last_inspection[1] is False
    camera.data.lens = 42.0
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
    check_viewport(settings)
    return framing


def check_product_switching(settings):
    from glb_orbit_export.rig import get_framing_setup

    first = get_framing_setup(settings)
    first_camera, first_point = first.rig_camera, first.rig_target
    first_confirmation = first.confirmed_framing
    first_location, first_center = first_camera.location.copy(), first_point.location.copy()

    bpy.ops.mesh.primitive_cube_add(size=1, location=(-12, 3, 1))
    product = bpy.context.object
    product.name = "另一件产品"
    settings.target = product
    assert get_framing_setup(settings) is None
    expect_cancelled(bpy.ops.glb_orbit.render_sequence, "添加取景相机")
    assert bpy.ops.glb_orbit.add_rig() == {"FINISHED"}
    second = get_framing_setup(settings)
    assert second.rig_camera != first_camera and second.rig_target != first_point
    assert second.rig_target.location == product.location
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
    second_confirmation = second.confirmed_framing

    area = next(area for area in bpy.context.screen.areas if area.type == "VIEW_3D")
    region = next(region for region in area.regions if region.type == "WINDOW")
    with bpy.context.temp_override(area=area, region=region):
        assert bpy.ops.glb_orbit.reframe() == {"FINISHED"}
        assert area.spaces.active.camera == second.rig_camera
        settings.target = first.framing_source
        assert area.spaces.active.camera != second.rig_camera
        assert not first.reframing and first.confirmed_framing == first_confirmation
        assert first_camera.location == first_location and first_point.location == first_center
        assert bpy.ops.glb_orbit.inspect_view() == {"FINISHED"}
        settings.target = product
        assert second.reframing and second.confirmed_framing == second_confirmation
        expect_cancelled(bpy.ops.glb_orbit.inspect_view, "确认")
        assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
        assert bpy.ops.glb_orbit.inspect_view() == {"FINISHED"}
        assert isclose((settings.preview_camera.location - product.location).length,
                       json.loads(second_confirmation)["distance"], abs_tol=1e-5)
        settings.target = first.framing_source

    return second_confirmation


def main(project_root: Path):
    assert bpy.app.version >= (5, 1, 2), bpy.app.version_string
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "blender"))
    import glb_orbit_export
    from glb_orbit_export.rig import get_framing_setup

    check_contract()
    glb_orbit_export.register()
    try:
        check_motion_controls(glb_orbit_export)
        scene = bpy.context.scene
        target = scene.objects["Cube"]
        target.location = (4, -3, 2)
        target.scale = (1, 1.65, 0.7)
        for index, face in enumerate(target.data.polygons):
            material = bpy.data.materials.new(f"Face {index}")
            material.diffuse_color = (index / 6, 0.2, 1 - index / 6, 1)
            material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = material.diffuse_color
            target.data.materials.append(material)
            face.material_index = index

        scene.frame_set(17, subframe=0.25)
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        scene.render.threads_mode = "FIXED"
        scene.render.threads = 2
        scene.render.filepath = "//untouched.png"
        scene.render.resolution_percentage = 53
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.film_transparent = True
        scene.keyframe_insert(data_path="render.film_transparent", frame=17)
        scene.render.film_transparent = False
        scene.keyframe_insert(data_path="render.film_transparent", frame=18)
        scene.driver_add("render.use_multiview").driver.expression = "1.0"
        scene.frame_set(17, subframe=0.25)
        assert scene.render.film_transparent
        side_directory = project_root / "compositor-side"
        side_directory.mkdir()
        side_output = setup_compositor(scene, side_directory)
        scene.render.use_compositing = True
        original = scene_state(scene)

        settings = scene.glb_orbit_export
        settings.target = target
        settings.product_name = "测试 产品"
        settings.output_directory = str(project_root)
        settings.angles = "-12.5，+5.125"
        settings.frame_count = 4
        settings.width = 80
        settings.height = 64
        framing = check_framing(scene, settings, target)
        assert scene_state(scene) == original
        managed_objects = set(scene.objects)
        rig_camera = get_framing_setup(settings).rig_camera
        rig_pose = rig_camera.matrix_world.copy()
        output_directory = project_root / "image_sequence"
        product = output_directory / settings.product_name
        assert bpy.ops.glb_orbit.render_sequence(preview=True, angle_index=0, frame_number=3) == {"FINISHED"}
        preview = image_pixels(glb_orbit_export._last_result.path)
        corner_alpha, center_alpha = alpha_samples(preview)
        assert corner_alpha == 0.0 and isclose(center_alpha, 0.5, abs_tol=0.01), (corner_alpha, center_alpha)
        assert not list(output_directory.rglob("*.png"))
        assert scene_state(scene) == original
        assert bpy.ops.glb_orbit.render_sequence() == {"FINISHED"}
        assert scene_state(scene) == original
        assert set(scene.objects) == managed_objects
        assert rig_camera.matrix_world == rig_pose
        assert preview == image_pixels(product / "测试 产品_俯角-12.5_0003.png")
        assert preview != image_pixels(product / "测试 产品_俯角-12.5_0001.png")
        assert preview != image_pixels(product / "测试 产品_俯角5.125_0003.png")
        outputs = {path.name: path.read_bytes() for path in product.iterdir()}
        assert len(outputs) == 8, list(outputs)
        check_scene_background(glb_orbit_export, scene)
        assert scene_state(scene) == original
        assert settings.bl_rna.properties.get("transparent") is None
        assert not side_output.mute
        assert not list(side_directory.iterdir())

        settings.angles = "45"
        settings.output_directory = str(output_directory)
        expect_cancelled(bpy.ops.glb_orbit.render_sequence, "目录")
        assert {path.name: path.read_bytes() for path in product.iterdir()} == outputs
        assert scene_state(scene) == original

        settings.product_name = "取消的产品"
        job = glb_orbit_export.start_job(scene, bpy.context.view_layer, settings, preview=False)
        try:
            job.request_cancel()
            job.process.wait(timeout=15)
            assert job.collect() is None
        finally:
            job.close()
        assert not (output_directory / settings.product_name).exists()
        assert not list((output_directory / ".generated").iterdir())

        second_confirmation = check_product_switching(settings)
        saved = str(project_root / "取景.blend")
        main_camera = scene.camera
        area = next(area for area in bpy.context.screen.areas if area.type == "VIEW_3D")
        region = next(region for region in area.regions if region.type == "WINDOW")
        with bpy.context.temp_override(area=area, region=region):
            space = area.spaces.active
            space.shading.type = "RENDERED"
            assert bpy.ops.glb_orbit.inspect_view() == {"FINISHED"}
            if bpy.app.version[:2] == (5, 1):
                assert scene.camera == settings.preview_camera
            assert bpy.ops.wm.save_as_mainfile(filepath=saved) == {"FINISHED"}
            assert scene.camera == main_camera
            space.shading.type = "SOLID"
        assert bpy.ops.wm.open_mainfile(filepath=saved, load_ui=False) == {"FINISHED"}
        scene = bpy.context.scene
        assert scene.camera.name == "Camera"
        reopened = scene.glb_orbit_export
        first = get_framing_setup(reopened)
        assert json.loads(first.confirmed_framing) == framing
        assert first.rig_camera.name == "手动取景相机"
        assert first.rig_target.name == "手动目标点"
        assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=4) == {"FINISHED"}

        # Restore the legacy layout for the first product and switch between both storage formats.
        for name in ("framing_source", "rig_camera", "rig_target", "confirmed_framing", "reframing"):
            setattr(reopened, name, getattr(first, name))
        reopened.framings.remove(0)
        reopened.target = scene.objects["另一件产品"]
        second = get_framing_setup(reopened)
        assert second.confirmed_framing == second_confirmation
        bpy.data.objects.remove(second.rig_camera, do_unlink=True)
        assert bpy.ops.glb_orbit.add_rig() == {"FINISHED"}
        assert second.rig_camera != reopened.rig_camera and not second.confirmed_framing
        reopened.target = reopened.framing_source
        assert get_framing_setup(reopened) == reopened
        assert json.loads(reopened.confirmed_framing) == framing
        assert bpy.ops.glb_orbit.inspect_view() == {"FINISHED"}
        scene.objects["另一件产品"].hide_render = True
        check_object_motion(glb_orbit_export, scene, project_root)
    finally:
        glb_orbit_export.unregister()


if __name__ == "__main__":
    main(Path(sys.argv[sys.argv.index("--") + 1]))
