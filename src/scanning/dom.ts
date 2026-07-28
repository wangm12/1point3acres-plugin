import type { Issuer, ScannedOffer } from './contract';

export interface ParserSelectors {
  cards: string;
  merchant: string;
  reward: string;
  minimumSpend: string;
  expiry: string;
  idAttributes: string[];
  merchantFallback: RegExp;
  rewardFallback: RegExp;
}

const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || undefined;
const normalize = (value: string) => clean(value.replace(/\s*([:$])\s*/g, '$1'))!;
const fingerprint = (value: string) => { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(16).padStart(8, '0'); };

function fromText(node: Element, pattern: RegExp): string | undefined {
  const text = clean(node.textContent);
  const match = text?.match(pattern);
  return clean(match?.[1]);
}

export function parseOffers(root: ParentNode, issuer: Issuer, sourceUrl: string, selectors: ParserSelectors): ScannedOffer[] {
  const seen = new Set<string>();
  const result: ScannedOffer[] = [];
  root.querySelectorAll(selectors.cards).forEach((card) => {
    const merchant = clean(card.querySelector(selectors.merchant)?.textContent) ?? fromText(card, selectors.merchantFallback);
    const rewardLabel = clean(card.querySelector(selectors.reward)?.textContent) ?? fromText(card, selectors.rewardFallback);
    if (!merchant || !rewardLabel) return;
    const id = selectors.idAttributes.map((attribute) => card.getAttribute(attribute)).find(Boolean);
    const minimumSpend = clean(card.querySelector(selectors.minimumSpend)?.textContent);
    const expiry = clean(card.querySelector(selectors.expiry)?.textContent);
    const stableId = id ? `${issuer}:${normalize(id)}` : `${issuer}:${fingerprint([merchant, rewardLabel, minimumSpend ?? '', expiry ?? ''].map(normalize).join('|').toLowerCase())}`;
    if (seen.has(stableId)) return;
    seen.add(stableId);
    result.push({ id: stableId, issuer, merchant: normalize(merchant), rewardLabel: normalize(rewardLabel), ...(minimumSpend ? { minimumSpend: normalize(minimumSpend) } : {}), ...(expiry ? { expiry: normalize(expiry) } : {}), sourceUrl });
  });
  return result;
}
