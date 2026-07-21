"""
Extract valuation assumptions from the KCF integrator workbook.

This is intentionally lightweight: it reads cached values and key cells that
represent the model's assumptions (build-up method, growth, DLOM).

Usage:
  python scripts/extract-kcf-excel-assumptions.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import openpyxl


ROOT = Path(__file__).resolve().parents[1]
XLSX = Path(os.environ.get("KCF_XLSX", ROOT.parent / "Documents" / "KCF MAIN CURRENT EXCEL.xlsx"))
OUT = ROOT / "scripts" / "benchmark-output" / "kcf-excel-assumptions.json"


def n(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def main():
    wb = openpyxl.load_workbook(XLSX, data_only=True)

    dp = wb["3 D&P"]
    dlom = wb["DLOM"]

    # From the visible build-up table (see sheet labels in column A).
    risk_free = n(dp["E6"].value)
    equity_risk = n(dp["E7"].value)
    size_premium = n(dp["E8"].value)
    return_excess = n(dp["E9"].value)  # return in excess of risk-free (includes components)
    industry_risk = n(dp["E10"].value)
    company_specific_total = n(dp["E16"].value)
    growth = n(dp["E18"].value)
    pre_tax_cap_rate = n(dp["E23"].value)

    # DLOM sheet has a computed/selected discount around row 14–16.
    dlom_value = n(dlom["D14"].value) or n(dlom["E16"].value)

    out = {
        "sourceWorkbook": str(XLSX),
        "assumptions": {
            "riskFreeRate": risk_free,
            "equityRiskPremium": equity_risk,
            "sizePremium": size_premium,
            "returnInExcessOfRiskFree": return_excess,
            "industryRiskPremium": industry_risk,
            "companySpecificRiskTotal": company_specific_total,
            "longTermGrowthRate": growth,
            "preTaxNetIncomeCapRate": pre_tax_cap_rate,
            "dlomRate": dlom_value,
        },
        "cells": {
            "riskFreeRate": "3 D&P!E6",
            "equityRiskPremium": "3 D&P!E7",
            "sizePremium": "3 D&P!E8",
            "returnInExcessOfRiskFree": "3 D&P!E9",
            "industryRiskPremium": "3 D&P!E10",
            "companySpecificRiskTotal": "3 D&P!E16",
            "longTermGrowthRate": "3 D&P!E18",
            "preTaxNetIncomeCapRate": "3 D&P!E23",
            "dlomRatePrimary": "DLOM!D14",
            "dlomRateFallback": "DLOM!E16",
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("Wrote", OUT)


if __name__ == "__main__":
    main()

