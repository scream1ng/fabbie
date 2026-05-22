import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STEP → Label",
  description: "Generate isometric wireframe labels from STEP files",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
