"use client";

import { ConsentManagerProvider } from "@c15t/nextjs";
import type { AllConsentNames } from "@c15t/react";
import { type ReactNode } from "react";
import bannerVersion from "../../banner-versions/1.0.0.json";

// The c15t handler is mounted at /api/[[...path]] in the consent-service
// (per orbis ADR 0004 Task 1.6), so the API base lives at /api.
const CONSENT_API_URL =
  process.env.NEXT_PUBLIC_CONSENT_API_URL ?? "https://consent.heiberg.co/api";

// Map banner-version category IDs to AllConsentNames.
// "analytics" is not in AllConsentNames; the closest match is "measurement".
const CONSENT_CATEGORIES: AllConsentNames[] = bannerVersion.categories
  .map((cat) => {
    if (cat.id === "analytics") return "measurement" as const;
    return cat.id as AllConsentNames;
  })
  .filter((id): id is AllConsentNames =>
    ["experience", "functionality", "marketing", "measurement", "necessary"].includes(id)
  );

export function ConsentProvider({ children }: { children: ReactNode }) {
  return (
    <ConsentManagerProvider
      options={{
        mode: "hosted",
        backendURL: CONSENT_API_URL,
        consentCategories: CONSENT_CATEGORIES,
        i18n: { locale: "en", detectBrowserLanguage: false, messages: { en: { consentTypes: {
          necessary: { title: "Necessary", description: "Stores your consent choice and keeps the website working." },
          measurement: { title: "Analytics", description: "PostHog EU measures website and docs use. No session recordings or form contents." },
        } } } },
        legalLinks: {
          privacyPolicy: {
            label: "Privacy Policy",
            href: bannerVersion.privacyPolicyHref,
          },
        },
      }}
    >
      {children}
    </ConsentManagerProvider>
  );
}
