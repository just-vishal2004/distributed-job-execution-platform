import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';

export const metadata: Metadata = {
  title: 'Meridian | Distributed Job Execution Platform',
  description: 'An engineering prototype for PostgreSQL-backed background work, worker coordination, and execution recovery.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#0a0a0b] text-[#fafafa] antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
