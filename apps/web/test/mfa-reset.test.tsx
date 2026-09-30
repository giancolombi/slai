import type { Me, SignInResult } from "@slai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepUp } from "../src/components/step-up";
import { ApiError, api } from "../src/lib/api";
import { canResetMfa, stepUpFresh } from "../src/lib/auth-flow";

const me = (over: { role?: Me["role"]; security?: Partial<Me["security"]> } = {}): Me => ({
  user: { id: "u_admin", email: "ada@acme.example", name: "Ada", mfaEnabled: true },
  organization: { id: "o1", name: "Acme", slug: "acme", plan: "trial" },
  role: over.role ?? "admin",
  organizations: [{ id: "o1", name: "Acme", role: over.role ?? "admin" }],
  security: {
    authMethod: "password",
    mfa: "satisfied",
    totp: true,
    passkeys: 0,
    hasPassword: true,
    stepUpUntil: null,
    ...over.security,
  },
});

afterEach(() => vi.restoreAllMocks());

describe("step-up freshness", () => {
  it("is fresh only before stepUpUntil", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(stepUpFresh(me(), now)).toBe(false);
    expect(stepUpFresh(me({ security: { stepUpUntil: "2026-09-30T12:04:00Z" } }), now)).toBe(true);
    expect(stepUpFresh(me({ security: { stepUpUntil: "2026-09-30T11:59:59Z" } }), now)).toBe(false);
  });
});

describe("who sees 'Reset two-factor'", () => {
  const member = { userId: "u_bob", role: "member" as const, active: true };
  it("admins and owners, for others, owners only by owners, active members only", () => {
    expect(canResetMfa(me(), member)).toBe(true);
    expect(canResetMfa(me({ role: "owner" }), member)).toBe(true);
    expect(canResetMfa(me({ role: "member" }), member)).toBe(false);
    expect(canResetMfa(me(), { ...member, userId: "u_admin" })).toBe(false);
    expect(canResetMfa(me(), { ...member, role: "owner" })).toBe(false);
    expect(canResetMfa(me({ role: "owner" }), { ...member, role: "owner" })).toBe(true);
    expect(canResetMfa(me(), { ...member, active: false })).toBe(false);
  });
});

function renderStepUp(m: Me, onVerified = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StepUp me={m} onVerified={onVerified} />
    </QueryClientProvider>,
  );
  return onVerified;
}

describe("<StepUp>", () => {
  it("verifies a TOTP code in the current session", async () => {
    const verify = vi
      .spyOn(api.auth, "verifyTotp")
      .mockResolvedValue({ status: "signed_in", me: me() } satisfies SignInResult);
    const onVerified = renderStepUp(me());
    expect(screen.getByText(/enter a code from your authenticator app/i)).toBeInTheDocument();
    const boxes = screen.getAllByRole("textbox");
    await userEvent.click(boxes[0]!);
    await userEvent.paste("123456");
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(verify.mock.calls[0]?.[0]).toBe("123456");
  });

  it("shows the server's error on a bad code", async () => {
    vi.spyOn(api.auth, "verifyTotp").mockRejectedValue(new ApiError(401, "invalid_code", "That code is not valid."));
    const onVerified = renderStepUp(me());
    await userEvent.click(screen.getAllByRole("textbox")[0]!);
    await userEvent.paste("000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not valid.");
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("sends users without a slai factor to Security settings", () => {
    renderStepUp(me({ security: { totp: false, passkeys: 0, authMethod: "sso" } }));
    expect(screen.getByText(/Settings → Security/)).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});
