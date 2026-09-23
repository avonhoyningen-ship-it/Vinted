import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { SaleNotifier } from "@/components/SaleNotifier";
import { ToastProvider } from "@/components/Toasts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vinted Dashboard",
  description: "Verwaltung mehrerer eigener Vinted-Accounts",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <ToastProvider>
          <div className="shell">
            <Nav />
            <main className="main">{children}</main>
          </div>
          <SaleNotifier />
        </ToastProvider>
      </body>
    </html>
  );
}
