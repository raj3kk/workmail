// WorkMail email validation — Phase 3b, G-12 (disposable/temp-mail blocklist)
// and E5-13 (inbound spam handling, server-side blocklist + Junk move).
//
// This is the ONE central list. Bulk v2 carried an interim top-~40 list in
// lib/bulk.ts; it now re-exports this one (same behaviour, same messages).
// The bulk page keeps its own client-side mirror for live parse feedback
// (lib/bulk.ts is server-only); the server is the authority — a hand-made
// request cannot bypass it.
//
// Disposable domains are REJECTED with a clear message at team invite,
// contacts create, and bulk CSV/paste parse — never silently dropped.
//
// Spam (E5-13): a conservative, pattern-based score — NOT a machine-learning
// classifier. A full ML classifier is out of free-tier scope (no training
// data, no inference host, no budget); docs/BACKUP.md says so honestly.
// Scoring is deliberately strict so ordinary mail is never junked: a
// message is spam only when it hits a known spam sender domain, or scores
// >= 2 across subject/body patterns (one "free prize" subject line alone
// is not enough). Matched patterns are returned so the inbound route can
// log exactly why a message was moved to the Junk (spam) folder.

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] || '';
}

/** Curated list of known disposable / temporary-mail domains (~100). */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'anonymbox.com',
  'anonmails.de',
  'armyspy.com',
  'binkmail.com',
  'bobmail.info',
  'bugmenot.com',
  'burnermail.io',
  'byom.de',
  'crazymailing.com',
  'cuvox.de',
  'deadaddress.com',
  'despam.it',
  'discard.email',
  'disposableemailaddresses.com',
  'dispostable.com',
  'dodgit.com',
  'donemail.ru',
  'dropmail.me',
  'e4ward.com',
  'emailfake.com',
  'emailondeck.com',
  'emailtemporal.org',
  'emlhub.com',
  'fakeinbox.com',
  'fakemailgenerator.com',
  'filzmail.com',
  'getnada.com',
  'ghosttexter.de',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'haltospam.com',
  'hidemail.de',
  'incognitomail.com',
  'inboxalias.com',
  'inboxbear.com',
  'jetable.org',
  'kasmail.com',
  'killmail.com',
  'kurzepost.de',
  'lifebyfood.com',
  'lookugly.com',
  'mailcatch.com',
  'maildrop.cc',
  'maildx.com',
  'maileater.com',
  'mailforspam.com',
  'mailfreeonline.com',
  'mailinator.com',
  'mailinator.net',
  'mailinator.org',
  'mailmetrash.com',
  'mailmoat.com',
  'mailnesia.com',
  'mailnull.com',
  'mailsac.com',
  'mailshell.com',
  'mailtemp.net',
  'mailtome.de',
  'mintemail.com',
  'mohmal.com',
  'mt2009.com',
  'mytemp.email',
  'mytrashmail.com',
  'neverbox.com',
  'nobulk.com',
  'noclickemail.com',
  'nogmailspam.info',
  'nomail.xl.cx',
  'nospam.ze.tc',
  'nurfuerspam.de',
  'objectmail.com',
  'pookmail.com',
  'proxymail.eu',
  'put2me.com',
  'quickinbox.com',
  'rcpt.at',
  'rejectmail.com',
  'rmqkr.net',
  'sharklasers.com',
  'shieldemail.com',
  'shitmail.me',
  'shitmail.org',
  'smellre.com',
  'spam.la',
  'spamavert.com',
  'spambox.us',
  'spamcannon.com',
  'spamday.com',
  'spamgourmet.com',
  'spaml.com',
  'spammotel.com',
  'spamtrail.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempinbox.com',
  'tempmail.com',
  'tempmailaddress.com',
  'tempmailo.com',
  'tempomail.fr',
  'throwawaymail.com',
  'tmpmail.org',
  'tmpmail.net',
  'trash-mail.com',
  'trash-mail.de',
  'trashcanmail.com',
  'trashmail.com',
  'trashmail.de',
  'trashmail.net',
  'trashymail.com',
  'wegwerfmail.de',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'zippymail.info',
];

export function isDisposableDomain(email: string): boolean {
  return DISPOSABLE_DOMAINS.includes(domainOf(email));
}

