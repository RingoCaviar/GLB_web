"""Render an asymmetric fixture with the extension inside Blender."""

import json
from math import atan2, degrees, hypot, isclose, pi
from pathlib import Path
import sys

import bpy
from mathutils import Vector


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


def check_object_motion(addon, scene, project_root):
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
    settings.rig_target.location = pivot
    settings.rig_camera.location = pivot + Vector((0, -8, 0))
    settings.rig_camera.data.lens = 42
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}

    subjects = (product, target, sun, marker)
    before = scene_state(scene)
    matrices = [obj.matrix_world.copy() for obj in subjects]
    parents = [obj.parent for obj in subjects]

    def preview(frame):
        assert bpy.ops.glb_orbit.render_sequence(preview=True, angle_index=0, frame_number=frame) == {"FINISHED"}
        return image_pixels(addon._last_result.path)

    camera_side, camera_back = preview(2), preview(3)
    settings.motion_mode = "OBJECT"
    assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=2) == {"FINISHED"}
    object_side_preview = preview(2)
    assert bpy.ops.glb_orbit.render_sequence() == {"FINISHED"}

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


def check_viewport(settings):
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
        assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=2) == {"FINISHED"}
        assert space.use_local_camera and space.camera == settings.preview_camera
        assert view.view_perspective == "CAMERA" and not space.lock_camera
        assert bpy.ops.glb_orbit.exit_view() == {"FINISHED"}
    assert viewport_state() == before


def check_framing(scene, settings, target):
    from glb_orbit_export import camera_ui

    before = set(scene.objects)
    expect_cancelled(bpy.ops.glb_orbit.render_sequence, "取景")
    assert bpy.ops.glb_orbit.add_rig() == {"FINISHED"}
    camera, focus = settings.rig_camera, settings.rig_target
    assert camera.type == "CAMERA" and camera.data.type == "PERSP"
    assert focus.type == "EMPTY"
    assert settings.framing_source == target
    assert set(scene.objects) - before == {camera, focus}
    collection = scene.collection.children["GLB Web · 360°"]
    assert set(collection.children["取景"].objects) == {camera, focus}

    camera.name = "手动取景相机"
    focus.name = "手动目标点"
    assert bpy.ops.glb_orbit.add_rig() == {"FINISHED"}
    assert settings.rig_camera == camera and settings.rig_target == focus
    assert bpy.ops.glb_orbit.rig_view(action="CAMERA") == {"FINISHED"}
    assert bpy.context.view_layer.objects.active == camera
    assert bpy.ops.glb_orbit.rig_view(action="TARGET") == {"FINISHED"}
    assert bpy.context.view_layer.objects.active == focus
    focus.location = (4.2, -3.05, 2.1)
    camera.location = focus.location + Vector((4, -6, 2))
    camera.data.lens = 42.0
    bpy.context.view_layer.update()
    assert bpy.ops.glb_orbit.confirm_framing() == {"FINISHED"}
    framing = json.loads(settings.confirmed_framing)
    assert (Vector(framing["center"]) - focus.location).length < 1e-6
    assert isclose(framing["distance"], 56 ** 0.5, abs_tol=1e-5)
    assert isclose(framing["start_azimuth"], atan2(4, 6), abs_tol=1e-6)
    assert framing["lens"] == 42.0
    view_direction = camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    assert view_direction.dot((focus.location - camera.location).normalized()) > 0.9999

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


def main(project_root: Path):
    assert bpy.app.version >= (5, 1, 2), bpy.app.version_string
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "blender"))
    import glb_orbit_export

    check_contract()
    glb_orbit_export.register()
    try:
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
        rig_pose = settings.rig_camera.matrix_world.copy()
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
        assert settings.rig_camera.matrix_world == rig_pose
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

        saved = str(project_root / "取景.blend")
        assert bpy.ops.wm.save_as_mainfile(filepath=saved) == {"FINISHED"}
        assert bpy.ops.wm.open_mainfile(filepath=saved, load_ui=False) == {"FINISHED"}
        reopened = bpy.context.scene.glb_orbit_export
        assert json.loads(reopened.confirmed_framing) == framing
        assert reopened.rig_camera.name == "手动取景相机"
        assert reopened.rig_target.name == "手动目标点"
        assert bpy.ops.glb_orbit.inspect_view(angle_index=0, frame_number=4) == {"FINISHED"}
        check_object_motion(glb_orbit_export, bpy.context.scene, project_root)
    finally:
        glb_orbit_export.unregister()


if __name__ == "__main__":
    main(Path(sys.argv[sys.argv.index("--") + 1]))
