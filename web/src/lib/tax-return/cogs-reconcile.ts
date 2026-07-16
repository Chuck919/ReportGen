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
 * Identity-only COGS reconcile — no sales-% or dollar floors.
 * - Comparison ≈ sales − form → comparison was gross profit; keep Form.
 * - Form much larger than comparison (comparison ≤ half) → comparison is a crumb; keep Form.
 * - Otherwise prefer comparison (two-year column / worksheet is usually the target year).
 */
export function reconcileCogsFromSources(input: CogsReconcileInput): CogsReconcileResult | null {
  const formCogs = input.formCogs;
  const comparisonCogs = input.comparisonCogs;
  const formConfidence = input.formConfidence ?? 0;
  const formSource = input.formSource ?? "Form 1120-S line 2";
  const sales = input.sales;

  if (comparisonCogs !== undefined && formCogs !== undefined) {
    const scale = Math.max(Math.abs(formCogs), Math.abs(comparisonCogs), 1);
    if (Math.abs(formCogs - comparisonCogs) <= Math.max(1, scale * 0.001)) return null;

    if (sales !== undefined && sales > formCogs) {
      const grossProfit = sales - formCogs;
      if (Math.abs(comparisonCogs - grossProfit) <= Math.max(1, Math.abs(grossProfit) * 0.001)) {
        return {
          value: formCogs,
          confidence: formConfidence || 97,
          source: `${formSource} (comparison row was gross profit)`,
        };
      }
    }

    // Comparison is a partial read vs Form (e.g. worksheet vs 1125-A) — structural, not sales-%.
    if (formCogs > 0 && comparisonCogs > 0 && comparisonCogs * 2 <= formCogs) {
      return {
        value: formCogs,
        confidence: Math.max(formConfidence, 96),
        source: `${formSource} (preferred over comparison crumb)`,
      };
    }

    // Close or same-order disagreement: comparison year column wins (AZ prior vs current).
    return {
      value: comparisonCogs,
      confidence: input.comparisonConfidence ?? 92,
      source: "Two-year comparison (COGS row — form year column mismatch)",
    };
  }

  if (formCogs !== undefined && formConfidence >= 96) {
    return {
      value: formCogs,
      confidence: formConfidence,
      source: formSource,
    };
  }

  if (comparisonCogs !== undefined) {
    return {
      value: comparisonCogs,
      confidence: input.comparisonConfidence ?? 90,
      source: "Two-year comparison (COGS row)",
    };
  }

  return null;
}
