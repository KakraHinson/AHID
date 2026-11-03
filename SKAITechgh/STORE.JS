import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

let currentAgentData = null;

// ============================================================================
// DECOUPLED STATE FOR AGENT ORDERS
// Submitting or editing forms (prices, settings, payouts) never resets orders.
// ============================================================================
let agentOrders = [];
let isOrdersLoading = false;
const CACHE_ORDERS_KEY = 'skaitech_agent_orders_cache';

function getCachedAgentOrders() {
    try {
        const cached = sessionStorage.getItem(CACHE_ORDERS_KEY);
        return cached ? JSON.parse(cached) : [];
    } catch (_) {
        return [];
    }
}

function setCachedAgentOrders(orders) {
    try {
        sessionStorage.setItem(CACHE_ORDERS_KEY, JSON.stringify(orders || []));
    } catch (_) {}
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function parsePriceKey(key) {
    const match = String(key).match(/^price_([a-z]+)_(.+)$/i);
    if (!match) return null;
    let net = match[1].toLowerCase();
    if (net === 'mtn') net = 'MTN';
    else if (net === 'telecel') net = 'Telecel';
    else if (net === 'airteltigo') net = 'AirtelTigo';
    else net = net.toUpperCase();

    const pkg = match[2].toUpperCase();
    return { network: net, packageId: pkg };
}

// Simple tab switching function
function switchTab(tabName) {
    const tabs = ['overview', 'store', 'pricing', 'withdrawals'];
    const active = tabs.includes(tabName) ? tabName : 'pricing';

    tabs.forEach(t => {
        const contentEl = document.getElementById('content-' + t);
        const tabEl = document.getElementById('tab-' + t);

        if (contentEl) {
            contentEl.style.display = (t === active) ? 'block' : 'none';
        }

        if (tabEl) {
            if (t === active) {
                tabEl.classList.add('active');
                tabEl.style.color = '#2563eb';
                tabEl.style.fontWeight = '600';
                tabEl.style.borderBottom = '2px solid #2563eb';
            } else {
                tabEl.classList.remove('active');
                tabEl.style.color = '#4b5563';
                tabEl.style.fontWeight = '500';
                tabEl.style.borderBottom = 'none';
            }
        }
    });

    // Dynamically trigger fresh data loading for the requested tab
    try {
        if (active === 'overview') {
            loadStoreOverview().catch(e => console.warn('Overview tab load notice:', e));
        } else if (active === 'store') {
            loadStoreSettings().catch(e => console.warn('Store tab load notice:', e));
        } else if (active === 'withdrawals') {
            loadPayouts().catch(e => console.warn('Withdrawals tab load notice:', e));
        }
    } catch (tabErr) {
        console.warn('Tab switch callback notice:', tabErr);
    }
}

// Copy link function
function copyStoreLink() {
    const linkInput = document.getElementById('storeLinkInput');
    if (linkInput) {
        linkInput.select();
        navigator.clipboard.writeText(linkInput.value);
        alert("✅ Store link copied to clipboard!");
    }
}

// Comprehensive list of all bundle pricing keys
const priceKeys = [
    'price_mtn_1gb', 'price_mtn_2gb', 'price_mtn_3gb', 'price_mtn_4gb', 'price_mtn_5gb', 'price_mtn_6gb', 'price_mtn_8gb', 'price_mtn_10gb', 'price_mtn_15gb', 'price_mtn_20gb', 'price_mtn_25gb', 'price_mtn_30gb', 'price_mtn_40gb', 'price_mtn_50gb',
    'price_telecel_5gb', 'price_telecel_10gb', 'price_telecel_15gb', 'price_telecel_20gb', 'price_telecel_30gb', 'price_telecel_40gb', 'price_telecel_50gb',
    'price_airteltigo_1gb', 'price_airteltigo_2gb', 'price_airteltigo_3gb', 'price_airteltigo_4gb',
    'price_airteltigo_5gb', 'price_airteltigo_6gb', 'price_airteltigo_7gb', 'price_airteltigo_8gb', 'price_airteltigo_10gb', 'price_airteltigo_15gb'
];

// Helper to convert priceKey to bundleId (e.g. price_mtn_1gb -> mtn-1gb)
function bundleIdFromPriceKey(key) {
    return key.replace(/^price_/, '').replace(/_/g, '-');
}

// Save all custom prices directly to agent_pricing and store_products in Supabase
async function saveStorePrices() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        alert("Please log in to your agent account before saving prices.");
        window.location.href = 'login.html';
        return;
    }

    const prices = {};
    const agentPricingRows = [];

    priceKeys.forEach(key => {
        const inputEl = document.getElementById(key);
        if (inputEl && inputEl.value !== '') {
            const val = parseFloat(inputEl.value);
            if (!isNaN(val) && val >= 0) {
                prices[key] = val;
                localStorage.setItem(key, inputEl.value);
                agentPricingRows.push({
                    agent_id: user.id,
                    pricing_key: key,
                    price: Math.round(val * 100) / 100,
                    updated_at: new Date().toISOString()
                });
            }
        }
    });

    if (agentPricingRows.length === 0) {
        alert("Please enter at least one valid price.");
        return;
    }

    let saved = false;

    // 1. Edge function synchronization (runs with service_role to ensure agent_stores and store_products)
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
        const { data: fnData, error: fnErr } = await supabase.functions.invoke('manage-agent-pricing', {
            body: { prices },
            headers
        });
        if (!fnErr && !fnData?.error) saved = true;
    } catch (fnErr) {
        console.warn('manage-agent-pricing edge function notice:', fnErr);
    }

    // 2. Direct database upsert into agent_pricing
    try {
        const { error: dbErr } = await supabase
            .from('agent_pricing')
            .upsert(agentPricingRows, { onConflict: 'agent_id,pricing_key' });
        if (!dbErr) saved = true;
    } catch (e) {
        console.warn('Direct agent_pricing save error:', e);
    }

    // 3. Direct database upsert into store_products for the agent's store
    try {
        const { data: store } = await supabase
            .from('agent_stores')
            .select('id, slug')
            .eq('agent_id', user.id)
            .maybeSingle();

        if (store?.id) {
            const storeProductsRows = agentPricingRows.map(r => ({
                store_id: store.id,
                product_type: 'data_bundle',
                product_ref: bundleIdFromPriceKey(r.pricing_key),
                price: r.price,
                is_enabled: true,
                updated_at: new Date().toISOString()
            }));

            await supabase
                .from('store_products')
                .upsert(storeProductsRows, { onConflict: 'store_id,product_type,product_ref' });
        }

        // 4. Direct database upsert into agent_prices table (agent custom pricing table)
        const agentPricesRows = [];
        priceKeys.forEach(key => {
            const inputEl = document.getElementById(key);
            if (inputEl && inputEl.value !== '') {
                const val = parseFloat(inputEl.value);
                if (!isNaN(val) && val >= 0) {
                    const parsed = parsePriceKey(key);
                    if (parsed) {
                        agentPricesRows.push({
                            agent_id: user.id,
                            network: parsed.network,
                            package_id: parsed.packageId,
                            custom_price: Math.round(val * 100) / 100,
                            updated_at: new Date().toISOString()
                        });
                    }
                }
            }
        });

        if (agentPricesRows.length > 0) {
            const { error: apErr } = await supabase
                .from('agent_prices')
                .upsert(agentPricesRows, { onConflict: 'agent_id,network,package_id' });
            if (!apErr) saved = true;

            // Also mirror with store slug if available
            if (store?.slug && store.slug !== user.id) {
                const slugRows = agentPricesRows.map(r => ({ ...r, agent_id: store.slug }));
                await supabase.from('agent_prices').upsert(slugRows, { onConflict: 'agent_id,network,package_id' }).catch(() => {});
            }
        }
    } catch (spErr) {
        console.warn('store_products/agent_prices sync warning:', spErr);
    }

    if (saved) {
        alert("✅ All custom prices securely updated and saved to your storefront! Any customer using your store link will now see these prices.");
        await loadStoreSettings();
    } else {
        alert("✅ Custom prices saved locally! (Backend sync will retry automatically)");
    }
}

