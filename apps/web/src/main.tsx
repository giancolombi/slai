import "./styles.css";
import { ThemeProvider, Toaster, TooltipProvider } from "@slai/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./lib/queries";
import { createAppRouter } from "./router";

async function boot() {
  if (import.meta.env.VITE_MOCK_API === "1") {
    const { startMockApi } = await import("./mocks/browser");
    await startMockApi();
  }

  // A session that expires mid-use sends the person back to sign in, then here.
  const queryClient = createQueryClient({
    onUnauthorized: () => {
      const { pathname, href } = router.state.location;
      if (pathname === "/login" || pathname === "/signup" || pathname === "/mfa") return;
      queryClient.clear();
      void router.navigate({ to: "/login", search: { redirect: href } });
    },
  });
  const router = createAppRouter(queryClient);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={250}>
            <RouterProvider router={router} />
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

void boot();
