export const authConfig = {
  usernameDomain: 'parents-move.invalid',
  loginTitle: 'Private family access',
  defaultRememberDevice: true
} as const;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

export function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@${authConfig.usernameDomain}`;
}

export function emailToUsername(email?: string | null): string {
  if (!email) return '';
  return email.toLowerCase().endsWith(`@${authConfig.usernameDomain}`)
    ? email.slice(0, -(`@${authConfig.usernameDomain}`.length))
    : email;
}