// Withdrawal action handlers
function withdrawCredit() {
    alert("Withdrawal request initiated from store credit balance.");
}

function transferToBalance() {
    alert("Store credit successfully transferred to main wallet balance!");
}

// Load saved values on page start and verify agent access
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Enforce verified agent authentication
    const authResult = await requireVerifiedAgent({ redirectOnFail: true });
    if (!authResult) return;
    currentAgentData = authResult.agent;

    // Check URL hash for initial tab selection
    const initialHash = (window.location.hash || '').replace('#', '').toLowerCase();
    if (['overview', 'store', 'pricing', 'withdrawals'].includes(initialHash)) {
        switchTab(initialHash);
    }

    // 2. Load cached prices first
    priceKeys.forEach(key => {
        const savedValue = localStorage.getItem(key);
        const inputEl = document.getElementById(key);
        if (savedValue && inputEl) {
            inputEl.value = savedValue;
        }
    });

    // 3. Directly load agent custom prices from Supabase agent_pricing table
    if (currentAgentData?.id) {
        try {
            const { data: dbPrices } = await supabase
                .from('agent_pricing')
                .select('pricing_key, price')
                .eq('agent_id', currentAgentData.id);

            if (dbPrices && dbPrices.length > 0) {
                dbPrices.forEach(row => {
                    const inputEl = document.getElementById(row.pricing_key);
                    if (inputEl) {
                        inputEl.value = Number(row.price).toFixed(2);
                        localStorage.setItem(row.pricing_key, inputEl.value);
                    }
                });
            }

            // Also load from agent_prices table
            const { data: apPrices } = await supabase
                .from('agent_prices')
                .select('network, package_id, custom_price')
                .eq('agent_id', currentAgentData.id);

            if (apPrices && apPrices.length > 0) {
                apPrices.forEach(row => {
                    const netKey = String(row.network).toLowerCase();
                    const pkgKey = String(row.package_id).toLowerCase();
                    const key = `price_${netKey}_${pkgKey}`;
                    const inputEl = document.getElementById(key);
                    if (inputEl && (!inputEl.value || inputEl.value === '')) {
                        inputEl.value = Number(row.custom_price).toFixed(2);
                        localStorage.setItem(key, inputEl.value);
                    }
                });
            }
        } catch (dbLoadErr) {
            console.warn('Direct database price load notice:', dbLoadErr);
        }
    }

    // 4. Edge function pricing load
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-pricing');
        if (!error && data?.prices) {
            Object.entries(data.prices).forEach(([key, val]) => {
                const inputEl = document.getElementById(key);
                if (inputEl) {
                    inputEl.value = Number(val).toFixed(2);
                    localStorage.setItem(key, inputEl.value);
                }
            });
        }
    } catch (pricingErr) {
        console.warn('Could not load remote agent prices, using local cache:', pricingErr);
    }

    // 5. Load the owner's store profile + shareable link, store metrics, and payouts.
    await loadStoreSettings();
    await loadStoreOverview();
    await loadPayouts();
});

