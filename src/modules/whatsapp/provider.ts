import type { WhatsAppMessage, WhatsAppTemplateKey } from '@moto/shared';
import { toE164Digits, waMeLink } from '@moto/shared';
import { env } from '../../config/env.js';
import { WhatsAppMessageModel } from '../../db/models.js';
import { newId, nowISO } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { toPublic } from '../../lib/pagination.js';
import { badRequest } from '../../lib/errors.js';

export interface SendInput {
  customerId: string;
  phone: string;
  templateKey: WhatsAppTemplateKey;
  body: string;
  userId: string;
  referenceId?: string;
}

export interface WhatsAppProvider {
  /** `link` is set in deep-link mode so the caller can open WhatsApp Web. */
  send(input: SendInput, messageId: string): Promise<{ status: WhatsAppMessage['status']; error?: string; link?: string }>;
}

/** Meta Cloud API provider (text messages). */
const cloudProvider: WhatsAppProvider = {
  async send(input) {
    if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) return { status: 'failed', error: 'WhatsApp Cloud API not configured' };
    const res = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ messaging_product: 'whatsapp', to: input.phone.replace(/\D/g, ''), type: 'text', text: { body: input.body } }),
    });
    if (!res.ok) return { status: 'failed', error: `Cloud API ${res.status}` };
    const receipt = await res.json() as { messages?: { id?: string }[] };
    if (!receipt.messages?.[0]?.id) return { status: 'failed', error: 'Cloud API did not acknowledge a message' };
    return { status: 'sent' };
  },
};

/**
 * Deep-link mode: the server records the message and hands back a `wa.me` URL that the operator opens in
 * WhatsApp Web. No unofficial automation, and the message leaves from the shop's own WhatsApp account.
 */
const webProvider: WhatsAppProvider = {
  async send(input) {
    if (!toE164Digits(input.phone, env.WHATSAPP_COUNTRY_CODE)) return { status: 'failed', error: 'Invalid phone number' };
    return { status: 'prepared', link: waMeLink(input.phone, input.body, env.WHATSAPP_COUNTRY_CODE) };
  },
};

export const provider: WhatsAppProvider =
  env.WHATSAPP_MODE === 'cloud' ? cloudProvider : webProvider;

export async function sendWhatsApp(input: SendInput): Promise<WhatsAppMessage> {
  if (/\{[a-zA-Z_]+\}/.test(input.body)) throw badRequest('Complete all message variables before sending', 'UNRESOLVED_TEMPLATE');
  const id = newId('wa');
  const phone = toE164Digits(input.phone, env.WHATSAPP_COUNTRY_CODE) || input.phone;
  const doc = await WhatsAppMessageModel.create({ _id: id, customerId: input.customerId, phone, templateKey: input.templateKey, body: input.body, status: 'queued', sentAt: nowISO(), userId: input.userId, referenceId: input.referenceId });
  try {
    const r = await provider.send({ ...input, phone }, id);
    doc.status = r.status;
    if (r.error) doc.error = r.error;
    if (r.link) doc.link = r.link;
  } catch (e) {
    logger.warn({ err: e }, 'whatsapp send failed');
    doc.status = 'failed';
    doc.error = e instanceof Error ? e.message : 'send failed';
  }
  await doc.save();
  return toPublic(doc.toObject()) as unknown as WhatsAppMessage;
}

export function renderTemplate(body: string, vars: Record<string, string | number>): string {
  return body.replace(/\{([a-zA-Z_]+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}
