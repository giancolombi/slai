import { AppLink, B, Callout, Defs, Ol, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="roles" title="Roles">
        <Defs
          rows={[
            ["Owner", "Everything, including billing changes, deleting the organization and changing roles."],
            [
              "Admin",
              "Connections, policy approval, autonomy, alerts, knowledge, SSO and SCIM, invitations, the audit log, and billing changes.",
            ],
            ["Member", "Works tickets, uploads contracts, edits customers, approves or rejects drafts."],
            ["Viewer", "Read-only: sees what the organization sees and changes nothing."],
          ]}
        />
        <P>
          Invite people from <AppLink to="/team">Team</AppLink> with a role. They get a one-time link that works for 7
          days; admins can resend or revoke pending invitations. slai prices by tickets, not seats.
        </P>
      </Section>

      <Section id="mfa" title="Two-factor authentication (required)">
        <P>
          Every password account must use a second factor. After the first sign-in, you set one up before anything else
          works: an <B>authenticator app</B> (with ten single-use backup codes to keep safe) or a <B>passkey</B>. Every
          sign-in then asks for it. There is no switch to turn this off.
        </P>
        <P>
          Manage your factors in{" "}
          <AppLink to="/settings" hash="security">
            Settings → Security
          </AppLink>
          : add a passkey, replace your authenticator, or regenerate backup codes. You can never remove your last
          factor.
        </P>
      </Section>

      <Section id="reset" title="Resetting a lost factor">
        <P>Lost your phone and your backup codes? Ask an admin:</P>
        <Ol>
          <li>
            On <AppLink to="/team">Team</AppLink>, the admin opens your row's menu and chooses <B>Reset two-factor</B>.
          </li>
          <li>
            They record how they checked it is really you (a reason), and confirm with their own authenticator code or
            passkey.
          </li>
          <li>
            slai removes your factors, signs you out everywhere and emails you. At your next sign-in you set up a new
            factor.
          </li>
        </Ol>
        <Callout title="Limits">
          Nobody can reset their own factors this way, and admins cannot reset owners (owners can). If you are the
          organization's only owner, contact slai support: recovery then goes through a verified, audited break-glass
          procedure.
        </Callout>
      </Section>

      <Section id="sso" title="Single sign-on (SSO)">
        <Ul>
          <li>
            Admins connect an OIDC or SAML identity provider (Okta, Entra ID, Google Workspace…) in{" "}
            <AppLink to="/settings" hash="sso">
              Settings → Single sign-on
            </AppLink>
            , and prove they own the email domain with a DNS TXT record.
          </li>
          <li>People on that domain then sign in through the provider; new ones join as members automatically.</li>
          <li>
            <B>Enforce SSO</B> turns off password and passkey sign-in for the domain.
          </li>
          <li>
            By default your identity provider's MFA counts. Admins can also require slai's own second factor for SSO
            users, or refuse sign-ins where the provider does not confirm MFA was used.
          </li>
        </Ul>
      </Section>

      <Section id="scim" title="SCIM provisioning">
        <P>
          With SSO in place, admins can generate a SCIM token in the single sign-on settings and give it to Okta or
          Entra ID. The provider then creates, updates and deactivates members (deactivating signs them out), and can
          map groups to roles, for example "slai-admins" → Admin. Group mapping never grants or changes the owner role.
        </P>
      </Section>

      <Section id="audit" title="The audit log">
        <P>
          Sign-ins, membership and role changes, connections, policy approvals, autonomy changes, draft approvals and
          every write to your help desk are recorded, append-only. Admins see it in{" "}
          <AppLink to="/audit">Audit log</AppLink>.
        </P>
      </Section>
    </>
  );
}

export const teamSecurity: Guide = {
  id: "team-security",
  title: "Team and security",
  summary:
    "Roles and invitations, required two-factor authentication, resetting a lost factor, SSO, SCIM and the audit log.",
  keywords: [
    "roles",
    "owner",
    "admin",
    "member",
    "viewer",
    "invite",
    "invitation",
    "mfa",
    "2fa",
    "two-factor",
    "authenticator",
    "totp",
    "passkey",
    "backup codes",
    "lost phone",
    "reset",
    "sso",
    "saml",
    "oidc",
    "okta",
    "entra",
    "scim",
    "audit",
  ],
  related: ["getting-started", "billing", "faq"],
  sections: [
    { id: "roles", title: "Roles" },
    { id: "mfa", title: "Two-factor authentication (required)" },
    { id: "reset", title: "Resetting a lost factor" },
    { id: "sso", title: "Single sign-on (SSO)" },
    { id: "scim", title: "SCIM provisioning" },
    { id: "audit", title: "The audit log" },
  ],
  Body,
};
