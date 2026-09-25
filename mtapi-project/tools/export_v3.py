from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.func import grad
from torch.fx.experimental.proxy_tensor import make_fx
import torch.nn.functional as F
from torchvision.models import Inception_V3_Weights, inception_v3
from torchvision.models.feature_extraction import create_feature_extractor

LOGGER = logging.getLogger("deepdream_v3_export")
TAPS = ("5b", "5c", "6a", "6b", "6c")
BASE_SHAPE = (512, 512)
SCALE = 1.4


class DeepDreamV3Step(nn.Module):
    def __init__(self, turbo: bool = False):
        super().__init__()
        base = inception_v3(
            weights=Inception_V3_Weights.DEFAULT,
            transform_input=False,
        )
        base.aux_logits = False
        base.AuxLogits = None
        base.eval()
        for parameter in base.parameters():
            parameter.requires_grad = False
        self.extractor = create_feature_extractor(
            base,
            return_nodes={f"Mixed_{name}": name for name in TAPS},
        )
        self.turbo = bool(turbo)
        self.register_buffer(
            "imagenet_mean",
            torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32).view(1, 3, 1, 1),
        )
        self.register_buffer(
            "imagenet_std",
            torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32).view(1, 3, 1, 1),
        )

    def _normalize(self, image: torch.Tensor) -> torch.Tensor:
        return (image - self.imagenet_mean) / self.imagenet_std

    def _objective(self, image: torch.Tensor, *weights: torch.Tensor) -> torch.Tensor:
        features = self.extractor(image)
        terms = [
            weight.reshape(()) * features[name].mean()
            for name, weight in zip(TAPS, weights)
        ]
        return torch.stack(terms).sum()

    def forward(
        self,
        image_tensor: torch.Tensor,
        learning_rate: torch.Tensor,
        w_5b: torch.Tensor,
        w_5c: torch.Tensor,
        w_6a: torch.Tensor,
        w_6b: torch.Tensor,
        w_6c: torch.Tensor,
    ) -> torch.Tensor:
        normalized = self._normalize(image_tensor)
        gradient = grad(self._objective)(
            normalized,
            w_5b,
            w_5c,
            w_6a,
            w_6b,
            w_6c,
        )
        gradient = gradient / (gradient.abs().mean() + 1e-8)
        rate = learning_rate.reshape(1, 1, 1, 1)
        return torch.clamp(image_tensor + rate * gradient, 0.0, 1.0)

    def forward_turbo(
        self,
        image_tensor: torch.Tensor,
        w_5b: torch.Tensor,
        w_5c: torch.Tensor,
        w_6a: torch.Tensor,
        w_6b: torch.Tensor,
        w_6c: torch.Tensor,
    ) -> torch.Tensor:
        normalized = self._normalize(image_tensor)
        features = self.extractor(normalized)
        target_size = image_tensor.shape[-2:]
        saliency = image_tensor.new_zeros((image_tensor.shape[0], 1, *target_size))
        for name, weight in zip(TAPS, (w_5b, w_5c, w_6a, w_6b, w_6c)):
            activation = features[name].mean(dim=1, keepdim=True)
            activation = F.interpolate(
                activation,
                size=target_size,
                mode="bilinear",
                align_corners=False,
            )
            saliency = saliency + weight.reshape(1, 1, 1, 1) * activation
        low = saliency.amin(dim=(-2, -1), keepdim=True)
        high = saliency.amax(dim=(-2, -1), keepdim=True)
        return torch.clamp((saliency - low) / (high - low + 1e-6), 0.0, 1.0)


def _zero_insert_1d(value: torch.Tensor, dim: int, stride: int) -> torch.Tensor:
    if stride == 1:
        return value
    moved = value.movedim(dim, -1)
    count = moved.shape[-1]
    zeros = torch.zeros(
        *moved.shape[:-1],
        count,
        stride - 1,
        device=value.device,
        dtype=value.dtype,
    )
    interleaved = torch.cat([moved.unsqueeze(-1), zeros], dim=-1)
    return interleaved.reshape(*moved.shape[:-1], count * stride).movedim(-1, dim)


