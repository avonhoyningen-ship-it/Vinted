import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { deDE } from "@clerk/localizations";
import { AuthGate } from "@/components/AuthGate";
import { CLOUD } from "@/lib/mode";
import { ToastProvider } from "@/components/Toasts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alex Sales Kit",
  description: "Verwaltung mehrerer eigener Vinted-Accounts",
  appleWebApp: { capable: true, title: "ASK", statusBarStyle: "default" },
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
  const page = (
    <html lang="de">
      <body>
        <ToastProvider>
          <AuthGate>{children}</AuthGate>
        </ToastProvider>
      </body>
    </html>
  );
  // Cloud: Clerk handles sign-up, sign-in, password reset and sessions.
  return CLOUD ? <ClerkProvider localization={deDE} signInUrl="/sign-in" signUpUrl="/sign-up">{page}</ClerkProvider> : page;
}
