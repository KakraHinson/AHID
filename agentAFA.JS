import { requireVerifiedAgent } from './agentAuthGuard.js';
import { readFunctionError, supabase } from './supabaseClient.js?v=2026110506';
import { applyWalletBalance } from './walletBalance.js';

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

let afaFee = 11.00;
let afaStep = 1;

function showAfaFormMessage(message = '', type = 'error') {
    const element = document.getElementById('afaFormMessage');
    if (!element) return;
    element.textContent = message;
    element.className = `afa-form-message${message ? ` show ${type}` : ''}`;
}

function setAfaStep(step) {
    afaStep = step === 2 ? 2 : 1;
    document.getElementById('afaStep1')?.toggleAttribute('hidden', afaStep !== 1);
    document.getElementById('afaStep2')?.toggleAttribute('hidden', afaStep !== 2);
    document.getElementById('afaStepMarker1')?.classList.toggle('active', afaStep === 1);
    document.getElementById('afaStepMarker2')?.classList.toggle('active', afaStep === 2);
    if (afaStep === 1) document.getElementById('afaName')?.focus({ preventScroll: true });
    if (afaStep === 2) document.getElementById('afaIdNumber')?.focus({ preventScroll: true });
}

function validateAfaStep(step) {
    const ids = step === 1 ? ['afaName', 'afaPhone', 'afaTown'] : ['afaIdNumber', 'afaOccupation'];
    for (const id of ids) {
        const field = document.getElementById(id);
        if (!field) continue;
        if (!field.value.trim()) {
            field.focus();
            field.reportValidity?.();
            return false;
        }
    }

    if (step === 1) {
        const phone = document.getElementById('afaPhone');
        const normalizedPhone = phone.value.replace(/\D/g, '').slice(0, 10);
        phone.value = normalizedPhone;
        if (!/^0\d{9}$/.test(normalizedPhone)) {
            phone.setCustomValidity('Enter a valid 10-digit Ghana phone number starting with 0.');
            phone.reportValidity?.();
            phone.setCustomValidity('');
            phone.focus();
            return false;
        }
    }
    return true;
}

function nextAfaStep() {
    if (validateAfaStep(1)) {
        showAfaFormMessage();
        setAfaStep(2);
    }
}

function previousAfaStep() {
    showAfaFormMessage();
    setAfaStep(1);
}

function setupAfaForm() {
    const phone = document.getElementById('afaPhone');
    phone?.addEventListener('input', () => {
        phone.value = phone.value.replace(/\D/g, '').slice(0, 10);
    });
    const idNumber = document.getElementById('afaIdNumber');
    idNumber?.addEventListener('input', () => {
        idNumber.value = idNumber.value.toUpperCase();
    });
}

// Reads the live AFA price from service_pricing so the figure shown here always
// matches what the server charges. Falls back to 11.00 if it cannot be read.
async function loadAfaFee() {
    try {
        const { data } = await supabase
            .from('service_pricing')
            .select('price')
            .eq('service', 'afa')
            .maybeSingle();
        const price = Number(data?.price);
        if (Number.isFinite(price) && price >= 0) afaFee = Math.round(price * 100) / 100;
    } catch (err) {
        console.warn('Could not load AFA price:', err);
    }
    const shown = afaFee.toFixed(2);
    const main = document.getElementById('afaFeeDisplay');
    if (main) main.textContent = `GHS ${shown}`;
    const inline = document.getElementById('afaFeeInline');
    if (inline) inline.textContent = shown;
}

document.addEventListener('DOMContentLoaded', async () => {
    setupAfaForm();
    const authResult = await requireVerifiedAgent({ redirectOnFail: true });
    if (!authResult) return;
    await loadAfaFee();
    await loadAfaRequests();
    window.setInterval(() => loadAfaRequests(document.getElementById('afaSearchInput')?.value || ''), 15000);
});

// Open/Close Modal handlers
function openAddAfaModal() {
    const modal = document.getElementById('afaModal');
    if (modal) {
        modal.style.display = 'flex';
        showAfaFormMessage();
        setAfaStep(1);
    }
}

function closeAddAfaModal() {
    const modal = document.getElementById('afaModal');
    if (modal) modal.style.display = 'none';
    showAfaFormMessage();
}

