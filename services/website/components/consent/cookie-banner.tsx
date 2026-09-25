"use client";

import {
  ConsentBanner,
  ConsentDialog,
} from "@c15t/nextjs";
import bannerVersion from "../../banner-versions/1.0.0.json";
import "./cookie-banner.css";

export function CookieBanner() {
  return (
    <>
      <ConsentBanner
        noStyle
        title={bannerVersion.title}
        description={
          <>
            {bannerVersion.message}{" "}
            <a
              href={bannerVersion.privacyPolicyHref}
              target="_blank"
              rel="noopener noreferrer"
              className="consent-privacy-link"
            >
              Privacy Policy
            </a>
            .
          </>
        }
        acceptButtonText={bannerVersion.buttons.accept}
        rejectButtonText={bannerVersion.buttons.reject}
        customizeButtonText={bannerVersion.buttons.managePreferences}
        hideBranding
        layout={[["reject", "accept"], "customize"]}
        primaryButton="accept"
        legalLinks={null}
      />
      {/* ConsentDialog opens when the user clicks "Manage preferences".
          We keep c15t's default modal styling (no `noStyle`) — the banner
          carries our brand-styled card, the dialog uses c15t's clean
          modal which is functional and well-styled out of the box. */}
      <ConsentDialog hideBranding />
    </>
  );
}
