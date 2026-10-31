import pytest
import numpy as np
import cv2
from pathlib import Path
from app.operations.depthmap_ops import DepthmapParams, depthmap_op
from app.filters.depthmap import (
    ensure_depth_model,
    get_runtime_model,
    predict_depth_runtime,
    DepthEstimatorPredictor,
)
from app.contract import REGISTRY


def test_depthmap_contract_and_params():
    import app.operations  # ensures registration
    spec = REGISTRY.get("depthmap")
    assert spec is not None
    assert spec.id == "depthmap"
    assert spec.params_model is DepthmapParams

    p = DepthmapParams(input_path="/tmp/test.jpg")
    assert p.device == "CPU"
    assert p.colormap == "grayscale"
    assert p.invert is False
    assert p.input_size == 518
    assert p.model_id == "depth-anything-v2-small"


def test_depthmap_model_loading_and_inference():
    model_path = ensure_depth_model("depth-anything-v2-small", device="CPU")
    assert Path(model_path).is_file()
    assert model_path.endswith(".xml")

    model = get_runtime_model(model_path, keep_warm=False, model_id="depth-anything-v2-small", device="CPU")
    assert isinstance(model, DepthEstimatorPredictor)

    # Test image (200x200 RGB) with distinct foreground circle
    img = np.zeros((200, 200, 3), dtype=np.uint8)
    cv2.circle(img, (100, 100), 50, (255, 255, 255), -1)

    out_gray = predict_depth_runtime(
        model, img,
        model_id="depth-anything-v2-small",
        model_path=model_path,
        device="CPU",
        input_size=392,
        colormap="grayscale",
        invert=False,
    )
    assert out_gray.shape == (200, 200, 3)
    assert out_gray.dtype == np.uint8
    assert out_gray.min() >= 0
    assert out_gray.max() <= 255

    # Test colormap (inferno)
    out_inferno = predict_depth_runtime(
        model, img,
        model_id="depth-anything-v2-small",
        model_path=model_path,
        device="CPU",
        input_size=392,
        colormap="inferno",
        invert=False,
    )
    assert out_inferno.shape == (200, 200, 3)

    # Test inverted
    out_inv = predict_depth_runtime(
        model, img,
        model_id="depth-anything-v2-small",
        model_path=model_path,
        device="CPU",
        input_size=392,
        colormap="grayscale",
        invert=True,
    )
    assert out_inv.shape == (200, 200, 3)


@pytest.mark.anyio
async def test_depthmap_dry_run():
    # Dry run should succeed without running heavy pipeline
    p = DepthmapParams(input_path="/tmp/fake_image.png", dry_run=True)
    # create fake file
    fake_file = Path("/tmp/fake_image.png")
    fake_file.write_text("fake")
    try:
        res = await depthmap_op(p)
        assert res.ok is True
        assert res.dry_run is True
        assert "depthmap stage" in res.stdout
    finally:
        fake_file.unlink(missing_ok=True)
