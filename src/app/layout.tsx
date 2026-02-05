import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Service Manager',
  description: 'Manage your Windows services and applications',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="gradient-bg min-h-screen antialiased">
        {children}
      </body>
    </html>
  )
}
