// Sends transactional email via Resend's REST API. With no RESEND_API_KEY
// (local dev), the message is logged to the server console instead.
export async function sendEmail({
  to,
  subject,
  text,
}: {
  to: string;
  subject: string;
  text: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Reset and verification messages contain live capability links. Logging
    // them is useful in local development, but must never be a production
    // fallback when email configuration is missing.
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is required in production");
    }
    console.log(
      `[email:dev-fallback] To: ${to}\nSubject: ${subject}\n\n${text}\n`
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? "webtunes@matteob.dev",
      to,
      subject,
      text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Email send failed (${res.status}): ${await res.text()}`);
  }
}
