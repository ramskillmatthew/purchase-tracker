import type { Metadata, Viewport } from "next";
import AppHeader from "@/components/AppHeader";
import GlobalPurchaseSearch from "@/components/GlobalPurchaseSearch";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trotter's Attire HQ",
  description: "A simple personal purchase and expense tracker",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Trotter's Attire",
  },
  icons: {
    icon: "/branding/trotters-checked-cap.png",
    apple: "/branding/trotters-checked-cap.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0c0e14",
};

const themeScript = `
  try {
    const saved = localStorage.getItem('purchase-tracker-theme');
    const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  } catch {}
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
    <body>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <AppHeader />
      <GlobalPurchaseSearch />
      <main className="app-main">{children}</main>
    </body>
  </html>;
}
