import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Loads a fresh copy of the router with `import.meta.env.DEV` set as a build would set it. */
async function routerFor(dev: boolean) {
  vi.stubEnv("DEV", dev);
  vi.resetModules();
  const { createAppRouter } = await import("../src/router");
  return createAppRouter(new QueryClient());
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the design-system style guide is a development tool, not a product page", () => {
  it("is not routable in a production build", async () => {
    const router = await routerFor(false);
    expect(Object.keys(router.routesByPath)).not.toContain("/design");
    // An unknown path falls through to the not-found page.
    const matches = router.matchRoutes("/design", {});
    expect(matches.some((m) => m.fullPath === "/design")).toBe(false);
  });

  it("is routable in development", async () => {
    const router = await routerFor(true);
    expect(Object.keys(router.routesByPath)).toContain("/design");
  });

  it("is not linked from the app shell", async () => {
    const layout = readFileSync(join(import.meta.dirname, "../src/app-layout.tsx"), "utf8");
    expect(layout).not.toMatch(/["']\/design["']/);
    expect(layout).not.toMatch(/Design system/i);
  });
});
