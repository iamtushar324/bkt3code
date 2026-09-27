let clerkIdentityTokenProvider: (() => Promise<string | null>) | null = null;

export function setManagedClerkIdentityTokenProvider(
  provider: (() => Promise<string | null>) | null,
): void {
  clerkIdentityTokenProvider = provider;
}

export async function readManagedClerkIdentityToken(): Promise<string | null> {
  return clerkIdentityTokenProvider?.() ?? null;
}
