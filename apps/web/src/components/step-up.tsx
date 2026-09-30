/**
 * Step-up prompt (T-19): prove TOTP or a passkey in this session before a
 * sensitive action. Backup codes do not count; SSO users without a slai factor
 * are sent to Settings → Security.
 */
import type { Me } from "@slai/shared";
import { Button } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fingerprint } from "lucide-react";
import { useId, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { passkeyError, passkeysSupported, stepUpWithPasskey } from "../lib/passkeys";
import { qk } from "../lib/queries";
import { CodeInput } from "../pages/auth/code-input";

export function StepUp({ me, onVerified }: { me: Me; onVerified: () => void }) {
  const queryClient = useQueryClient();
  const errorId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: qk.me });
    onVerified();
  };
  const totp = useMutation({
    mutationFn: api.auth.verifyTotp,
    onSuccess: done,
    onError: (e) => {
      setCode("");
      setError(errorMessage(e));
    },
  });
  const passkey = useMutation({
    mutationFn: stepUpWithPasskey,
    onSuccess: done,
    onError: (e) => setError(passkeyError(e)),
  });

  if (!me.security.totp && me.security.passkeys === 0) {
    return (
      <p className="rounded-md border border-line bg-warning-subtle/60 p-3 text-sm text-warning-text">
        Add an authenticator app or a passkey in Settings → Security to do this.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-sunken/50 p-3">
      <p className="text-sm text-ink">
        Confirm it's you
        {me.security.totp ? ": enter a code from your authenticator app" : ""}
        {me.security.totp && me.security.passkeys > 0 ? " or use your passkey." : "."}
      </p>
      {me.security.totp && (
        <CodeInput
          value={code}
          onChange={setCode}
          onComplete={(c) => totp.mutate(c)}
          invalid={error !== null}
          disabled={totp.isPending}
          describedBy={error ? errorId : undefined}
        />
      )}
      {me.security.passkeys > 0 && passkeysSupported() && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Fingerprint />}
            loading={passkey.isPending}
            onClick={() => passkey.mutate()}
          >
            Use a passkey
          </Button>
        </div>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-breached-text">
          {error}
        </p>
      )}
    </div>
  );
}