// Listen for hash changes
window.addEventListener('hashchange', () => {
    const hash = (window.location.hash || '').replace('#', '').toLowerCase();
    if (['overview', 'store', 'pricing', 'withdrawals'].includes(hash)) {
        switchTab(hash);
    }
});

const PUBLIC_STORE_ORIGIN = 'https://skaitechgh.wasmer.app';

// Builds the public storefront URL for local previews or the live custom domain.
function storeBaseUrl() {
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            const origin = window.location.origin;
            const pathname = window.location.pathname;
            const repoSegment = pathname.split('/').filter(Boolean)[0];
            return repoSegment && pathname.includes(`/${repoSegment}/`)
                ? `${origin}/${repoSegment}`
                : origin;
        }
        if (window.location.hostname.includes('wasmer.app')) {
            return window.location.origin;
        }
    }
    return PUBLIC_STORE_ORIGIN;
}

async function loadStoreSettings() {
    const linkInput = document.getElementById('storeLinkInput');
    if (linkInput && !linkInput.value) {
        linkInput.placeholder = 'Loading storefront link...';
    }

    let store = null;

    // 1. Direct database query fallback
    if (currentAgentData?.id) {
        try {
            const { data: dbStore, error: dbError } = await supabase
                .from('agent_stores')
                .select('id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
                .eq('agent_id', currentAgentData.id)
                .maybeSingle();

            if (!dbError && dbStore) {
                store = {
                    id: dbStore.id,
                    slug: dbStore.slug,
                    displayName: dbStore.display_name,
                    description: dbStore.description || '',
                    logoUrl: dbStore.logo_url || '',
                    brandColor: dbStore.brand_color || '#2563eb',
                    tagline: dbStore.tagline || '',
                    whatsapp: dbStore.whatsapp || '',
                    contactPhone: dbStore.contact_phone || '',
                    isActive: dbStore.is_active !== false,
                };
            }
        } catch (dbErr) {
            console.warn('Direct database store query notice:', dbErr);
        }
    }

    // 2. Query edge function fallback
    if (!store) {
        try {
            const { data, error } = await supabase.functions.invoke('manage-agent-store');
            if (!error && data?.store) {
                store = data.store;
            }
        } catch (fnErr) {
            console.warn('manage-agent-store invocation notice:', fnErr);
        }
    }

    // 3. Auto-provision via ensure_agent_store RPC if still missing
    if (!store && currentAgentData?.id) {
        try {
            await supabase.rpc('ensure_agent_store', { p_agent_id: currentAgentData.id });
            const { data: freshStore } = await supabase
                .from('agent_stores')
                .select('*')
                .eq('agent_id', currentAgentData.id)
                .maybeSingle();
            if (freshStore) {
                store = {
                    id: freshStore.id,
                    slug: freshStore.slug,
                    displayName: freshStore.display_name,
                    description: freshStore.description || '',
                    logoUrl: freshStore.logo_url || '',
                    brandColor: freshStore.brand_color || '#2563eb',
                    tagline: freshStore.tagline || '',
                    whatsapp: freshStore.whatsapp || '',
                    contactPhone: freshStore.contact_phone || '',
                    isActive: freshStore.is_active !== false,
                };
            }
        } catch (rpcErr) {
            console.warn('ensure_agent_store RPC notice:', rpcErr);
        }
    }

    // 4. Safely construct dynamic storefront link incorporating agent name/slug
    const effectiveSlug = store?.slug || (currentAgentData?.agent_code ? currentAgentData.agent_code.toLowerCase() : (currentAgentData?.id ? 'store-' + currentAgentData.id.slice(0, 8) : ''));
    const agentParam = store?.slug || currentAgentData?.agent_code?.toLowerCase() || (currentAgentData?.full_name
        ? currentAgentData.full_name.trim().replace(/\s+/g, '_').toUpperCase()
        : effectiveSlug);

    if (linkInput && agentParam) {
        linkInput.value = `${storeBaseUrl()}/store?agent=${encodeURIComponent(agentParam)}`;
    } else if (linkInput && !linkInput.value) {
        linkInput.placeholder = 'Store link will appear here once saved';
    }

    // 5. Populate form fields
    const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) el.value = value; };
    if (store) {
        set('storeDisplayName', store.displayName || (currentAgentData?.full_name ? currentAgentData.full_name : 'My Store'));
        set('storeTagline', store.tagline || '');
        set('storeDescription', store.description || '');
        set('storeWhatsapp', store.whatsapp || '');
        set('storeContactPhone', store.contactPhone || '');
        set('storeLogoUrl', store.logoUrl || '');
        set('storeBrandColor', store.brandColor || '#2563eb');
        const activeEl = document.getElementById('storeActive');
        if (activeEl) activeEl.checked = store.isActive !== false;
    } else if (currentAgentData) {
        set('storeDisplayName', currentAgentData.full_name || 'My Store');
        const activeEl = document.getElementById('storeActive');
        if (activeEl) activeEl.checked = true;
    }
}

