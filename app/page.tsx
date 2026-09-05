import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";

export default async function Home() {
  const t = await getTranslations("common");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t("appName")}
      </h1>
      <p className="max-w-sm text-base text-muted-foreground">
        {t("placeholder")}
      </p>
      <Button>{t("appName")}</Button>
    </main>
  );
}