async function setAfaStatus(reference, status) {
    const { data, error } = await supabase.functions.invoke('manage-afa-registrations', {
        body: { action: 'update_status', reference, status }
    });
    if (error || data?.error) {
        alert(data?.error || error?.message || 'Unable to update status. Please try again.');
        return;
    }
    await loadAfaRequests();
}

// Save a new AFA registration
async function submitNewAfa() {
    if (!validateAfaStep(1)) {
        setAfaStep(1);
        return;
    }
    if (!validateAfaStep(2)) {
        setAfaStep(2);
        return;
    }

    const name = document.getElementById('afaName').value.trim();
    const phone = document.getElementById('afaPhone').value.replace(/\D/g, '').slice(0, 10);
    const town = document.getElementById('afaTown').value.trim();
    const idNumber = document.getElementById('afaIdNumber').value.trim();
    const occupation = document.getElementById('afaOccupation').value.trim();

    const submitButton = document.getElementById('afaSubmitButton');
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Submitting…';
    }
    showAfaFormMessage('Submitting the request securely…', 'success');

    try {
        const { data, error } = await supabase.functions.invoke('create-afa-registration', {
            body: {
                fullName: name,
                phone,
                town,
                idType: 'NATIONAL_ID',
                idNumber,
                occupation,
            }
        });

        if (error || data?.error) {
            const functionError = error ? await readFunctionError(error) : { body: null, message: '' };
            const errorBody = functionError.body || {};
            if (Number.isFinite(Number(errorBody.walletBalance))) {
                applyWalletBalance(errorBody.walletBalance);
            }
            showAfaFormMessage(data?.error || functionError.message || 'Unable to submit registration. Please try again.', 'error');
            return;
        }

        if (data.walletBalance !== undefined && data.walletBalance !== null) {
            applyWalletBalance(data.walletBalance);
        }

        const reference = data.registration?.reference ? ` Reference: ${data.registration.reference}` : '';
        showAfaFormMessage(`Request submitted successfully.${reference} You can track its provider status below.`, 'success');
        document.getElementById('afaForm')?.reset();
        await loadAfaRequests();
        window.setTimeout(() => closeAddAfaModal(), 1800);
    } catch (error) {
        console.error('AFA submission failed:', error);
        showAfaFormMessage(error?.message || 'Unable to submit registration. Please try again.', 'error');
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML = 'Submit request <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>';
        }
    }

}

