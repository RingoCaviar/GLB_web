# SPDX-License-Identifier: GPL-3.0-or-later

import json
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import bpy

from .rig import confirmed_framing, get_framing_setup
from .sequence import format_angle, parse_angles, select_pose, validate_product_name
from .viewport_preview import end_object_preview


STAGE_MARKER = ".glb-orbit-render"
WORKER = Path(__file__).with_name("render_worker.py")


def ensure_new_product(path):
    if path.exists() or path.is_symlink():
        raise ValueError("产品目录已存在，请使用新产品名称或先移走旧目录。")


def product_destination(settings):
    product = validate_product_name(settings.product_name)
    output = settings.output_directory.strip()
    if not output:
        raise ValueError("请选择项目根目录或 image_sequence 输出目录。")
    if output.startswith("//") and not bpy.data.filepath:
        raise ValueError("使用相对路径前请先保存 .blend，或选择绝对路径。")
    root = Path(bpy.path.abspath(output)).expanduser()
    if not root.is_absolute():
        raise ValueError("请选择绝对路径，或使用 Blender 的 // 相对路径。")
    root = root.resolve()
    if (root / "scripts" / "sequence-cache.mjs").is_file():
        root /= "image_sequence"
    if any(part.casefold() == ".generated" for part in root.parts):
        raise ValueError("请选择 .generated 缓存目录之外的位置。")
    destination = root / product
    ensure_new_product(destination)
    return destination


def prepare_stage(output_root):
    cache = output_root / ".generated"
    cache.mkdir(parents=True, exist_ok=True)
    # A library refresh can prune an empty cache directory before the marker is created.
    for _ in range(3):
        stage = Path(tempfile.mkdtemp(prefix=".blender-orbit-", dir=cache))
        try:
            (stage / STAGE_MARKER).touch()
        except FileNotFoundError:
            continue
        except OSError:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        return stage
    raise RuntimeError("无法创建序列暂存目录，请重试。")


@dataclass
class RenderJob:
    process: subprocess.Popen
    directory: Path
    stage: Path
    destination: Path | None
    scene_uid: int
    total: int
    preview_title: str = ""
    cancel_deadline: float | None = None

    def status(self):
        try:
            return json.loads((self.directory / "status.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def request_cancel(self):
        self.cancel_deadline = time.monotonic() + 3
        if self.process.poll() is None:
            self.process.terminate()

    def running(self):
        if self.process.poll() is not None:
            return False
        if self.cancel_deadline is not None and time.monotonic() >= self.cancel_deadline:
            self.process.kill()
        return True

    def collect(self):
        if self.cancel_deadline is not None:
            return None
        status = self.status()
        if self.process.returncode or status.get("completed") != self.total:
            log = self.directory / "render.log"
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 8192))
                print(stream.read().decode("utf-8", errors="replace"))
            raise RuntimeError(status.get("error") or "Blender 渲染未完成，请检查系统控制台。")

        if self.destination is None:
            preview = self.stage / "preview.png"
            if not preview.is_file():
                raise RuntimeError("Blender 未写出预览图。")
            preview_directory = Path(tempfile.mkdtemp(prefix="glb-orbit-preview-"))
            try:
                return preview.rename(preview_directory / preview.name)
            except OSError:
                shutil.rmtree(preview_directory, ignore_errors=True)
                raise

        if sum(1 for path in self.stage.glob("*.png") if path.is_file()) != self.total:
            raise RuntimeError("序列帧数不完整，产品目录未发布。")
        ensure_new_product(self.destination)
        (self.stage / STAGE_MARKER).unlink()
        return self.stage.rename(self.destination)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.destination is not None:
            shutil.rmtree(self.stage, ignore_errors=True)
        shutil.rmtree(self.directory, ignore_errors=True)


def start_job(scene, view_layer, settings, preview, angle_index=0, frame_number=1):
    end_object_preview()
    view_layer.update()
    setup = get_framing_setup(settings)
    framing = confirmed_framing(setup, bpy.context.evaluated_depsgraph_get())
    angles = parse_angles(settings.angles)
    preview_title = ""
    if preview:
        pitch, frame = select_pose(angles, settings.frame_count, angle_index, frame_number)
        mode_label = "转物体" if settings.motion_mode == "OBJECT" else "转相机"
        preview_title = f"{mode_label} · {format_angle(pitch)}° · 第 {frame} 帧"
    destination = None if preview else product_destination(settings)
    directory = Path(tempfile.mkdtemp(prefix="glb-orbit-job-"))
    stage = directory
    try:
        if destination is not None:
            stage = prepare_stage(destination.parent)

        config = {
            "mode": "preview" if preview else "export",
            "motion_mode": settings.motion_mode,
            "target": setup.framing_source.name,
            "scene": scene.name,
            "view_layer": view_layer.name,
            "framing": asdict(framing),
            "angles": angles,
            "frame_count": settings.frame_count,
            "width": settings.width,
            "height": settings.height,
            "product": destination.name if destination is not None else "",
            "stage": str(stage),
        }
        if preview:
            config.update(preview_angle=pitch, preview_frame=frame)
        job_file = directory / "job.json"
        job_file.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        snapshot = directory / "scene.blend"
        result = bpy.ops.wm.save_as_mainfile(
            filepath=str(snapshot), copy=True, relative_remap=True,
            compress=False, check_existing=False,
        )
        if "FINISHED" not in result:
            raise RuntimeError("无法创建当前场景的渲染副本。")

        arguments = [
            bpy.app.binary_path, "--background", "--disable-autoexec", str(snapshot),
            "--python-exit-code", "1", "--python", str(WORKER), "--", str(job_file),
        ]
        with (directory / "render.log").open("wb") as log:
            process = subprocess.Popen(
                arguments, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        total = 1 if preview else len(angles) * settings.frame_count
        return RenderJob(process, directory, stage, destination, scene.session_uid, total, preview_title)
    except Exception:
        if stage != directory:
            shutil.rmtree(stage, ignore_errors=True)
        shutil.rmtree(directory, ignore_errors=True)
        raise
