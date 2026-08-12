import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import ClientErrorLogger from "@/components/ClientErrorLogger";
import "./globals.css";

const figtree = localFont({
  src: "../../node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
  display: "swap",
  variable: "--font-figtree",
  weight: "300 900",
  style: "normal",
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
    <html lang="en" className={`${figtree.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-surface-0 text-fg">
        <ClientErrorLogger />
        {children}
      </body>
    </html>
  );
}
