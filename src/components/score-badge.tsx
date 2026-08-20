import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { classify } from "@/services/scoring";

const STYLES = {
  quente: "bg-score-hot-soft text-score-hot",
  bom: "bg-score-good-soft text-score-good",
  medio: "bg-score-mid-soft text-score-mid",
  frio: "bg-score-cold-soft text-score-cold",
} as const;

export function ScoreBadge({
  score,
  className,
  size = "md",
}: {
  score: number | null;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  if (score === null) {
    return (
      <span className={cn("text-xs text-faint-foreground", className)}>—</span>
    );
  }
  const temp = classify(score);
  const sizes = {
    sm: "h-5 min-w-7 px-1 text-[11px]",
    md: "h-6 min-w-8 px-1.5 text-xs",
    lg: "h-8 min-w-11 px-2 text-sm",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center gap-0.5 rounded-md font-semibold tabular-nums",
        STYLES[temp],
        sizes[size],
        className
      )}
    >
      {temp === "quente" && <Flame className={size === "lg" ? "size-3.5" : "size-3"} />}
      {score}
    </span>
  );
}
