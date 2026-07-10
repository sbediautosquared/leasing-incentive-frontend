import type { Metadata } from "next";
import "./globals.css";
import { AuthGate } from "@/components/auth-gate";
import { AuthProvider } from "@/components/auth-provider";

export const metadata: Metadata = {
  title: "Lease Ledger",
  description: "Import and review lease residual PDFs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><AuthProvider><AuthGate>{children}</AuthGate></AuthProvider></body>
    </html>
  );
}
