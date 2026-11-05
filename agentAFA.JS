import { requireVerifiedAgent } from './agentAuthGuard.js';
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

let afaFee = 11.00;

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
    const authResult = await requireVerifiedAgent({ redirectOnFail: true });
    if (!authResult) return;
    await loadAfaFee();
    await loadAfaRequests();
});

// Open/Close Modal handlers
function openAddAfaModal() {
    const modal = document.getElementById('afaModal');
    if (modal) modal.style.display = 'flex';
}

function closeAddAfaModal() {
    const modal = document.getElementById('afaModal');
    if (modal) modal.style.display = 'none';
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
    const name = document.getElementById('afaName').value.trim();
    const phone = document.getElementById('afaPhone').value.trim();
    const town = document.getElementById('afaTown').value.trim();
    const idNumber = document.getElementById('afaIdNumber').value.trim();
    const dateOfBirth = document.getElementById('afaDob').value.trim();
    const occupation = document.getElementById('afaOccupation').value.trim();

    if (!name || !phone || !town || !idNumber || !dateOfBirth || !occupation) {
        alert("Please fill in all required fields.");
        return;
    }

    const { data, error } = await supabase.functions.invoke('create-afa-registration', {
        body: {
            fullName: name,
            phone,
            town,
            idType: 'Ghana Card',
            idNumber,
            dateOfBirth,
            occupation,
        }
    });

    if (error || data?.error) {
        alert(data?.error || error?.message || 'Unable to submit registration. Please try again.');
        return;
    }

    alert("✅ AFA Registration submitted successfully!");
    closeAddAfaModal();

    if (data.walletBalance !== undefined && data.walletBalance !== null) {
        applyWalletBalance(data.walletBalance);
    }

    // Clear fields
    document.getElementById('afaName').value = '';
    document.getElementById('afaPhone').value = '';
    document.getElementById('afaTown').value = '';
    document.getElementById('afaIdNumber').value = '';
    document.getElementById('afaDob').value = '';
    document.getElementById('afaOccupation').value = '';

    await loadAfaRequests();
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
                <span style="font-size: 12px; color: #9ca3af;">${new Date(item.created_at).toLocaleDateString()}</span>
            </div>
        `;
        container.appendChild(card);
    });
}

// Live search tracker function
function filterAfaList() {
    const searchInput = document.getElementById('afaSearchInput');
    const query = searchInput ? searchInput.value : '';
    loadAfaRequests(query);
}

window.openAddAfaModal = openAddAfaModal;
window.closeAddAfaModal = closeAddAfaModal;
window.submitNewAfa = submitNewAfa;
window.filterAfaList = filterAfaList;
window.loadAfaRequests = loadAfaRequests;
window.setAfaStatus = setAfaStatus;
