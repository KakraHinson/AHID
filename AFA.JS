import { supabase } from './supabaseClient.js';
import { applyWalletBalance } from './walletBalance.js';

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function submitFormError(message) {
    alert(message || 'Unable to submit registration. Please try again.');
}

// Loads the live AFA price from service_pricing so the figure shown matches
// what the server charges. Falls back to 11.00 if it cannot be read.
async function loadAfaFee() {
    try {
        const { data } = await supabase
            .from('service_pricing')
            .select('price')
            .eq('service', 'afa')
            .maybeSingle();
        const price = Number(data?.price);
        if (Number.isFinite(price) && price >= 0) {
            const el = document.getElementById('afaFeeDisplay');
            if (el) el.textContent = `GHS ${price.toFixed(2)}`;
        }
    } catch (err) {
        console.warn('Could not load AFA price:', err);
    }
}

document.addEventListener('DOMContentLoaded', loadAfaFee);

// Handle New Registration Submission
async function submitRegistration() {
    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const town = document.getElementById('regTown').value.trim();
    const idType = document.getElementById('regIdType').value;
    const idNumber = document.getElementById('regIdNumber').value.trim();
    const occupation = document.getElementById('regOccupation').value.trim();

    if (!name || !phone || !town || !idType || !idNumber || !occupation) {
        alert('Please fill out all registration fields.');
        return;
    }

    // AFA is paid from the agent wallet, so a signed-in agent is required.
    // The status tracker below stays public.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
        alert('AFA registration is available to Skaitech Agents only. Please sign in or register as an agent to continue using your wallet balance.');
        return;
    }

    const { data, error } = await supabase.functions.invoke('create-afa-registration', {
        body: { fullName: name, phone, town, idType, idNumber, occupation }
    });

    if (error || data?.error) {
        submitFormError(data?.error || error?.message);
        return;
    }

    if (data.walletBalance !== undefined && data.walletBalance !== null) {
        applyWalletBalance(data.walletBalance);
    }

    alert(data.message || 'AFA Registration submitted successfully! You can now track your status below.');

    // Clear inputs
    document.getElementById('regName').value = '';
    document.getElementById('regPhone').value = '';
    document.getElementById('regTown').value = '';
    document.getElementById('regIdType').value = '';
    document.getElementById('regIdNumber').value = '';
    document.getElementById('regOccupation').value = '';
}

// Handle Status Tracking Lookup
async function trackAfa() {
    const inputField = document.getElementById('afaQuery');
    const resultBox = document.getElementById('afaResult');

    if (!inputField || !resultBox) return;

    const query = inputField.value.trim();

    if (!query) {
        alert('Please enter your phone number or ID number.');
        return;
    }

    resultBox.style.display = 'block';
    resultBox.innerHTML = `<p style="color: #6b7280; font-weight: 600; margin: 0;">Searching…</p>`;

    const { data, error } = await supabase.functions.invoke('get-afa-registration', {
        body: { query }
    });

    if (error || data?.error) {
        resultBox.innerHTML = `<p style="color: #dc2626; font-weight: 600; margin: 0;">${escapeHtml(data?.error || 'Unable to check registration status. Please try again.')}</p>`;
        return;
    }

    const found = data.registrations?.[0];
    if (!found) {
        resultBox.innerHTML = `<p style="color: #b45309; font-weight: 600; margin: 0;">No active AFA registration matched: "${escapeHtml(query)}"</p>`;
        return;
    }

    resultBox.style.display = 'block';
    resultBox.innerHTML = `
        <div style="font-size: 0.9rem;">
            <div style="font-weight: 800; color: #b45309; margin-bottom: 10px; font-size: 1rem;">Registration Found!</div>
            
            <div class="field-label">FULL NAME</div>
            <div class="field-val">${escapeHtml(found.full_name)}</div>

            <div class="field-label">PHONE NUMBER</div>
            <div class="field-val">${escapeHtml(found.phone)}</div>

            <div class="field-label">TOWN</div>
            <div class="field-val">${escapeHtml(found.town)}</div>

            <div class="field-label">ID NUMBER</div>
            <div class="field-val">${escapeHtml(found.id_type)} (${escapeHtml(found.id_number)})</div>

            <div class="field-label">REFERENCE</div>
            <div class="field-val">${escapeHtml(found.reference)}</div>

            <div class="field-label">REGISTRATION STATUS</div>
            <div style="display: inline-block; background: #d97706; color: white; padding: 3px 10px; border-radius: 6px; font-weight: 700; font-size: 0.8rem; margin-top: 4px;">
                ${escapeHtml(found.status)}
            </div>
        </div>
    `;
}

// Bind AFA functions to window for HTML onclick attributes
window.submitRegistration = submitRegistration;
window.trackAfa = trackAfa;
