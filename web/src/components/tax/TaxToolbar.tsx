import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/Button";

export function TaxToolbar({
  pasteTsv,
  confirmedTsv,
  onClear,
}: {
  pasteTsv: string;
  confirmedTsv: string;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <CopyButton label="Copy for Excel" text={pasteTsv} />
      <CopyButton label="Copy verified only" text={confirmedTsv} />
      <Button variant="ghost" className="ml-auto text-stone-500" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
