import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Link With Buyers Dashboard",
  description: "A local, read-only campaign activity dashboard.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
