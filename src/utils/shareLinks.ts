export const FALLBACK_PREVIEW_APP_URL =
  'https://ais-pre-hs4ovoipx6k46ebdr5f5on-873796930200.europe-west2.run.app';

export function normalizeBaseUrl(raw?: string | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.origin.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function isAiStudioRestrictedUrl(raw?: string | null): boolean {
  const value = (raw || '').trim().toLowerCase();
  if (!value || value === 'null' || value === 'about:blank') return true;
  return (
    value.includes('aistudio.google.com') ||
    value.includes('ais-pre-') ||
    value.includes('ais-dev-') ||
    value.includes('localhost') ||
    value.includes('127.0.0.1')
  );
}

export function isPublicDeployedOrigin(raw?: string | null): boolean {
  const normalized = normalizeBaseUrl(raw);
  if (!normalized) return false;
  return !isAiStudioRestrictedUrl(normalized);
}

export function resolveShareOrigin(configuredPublicUrl?: string | null): string {
  const cleanConfigured = normalizeBaseUrl(configuredPublicUrl);
  if (
    cleanConfigured &&
    !cleanConfigured.includes('aistudio.google.com') &&
    !cleanConfigured.includes('ais-dev-')
  ) {
    return cleanConfigured;
  }

  if (typeof window !== 'undefined') {
    const origin = window.location?.origin || '';
    if (isPublicDeployedOrigin(origin)) {
      return normalizeBaseUrl(origin);
    }
    if (origin.includes('ais-dev-')) {
      return (
        normalizeBaseUrl(origin.replace('ais-dev-', 'ais-pre-')) ||
        FALLBACK_PREVIEW_APP_URL
      );
    }
    if (origin.includes('ais-pre-')) {
      return normalizeBaseUrl(origin) || FALLBACK_PREVIEW_APP_URL;
    }
  }

  const envUrl = (
    (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_APP_URL || ''
  ).trim();
  if (envUrl) {
    const cleanEnv = normalizeBaseUrl(envUrl.replace('ais-dev-', 'ais-pre-'));
    if (cleanEnv) return cleanEnv;
  }

  return FALLBACK_PREVIEW_APP_URL;
}

export function buildStaffShareLink(
  email?: string,
  configuredPublicUrl?: string | null
): string {
  const base = resolveShareOrigin(configuredPublicUrl);
  if (!email) {
    return `${base}/?portal=staff`;
  }
  const clean = encodeURIComponent(email.trim().toLowerCase());
  return `${base}/?staff=${clean}#staff=${clean}`;
}

export function cleanStaffEmailCandidate(raw?: string | null): string {
  if (!raw) return '';
  let val = raw.trim();
  for (let i = 0; i < 2; i++) {
    try {
      if (val.includes('%')) {
        val = decodeURIComponent(val);
      }
    } catch {
      break;
    }
  }
  val = val.trim().toLowerCase().replace(/^['"<]+|['">.,;]+$/g, '');
  return val.includes('@') && val.includes('.') ? val : '';
}

export function extractStaffEmailFromLocation(): string {
  if (typeof window === 'undefined') return '';

  try {
    // 1. Check query parameter e.g. ?staff=hannah.lin@oakridge.edu or ?email=...
    const searchParams = new URLSearchParams(window.location.search);
    const fromQuery =
      searchParams.get('staff') ||
      searchParams.get('email') ||
      searchParams.get('teacher') ||
      searchParams.get('user') ||
      '';
    const cleanedQuery = cleanStaffEmailCandidate(fromQuery);
    if (cleanedQuery) return cleanedQuery;

    // 2. Check hash parameter e.g. #staff=hannah.lin@oakridge.edu or #/?staff=...
    const hash = window.location.hash || '';
    if (hash) {
      const qIdx = hash.indexOf('?');
      if (qIdx !== -1) {
        const hashSearch = new URLSearchParams(hash.slice(qIdx + 1));
        const fromHashQuery =
          hashSearch.get('staff') ||
          hashSearch.get('email') ||
          hashSearch.get('teacher') ||
          hashSearch.get('user') ||
          '';
        const cleanedHashQuery = cleanStaffEmailCandidate(fromHashQuery);
        if (cleanedHashQuery) return cleanedHashQuery;
      }

      const strippedHash = hash.replace(/^#\/?/, '');
      const hashParams = new URLSearchParams(strippedHash);
      const fromHash =
        hashParams.get('staff') ||
        hashParams.get('email') ||
        hashParams.get('teacher') ||
        hashParams.get('user') ||
        '';
      const cleanedHash = cleanStaffEmailCandidate(fromHash);
      if (cleanedHash) return cleanedHash;

      const hashPathMatch = strippedHash.match(/staff\/([^/?#]+)/i);
      if (hashPathMatch && hashPathMatch[1]) {
        const cleanedHashPath = cleanStaffEmailCandidate(hashPathMatch[1]);
        if (cleanedHashPath) return cleanedHashPath;
      }
    }

    // 3. Check pathname e.g. /staff/hannah.lin%40oakridge.edu
    const pathMatch = window.location.pathname.match(/\/staff\/([^/?#]+)/i);
    if (pathMatch && pathMatch[1]) {
      const cleanedPath = cleanStaffEmailCandidate(pathMatch[1]);
      if (cleanedPath) return cleanedPath;
    }
  } catch {
    // ignore
  }

  return '';
}

export async function copyTextReliably(text: string): Promise<boolean> {
  let copied = false;
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch {
      // ignore fallback errors
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // fallback already attempted above
    }
  }

  return copied;
}
