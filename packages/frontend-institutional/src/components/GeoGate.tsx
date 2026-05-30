import { ReactNode, useState, useEffect } from "react";

/**
 * OFAC-sanctioned and high-risk jurisdictions.
 * Wallets connecting from these countries are blocked at the UI layer.
 */
const BLOCKED_COUNTRIES = [
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea
  "SY", // Syria
  "RU", // Russia
  "BY", // Belarus
  "MM", // Myanmar
  "SD", // Sudan
  "SO", // Somalia
  "YE", // Yemen
  "AF", // Afghanistan
];

type GeoStatus = "checking" | "allowed" | "blocked";

export default function GeoGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GeoStatus>("checking");
  const [country, setCountry] = useState<string | null>(null);

  useEffect(() => {
    const cached = sessionStorage.getItem("geo-country");
    if (cached) {
      const blocked = BLOCKED_COUNTRIES.includes(cached);
      setCountry(cached);
      setStatus(blocked ? "blocked" : "allowed");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    fetch("https://ipapi.co/json/", { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        const code = data?.country_code ?? data?.country ?? "";
        sessionStorage.setItem("geo-country", code);
        setCountry(code);
        setStatus(BLOCKED_COUNTRIES.includes(code) ? "blocked" : "allowed");
      })
      .catch(() => {
        // Fail-open: allow access if geo lookup fails (hackathon trade-off)
        sessionStorage.setItem("geo-country", "UNKNOWN");
        setStatus("allowed");
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  if (status === "checking") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <h1 className="text-2xl font-bold text-center">Service Unavailable</h1>
        <p className="text-base-content/60 text-center max-w-md">
          This service is not available in your jurisdiction ({country}).
          Access is restricted in compliance with applicable sanctions regulations.
        </p>
        <p className="text-xs text-base-content/30 text-center max-w-sm">
          If you believe this is an error, please contact compliance support.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
