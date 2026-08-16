import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  return {
    metadataBase,
    title: "SnapCanvas — iPad画像編集",
    description: "画像を端末の中だけで、すばやく編集できるオフラインPWA。",
    applicationName: "SnapCanvas",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/favicon.svg", apple: "/favicon.svg" },
    appleWebApp: { capable: true, statusBarStyle: "default", title: "SnapCanvas" },
    openGraph: {
      title: "SnapCanvas — iPad画像編集",
      description: "画像を端末の中だけで、すばやく編集。",
      type: "website",
      locale: "ja_JP",
      images: [{ url: new URL("/og.png", metadataBase).toString(), width: 1792, height: 915, alt: "SnapCanvasの画像編集画面" }],
    },
    twitter: { card: "summary_large_image", title: "SnapCanvas — iPad画像編集", description: "画像を端末の中だけで、すばやく編集。", images: [new URL("/og.png", metadataBase).toString()] },
  };
}

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false,
  viewportFit: "cover", themeColor: "#f7f8fa",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
