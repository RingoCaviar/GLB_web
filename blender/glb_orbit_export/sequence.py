# SPDX-License-Identifier: GPL-3.0-or-later

"""Naming and input validation for GLB Web's PNG frame sequences."""

import re


DEFAULT_ANGLES = "5, 15, 30"
DEFAULT_FRAMES = 36
MAX_ANGLES = 24
ANGLE_DECIMALS = 6

_ANGLE = re.compile(r"[+-]?[0-9]+(?:\.[0-9]+)?")
_SEPARATORS = re.compile(r"[\s,，、;；]+")
_DEVICE_NAME = re.compile(r"(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])", re.IGNORECASE)


def parse_angles(value: str) -> tuple[float, ...]:
    tokens = [token for token in _SEPARATORS.split(value) if token]
    if not tokens:
        raise ValueError("请至少输入一个俯角，例如 5, 15, 30。")
    if len(tokens) > MAX_ANGLES:
        raise ValueError(f"一次最多可以渲染 {MAX_ANGLES} 个俯角。")

    angles = []
    for token in tokens:
        if not _ANGLE.fullmatch(token):
            raise ValueError(f"俯角「{token}」格式无效，请输入数字，例如 -12.5。")
        angle = float(token)
        if not -89 <= angle <= 89:
            raise ValueError(f"俯角「{token}」超出范围，请输入 -89° 到 89°。")
        if len(token.partition(".")[2].rstrip("0")) > ANGLE_DECIMALS:
            raise ValueError(f"俯角「{token}」最多支持 {ANGLE_DECIMALS} 位小数。")
        if angle in angles:
            raise ValueError(f"俯角「{token}」重复，请保留一个。")
        angles.append(angle or 0.0)
    return tuple(angles)


def validate_product_name(name: str) -> str:
    if not name or not name.strip():
        raise ValueError("请输入产品名称。")
    if name != name.strip() or name.endswith("."):
        raise ValueError("产品名称首尾不能有空白，末尾不能有句点。")
    if any(ord(char) < 32 or char in '<>:"/\\|?*\u2028\u2029' for char in name):
        raise ValueError("产品名称含有文件名不支持的字符。")
    device_stem = name.partition(".")[0].rstrip()
    if name.casefold() == ".generated" or _DEVICE_NAME.fullmatch(device_stem):
        raise ValueError(f"「{name}」为保留名称，请另取一个产品名称。")
    if len(name.encode("utf-8")) > 220:
        raise ValueError("产品名称过长，请缩短名称。")
    return name


def format_angle(angle: float) -> str:
    return f"{angle or 0:.{ANGLE_DECIMALS}f}".rstrip("0").rstrip(".")


def select_pose(angles, frame_count, angle_index, frame_number):
    if not 0 <= angle_index < len(angles) or not 1 <= frame_number <= frame_count:
        raise ValueError("请选择序列范围内的俯角和帧号。")
    return angles[angle_index], frame_number


def frame_filename(product: str, angle: float, frame: int) -> str:
    return f"{product}_俯角{format_angle(angle)}_{frame:04d}.png"
