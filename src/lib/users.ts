import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export async function createUser(input: RegisterInput) {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email));
  if (existing) {
    return { error: "An account with that email already exists" } as const;
  }
  const passwordHash = await hash(input.password, 12);
  const [user] = await db
    .insert(users)
    .values({ name: input.name, email: input.email, passwordHash })
    .returning({ id: users.id, email: users.email, name: users.name });
  return { user } as const;
}
