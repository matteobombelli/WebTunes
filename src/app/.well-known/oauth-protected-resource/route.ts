import { corsPreflight, protectedResourceMetadataResponse } from "@/lib/oauth/config";

export function GET() {
  return protectedResourceMetadataResponse();
}

export const OPTIONS = corsPreflight;
