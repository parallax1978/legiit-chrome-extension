/**
 * The user's own brand, guessed from the email address of the first screen, so that nobody has to type it:
 * jordan@brightpathdental.com → "Brightpathdental" on brightpathdental.com. Free mail providers say nothing about
 * the user's business, so they give no brand.
 */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'web.de', 'qq.com', '163.com', '126.com', 'mail.ru', 'fastmail.com', 'hey.com', 'tutanota.com',
]);

export function brandFromEmail(email: string): { name: string; domain: string } | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/^(www|mail|email)\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || FREE_MAIL.has(domain)) return null;
  const label = domain.split('.')[0]!;
  return { name: label.charAt(0).toUpperCase() + label.slice(1), domain };
}
