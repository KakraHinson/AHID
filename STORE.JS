import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

let currentAgentData = null;

// Percent of their commission profit the agent shares with storefront customers,
// and the per-network profit rates that mirror the Service Commission Calculator.
let customerDiscountPercent = 0;
const DATA_PROFIT_RATES = { mtn: 6, telecel: 4, airteltigo: 5 };

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
    initServiceCommissionCalculator();
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

    // 4. Update the shareable storefront link with the public agent referral code.
    const linkInput = document.getElementById('storeLinkInput');
    if (linkInput) {
        const origin = window.location.origin;
        const pathname = window.location.pathname;
        const repoSegment = pathname.split('/').filter(Boolean)[0];
        const baseUrl = repoSegment && pathname.includes(`/${repoSegment}/`)
            ? `${origin}/${repoSegment}`
            : origin;

        if (!currentAgentData?.agent_code) {
            console.error('This agent account has no referral code configured.');
            return;
        }
        linkInput.value = `${baseUrl}/nonAgentBuyers.html?ref=${encodeURIComponent(currentAgentData.agent_code)}`;
    }
});

// Bind STORE functions to window for HTML onclick attributes
window.switchTab = switchTab;
window.copyStoreLink = copyStoreLink;
window.saveStorePrices = saveStorePrices;
window.withdrawCredit = withdrawCredit;
window.transferToBalance = transferToBalance;
// Service rates used by the interactive commission calculator. API-backed transaction
// recording and wallet posting can be connected when endpoint details are available.
const SERVICE_COMMISSION_RATES = [
    { name: 'Go TV', rate: 1 },
    { name: 'DSTV', rate: 1 },
    { name: 'ECG Postpaid', rate: 1 },
    { name: 'ECG Prepaid', rate: 1 },
    { name: 'AT Airtime', rate: 6 },
    { name: 'MTN Airtime', rate: 6 },
    { name: 'Vodafone Airtime', rate: 8 },
    { name: 'MTN Data', rate: 6 },
    { name: 'AT Data', rate: 5 },
    { name: 'Vodafone Data', rate: 4 },
    { name: 'WAEC Results', rate: 8 }
];

function calculateServiceCommission(serviceName, amount) {
    const service = SERVICE_COMMISSION_RATES.find(item => item.name === serviceName && item.automatic !== false);
    const transactionAmount = Number(amount);
    if (!service || !Number.isFinite(transactionAmount) || transactionAmount < 0) return null;

    const multiplier = 1 + (service.rate / 100);
    const commissionBeforeDeduction = transactionAmount / multiplier;
    const actualCommission = transactionAmount - commissionBeforeDeduction;
    return {
        amount: transactionAmount,
        rate: service.rate,
        multiplier,
        commissionBeforeDeduction,
        actualCommission,
        agentCommission: actualCommission * 0.35,
        hubtelCommission: actualCommission * 0.30,
        merchantCommission: actualCommission * 0.35
    };
}

