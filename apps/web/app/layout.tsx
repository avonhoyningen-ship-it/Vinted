import type { Metadata, Viewport } from "next";
import { AuthGate } from "@/components/AuthGate";
import { ToastProvider } from "@/components/Toasts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vinted Dashboard",
  description: "Verwaltung mehrerer eigener Vinted-Accounts",
  appleWebApp: { capable: true, title: "Vinted", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f4" },
    { media: "(prefers-color-scheme: dark)", color: "#121211" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <ToastProvider>
          <AuthGate>{children}</AuthGate>
        </ToastProvider>
      </body>
    </html>
  );
}
