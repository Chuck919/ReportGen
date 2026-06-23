#!/usr/bin/env python3
"""Extract tax workbook ground truth from Blue Owl integrator .xls files."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import xlrd

LABEL_TO_ID: dict[str, str] = {
    "sales (income)": "sales",
    "cost of sales (cogs)": "cogs",
    "depreciation": "depreciation",
    "amortization": "amortization",
    "compensation of officers": "officer_compensation",
    "officer compensation": "officer_compensation",
    "salaries and wages": "salaries_wages",
    "advertising": "advertising",
    "rents": "rent",
    "rent": "rent",
    "taxes and licenses": "taxes_licenses",
    "legal and professional": "professional_fees",
    "professional services": "professional_fees",
    "professional fees": "professional_fees",
    "utilities": "utilities",
    "other operating income": "other_operating_income",
    "other operating expenses": "other_operating_expenses",
    "interest expense": "interest_expense",
    "other income": "other_income",
    "other expenses": "other_expenses",
    "adjusted owner's compensation": "adjusted_owner_compensation",
    "taxes paid": "taxes_paid",
    "extraordinary gain": "extraordinary_gain",
    "extraordinary loss": "extraordinary_loss",
    "cash (bank funds)": "cash",
    "accounts receivable": "accounts_receivable",
    "inventory": "inventory",
    "other current assets": "other_current_assets",
    "gross fixed assets": "gross_fixed_assets",
    "accumulated depreciation": "accumulated_depreciation",
    "gross intangible assets": "gross_intangible_assets",
    "accumulated amortization": "accumulated_amortization",
    "other assets": "other_assets",
    "accounts payable": "accounts_payable",
    "short term debt": "short_term_debt",
    "notes payable/ current portion of long term debt": "current_portion_ltd",
    "other current liabilities": "other_current_liabilities",
    "notes minus short-term": "notes_minus_short_term",
    "subordinated": "subordinated",
    "other long term liabilities": "other_long_term_liabilities",
    "preferred stock": "preferred_stock",
    "common stock": "common_stock",
    "additional paid-in capital": "additional_paid_in_capital",
    "other stock/ equity": "other_stock_equity",
    "unclassified equity": "unclassified_equity",
}


def norm_label(s: str) -> str:
    return re.sub(r"\s+", " ", str(s).strip().lower())


def excel_year_columns(sh: xlrd.sheet.Sheet) -> dict[int, int]:
    """Map calendar year -> column index from row 17 Julian dates."""
    out: dict[int, int] = {}
    for col in range(1, sh.ncols):
        raw = sh.cell_value(17, col)
        if not isinstance(raw, (int, float)) or raw < 30000:
            continue
        dt = xlrd.xldate.xldate_as_datetime(raw, 0)
        out[dt.year] = col
    return out


def extract_file(path: Path, fixture_prefix: str) -> dict[str, dict]:
    wb = xlrd.open_workbook(str(path))
    sh = wb.sheet_by_index(0)
    year_cols = excel_year_columns(sh)
    fixtures: dict[str, dict] = {}

    for year, col in sorted(year_cols.items()):
        values: dict[str, int] = {}
        for row in range(sh.nrows):
            label = norm_label(sh.cell_value(row, 0))
            field_id = LABEL_TO_ID.get(label)
            if not field_id:
                continue
            raw = sh.cell_value(row, col)
            if raw == "" or raw is None:
                continue
            if not isinstance(raw, (int, float)):
                continue
            num = int(round(raw))
            # Accumulated depr/amort sometimes stored negative in integrator
            if field_id in ("accumulated_depreciation", "accumulated_amortization") and num < 0:
                num = abs(num)
            values[field_id] = num

        key = f"{fixture_prefix} / {year}"
        fixtures[key] = {"year": year, "values": values}

    return fixtures


def main() -> None:
    root = Path(__file__).resolve().parents[2] / "Documents" / "For Changwen"
    clients = [
        ("carithers-liquor/integrator.xls", "carithers-liquor/integrator.xls"),
        ("strategic-solution-services/integrator.xls", "strategic-solution-services/integrator.xls"),
        ("arizona-sun-supply/integrator.xls", "arizona-sun-supply/integrator.xls"),
    ]
    all_fixtures: dict[str, dict] = {}
    for rel, prefix in clients:
        path = root / rel
        if not path.exists():
            print(f"skip missing {path}", file=sys.stderr)
            continue
        extracted = extract_file(path, prefix)
        all_fixtures.update(extracted)
        print(f"{prefix}: years {sorted(v['year'] for v in extracted.values())}", file=sys.stderr)

    out = Path(__file__).resolve().parent / "changwen-fixtures.json"
    out.write_text(json.dumps(all_fixtures, indent=2), encoding="utf-8")
    print(str(out))


if __name__ == "__main__":
    main()
