import "@lares/ui/theme.css";
import "./site.css";
import { Analytics } from "../components/Analytics";
import { BookingProvider } from "../components/Booking";
import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://lares.is"),
  alternates: { canonical: "/" },
  title: "lares — agents that live in your house",
  description: "A small fleet for the everyday work of your business. The code is open; setup help starts with a conversation.",
  robots: { index: process.env.NEXT_PUBLIC_SITE_INDEXABLE === "true", follow: true },
};

const appearanceScript = `try{var v=localStorage.getItem('lares-website-appearance');if(v==='dark'||(!v&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch{}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: appearanceScript }} /></head>
      <body><BookingProvider>{children}</BookingProvider><Analytics /></body>
    </html>
  );
}
