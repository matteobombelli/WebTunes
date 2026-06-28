import Link from "next/link";
import { getInviteByToken } from "@/lib/invites";
import RegisterForm from "./RegisterForm";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  const valid = invite ? await getInviteByToken(invite) : null;

  if (!invite || !valid) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <h2 className="font-display text-lg font-semibold">Invite-only</h2>
        <p className="text-fg-muted">
          Registration is currently invite-only. Ask a friend on WebTunes to send
          you an invite link.
        </p>
        <Link href="/login" className="text-accent-bright hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return <RegisterForm token={invite} inviterName={valid.inviterName} />;
}
