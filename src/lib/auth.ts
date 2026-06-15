import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { encode as defaultEncode } from "next-auth/jwt";
import { randomUUID } from "crypto";
import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { BASE_PATH } from "@/lib/base-path";
import { getClientIp } from "@/lib/client-ip";
import { clearRateLimit, rateLimit } from "@/lib/rate-limit";

const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Per-IP ceiling on login attempts, on top of the per-email limit: bounds the
// bcrypt CPU an attacker can burn by rotating through many distinct emails.
const LOGIN_IP_LIMIT = 30;

// Thrown when credentials are valid but the email is unverified. The custom
// `code` lets the login form action distinguish this from a bad password and
// offer to resend the verification link, without leaking the distinction to
// the generic redirect error.
class UnverifiedEmailError extends CredentialsSignin {
  code = "unverified";
}
// Compared against when the email has no account, so both paths cost one
// bcrypt verify and response timing can't be used to enumerate emails.
const TIMING_EQUALIZER_HASH =
  "$2b$12$Xp1JwVhng6w4U3mq9WrFeezPVMuaA2umYkRdGBrZqvFCJMthbNpSK";

const adapter = DrizzleAdapter(db, {
  usersTable: users,
  accountsTable: accounts,
  sessionsTable: sessions,
  verificationTokensTable: verificationTokens,
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  // Route handlers receive URLs with the Next basePath already stripped, so
  // Auth.js sees /api/auth/* regardless of the public /projects/webtunes prefix.
  basePath: "/api/auth",
  // Strategy is intentionally NOT set: with an adapter present it defaults to
  // "database" at runtime, but setting it explicitly trips Auth.js's
  // credentials-requires-JWT assertion. Sign-ins flow through jwt.encode
  // below, which mints the database session.
  session: { maxAge: SESSION_MAX_AGE_SEC },
  pages: { signIn: `${BASE_PATH}/login` },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials, request) => {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;
        // Per-IP limit first so bcrypt is bounded even when the attacker
        // rotates the email (which would otherwise dodge the per-email key).
        const ip = getClientIp(request.headers);
        if (!rateLimit(`login-ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS)) {
          return null;
        }
        if (!rateLimit(`login:${email}`, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS)) {
          return null;
        }
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email));
        if (!user) {
          await compare(password, TIMING_EQUALIZER_HASH);
          return null;
        }
        const valid = await compare(password, user.passwordHash);
        if (!valid) return null;
        // Block sign-in until the address is verified (signals via the custom
        // error code so the form can offer a resend).
        if (!user.emailVerified) throw new UnverifiedEmailError();
        clearRateLimit(`login:${email}`);
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  // The credentials provider normally forces stateless JWT sessions. To keep
  // database sessions (and a token a future mobile client can send as a
  // Bearer token), we intercept JWT encoding for credentials sign-ins and
  // mint a sessions row instead — the cookie then holds the session token.
  jwt: {
    encode: async (params) => {
      if (params.token?.credentials) {
        if (!params.token.sub) throw new Error("Missing user id on token");
        const sessionToken = randomUUID();
        await adapter.createSession!({
          sessionToken,
          userId: params.token.sub,
          expires: new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000),
        });
        return sessionToken;
      }
      return defaultEncode(params);
    },
  },
  callbacks: {
    jwt: async ({ token, account }) => {
      if (account?.provider === "credentials") token.credentials = true;
      return token;
    },
    // With database sessions the raw adapter user (incl. passwordHash) is
    // passed in — expose only safe fields.
    session: async ({ session, user }) => {
      return {
        expires: session.expires,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        },
      } as unknown as typeof session;
    },
    // baseUrl is the bare origin; redirects must land under the basePath.
    redirect: async ({ url, baseUrl }) => {
      const origin = new URL(baseUrl).origin;
      const target = url.startsWith("/") ? new URL(url, origin) : new URL(url);
      if (target.origin !== origin) return `${origin}${BASE_PATH}`;
      if (!target.pathname.startsWith(BASE_PATH)) {
        target.pathname =
          BASE_PATH + (target.pathname === "/" ? "" : target.pathname);
      }
      return target.toString();
    },
  },
});
