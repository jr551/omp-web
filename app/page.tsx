import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { VersionRefreshBanner } from "@/components/VersionRefreshBanner";
import { I18nProvider } from "@/hooks/useI18n";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <AppShell />
        <VersionRefreshBanner />
      </I18nProvider>
    </Suspense>
  );
}
