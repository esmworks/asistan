import { redactSecrets } from '../services/secrets';

/**
 * Messages that carry a way into an account: a one-time code, a password, a sign-in or reset
 * link. A chat a routine reads may get these (a bank's code, "your Facebook password was
 * changed"), and none of them is the bot's business: they are dropped before they are stored,
 * batched or shown to a model. The check reads words, so it can miss a message worded otherwise;
 * it would rather drop an ordinary message than keep a code.
 */

/** Words that name a code or a secret, in Turkish and English. */
const CODE_WORDS =
  /(?<![\p{L}\p{N}])(doğrulama|onay|güvenlik|giriş|oturum|tek kullanımlık|aktivasyon|etkinleştirme|verification|verify|security|login|log[- ]?in|sign[- ]?in|one[- ]?time|confirmation|activation|access|authentication|2fa|otp|pin|sms)\s*(kodu|kodunuz|kod|code|codes|şifresi|şifreniz|şifre|parolası|parola|password|passcode|number)(?![\p{L}])/iu;

/** A code on its own: 4 to 8 digits, or a short run of letters and digits with at least one digit. */
const CODE =
  /(?<![\p{L}\p{N}])(?:\d[\s-]?){3,7}\d(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?=[A-Z0-9-]*\d)[A-Z0-9]{2,4}-?[A-Z0-9]{2,4}(?![\p{L}\p{N}])/u;

/** Sentences such messages always carry. */
const WARNINGS =
  /(kimseyle paylaşma|kimse ile paylaşma|paylaşmayınız|paylaşmayın|do not share|don't share|never share|not share this|kodunuz|kodunuzdur|your code is|your code:|is your (?:\p{L}+ )?code|şifreniz|parolanız|your password|şifre sıfırla|parola sıfırla|şifrenizi sıfırla|reset your password|password reset|şifreniz değiştirildi|password (?:was|has been) changed)/iu;

/** A link whose address is made to sign in, verify or reset. */
const ACCOUNT_LINK =
  /https?:\/\/\S*(?:reset|password|passwd|sifre|parola|login|signin|sign-in|verify|verification|confirm|otp|magic|token|auth|2fa|recover)\S*/iu;

/** Whether a message is one to drop unread: see above. */
export function privateText(text: string): boolean {
  const s = text.normalize('NFKC');
  if (!s.trim()) return false;
  if (redactSecrets(s, '\u0000').redacted) return true;
  if (WARNINGS.test(s) || ACCOUNT_LINK.test(s)) return true;
  return CODE_WORDS.test(s) && CODE.test(s);
}