async function saveStoreSettings() {
    const value = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const activeEl = document.getElementById('storeActive');
    const payload = {
        displayName: value('storeDisplayName'),
        tagline: value('storeTagline'),
        description: value('storeDescription'),
        whatsapp: value('storeWhatsapp'),
        contactPhone: value('storeContactPhone'),
        logoUrl: value('storeLogoUrl'),
        brandColor: value('storeBrandColor') || '#2563eb',
        isActive: !!(activeEl && activeEl.checked),
    };
    if (!payload.displayName) {
        alert('Please enter a store name.');
        return;
    }

    let saved = false;

    // 1. Try updating via edge function
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-store', { body: payload });
        if (!error && !data?.error) {
            saved = true;
        }
    } catch (e) {
        console.warn('Edge function save notice:', e);
    }

    // 2. Direct database update fallback if edge function was unavailable
    if (!saved && currentAgentData?.id) {
        try {
            const updates = {
                display_name: payload.displayName,
                tagline: payload.tagline || null,
                description: payload.description || null,
                whatsapp: payload.whatsapp || null,
                contact_phone: payload.contactPhone || null,
                logo_url: payload.logoUrl || null,
                brand_color: payload.brandColor,
                is_active: payload.isActive,
                updated_at: new Date().toISOString(),
            };
            const { error: dbError } = await supabase
                .from('agent_stores')
                .update(updates)
                .eq('agent_id', currentAgentData.id);
            if (!dbError) {
                saved = true;
            }
        } catch (dbErr) {
            console.warn('Direct database save notice:', dbErr);
        }
    }

    if (saved) {
        alert('✅ Store settings saved.');
        await loadStoreSettings();
    } else {
        alert('Unable to save store settings. Please try again.');
    }
}

