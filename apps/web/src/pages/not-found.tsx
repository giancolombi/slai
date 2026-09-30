import { Button, EmptyState, Logo } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";

export function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-4">
      <Logo />
      <EmptyState
        icon={<Compass />}
        title="This page doesn't exist"
        description="The link may be old, or the page moved."
        action={
          <Button asChild variant="primary">
            <Link to="/">Go to dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}
