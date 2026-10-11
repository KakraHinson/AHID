import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

/**
 * Reads and updates the authenticated agent's own storefront profile.
 *
 * Only the owner (or an admin) can reach this, and only a whitelist of branding
 * fields may change - the slug, ownership and suspension state are never exposed
 * to the client, so a store link can never be hijacked or silently re-pointed.
 *
 * The store row is provisioned on demand with `ensure_agent_store` so an agent
 * that predates the trigger still gets a store the first time they open the
 * dashboard.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function cleanText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAgent(request);

    // Provision the store if it is missing, then load it by owner.
    await admin.rpc('ensure_agent_store', { p_agent_id: user.id });
    const { data: store, error: storeError } = await admin
      .from('agent_stores')
      .select('id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
      .eq('agent_id', user.id)
      .maybeSingle();
    if (storeError) throw storeError;
    if (!store) throw new Error('Your store could not be loaded. Please try again shortly.');

    if (request.method === 'GET') {
      return json({
        store: {
          slug: store.slug,
          displayName: store.display_name,
          description: store.description || '',
          logoUrl: store.logo_url || '',
          brandColor: store.brand_color || '#2563eb',
          tagline: store.tagline || '',
          whatsapp: store.whatsapp || '',
          contactPhone: store.contact_phone || '',
          isActive: store.is_active !== false,
        },
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const updates: Record<string, unknown> = {};

      const displayName = cleanText(body.displayName, 80);
      if (displayName !== undefined) {
        if (!displayName) return json({ error: 'Store name is required.' }, 400);
        updates.display_name = displayName;
      }

      const description = cleanText(body.description, 500);
      if (description !== undefined) updates.description = description;

      const tagline = cleanText(body.tagline, 120);
      if (tagline !== undefined) updates.tagline = tagline;

      const whatsapp = cleanText(body.whatsapp, 30);
      if (whatsapp !== undefined) {
        if (whatsapp && !/^[+0-9][0-9\s-]{6,}$/.test(whatsapp)) {
          return json({ error: 'Enter a valid WhatsApp number, e.g. 0240000000.' }, 400);
        }
        updates.whatsapp = whatsapp;
      }

      const contactPhone = cleanText(body.contactPhone, 30);
      if (contactPhone !== undefined) {
        if (contactPhone && !/^[+0-9][0-9\s-]{6,}$/.test(contactPhone)) {
          return json({ error: 'Enter a valid contact number, e.g. 0240000000.' }, 400);
        }
        updates.contact_phone = contactPhone;
      }

      const logoUrl = cleanText(body.logoUrl, 500);
      if (logoUrl !== undefined) {
        if (logoUrl && !/^https:\/\/\S+$/i.test(logoUrl)) {
          return json({ error: 'The logo link must be a secure https:// URL.' }, 400);
        }
        updates.logo_url = logoUrl;
      }

      if (body.brandColor !== undefined) {
        const brandColor = String(body.brandColor || '').trim();
        if (!HEX_COLOR.test(brandColor)) {
          return json({ error: 'Brand colour must be a hex value like #2563eb.' }, 400);
        }
        updates.brand_color = brandColor.toLowerCase();
      }

      if (body.isActive !== undefined) {
        updates.is_active = body.isActive === true || body.isActive === 'true';
      }

      if (Object.keys(updates).length === 0) {
        return json({ error: 'No store changes were provided.' }, 400);
      }

      const { error: updateError } = await admin
        .from('agent_stores')
        .update(updates)
        .eq('agent_id', user.id);
      if (updateError) throw updateError;

      return json({ success: true, updated: Object.keys(updates) });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-agent-store error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process your store request.';
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
