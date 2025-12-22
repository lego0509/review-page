import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '授業レビュー投稿 | University review app',
  description: '授業レビューを投稿するフォーム',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-[#f8e9f0] text-gray-900">
        {children}
      </body>
    </html>
  );
}