/** True when the address uses a disposable / temporary-mail domain. */
export function isDisposableEmail(email: string): boolean {
  return isDisposableDomain(email);
}

// ---------------------------------------------------------------------------
// Spam handling (E5-13)
// ---------------------------------------------------------------------------

/** Sender domains seen in bulk spam runs (throwaway + lookalike freemail). */
export const SPAM_SENDER_DOMAINS: readonly string[] = [
  'freeprize-claim.com',
  'crypto-giveaway.net',
  'lottery-winner-alert.com',
  'inheritance-fund.org',
  'account-verify-now.com',
  'secure-login-alert.net',
  'prize-delivery-center.com',
  'bitcoin-doubler.io',
  'claim-your-reward-now.com',
  'urgent-payment-required.com',
];

/** Strong subject-line spam signals (each counts 1). */
export const SPAM_SUBJECT_PATTERNS: ReadonlyArray<{name: string; re: RegExp}> = [
  {name: 'you_have_won', re: /(you'?ve won|you are (a|the) winner|congratulations,? you'?ve won|winner notification)/i},
  {name: 'claim_prize', re: /(claim your (prize|reward|gift|money|inheritance)|claim now|collect your prize)/i},
  {name: 'crypto_double', re: /(double your (bitcoin|btc|crypto|ethereum)|send .* (btc|bitcoin) (and|to) (get|receive) double|crypto giveaway)/i},
  {name: 'urgent_verify_account', re: /(urgent[:!]? ?(verify|confirm|update) your account|account (will be|suspended|closed).*verify|verify your (account|identity) (now|immediately|urgent))/i},
  {name: 'inheritance_funds', re: /(inheritance (fund|claim)|deceased (client|relative)|beneficiary.*\b\d[\d,]*\s*(million|usd|dollars))/i},
  {name: 'free_iphone_gift', re: /(free (iphone|ipad|macbook|samsung|gift card)|you'?ve been selected.*free)/i},
  {name: 'lottery_funds', re: /(lottery (winner|winning|fund)|international lottery|powerball winner)/i},
  {name: 'act_now_limited', re: /(act now.*(limited|expires|24 hours)|limited time.*claim|offer expires (today|in \d+ hours))/i},
];

/** Body spam signals (each counts 1). */
export const SPAM_BODY_PATTERNS: ReadonlyArray<{name: string; re: RegExp}> = [
  {name: 'send_crypto_double', re: /(send (0\.\d+|\d+) (btc|bitcoin|eth|ethereum).*receive double|double.*(btc|bitcoin).*back)/i},
  {name: 'western_union_fee', re: /(western union|money ?gram|wire transfer.*(fee|processing)|pay .* (release|processing) fee)/i},
  {name: 'bank_details_request', re: /(send (me )?(your )?(bank (account|details)|account number|sort code|routing number|passport (copy|number)))/i},
  {name: 'click_shortened_prize', re: /(click (here|below)).*claim|claim.*http/i},
  {name: 'confidential_funds', re: /(strictly confidential|keep this (strictly )?confidential|do not (tell|disclose|share).*any(one|body))/i},
];

export interface SpamCheck {
  isSpam: boolean;
  score: number;
  matched: string[];
}

/**
 * Score an inbound message. Spam when the sender domain is on the known
 * spam list, or when subject + body patterns score >= 2. A single weak
 * pattern never junks a message on its own.
 */
export function checkSpamInbound(input: {
  from: string;
  subject: string;
  text?: string;
  html?: string;
}): SpamCheck {
  const matched: string[] = [];
  if (SPAM_SENDER_DOMAINS.includes(domainOf(input.from))) matched.push('spam_sender_domain');
  const subject = input.subject || '';
  const body = `${input.text || ''}\n${input.html || ''}`;
  for (const p of SPAM_SUBJECT_PATTERNS) if (p.re.test(subject)) matched.push(`subject:${p.name}`);
  for (const p of SPAM_BODY_PATTERNS) if (p.re.test(body)) matched.push(`body:${p.name}`);
  const isSpam = matched.includes('spam_sender_domain') || matched.length >= 2;
  return {isSpam, score: matched.length, matched};
}