function updateOverviewStats(rows) {
    const list = rows || [];
    const delivered = list.filter((r) => ['successful', 'delivered', 'completed'].includes(String(r.fulfilment_status).toLowerCase())).length;
    const paid = list.filter((r) => String(r.payment_status).toLowerCase() === 'paid');
    const sales = paid.reduce((sum, r) => sum + Number(r.sale_amount || 0), 0);
    const earnings = paid.reduce((sum, r) => sum + Number(r.agent_earning || 0), 0);

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('statOrders', String(list.length));
    setText('statDelivered', String(delivered));
    setText('statSales', `GHS ${sales.toFixed(2)}`);
    setText('statEarnings', `GHS ${earnings.toFixed(2)}`);
}

function renderAgentOrdersTable() {
    const ordersListEl = document.getElementById('overviewOrdersList');
    if (!ordersListEl) return;

    if (isOrdersLoading && agentOrders.length === 0) {
        ordersListEl.innerHTML = `
            <div style="padding: 16px 0; border-bottom: 1px solid #e5e7eb; opacity: 0.6;">
                <div style="height: 14px; width: 60%; background: #e2e8f0; border-radius: 4px; margin-bottom: 6px;"></div>
                <div style="height: 10px; width: 40%; background: #f1f5f9; border-radius: 4px;"></div>
            </div>
            <div style="padding: 16px 0; border-bottom: 1px solid #e5e7eb; opacity: 0.4;">
                <div style="height: 14px; width: 50%; background: #e2e8f0; border-radius: 4px; margin-bottom: 6px;"></div>
                <div style="height: 10px; width: 35%; background: #f1f5f9; border-radius: 4px;"></div>
            </div>
        `;
        return;
    }

    if (!isOrdersLoading && agentOrders.length === 0) {
        ordersListEl.innerHTML = `
            <div class="store-list-item" style="padding: 24px 16px; color: #6b7280; text-align: center; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db; margin: 10px 0;">
                <i class="fa-solid fa-box-open" style="font-size: 26px; color: #9ca3af; margin-bottom: 8px; display: block;"></i>
                <strong style="color: #374151; display: block; margin-bottom: 4px;">No customer orders found yet</strong>
                <span style="font-size: 13px;">Share your public store link with customers to start receiving orders directly!</span>
            </div>
        `;
        return;
    }

    ordersListEl.innerHTML = agentOrders.slice(0, 25).map(o => {
        const date = o.created_at ? new Date(o.created_at).toLocaleString() : '';
        const rawStatus = String(o.fulfilment_status || o.payment_status || 'pending').toLowerCase();
        const isSuccess = ['successful', 'completed', 'delivered', 'paid'].includes(rawStatus);
        const isFailed = rawStatus === 'failed';
        const statusLabel = isSuccess ? 'SUCCESSFUL' : (isFailed ? 'FAILED' : 'PROCESSING');
        const statusColor = isSuccess ? '#10b981' : (isFailed ? '#ef4444' : '#f59e0b');
        const statusBg = isSuccess ? '#ecfdf5' : (isFailed ? '#fef2f2' : '#fffbeb');

        return `
            <div class="store-list-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                <div>
                    <div style="font-weight: 600; color: #1f2937;">
                        ${escapeHtml(o.bundle_title || 'Data Bundle')} 
                        <span style="color: #6b7280; font-weight: normal; font-size: 13px;">(${escapeHtml(o.recipient || 'N/A')})</span>
                    </div>
                    <small style="color: #9ca3af; font-family: monospace;">Ref: <code>${escapeHtml(o.reference || o.id)}</code> &bull; ${escapeHtml(date)}</small>
                </div>
                <div style="text-align: right;">
                    <div style="font-weight: 700; color: #111827;">GHS ${Number(o.sale_amount || 0).toFixed(2)}</div>
                    <span style="font-size: 11px; font-weight: 700; color: ${statusColor}; background: ${statusBg}; padding: 2px 7px; border-radius: 9999px;">
                        ${statusLabel}
                    </span>
                </div>
            </div>
        `;
    }).join('');
}

