import "./global.css";

import type { Metadata } from "next";
import { Golos_Text, JetBrains_Mono, Tilt_Neon } from "next/font/google";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Last Call ($LAST)",
  description: "A memecoin with no keys and a daily check-in game on NEAR.",
};

// The bar's type (LC-021): exposed as CSS variables, read by the bar's styles and its canvas.
const golos = Golos_Text({ subsets: ["latin", "cyrillic"], weight: ["400", "700", "900"], variable: "--font-golos" });
const jetbrains = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "700"],
  variable: "--font-jetbrains",
});
const tiltNeon = Tilt_Neon({ subsets: ["latin"], variable: "--font-tilt-neon" });

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${golos.variable} ${jetbrains.variable} ${tiltNeon.variable}`}>
      <body>{children}</body>
    </html>
  );
}
