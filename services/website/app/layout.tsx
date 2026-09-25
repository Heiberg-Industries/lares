import "@lares/ui/theme.css";
import "./site.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "lares — agents that live in your house",
  description: "A small fleet for the everyday work of your business. The code is open; setup help starts with a conversation.",
  robots: { index: false, follow: false },
};

const appearanceScript = `try{var v=localStorage.getItem('lares-website-appearance');if(v==='dark'||(!v&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch{}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: appearanceScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
