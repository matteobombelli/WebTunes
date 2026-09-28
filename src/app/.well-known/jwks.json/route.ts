import { corsPreflight, jwksResponse } from "@/lib/oauth/config";

export function GET() {
  return jwksResponse();
}

export const OPTIONS = corsPreflight;
