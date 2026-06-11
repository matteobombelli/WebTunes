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
  });
  if (!res.ok) {
    throw new Error(`Email send failed (${res.status}): ${await res.text()}`);
  }
}
