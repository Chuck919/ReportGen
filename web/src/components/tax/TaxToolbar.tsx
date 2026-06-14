import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/Button";

export function TaxToolbar({
  pasteTsv,
  onClear,
}: {
  pasteTsv: string;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <CopyButton label="Copy for Excel" text={pasteTsv} />
      <Button variant="ghost" className="ml-auto text-stone-500" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
