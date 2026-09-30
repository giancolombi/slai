import { Button } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { GUIDE_TITLES } from "./titles";
import type { GuideId } from "./types";

/** "Read: <guide>" for empty states and callouts: the newcomer's next step when there is nothing to show. */
export function GuideButton({ guide, anchor }: { guide: GuideId; anchor?: string }) {
  return (
    <Button asChild size="sm" variant="ghost" leadingIcon={<BookOpen aria-hidden />}>
      <Link to="/help/$guideId" params={{ guideId: guide }} hash={anchor}>
        Read: {GUIDE_TITLES[guide]}
      </Link>
    </Button>
  );
}
