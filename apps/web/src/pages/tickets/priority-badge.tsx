import type { Priority } from "@slai/shared";
import { Badge } from "@slai/ui";
import { ChevronDown, ChevronsUp, ChevronUp, Equal } from "lucide-react";
import { PRIORITY_LABEL } from "../../lib/labels";

const ICONS = { urgent: ChevronsUp, high: ChevronUp, normal: Equal, low: ChevronDown };

/** Priority never borrows the risk colors (those are reserved for SLA state). */
export function PriorityBadge({
  priority,
  size = "sm",
  suffix,
}: {
  priority: Priority;
  size?: "sm" | "md";
  suffix?: string;
}) {
  const Icon = ICONS[priority];
  return (
    <Badge
      tone={priority === "urgent" ? "accent" : priority === "high" ? "outline" : "neutral"}
      size={size}
      icon={<Icon aria-hidden />}
    >
      {PRIORITY_LABEL[priority]}
      {suffix}
    </Badge>
  );
}
