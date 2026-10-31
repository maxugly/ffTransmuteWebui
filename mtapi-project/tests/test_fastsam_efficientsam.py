import pytest
import numpy as np
import cv2
from pathlib import Path
from app.operations.fastsam_ops import FastSAMParams, fastsam_op
from app.filters.fastsam import (
    is_yoloe,
    is_efficient_sam,
    ensure_openvino_model,
    get_runtime_model,
    predict_runtime,
    get_target_mask,
    EfficientSAMResult,
    EfficientSAMPredictor,
)


def test_fastsam_params_defaults_and_options():
    p_default = FastSAMParams(input_path="/tmp/fake.png")
    assert p_default.model_id == "efficient-sam-vitt"

    p_fastsam_s = FastSAMParams(input_path="/tmp/fake.png", model_id="FastSAM-s")
    assert p_fastsam_s.model_id == "FastSAM-s"

    p_fastsam_x = FastSAMParams(input_path="/tmp/fake.png", model_id="FastSAM-x")
    assert p_fastsam_x.model_id == "FastSAM-x"


def test_is_efficient_sam_detection():
    assert is_efficient_sam("efficient-sam-vitt")
    assert is_efficient_sam("efficient-sam-vits")
    assert is_efficient_sam("EfficientSAM-ti")
    assert not is_efficient_sam("FastSAM-s")
    assert not is_efficient_sam("FastSAM-x")


def test_get_target_mask_efficient_sam_result():
    dummy_mask = np.ones((50, 50), dtype=np.uint8)
    everything = [dummy_mask, dummy_mask * 0]
    res = EfficientSAMResult(dummy_mask, everything_masks=everything)

    # Target mode
    target_out = get_target_mask(res, (50, 50), "target", 0.5, 0.5)
    assert np.array_equal(target_out, dummy_mask)

    # Everything mode
    everything_out = get_target_mask(res, (50, 50), "everything", 0.5, 0.5)
    assert len(everything_out) == 2
    assert np.array_equal(everything_out[0], dummy_mask)


def test_efficientsam_e2e_inference():
    # Use CPU for deterministic lightweight test
    model_path = ensure_openvino_model("efficient-sam-vitt", device="CPU")
    assert Path(model_path).is_file()
    assert model_path.endswith(".xml")

    predictor = get_runtime_model(model_path, keep_warm=False, model_id="efficient-sam-vitt", device="CPU")
    assert isinstance(predictor, EfficientSAMPredictor)

    # Synthetic image with a white circle in the center
    img = np.zeros((120, 120, 3), dtype=np.uint8)
    cv2.circle(img, (60, 60), 20, (255, 255, 255), -1)

    results = predict_runtime(
        predictor, img,
        model_id="efficient-sam-vitt",
        model_path=model_path,
        target_x=0.5,
        target_y=0.5,
        mode="target",
    )
    assert len(results) == 1
    assert isinstance(results[0], EfficientSAMResult)
    mask = get_target_mask(results[0], img.shape, "target", 0.5, 0.5)
    assert mask is not None
    assert mask.shape == (120, 120)
    # White circle has radius 20, area ~ 1256 pixels
    assert 500 < mask.sum() < 2500


def test_yoloe_params_and_detection():
    p = FastSAMParams(input_path="/tmp/fake.png", model_id="yoloe-26n-seg", text_prompt="hero, sword")
    assert p.model_id == "yoloe-26n-seg"
    assert p.text_prompt == "hero, sword"
    assert is_yoloe("yoloe-26n-seg")
    assert is_yoloe("yoloe-26n")
    assert not is_yoloe("efficient-sam-vitt")


@pytest.mark.anyio
async def test_yoloe_dry_run():
    p = FastSAMParams(
        input_path="/tmp/test_image.png",
        model_id="yoloe-26n-seg",
        text_prompt="character, vehicle",
        dry_run=True,
    )
    # Create fake input file for validation
    fake_path = Path("/tmp/test_image.png")
    fake_path.write_bytes(b"dummy")
    try:
        res = await fastsam_op(p)
        assert res.ok is True
        assert res.dry_run is True
        assert "yoloe-26n-seg" in res.stdout
        assert "prompt=character, vehicle" in res.stdout
    finally:
        if fake_path.exists():
            fake_path.unlink()


def test_yoloe_e2e_inference():
    model_path = ensure_openvino_model("yoloe-26n-seg", device="CPU")
    assert Path(model_path).is_file()

    model = get_runtime_model(model_path, keep_warm=False, model_id="yoloe-26n-seg", device="CPU")
    assert hasattr(model, "set_classes")
    assert hasattr(model, "predict")

    bus_path = Path(__file__).resolve().parent.parent / "junk" / "bus.jpg"
    if not bus_path.is_file():
        pytest.skip("junk/bus.jpg not found for real inference test")

    img = cv2.imread(str(bus_path))
    results = predict_runtime(
        model, img,
        model_id="yoloe-26n-seg",
        model_path=model_path,
        conf=0.25,
        iou=0.7,
        text_prompt="bus, person",
    )
    assert len(results) >= 1
    res0 = results[0]
    assert hasattr(res0, "masks") and res0.masks is not None
    assert len(res0.masks.xy) > 0

    target_mask = get_target_mask(res0, img.shape, "target", 0.5, 0.5)
    assert target_mask is not None
    assert target_mask.shape == (img.shape[0], img.shape[1])
    assert target_mask.sum() > 0
