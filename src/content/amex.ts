import { scanAmexOffers } from '../issuers/amex';
import { SCAN_OFFERS_MESSAGE, type ScanOffersMessage, type ScanOffersResponse } from '../scanning/contract';
export const issuer = 'amex';
const supported = () => location.hostname === 'americanexpress.com' || location.hostname.endsWith('.americanexpress.com');
chrome.runtime.onMessage.addListener((message: ScanOffersMessage, _sender, sendResponse: (response: ScanOffersResponse) => void) => {
  if (message?.type !== SCAN_OFFERS_MESSAGE || message.issuer !== issuer) return;
  if (!supported()) { sendResponse({ ok: false, issuer, error: 'Unsupported Amex page URL' }); return; }
  sendResponse({ ok: true, issuer, offers: scanAmexOffers(document, location.href) });
  return true;
});
