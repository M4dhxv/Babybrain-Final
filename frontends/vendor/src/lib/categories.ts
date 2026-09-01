import type { VendorCategory } from './database.types';

/**
 * The vendor-facing category list, shared by Settings (profile editor) and the
 * Save-your-listing review page so the options and labels stay in one place.
 */
export const VENDOR_CATEGORIES: { value: VendorCategory; label: string }[] = [
  { value: 'baby-toddler-classes', label: 'Baby & Toddler Classes' },
  { value: 'playspaces', label: 'Playspaces' },
  { value: 'camps-holiday', label: 'Camps & Holiday Programmes' },
  { value: 'community-events', label: 'Community Events' },
  { value: 'mum-bub-exercise', label: 'Parent & Child Exercise' },
  { value: 'other', label: 'Other' },
];

export const categoryLabel = (value: string | null | undefined): string =>
  VENDOR_CATEGORIES.find((c) => c.value === value)?.label ?? (value || 'Not set');
