"""Validation gate unit tests (no services needed)."""

import pytest

from app.services.validation import ValidationFailure, validate
from workers.connectors.blinkit import BlinkitConnector

COLS = BlinkitConnector.COLUMNS["inventory"]
HDR = "item_id,item_name,total_qty,last_updated\n"
ROW = "BLK-1,Oil,10,2026-01-01T00:00:00+00:00\n"


def run(payload, hint=None, hist=None):
    return validate(dataset="inventory", payload=payload, columns=COLS, row_hint=hint,
                    history_counts=hist)


def test_valid_and_reordered_columns_are_not_drift():
    assert run(HDR + ROW, hint=1)[0]["units"] == 10
    reordered = "total_qty,item_id,last_updated,item_name\n10,BLK-1,2026-01-01T00:00:00+00:00,Oil\n"
    assert run(reordered)[0]["sku"] == "BLK-1"


def test_renamed_column_is_drift():
    with pytest.raises(ValidationFailure) as e:
        run(HDR.replace("total_qty", "qty_total") + ROW)
    assert e.value.kind == "SCHEMA_DRIFT" and e.value.details["missing"] == ["total_qty"]


def test_truncated_tail_and_hint_mismatch_are_partial():
    with pytest.raises(ValidationFailure) as e:
        run(HDR + ROW + "BLK-2,Gh")
    assert e.value.kind == "PARTIAL_PULL" and "truncated" in e.value.reason
    with pytest.raises(ValidationFailure) as e:
        run(HDR + ROW, hint=5)
    assert e.value.kind == "PARTIAL_PULL"


def test_type_violation_and_future_timestamp():
    with pytest.raises(ValidationFailure) as e:
        run(HDR + "BLK-1,Oil,-3,2026-01-01T00:00:00+00:00\n")
    assert e.value.kind == "SCHEMA_DRIFT" and e.value.details["error_count"] == 1
    with pytest.raises(ValidationFailure, match="future"):
        run(HDR + "BLK-1,Oil,3,2999-01-01T00:00:00+00:00\n")


def test_row_count_band():
    run(HDR + ROW * 10, hist=[10, 11, 10])
    with pytest.raises(ValidationFailure, match="below band"):
        run(HDR + ROW * 3, hist=[10, 11, 10])
    run(HDR + ROW * 3, hist=[10])  # warm-up: not enough history, no false alarm
