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

// Zoom is locked because an accidental pinch or input-focus zoom breaks the fixed
// player and nav chrome; iOS ignores this for pinch but honours it on input focus.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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
