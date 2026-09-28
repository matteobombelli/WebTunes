import { authorizationServerMetadataResponse, corsPreflight } from "@/lib/oauth/config";

export function GET() {
  return authorizationServerMetadataResponse();
}

export const OPTIONS = corsPreflight;
