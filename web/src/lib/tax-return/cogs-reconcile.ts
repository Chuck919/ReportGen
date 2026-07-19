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
 * - Direct Form page-1 line 2 beats a disagreeing comparison row.
 * - Otherwise prefer comparison (its target-year column is structurally identified).
 */
export function reconcileCogsFromSources(input: CogsReconcileInput): CogsReconcileResult | null {
  const formCogs = input.formCogs;
  const comparisonCogs = input.comparisonCogs;
  const formConfidence = input.formConfidence ?? 0;
  const formSource = input.formSource ?? "Form 1120-S line 2";
  const sales = input.sales;

  if (comparisonCogs !== undefined && formCogs !== undefined) {
    // Exact-dollar agreement only (charter exactClosureTolerance $1 — no relative bands).
    if (Math.abs(formCogs - comparisonCogs) <= 1) return null;

    if (sales !== undefined && sales > formCogs) {
      const grossProfit = sales - formCogs;
      if (Math.abs(comparisonCogs - grossProfit) <= 1) {
        return {
          value: formCogs,
          confidence: formConfidence || 97,
          source: `${formSource} (comparison row was gross profit)`,
        };
      }
    }

    // Source identity, not a confidence cutoff, establishes Form authority.
    if (/form\s*1120(?:-s)?\s*(?:page\s*1\s*)?line\s*2\b|page\s*1\s+block/i.test(formSource)) {
      return {
        value: formCogs,
        confidence: formConfidence,
        source: `${formSource} (preferred over comparison disagreement)`,
      };
    }

    return {
      value: comparisonCogs,
      confidence: input.comparisonConfidence ?? 92,
      source: "Two-year comparison (COGS row — form year column mismatch)",
    };
  }

  if (formCogs !== undefined) {
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
