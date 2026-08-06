import type { Metadata, Viewport } from "next";
import { Geist, Space_Grotesk } from "next/font/google";
import ClientErrorLogger from "@/components/ClientErrorLogger";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Distinctive display face for the logo, titles and section headers.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

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
    <html
      lang="en"
      className={`${geistSans.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-surface-0 text-fg">
        <ClientErrorLogger />
        {children}
      </body>
    </html>
  );
}