def _flip_and_transpose_weight(weight: torch.Tensor, groups: int) -> torch.Tensor:
    out_channels, in_channels, kernel_h, kernel_w = weight.shape
    out_per_group = out_channels // groups
    value = weight.reshape(groups, out_per_group, in_channels, kernel_h, kernel_w)
    value = value.transpose(1, 2)
    value = torch.flip(value, dims=[-2, -1])
    return value.reshape(groups * in_channels, out_per_group, kernel_h, kernel_w).contiguous()


def _conv_transpose_as_forward_conv(
    grad_output: torch.Tensor,
    weight: torch.Tensor,
    stride: list[int],
    padding: list[int],
    dilation: list[int],
    output_padding: list[int],
    groups: int,
    output_shape: tuple[int, int],
) -> torch.Tensor:
    output_h, output_w = output_shape
    kernel_h, kernel_w = weight.shape[-2:]
    stride_h, stride_w = stride
    padding_h, padding_w = padding
    dilation_h, dilation_w = dilation
    needed_h = min(grad_output.shape[2], (output_h + padding_h + stride_h - 1) // stride_h)
    needed_w = min(grad_output.shape[3], (output_w + padding_w + stride_w - 1) // stride_w)
    value = grad_output[:, :, :needed_h, :needed_w]
    for dim, amount in zip((2, 3), stride):
        value = _zero_insert_1d(value, dim, amount)
    insert_h, insert_w = value.shape[2:]
    pad_top = max(0, dilation_h * (kernel_h - 1) - padding_h)
    pad_left = max(0, dilation_w * (kernel_w - 1) - padding_w)
    pad_bottom = max(0, output_h - (insert_h - pad_top))
    pad_right = max(0, output_w - (insert_w - pad_left))
    value = torch.ops.aten.constant_pad_nd(
        value,
        [pad_left, pad_right, pad_top, pad_bottom],
        0.0,
    )
    value = torch.ops.aten.convolution(
        value,
        _flip_and_transpose_weight(weight, groups),
        None,
        [1, 1],
        [0, 0],
        list(dilation),
        False,
        [0, 0],
        groups,
    )
    return value[:, :, :output_h, :output_w]


def _convolution_backward_decomp(
    grad_output: torch.Tensor,
    input: torch.Tensor,
    weight: torch.Tensor,
    bias_sizes: list[int] | None,
    stride: list[int],
    padding: list[int],
    dilation: list[int],
    transposed: bool,
    output_padding: list[int],
    groups: int,
    output_mask: list[bool],
) -> tuple[torch.Tensor | None, torch.Tensor | None, torch.Tensor | None]:
    grad_input = grad_weight = grad_bias = None
    if output_mask[0]:
        if not transposed:
            output_padding_needed = []
            for index in range(len(stride)):
                expected = (
                    (grad_output.shape[2 + index] - 1) * stride[index]
                    - 2 * padding[index]
                    + dilation[index] * (weight.shape[2 + index] - 1)
                    + 1
                )
                output_padding_needed.append(input.shape[2 + index] - expected)
            grad_input = _conv_transpose_as_forward_conv(
                grad_output,
                weight,
                stride,
                padding,
                dilation,
                output_padding_needed,
                groups,
                tuple(input.shape[2:]),
            )
        else:
            grad_input = torch.ops.aten.convolution(
                grad_output,
                weight,
                None,
                stride,
                padding,
                dilation,
                False,
                [0] * len(stride),
                groups,
            )
    if output_mask[1]:
        grad_weight = torch.zeros_like(weight)
    if output_mask[2]:
        grad_bias = torch.zeros(
            weight.shape[0], device=grad_output.device, dtype=grad_output.dtype
        )
    return grad_input, grad_weight, grad_bias


def _avg_pool2d_backward_decomp(
    grad_output: torch.Tensor,
    input: torch.Tensor,
    kernel_size: list[int],
    stride: list[int],
    padding: list[int],
    ceil_mode: bool,
    count_include_pad: bool,
    divisor_override: int | None,
) -> torch.Tensor:
    channels = input.shape[1]
    kernel_h, kernel_w = kernel_size
    divisor = divisor_override if divisor_override is not None else kernel_h * kernel_w
    weight = torch.ones(
        channels,
        1,
        kernel_h,
        kernel_w,
        device=grad_output.device,
        dtype=grad_output.dtype,
    ) / divisor
    output_padding = []
    for index in range(len(stride)):
        expected = (
            (grad_output.shape[2 + index] - 1) * stride[index]
            - 2 * padding[index]
            + kernel_size[index]
        )
        output_padding.append(max(0, input.shape[2 + index] - expected))
    return _conv_transpose_as_forward_conv(
        grad_output,
        weight,
        list(stride),
        list(padding),
        [1, 1],
        output_padding,
        channels,
        tuple(input.shape[2:]),
    )


def _max_pool2d_with_indices_backward_decomp(
    grad_output: torch.Tensor,
    input: torch.Tensor,
    kernel_size: list[int],
    stride: list[int],
    padding: list[int],
    dilation: list[int],
    ceil_mode: bool,
    indices: torch.Tensor,
) -> torch.Tensor:
    _, channels, height, width = input.shape
    kernel_h, kernel_w = kernel_size
    stride_h, stride_w = stride
    padding_h, padding_w = padding
    dilation_h, dilation_w = dilation
    output_h, output_w = grad_output.shape[2:]
    maximum = torch.ops.aten.max_pool2d(
        input,
        kernel_size,
        stride,
        padding,
        dilation,
        ceil_mode,
    )
    result = torch.zeros_like(input)
    identity = torch.ones(
        channels,
        1,
        1,
        1,
        device=input.device,
        dtype=input.dtype,
    )
    padded = torch.ops.aten.constant_pad_nd(
        input,
        [padding_w, padding_w, padding_h, padding_h],
        0.0,
    )
    for kernel_row in range(kernel_h):
        for kernel_col in range(kernel_w):
            row = kernel_row * dilation_h - padding_h
            col = kernel_col * dilation_w - padding_w
            window = padded[
                :,
                :,
                kernel_row * dilation_h : kernel_row * dilation_h + output_h * stride_h : stride_h,
                kernel_col * dilation_w : kernel_col * dilation_w + output_w * stride_w : stride_w,
            ]
            contribution = grad_output * (window == maximum).to(grad_output.dtype)
            result = result + _conv_transpose_as_forward_conv(
                contribution,
                identity,
                [stride_h, stride_w],
                [-row, -col],
                [1, 1],
                [0, 0],
                channels,
                (height, width),
            )
    return result


def _decompositions() -> dict[Any, Any]:
    from torch._decomp import core_aten_decompositions

    table = core_aten_decompositions()
    table[torch.ops.aten.convolution_backward.default] = _convolution_backward_decomp
    table[torch.ops.aten.avg_pool2d_backward.default] = _avg_pool2d_backward_decomp
    table[torch.ops.aten.max_pool2d_with_indices_backward.default] = (
        _max_pool2d_with_indices_backward_decomp
    )
    return table


def _dummy_inputs(shape: tuple[int, int], kind: str) -> tuple[torch.Tensor, ...]:
    height, width = shape
    image = torch.rand(1, 3, height, width, dtype=torch.float32)
    weights = tuple(
        torch.tensor([value], dtype=torch.float32)
        for value in (1.0, 0.75, 1.25, 0.5, 2.0)
    )
    if kind == "turbo":
        return (image, *weights)
    return (image, torch.tensor([0.01], dtype=torch.float32), *weights)


def _trace(model: DeepDreamV3Step, inputs: tuple[torch.Tensor, ...], kind: str):
    if kind == "turbo":
        def function(*args):
            return model.forward_turbo(*args)
    else:
        def function(*args):
            return model(*args)
    traced = make_fx(
        function,
        tracing_mode="real",
        decomposition_table=_decompositions(),
    )(*inputs)
    traced.eval()
    remaining = [
        node.target.__name__
        for node in traced.graph.nodes
        if node.op == "call_function"
        and hasattr(node.target, "__name__")
        and "backward" in node.target.__name__.lower()
    ]
    if remaining:
        raise RuntimeError(f"backward operators remain after decomposition: {sorted(set(remaining))}")
    return traced


def _export_onnx(
    traced: Any,
    inputs: tuple[torch.Tensor, ...],
    path: Path,
    kind: str,
) -> None:
    if kind == "turbo":
        input_names = ["image_tensor", *[f"w_{name}" for name in TAPS]]
        output_names = ["saliency_map"]
    else:
        input_names = ["image_tensor", "learning_rate", *[f"w_{name}" for name in TAPS]]
        output_names = ["dreamed_image"]
    try:
        torch.onnx.export(
            traced,
            inputs,
            str(path),
            input_names=input_names,
            output_names=output_names,
            opset_version=18,
        )
    except Exception as legacy_error:
        try:
            torch.onnx.export(
                traced,
                inputs,
                str(path),
                input_names=input_names,
                output_names=output_names,
                dynamo=True,
            )
        except Exception as dynamo_error:
            raise RuntimeError(
                f"ONNX export failed (legacy={legacy_error}; dynamo={dynamo_error})"
            ) from dynamo_error


def export_model_for_shape(
    shape: tuple[int, int],
    *,
    kind: str = "ascent",
    output_dir: str | Path | None = None,
    force: bool = False,
) -> tuple[Path, Path]:
    if kind not in ("ascent", "turbo"):
        raise ValueError(f"unsupported V3 model kind: {kind}")
    height, width = (int(shape[0]), int(shape[1]))
    if height < 160 or width < 160:
        raise ValueError(f"V3 shape must be at least 160x160, got {height}x{width}")
    directory = Path(output_dir) if output_dir else Path(__file__).resolve().parent.parent / "junk" / "models" / "deepdream_ov_v3"
    directory.mkdir(parents=True, exist_ok=True)
    prefix = "static_deepdream_v3_turbo_" if kind == "turbo" else "static_deepdream_v3_"
    onnx_path = directory / f"{prefix}{height}x{width}.onnx"
    ir_path = directory / f"{prefix}{height}x{width}_fp16.xml"
    bin_path = directory / f"{prefix}{height}x{width}_fp16.bin"
    if ir_path.is_file() and bin_path.is_file() and not force:
        return onnx_path, ir_path

    model = DeepDreamV3Step(turbo=kind == "turbo").eval()
    inputs = _dummy_inputs((height, width), kind)
    LOGGER.info("Tracing %s %dx%d", kind, height, width)
    traced = _trace(model, inputs, kind)
    with torch.no_grad():
        original = model.forward_turbo(*inputs) if kind == "turbo" else model(*inputs)
        traced_output = traced(*inputs)
        max_difference = float((original - traced_output).abs().max())
    if max_difference > 5e-3:
        raise RuntimeError(
            f"traced graph differs from PyTorch for {kind} {height}x{width}: {max_difference}"
        )
    LOGGER.info("Exporting ONNX %s", onnx_path)
    _export_onnx(traced, inputs, onnx_path, kind)
    import openvino as ov

    LOGGER.info("Converting OpenVINO IR %s", ir_path)
    converted = ov.convert_model(str(onnx_path))
    ov.save_model(converted, str(ir_path), compress_to_fp16=True)
    return onnx_path, ir_path


def octave_shapes(num_octaves: int = 4) -> list[tuple[int, int]]:
    count = int(num_octaves)
    if count < 1 or count > 4:
        raise ValueError(f"V3 export supports 1–4 octaves, got {num_octaves}")
    return [
        (
            int(BASE_SHAPE[0] / SCALE ** (count - 1 - index)),
            int(BASE_SHAPE[1] / SCALE ** (count - 1 - index)),
        )
        for index in range(count)
    ]


def export_all(
    *,
    kind: str = "both",
    num_octaves: int = 4,
    output_dir: str | Path | None = None,
    force: bool = False,
) -> list[tuple[Path, Path]]:
    kinds = ("ascent", "turbo") if kind == "both" else (kind,)
    output: list[tuple[Path, Path]] = []
    for shape in octave_shapes(num_octaves):
        for model_kind in kinds:
            output.append(
                export_model_for_shape(
                    shape,
                    kind=model_kind,
                    output_dir=output_dir,
                    force=force,
                )
            )
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="export_v3.py")
    parser.add_argument("--kind", choices=("ascent", "turbo", "both"), default="both")
    parser.add_argument("--octaves", type=int, default=4)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    for onnx_path, ir_path in export_all(
        kind=args.kind,
        num_octaves=args.octaves,
        output_dir=args.out_dir,
        force=args.force,
    ):
        print(f"{onnx_path}\n{ir_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
