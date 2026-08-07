/**
 * BabyBrain brand lockups for the vendor portal.
 *
 * Per the brand guide the horizontal lockup is the one for site headers and
 * wide spaces, and it already contains the wordmark — so nothing is typeset
 * beside it. The icon mark is for tight spaces (collapsed sidebar, favicons).
 */

export function BrandLogo({ className = 'h-10' }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/brand/logo-horizontal.png`}
      alt="BabyBrain"
      className={`w-auto object-contain ${className}`}
    />
  );
}

export function BrandIcon({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/brand/logo-icon.png`}
      alt=""
      aria-hidden="true"
      className={`object-contain ${className}`}
    />
  );
}