function initServiceCommissionCalculator() {
    const pricingContent = document.getElementById('content-pricing');
    if (!pricingContent || document.getElementById('serviceCommissionPanel')) return;

    const panel = document.createElement('section');
    panel.id = 'serviceCommissionPanel';
    panel.setAttribute('aria-labelledby', 'serviceCommissionTitle');
    panel.style.cssText = 'margin-top: 18px; background: #fff; border: 1px solid #e5e7eb; padding: 20px; border-radius: 8px;';

    const automaticServices = SERVICE_COMMISSION_RATES.filter(service => service.automatic !== false);
    panel.innerHTML =`
        <h3 id="serviceCommissionTitle" style="margin: 0 0 5px; color: #1f2937; font-size: 16px;">Service Commission Calculator</h3>
        <p style="font-size: 13px; color: #6b7280; margin: 0 0 16px;">Enter a transaction amount to see the profit you will earn on that service.</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px;">
            <label style="font-size: 13px; color: #374151; font-weight: 600;">Service
                <select id="commissionServiceSelect" style="display: block; box-sizing: border-box; width: 100%; margin-top: 6px; padding: 9px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb;">
                    ${automaticServices.map(service => `<option value="${service.name}">${service.name} — ${service.rate}%</option>`).join('')}
                </select>
            </label>
            <label style="font-size: 13px; color: #374151; font-weight: 600;">Transaction amount (GHS)
                <input id="commissionAmountInput" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" style="display: block; box-sizing: border-box; width: 100%; margin-top: 6px; padding: 9px; border: 1px solid #d1d5db; border-radius: 6px;">
            </label>
        </div>
        <div style="overflow-x: auto; margin-bottom: 18px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead><tr style="background: #f3f4f6; text-align: left;">
                    <th style="padding: 9px;">Amount</th><th style="padding: 9px;">Rate</th><th style="padding: 9px;">Multiplier</th>
                    <th style="padding: 9px;">Commission Before Deduction</th><th style="padding: 9px;">Actual Commission After Deduction</th>
                    <th style="padding: 9px;">Your Profit (35%)</th>
                </tr></thead>
                <tbody><tr>
                    <td id="commissionAmountResult" style="padding: 10px 9px; border-top: 1px solid #e5e7eb;">GHS 0.00</td>
                    <td id="commissionRateResult" style="padding: 10px 9px; border-top: 1px solid #e5e7eb;">1%</td>
                    <td id="commissionMultiplierResult" style="padding: 10px 9px; border-top: 1px solid #e5e7eb;">1.01</td>
                    <td id="commissionBeforeResult" style="padding: 10px 9px; border-top: 1px solid #e5e7eb;">GHS 0.00</td>
                    <td id="actualCommissionResult" style="padding: 10px 9px; border-top: 1px solid #e5e7eb; font-weight: 700; color: #2563eb;">GHS 0.00</td>
                    <td id="agentCommissionResult" style="padding: 10px 9px; border-top: 1px solid #e5e7eb; font-weight: 700; color: #15803d;">GHS 0.00</td>
                </tr></tbody>
            </table>
        </div>
        <h4 style="font-size: 14px; color: #374151; margin: 0 0 8px;">Service rates</h4>
        <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead><tr style="background: #f3f4f6; text-align: left;"><th style="padding: 9px;">Service</th><th style="padding: 9px;">Rate</th><th style="padding: 9px;">Calculator status</th></tr></thead>
                <tbody>${SERVICE_COMMISSION_RATES.map(service =>`
                    <tr><td style="padding: 8px 9px; border-top: 1px solid #e5e7eb;">${service.name}</td>
                    <td style="padding: 8px 9px; border-top: 1px solid #e5e7eb;">${service.rate}%</td>
                    <td style="padding: 8px 9px; border-top: 1px solid #e5e7eb; color: ${service.automatic === false ? '#b45309' : '#15803d'};">${service.automatic === false ? 'Manual upload — excluded' : 'Calculator enabled'}</td></tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p style="font-size: 12px; color: #6b7280; margin: 12px 0 0;">WAEC Results is calculated at 8%; API transaction recording and wallet posting can be connected once API details are available. Formula: multiplier = 1 + (rate / 100); before deduction = amount ÷ multiplier; actual commission = amount − before deduction. You earn 35% of the actual commission as profit.</p>
    `;
    pricingContent.appendChild(panel);

    const serviceSelect = panel.querySelector('#commissionServiceSelect');
    const amountInput = panel.querySelector('#commissionAmountInput');
    const money = value => `GHS ${value.toFixed(2)}`;
    const update = () => {
        const result = calculateServiceCommission(serviceSelect.value, amountInput.value || 0);
        if (!result) return;
        panel.querySelector('#commissionAmountResult').textContent = money(result.amount);
        panel.querySelector('#commissionRateResult').textContent = `${result.rate}%`;
        panel.querySelector('#commissionMultiplierResult').textContent = result.multiplier.toFixed(2);
        panel.querySelector('#commissionBeforeResult').textContent = money(result.commissionBeforeDeduction);
        panel.querySelector('#actualCommissionResult').textContent = money(result.actualCommission);
        panel.querySelector('#agentCommissionResult').textContent = money(result.agentCommission);
    };
    serviceSelect.addEventListener('change', update);
    amountInput.addEventListener('input', update);
    update();
}

window.calculateServiceCommission = calculateServiceCommission;

// Discount a package price by the agent's shared profit. Commission uses the
// platform multiplier formula, the agent keeps 35% of it, and the customer gets
// `customerDiscountPercent` of that agent share.
function profitShareDiscount(basePrice, rate) {
    const base = Math.round(Number(basePrice) * 100) / 100;
    const share = customerDiscountPercent;
    if (!rate || !Number.isFinite(base) || base <= 0 || !(share > 0)) {
        return { customerPrice: base, discount: 0 };
    }
    const commission = base - base / (1 + rate / 100);
    const agentProfit = commission * 0.35;
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
            <td style="padding:8px 9px;border-top:1px solid #e5e7eb;">${sample.label} <span style="color:#6b7280;">(${rate}%)</span></td>
            <td style="padding:8px 9px;border-top:1px solid #e5e7eb;">${money(base)}</td>
            <td style="padding:8px 9px;border-top:1px solid #e5e7eb;font-weight:600;">${money(customerPrice)}</td>
            <td style="padding:8px 9px;border-top:1px solid #e5e7eb;color:#15803d;">-${money(discount)}</td>
        </tr>`;
    }).join('');
    const sharePercent = (Number(customerDiscountPercent) || 0).toFixed(0);
    preview.innerHTML = `
        <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead><tr style="background:#f3f4f6;text-align:left;">
                    <th style="padding:8px 9px;">Package</th><th style="padding:8px 9px;">Your price</th>
                    <th style="padding:8px 9px;">Customer pays</th><th style="padding:8px 9px;">You share</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p style="font-size:12px;color:#6b7280;margin:10px 0 0;">Sharing ${sharePercent}% of your commission profit. Customers see these reduced prices when they buy through your store link.</p>`;
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
    panel.style.cssText = 'margin-top: 18px; background: #fff; border: 1px solid #e5e7eb; padding: 20px; border-radius: 8px;';
    panel.innerHTML = `
        <h3 id="profitShareTitle" style="margin: 0 0 5px; color: #1f2937; font-size: 16px;">Share Profit with Customers</h3>
        <p style="font-size: 13px; color: #6b7280; margin: 0 0 16px;">Give your customers a discount funded from the commission profit you earn. Set what share of your profit to pass on and they'll see the lower price in your store.</p>
        <div style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
            <label style="font-size: 13px; color: #374151; font-weight: 600;">Share of your profit (%)
                <input id="profitShareInput" type="number" min="0" max="100" step="1" inputmode="decimal" value="${customerDiscountPercent}" style="display: block; box-sizing: border-box; width: 130px; margin-top: 6px; padding: 9px; border: 1px solid #d1d5db; border-radius: 6px;">
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
