import type { Metadata } from "next";
import "./globals.css";
import Frame from "@/components/frame";
import { Toaster } from "@/components/toast";

export const metadata: Metadata = {
  title: "Q-REX",
  description: "Quick-commerce data retrieval & reliability",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-[14px] antialiased">
        <Frame>{children}</Frame>
        <Toaster />
      </body>
    </html>
  );
}
