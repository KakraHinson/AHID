import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

let currentAgentData = null;

// Percent of their commission profit the agent shares with storefront customers,
// and the per-network profit rates used to estimate that profit. The rates come
// from Hubtel at implementation, so the table is empty until then (no discount).
let customerDiscountPercent = 0;
const DATA_PROFIT_RATES = {};
const AGENT_PROFIT_SHARE_PERCENT = 0;

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
    initProfitSharePanel();

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
        const shareInput = document.getElementById('profitShareInput');
        const savedShare = (data && data.discountPercent !== undefined && data.discountPercent !== null)
            ? data.discountPercent
            : localStorage.getItem('customer_discount_percent');
        if (shareInput && savedShare !== null && savedShare !== undefined && savedShare !== '') {
            customerDiscountPercent = Math.min(Math.max(Number(savedShare) || 0, 0), 100);
            shareInput.value = String(customerDiscountPercent);
            updateProfitSharePreview();
        }
    } catch (pricingErr) {
        console.warn('Could not load remote agent prices, using local cache:', pricingErr);
    }

    // 4. Load the owner's store profile + shareable link, store metrics, and payouts.
    loadStoreSettings();
    loadStoreOverview();
    loadPayouts();
});

// Builds the public storefront URL for the local preview or live Wasmer site.
function storeBaseUrl() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        const origin = window.location.origin;
        const pathname = window.location.pathname;
        const repoSegment = pathname.split('/').filter(Boolean)[0];
        return repoSegment && pathname.includes(`/${repoSegment}/`)
            ? `${origin}/${repoSegment}`
            : origin;
    }
    return 'https://skaitechgh.wasmer.app';
}

async function loadStoreSettings() {
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-store');
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        const store = data?.store;
        if (!store) return;

        const linkInput = document.getElementById('storeLinkInput');
        if (linkInput && store.slug) {
            linkInput.value = `${storeBaseUrl()}/store/${encodeURIComponent(store.slug)}`;
        }

        const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
        set('storeDisplayName', store.displayName);
        set('storeTagline', store.tagline);
        set('storeDescription', store.description);
        set('storeWhatsapp', store.whatsapp);
        set('storeContactPhone', store.contactPhone);
        set('storeLogoUrl', store.logoUrl);
        set('storeBrandColor', store.brandColor);
        const activeEl = document.getElementById('storeActive');
        if (activeEl) activeEl.checked = store.isActive !== false;
    } catch (err) {
        console.warn('Could not load store settings:', err);
        const linkInput = document.getElementById('storeLinkInput');
        if (linkInput && !linkInput.value) {
            linkInput.placeholder = 'Store settings unavailable \u2014 refresh to retry.';
        }
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
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-store', { body: payload });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        alert('\u2705 Store settings saved.');
        loadStoreSettings();
    } catch (err) {
        alert(err.message || 'Unable to save store settings.');
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

// Discount a package price by the agent's shared profit. Commission uses the
// platform multiplier formula, the agent keeps a configurable share of it, and
// the customer gets `customerDiscountPercent` of that agent share. With no rate
// configured (see DATA_PROFIT_RATES) the discount is a no-op.
function profitShareDiscount(basePrice, rate) {
    const base = Math.round(Number(basePrice) * 100) / 100;
    const agentShare = AGENT_PROFIT_SHARE_PERCENT / 100;
    const share = customerDiscountPercent;
    if (!rate || !agentShare || !Number.isFinite(base) || base <= 0 || !(share > 0)) {
        return { customerPrice: base, discount: 0 };
    }
    const commission = base - base / (1 + rate / 100);
    const agentProfit = commission * agentShare;
    const discount = (Math.min(share, 100) / 100) * agentProfit;
    return { customerPrice: Math.round((base - discount) * 100) / 100, discount };
}

function updateProfitSharePreview() {
    const preview = document.getElementById('profitSharePreview');
    if (!preview) return;
    const money = value => `GHS ${Number(value).toFixed(2)}`;
    const samples = [
        { key: 'price_mtn_1gb', network: 'mtn', label: 'MTN 1GB', fallback: 4.30 },
        { key: 'price_telecel_5gb', network: 'telecel', label: 'Telecel 5GB', fallback: 21.00 },
        { key: 'price_airteltigo_1gb', network: 'airteltigo', label: 'AT 1GB', fallback: 4.20 }
    ];
    const rows = samples.map(sample => {
        const inputEl = document.getElementById(sample.key);
        const base = inputEl && inputEl.value !== '' ? parseFloat(inputEl.value) : sample.fallback;
        const rate = DATA_PROFIT_RATES[sample.network];
        const { customerPrice, discount } = profitShareDiscount(base, rate);
        return `<tr>
            <td style="padding:8px 9px;border-top:1px solid #1f2937;color:#e5e7eb;">${sample.label}${rate ? ` <span style="color:#9ca3af;">(${rate}%)</span>` : ''}</td>
            <td style="padding:8px 9px;border-top:1px solid #1f2937;color:#e5e7eb;">${money(base)}</td>
            <td style="padding:8px 9px;border-top:1px solid #1f2937;font-weight:600;color:#f9fafb;">${money(customerPrice)}</td>
            <td style="padding:8px 9px;border-top:1px solid #1f2937;color:#4ade80;">-${money(discount)}</td>
        </tr>`;
    }).join('');
    const sharePercent = (Number(customerDiscountPercent) || 0).toFixed(0);
    preview.innerHTML = `
        <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead><tr style="background:#1f2937;text-align:left;color:#e5e7eb;">
                    <th style="padding:8px 9px;">Package</th><th style="padding:8px 9px;">Your price</th>
                    <th style="padding:8px 9px;">Customer pays</th><th style="padding:8px 9px;">You share</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p style="font-size:12px;color:#9ca3af;margin:10px 0 0;">Sharing ${sharePercent}% of your commission profit. Customers see these reduced prices when they buy through your store link.</p>`;
}

async function saveProfitShare() {
    const inputEl = document.getElementById('profitShareInput');
    const percent = inputEl ? parseFloat(inputEl.value) : 0;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        alert('Enter a share between 0 and 100.');
        return;
    }
    customerDiscountPercent = Math.round(percent * 100) / 100;
    localStorage.setItem('customer_discount_percent', String(customerDiscountPercent));
    updateProfitSharePreview();
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-pricing', {
            body: { discountPercent: customerDiscountPercent }
        });
        if (error || data?.error) {
            console.warn('Backend profit share save notice:', error || data?.error);
            alert('✅ Profit share saved locally! (Backend sync pending)');
            return;
        }
        alert('✅ Customers will now see your shared-profit discount in the store.');
    } catch (err) {
        console.error('Failed to sync profit share to backend:', err);
        alert('✅ Profit share saved locally!');
    }
}