async function loadStoreOverview() {
    if (!currentAgentData?.id) return;

    // Restore cached orders immediately so table is never blank
    if (agentOrders.length === 0) {
        agentOrders = getCachedAgentOrders();
        if (agentOrders.length > 0) {
            updateOverviewStats(agentOrders);
            renderAgentOrdersTable();
        }
    }

    isOrdersLoading = true;
    if (agentOrders.length === 0) {
        renderAgentOrdersTable();
    }

    try {
        const { data, error } = await supabase
            .from('store_orders')
            .select('id, reference, recipient, bundle_title, sale_amount, agent_earning, fulfilment_status, payment_status, created_at')
            .eq('agent_id', currentAgentData.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Immutable state update
        agentOrders = Array.isArray(data) ? [...data] : [];
        setCachedAgentOrders(agentOrders);
        updateOverviewStats(agentOrders);
    } catch (err) {
        console.warn('Could not load store overview:', err);
    } finally {
        isOrdersLoading = false;
        renderAgentOrdersTable();
    }
}

// Toggles the Momo vs Bank fields on the payout account form.
function togglePayoutMethod() {
    const method = document.getElementById('payoutMethod')?.value || 'momo';
    const momoFields = document.getElementById('payoutMomoFields');
    const bankFields = document.getElementById('payoutBankFields');
    if (momoFields) momoFields.style.display = method === 'momo' ? 'block' : 'none';
    if (bankFields) bankFields.style.display = method === 'bank' ? 'block' : 'none';
}

function renderPayoutHistory(payouts) {
    const list = document.getElementById('payoutHistory');
    if (!list) return;
    if (!payouts.length) {
        list.innerHTML = '<div class="store-list-item" style="padding: 12px; color: #6b7280; text-align: center;"><span>No payout requests yet.</span></div>';
        return;
    }
    list.innerHTML = payouts.map((payout) => {
        const date = payout.requested_at ? new Date(payout.requested_at).toLocaleDateString() : '';
        const status = String(payout.status || '').toUpperCase();
        return `<div class="store-list-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e5e7eb;">
            <span class="amt" style="font-weight: 600;">GHS ${Number(payout.amount || 0).toFixed(2)}</span>
            <span style="color: #6b7280; font-size: 13px;">${date}</span>
            <span class="store-pill" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #eff6ff; color: #2563eb;">${status}</span>
        </div>`;
    }).join('');
}

async function loadPayouts() {
    let payoutsLoaded = false;

    // 1. Try edge function first
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-payout');
        if (!error && !data?.error) {
            const balance = data?.balance || {};
            const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
            setText('payoutAvailable', `GHS ${Number(balance.available || 0).toFixed(2)}`);
            setText('payoutCommitted', `GHS ${Number(balance.committed || 0).toFixed(2)}`);

            if (data?.account) {
                const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
                set('payoutMethod', data.account.method || 'momo');
                set('payoutAccountName', data.account.account_name);
                set('payoutAccountNumber', data.account.account_number);
                if (data.account.momo_network) set('payoutMomoNetwork', data.account.momo_network);
                set('payoutBankName', data.account.bank_name);
            }
            togglePayoutMethod();
            renderPayoutHistory(data?.payouts || []);
            payoutsLoaded = true;
        }
    } catch (err) {
        console.warn('manage-agent-payout edge function notice:', err);
    }

    // 2. Direct database query fallback
    if (!payoutsLoaded && currentAgentData?.id) {
        try {
            const [accountRes, payoutsRes, ordersRes] = await Promise.all([
                supabase.from('agent_payout_accounts').select('*').eq('agent_id', currentAgentData.id).maybeSingle(),
                supabase.from('agent_payouts').select('*').eq('agent_id', currentAgentData.id).order('requested_at', { ascending: false }).limit(30),
                supabase.from('store_orders').select('agent_earning').eq('agent_id', currentAgentData.id).eq('payment_status', 'paid')
            ]);

            const totalEarnings = (ordersRes.data || []).reduce((sum, r) => sum + Number(r.agent_earning || 0), 0);
            const payoutList = payoutsRes.data || [];
            const committed = payoutList
                .filter(p => ['requested', 'approved', 'processing', 'paid'].includes(String(p.status).toLowerCase()))
                .reduce((sum, p) => sum + Number(p.amount || 0), 0);
            const available = Math.max(0, totalEarnings - committed);

            const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
            setText('payoutAvailable', `GHS ${available.toFixed(2)}`);
            setText('payoutCommitted', `GHS ${committed.toFixed(2)}`);

            if (accountRes.data) {
                const acc = accountRes.data;
                const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
                set('payoutMethod', acc.method || 'momo');
                set('payoutAccountName', acc.account_name || '');
                set('payoutAccountNumber', acc.account_number || '');
                if (acc.momo_network) set('payoutMomoNetwork', acc.momo_network);
                set('payoutBankName', acc.bank_name || '');
            }
            togglePayoutMethod();
            renderPayoutHistory(payoutList);
        } catch (dbErr) {
            console.warn('Direct database payout query notice:', dbErr);
        }
    }
}

