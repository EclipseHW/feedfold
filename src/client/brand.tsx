interface BrandIdentityProps {
  className?: string;
  decorative?: boolean;
}

export function BrandLogo({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-logo${className ? ` ${className}` : ""}`} aria-hidden="true">
      <img src={`${import.meta.env.BASE_URL}icons/pwa-192.png`} alt="" width="192" height="192" />
    </span>
  );
}

export function BrandIdentity({ className = "", decorative = false }: BrandIdentityProps) {
  return (
    <span
      className={`brand-identity${className ? ` ${className}` : ""}`}
      aria-hidden={decorative || undefined}
    >
      <BrandLogo />
      <span className="brand-wordmark">echovale</span>
    </span>
  );
}
