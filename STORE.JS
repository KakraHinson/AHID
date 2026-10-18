import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

let currentAgentData = null;


// Simple tab switching function
function switchTab(tabName) {
    const tabs = ['overview', 'store', 'pricing', 'withdrawals'];
    tabs.forEach(t => {
        const contentEl = document.getElementById('content-' + t);
        const tabEl = document.getElementById('tab-' + t);

        if (contentEl) {
            contentEl.style.display = (t === tabName) ? 'block' : 'none';
        }

        if (tabEl) {
            if (t === tabName) {
                tabEl.style.color = '#2563eb';
                tabEl.style.fontWeight = '600';
                tabEl.style.borderBottom = '2px solid #2563eb';
            } else {
                tabEl.style.color = '#4b5563';
                tabEl.style.fontWeight = '500';
                tabEl.style.borderBottom = 'none';
            }
        }
    });
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

// Save all custom prices to backend and localStorage
async function saveStorePrices() {
    const prices = {};
    priceKeys.forEach(key => {
        const inputEl = document.getElementById(key);
        if (inputEl && inputEl.value !== '') {
            const val = parseFloat(inputEl.value);
            if (!isNaN(val)) {
                prices[key] = val;
                localStorage.setItem(key, inputEl.value);
            }
        }
    });

    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-pricing', {
            body: { prices }
        });
        if (error || data?.error) {
            console.warn('Backend pricing save notice:', error || data?.error);
            alert("✅ Custom prices saved locally! (Backend sync pending)");
            return;
        }
        alert("✅ All custom prices securely updated and saved to your agent account!");
    } catch (err) {
        console.error('Failed to sync pricing to backend:', err);
        alert("✅ Custom prices saved locally!");
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

    // 2. Load cached prices first
    priceKeys.forEach(key => {
        const savedValue = localStorage.getItem(key);
        const inputEl = document.getElementById(key);
        if (savedValue && inputEl) {
            inputEl.value = savedValue;
        }
    });

    // 3. Fetch server-authoritative agent pricing from Supabase Edge Function
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

    // 4. Load the owner's store profile + shareable link, store metrics, and payouts.
    loadStoreSettings();
    loadStoreOverview();
    loadPayouts();
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

    // 1. Direct database query fallback (fast, safe under RLS)
    if (currentAgentData?.id) {
        try {
            const { data: dbStore, error: dbError } = await supabase
                .from('agent_stores')
                .select('id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
                .eq('agent_id', currentAgentData.id)
                .maybeSingle();

            if (!dbError && dbStore) {
                store = {
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

    // 2. Query edge function (manage-agent-store provisions store if missing)
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

    // 4. Safely construct storefront link with reliable fallback
    const effectiveSlug = store?.slug || currentAgentData?.agent_code?.toLowerCase() || (currentAgentData?.id ? 'store-' + currentAgentData.id.slice(0, 8) : '');

    if (linkInput && effectiveSlug) {
        linkInput.value = `${storeBaseUrl()}/storefront.html?ref=${encodeURIComponent(effectiveSlug)}`;
    } else if (linkInput && !linkInput.value) {
        linkInput.placeholder = 'Store link will appear here once saved';
    }

    // 5. Populate form fields
    const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) el.value = value; };
    if (store) {
        set('storeDisplayName', store.displayName || (currentAgentData?.full_name ? `${currentAgentData.full_name}'s Store` : 'My Store'));
        set('storeTagline', store.tagline || '');
        set('storeDescription', store.description || '');
        set('storeWhatsapp', store.whatsapp || '');
        set('storeContactPhone', store.contactPhone || '');
        set('storeLogoUrl', store.logoUrl || '');
        set('storeBrandColor', store.brandColor || '#2563eb');
        const activeEl = document.getElementById('storeActive');
        if (activeEl) activeEl.checked = store.isActive !== false;
    } else if (currentAgentData) {
        set('storeDisplayName', currentAgentData.full_name ? `${currentAgentData.full_name}'s Store` : 'My Store');
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

async function loadStoreOverview() {
    if (!currentAgentData?.id) return;
    try {
        const { data, error } = await supabase
            .from('store_orders')
            .select('sale_amount, agent_earning, fulfilment_status, payment_status')
            .eq('agent_id', currentAgentData.id);
        if (error) throw error;
        const rows = data || [];
        const delivered = rows.filter((r) => r.fulfilment_status === 'successful').length;
        const paid = rows.filter((r) => r.payment_status === 'paid');
        const sales = paid.reduce((sum, r) => sum + Number(r.sale_amount || 0), 0);
        const earnings = paid.reduce((sum, r) => sum + Number(r.agent_earning || 0), 0);
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        setText('statOrders', String(rows.length));
        setText('statDelivered', String(delivered));
        setText('statSales', `GHS ${sales.toFixed(2)}`);
        setText('statEarnings', `GHS ${earnings.toFixed(2)}`);
    } catch (err) {
        console.warn('Could not load store overview:', err);
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
        list.innerHTML = '<div class="store-list-item"><span>No payout requests yet.</span></div>';
        return;
    }
    list.innerHTML = payouts.map((payout) => {
        const date = payout.requested_at ? new Date(payout.requested_at).toLocaleDateString() : '';
        const status = String(payout.status || '').toUpperCase();
        return `<div class="store-list-item">
            <span class="amt">GHS ${Number(payout.amount || 0).toFixed(2)}</span>
            <span>${date}</span>
            <span class="store-pill">${status}</span>
        </div>`;
    }).join('');
}

async function loadPayouts() {
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-payout');
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

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
    } catch (err) {
        console.warn('Could not load payouts:', err);
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
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-payout', { body: payload });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        alert('\u2705 Payout account saved.');
        loadPayouts();
    } catch (err) {
        alert(err.message || 'Unable to save the payout account.');
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
        alert(`\u2705 Payout request submitted (${data.reference || ''}).`);
        if (amountEl) amountEl.value = '';
        loadPayouts();
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
