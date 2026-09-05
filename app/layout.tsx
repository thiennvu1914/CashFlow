import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { resolveLocale } from "@/lib/i18n/config";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin", "vietnamese"],
});

export const metadata: Metadata = {
  title: "CashFlow",
  description: "Personal finance management",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await resolveLocale();
  const messages = (await import(`@/messages/${locale}.json`)).default;

  return (
    <html
      lang={locale}
      className={`${manrope.variable} ${manrope.className} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