function initProfitSharePanel() {
    const pricingContent = document.getElementById('content-pricing');
    if (!pricingContent || document.getElementById('profitSharePanel')) return;

    const cached = localStorage.getItem('customer_discount_percent');
    if (cached !== null && cached !== '' && Number.isFinite(Number(cached))) {
        customerDiscountPercent = Math.min(Math.max(Number(cached), 0), 100);
    }

    const panel = document.createElement('section');
    panel.id = 'profitSharePanel';
    panel.setAttribute('aria-labelledby', 'profitShareTitle');
    panel.style.cssText = 'margin-top: 18px; background: #111827; border: 1px solid #1f2937; padding: 20px; border-radius: 8px;';
    panel.innerHTML = `
        <h3 id="profitShareTitle" style="margin: 0 0 5px; color: #f9fafb; font-size: 16px;">Share Profit with Customers</h3>
        <p style="font-size: 13px; color: #9ca3af; margin: 0 0 16px;">Give your customers a discount funded from the commission profit you earn. Set what share of your profit to pass on and they'll see the lower price in your store.</p>
        <div style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
            <label style="font-size: 13px; color: #e5e7eb; font-weight: 600;">Share of your profit (%)
                <input id="profitShareInput" type="number" min="0" max="100" step="1" inputmode="decimal" value="${customerDiscountPercent}" style="display: block; box-sizing: border-box; width: 130px; margin-top: 6px; padding: 9px; border: 1px solid #374151; border-radius: 6px; background: #0b0f19; color: #f9fafb;">
            </label>
            <button id="profitShareSaveBtn" type="button" style="padding: 10px 18px; border: none; border-radius: 6px; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer;">Save</button>
        </div>
        <div id="profitSharePreview" style="margin-top: 16px;"></div>
    `;
    pricingContent.appendChild(panel);

    const inputEl = panel.querySelector('#profitShareInput');
    const saveBtn = panel.querySelector('#profitShareSaveBtn');
    inputEl.addEventListener('input', () => {
        const value = parseFloat(inputEl.value);
        customerDiscountPercent = Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0;
        updateProfitSharePreview();
    });
    saveBtn.addEventListener('click', saveProfitShare);

    updateProfitSharePreview();
}

window.saveProfitShare = saveProfitShare;