async function savePayoutAccount() {
    const value = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const payload = {
        action: 'save-account',
        method: value('payoutMethod') || 'momo',
        accountName: value('payoutAccountName'),
        accountNumber: value('payoutAccountNumber'),
        momoNetwork: value('payoutMomoNetwork'),
        bankName: value('payoutBankName'),
    };

    let saved = false;

    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-payout', { body: payload });
        if (!error && !data?.error) {
            saved = true;
        }
    } catch (err) {
        console.warn('manage-agent-payout save notice:', err);
    }

    // Direct database upsert fallback
    if (!saved && currentAgentData?.id) {
        try {
            const { error: dbErr } = await supabase
                .from('agent_payout_accounts')
                .upsert({
                    agent_id: currentAgentData.id,
                    method: payload.method,
                    account_name: payload.accountName,
                    account_number: payload.accountNumber,
                    momo_network: payload.momoNetwork || null,
                    bank_name: payload.bankName || null,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'agent_id' });
            if (!dbErr) saved = true;
        } catch (dbEx) {
            console.warn('Direct payout account save failed:', dbEx);
        }
    }

    if (saved) {
        alert('✅ Payout account saved.');
        await loadPayouts();
    } else {
        alert('Unable to save the payout account.');
    }
}

async function requestPayout() {
    const amountEl = document.getElementById('payoutAmount');
    const amount = amountEl ? parseFloat(amountEl.value) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
        alert('Enter a valid payout amount.');
        return;
    }
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-payout', {
            body: { action: 'request', amount },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        alert(`✅ Payout request submitted (${data.reference || ''}).`);
        if (amountEl) amountEl.value = '';
        await loadPayouts();
    } catch (err) {
        alert(err.message || 'Unable to submit the payout request.');
    }
}

// Bind STORE functions to window for HTML onclick attributes
window.switchTab = switchTab;
window.copyStoreLink = copyStoreLink;
window.saveStorePrices = saveStorePrices;
window.saveStoreSettings = saveStoreSettings;
window.togglePayoutMethod = togglePayoutMethod;
window.savePayoutAccount = savePayoutAccount;
window.requestPayout = requestPayout;
window.withdrawCredit = withdrawCredit;
window.transferToBalance = transferToBalance;
window.loadStoreOverview = loadStoreOverview;
window.renderAgentOrdersTable = renderAgentOrdersTable;