// Load and render AFA list from the backend
async function loadAfaRequests(filterQuery = '') {
    const container = document.getElementById('afaDataList');
    const emptyState = document.getElementById('emptyAfaState');

    if (!container || !emptyState) return;

    const query = filterQuery.trim();

    const functionName = query
        ? `manage-afa-registrations?query=${encodeURIComponent(query)}`
        : 'manage-afa-registrations';

    const { data, error } = await supabase.functions.invoke(functionName, {
        method: 'GET',
    });

    if (error || data?.error) {
        emptyState.innerHTML = `<p style="font-size: 15px; margin-bottom: 15px; color: #b91c1c;">${escapeHtml(data?.error || error?.message || 'Unable to load AFA requests.')}</p>`;
        emptyState.style.display = 'block';
        container.style.display = 'none';
        return;
    }

    let registrations = data?.registrations || [];

    const filtered = query
        ? registrations.filter(item => {
            const q = query.toLowerCase();
            return (item.full_name && item.full_name.toLowerCase().includes(q)) ||
                   (item.phone && item.phone.toLowerCase().includes(q)) ||
                   (item.town && item.town.toLowerCase().includes(q)) ||
                   (item.id_number && item.id_number.toLowerCase().includes(q)) ||
                   (item.reference && item.reference.toLowerCase().includes(q));
        })
        : registrations;

    if (filtered.length === 0) {
        emptyState.innerHTML = '<p style="font-size: 15px; margin-bottom: 15px;">No AFA requests found.</p>';
        emptyState.style.display = 'block';
        container.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    container.style.display = 'flex';

    container.innerHTML = '';

    filtered.forEach(item => {
        // Status badge color coding
        let badgeColor = '#f59e0b'; // Pending (Yellow/Orange)
        if (item.status === 'Completed') badgeColor = '#10b981'; // Green
        else if (item.status === 'Processing') badgeColor = '#3b82f6'; // Blue
        else if (item.status === 'Cancelled') badgeColor = '#ef4444'; // Red

        const card = document.createElement('div');
        card.style.cssText = "background: #fdfdfd; border: 1px solid #eaeaea; padding: 15px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;";

        const statusOptions = ['Pending', 'Processing', 'Completed', 'Cancelled']
            .map(s => `<option value="${s}"${s === item.status ? ' selected' : ''}>${s}</option>`)
            .join('');

        card.innerHTML = `
            <div>
                <div style="font-weight: 600; color: #1f2937; font-size: 15px; margin-bottom: 3px;">${escapeHtml(item.full_name)} <span style="font-size: 12px; color: #666; font-weight: normal;">(${escapeHtml(item.reference)})</span></div>
                <div style="font-size: 13px; color: #4b5563; display: flex; gap: 15px; flex-wrap: wrap;">
                    <span><i class="fa-solid fa-phone"></i> ${escapeHtml(item.phone)}</span>
                    <span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(item.town)}</span>
                    <span><i class="fa-solid fa-id-card"></i> ${escapeHtml(item.id_number)}</span>
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <select onchange="setAfaStatus('${item.reference}', this.value)" style="background: ${badgeColor}; color: white; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; border: none; cursor: pointer;">
                    ${statusOptions}
                </select>
                <span style="font-size: 12px; color: #9ca3af;">Updated ${new Date(item.updated_at || item.created_at).toLocaleString()}</span>
            </div>
        `;
        container.appendChild(card);
    });
}

async function trackMyAfa() {
    const query = document.getElementById('afaTrackQuery')?.value.trim();
    const result = document.getElementById('afaTrackResult');
    if (!result) return;
    if (!query) {
        result.style.display = 'block';
        result.innerHTML = '<strong>Enter an AFA reference or phone number.</strong>';
        return;
    }

    result.style.display = 'block';
    result.innerHTML = '<span style="color: #64748b;">Checking the latest provider status…</span>';
    const { data, error } = await supabase.functions.invoke(
        `manage-afa-registrations?query=${encodeURIComponent(query)}`,
        { method: 'GET' },
    );
    if (error || data?.error) {
        result.innerHTML = `<strong style="color: #b91c1c;">${escapeHtml(data?.error || error?.message || 'Unable to load status.')}</strong>`;
        return;
    }

    const item = data?.registrations?.[0];
    if (!item) {
        result.innerHTML = '<strong>No AFA order matched that reference or phone number.</strong>';
        return;
    }
    const status = String(item.status || 'Processing');
    const statusColor = status === 'Completed' ? '#047857' : status === 'Cancelled' ? '#b91c1c' : '#1d4ed8';
    result.innerHTML = `
      <div><strong>Reference:</strong> ${escapeHtml(item.reference || '—')}</div>
      <div><strong>Provider reference:</strong> ${escapeHtml(item.provider_reference || 'Waiting for provider')}</div>
      <div><strong>Status:</strong> <span style="color: ${statusColor}; font-weight: 800;">${escapeHtml(status)}</span></div>
      <div><strong>Last updated:</strong> ${escapeHtml(new Date(item.updated_at || item.created_at).toLocaleString())}</div>
      ${item.failure_reason ? `<div style="color: #b91c1c; margin-top: 5px;"><strong>Reason:</strong> ${escapeHtml(item.failure_reason)}</div>` : ''}
    `;
}

// Live search tracker function
function filterAfaList() {
    const searchInput = document.getElementById('afaSearchInput');
    const query = searchInput ? searchInput.value : '';
    loadAfaRequests(query);
}

window.openAddAfaModal = openAddAfaModal;
window.closeAddAfaModal = closeAddAfaModal;
window.nextAfaStep = nextAfaStep;
window.previousAfaStep = previousAfaStep;
window.submitNewAfa = submitNewAfa;
window.filterAfaList = filterAfaList;
window.loadAfaRequests = loadAfaRequests;
window.setAfaStatus = setAfaStatus;
window.trackMyAfa = trackMyAfa;
