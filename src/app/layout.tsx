import type { Metadata, Viewport } from "next";
import ClientErrorLogger from "@/components/ClientErrorLogger";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebTunes",
  description: "Your personal music library, anywhere",
};

// Keep the standard mobile viewport while allowing browser pinch zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-surface-0 text-fg">
        <ClientErrorLogger />
        {children}
      </body>
    </html>
  );
}
