/** Resolve COGS when form line 2 and two-year comparison disagree. */

export type CogsReconcileInput = {
  formCogs?: number;
  formConfidence?: number;
  formSource?: string;
  comparisonCogs?: number;
  comparisonConfidence?: number;
  sales?: number;
};

export type CogsReconcileResult = {
  value: number;
  confidence: number;
  source: string;
};

/**
 * Comparison worksheets sometimes capture gross profit (sales − COGS) instead of COGS.
 * Form 1120-S line 2 can also land in the wrong year column — prefer comparison only
 * when the disagreement is not a gross-profit misread and form confidence is weak.
 */
export function reconcileCogsFromSources(input: CogsReconcileInput): CogsReconcileResult | null {
  const formCogs = input.formCogs;
  const comparisonCogs = input.comparisonCogs;
  const formConfidence = input.formConfidence ?? 0;
  const formSource = input.formSource ?? "Form 1120-S line 2";
  const sales = input.sales;

  if (comparisonCogs !== undefined && comparisonCogs >= 10_000 && formCogs !== undefined) {
    const relDiff = Math.abs(formCogs - comparisonCogs) / Math.max(comparisonCogs, 1);
    if (relDiff <= 0.015) return null;

    if (sales !== undefined && sales > formCogs) {
      const grossProfit = sales - formCogs;
      if (Math.abs(comparisonCogs - grossProfit) / Math.max(grossProfit, 1) < 0.025) {
        return {
          value: formCogs,
          confidence: formConfidence || 97,
          source: `${formSource} (comparison row was gross profit)`,
        };
      }
    }

    // Form line 2 can OCR to a tiny fraction of sales while comparison has the real COGS row.
    if (sales !== undefined && sales > 0) {
      const formRatio = formCogs / sales;
      const compRatio = comparisonCogs / sales;
      if (formRatio < 0.08 && compRatio >= 0.12 && compRatio <= 0.95) {
        return {
          value: comparisonCogs,
          confidence: input.comparisonConfidence ?? 92,
          source: "Two-year comparison (COGS row — form line 2 implausibly low)",
        };
      }
    }

    return {
      value: comparisonCogs,
      confidence: input.comparisonConfidence ?? 92,
      source: "Two-year comparison (COGS row — form year column mismatch)",
    };
  }

  if (formCogs !== undefined && formCogs >= 10_000 && formConfidence >= 96) {
    return {
      value: formCogs,
      confidence: formConfidence,
      source: formSource,
    };
  }

  if (comparisonCogs !== undefined && comparisonCogs >= 10_000) {
    return {
      value: comparisonCogs,
      confidence: input.comparisonConfidence ?? 90,
      source: "Two-year comparison (COGS row)",
    };
  }

  return null;
}
