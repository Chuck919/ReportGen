import path from "node:path";

export type TaxBenchmarkClient = {
  id: string;
  label: string;
  /** Relative to `web/` */
  docsDir: string;
  /** Key prefix in WORKBOOK_COMPARISON_FIXTURES.tax */
  fixturePrefix: string;
  years: number[];
};

const changwenRoot = path.join("..", "Documents", "For Changwen");

export const TAX_BENCHMARK_CLIENTS: TaxBenchmarkClient[] = [
  {
    id: "kcf",
    label: "KC Fudge LLC",
    docsDir: path.join("..", "Documents"),
    fixturePrefix: "KCF MAIN CURRENT EXCEL.xlsx",
    years: [2023, 2024, 2025],
  },
  {
    id: "carithers",
    label: "Carithers Liquor LLC",
    docsDir: path.join(changwenRoot, "carithers-liquor"),
    fixturePrefix: "carithers-liquor/integrator.xls",
    years: [2021, 2022, 2023, 2024, 2025],
  },
  {
    id: "sssi",
    label: "Strategic Solution Services Inc",
    docsDir: path.join(changwenRoot, "strategic-solution-services"),
    fixturePrefix: "strategic-solution-services/integrator.xls",
    years: [2022, 2023, 2024],
  },
  {
    id: "arizona-sun",
    label: "Arizona Sun Supply Inc",
    docsDir: path.join(changwenRoot, "arizona-sun-supply"),
    fixturePrefix: "arizona-sun-supply/integrator.xls",
    years: [2022, 2023, 2024, 2025],
  },
];

export function fixtureKey(client: TaxBenchmarkClient, year: number): string {
  return `${client.fixturePrefix} / ${year}`;
}

export function resolveClientDocsDir(client: TaxBenchmarkClient): string {
  return path.resolve(process.cwd(), client.docsDir);
}
