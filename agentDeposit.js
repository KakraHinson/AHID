import { supabase } from './supabaseClient.js';
// Load and display current wallet balance on page load
document.addEventListener('DOMContentLoaded', () => {
    updateWalletDisplay();
    handlePaymentReturn();
    loadCashoutDepositRequests();
});

async function updateWalletDisplay() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    const { data: wallet, error } = await supabase
        .from('wallets')
        .select('balance')
        .eq('id', user.id)
        .maybeSingle();
    const balance = !error && wallet ? Number(wallet.balance) || 0 : 0;

    if (!error && wallet) {
        localStorage.setItem('agent_wallet_balance', String(balance));
    }

    const balanceDisplay = document.getElementById('walletHeaderDisplay');
    if (balanceDisplay) {
        balanceDisplay.innerText = `Wallet Balance: GHS ${balance.toFixed(2)}`;
    }
    const cardBalDisplay = document.getElementById('cashoutWalletBalDisplay');
    if (cardBalDisplay) {
        cardBalDisplay.innerText = `GHS ${balance.toFixed(2)}`;
    }
}

async function handlePaymentReturn() {
    const reference = new URLSearchParams(window.location.search).get('reference');
    const statusElement = document.getElementById('walletPaymentStatus');
    if (!reference || !statusElement) return;

    statusElement.hidden = false;
    statusElement.textContent = 'Payment received. Confirming your wallet top-up...';

    const { data: topup, error } = await supabase
        .from('wallet_topups')
        .select('amount, status, payment_reference')
        .eq('payment_reference', reference)
        .maybeSingle();

    if (error || !topup) {
        statusElement.textContent = 'Payment submitted. Your wallet will update after the payment provider confirms the transaction.';
        return;
    }

    if (topup.status === 'paid') {
        statusElement.textContent = `Wallet loaded successfully: GHS ${Number(topup.amount).toFixed(2)}.`;
        await updateWalletDisplay();
        return;
    }

    if (topup.status === 'failed') {
        statusElement.textContent = 'Payment was not successful. Your wallet was not loaded.';
        return;
    }

    statusElement.textContent = 'Payment is still being confirmed. Your wallet has not been loaded yet.';
}

// 1. Checkout Handler (Paystack or Hubtel)
function payWithExpressPay(provider) {
    const amountInput = document.getElementById('expressAmount');
    const amount = parseFloat(amountInput ? amountInput.value : 0);

    if (!amount || amount <= 0) {
        alert("Please enter a valid deposit amount in GHS.");
        return;
    }

    return startWalletPayment(amount, provider === 'hubtel' ? 'hubtel' : 'paystack');
}

async function startWalletPayment(amount, provider) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        alert('Please sign in with your agent account before funding your wallet.');
        window.location.href = 'login.html';
        return;
    }
    const button = document.querySelector('[onclick="payWithExpressPay(\'' + provider + '\')"]');
    if (button) { button.disabled = true; button.textContent = 'Opening secure checkout…'; }
    try {
        const { data, error } = await supabase.functions.invoke('create-agent-wallet-payment', { body: { amount, provider } });
        if (error) throw error;
        if (!data?.authorizationUrl) throw new Error(data?.error || 'Unable to open checkout.');
        window.location.href = data.authorizationUrl;
    } catch (error) {
        alert(error.message || 'Unable to start secure payment. Please try again.');
        if (button) { button.disabled = false; button.textContent = provider === 'hubtel' ? 'Pay with Hubtel' : 'Pay with Paystack'; }
    }
}

async function loadCashoutDepositRequests() {
    const statusElement = document.getElementById('cashoutRequestStatus');
    if (!statusElement) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: requests, error } = await supabase
        .from('cashout_deposit_requests')
        .select('id, amount, status, settlement_reference, admin_note, requested_at')
        .eq('agent_id', user.id)
        .order('requested_at', { ascending: false })
        .limit(5);
    if (error) {
        statusElement.textContent = 'Unable to load cashout deposit requests.';
        return;
    }
    if (!requests?.length) {
        statusElement.textContent = 'No cashout deposit requests yet.';
        return;
    }
    statusElement.innerHTML = requests.map((entry) => {
        const reference = entry.settlement_reference ? ` • Ref: ${entry.settlement_reference}` : '';
        const note = entry.admin_note ? ` • ${entry.admin_note}` : '';
        return `<div><strong>${String(entry.status).toUpperCase()}</strong> — GHS ${Number(entry.amount).toFixed(2)}${reference}${note}</div>`;
    }).join('');
}

// 3. Cashout Deposit Flow Handler
async function initiateCashoutDeposit() {
    alert("Cashout deposit is currently disabled. Please use Paystack Checkout.");
    return;
    const phone = document.getElementById('cashoutPhone').value.trim();
    const amount = parseFloat(document.getElementById('cashoutAmount').value);

    if (!amount || amount < 50) {
        alert("Minimum request amount is GHS 50.00.");
        return;
    }

    if (!phone || phone.length < 10) {
        alert("Please enter a valid paying MoMo phone number.");
        return;
    }

    const button = document.querySelector('[onclick="initiateCashoutDeposit()"]');
    if (button) { button.disabled = true; button.textContent = 'Submitting request…'; }
    try {
        const { data, error } = await supabase.functions.invoke('request-cashout-deposit', { body: { amount, phone } });
        if (error || data?.error) throw new Error(data?.error || error?.message || 'Unable to submit the deposit request.');
        alert(`Deposit request submitted for GHS ${Number(data.request.amount).toFixed(2)}. Pay only through the agreed admin/booth process. Your wallet will be credited after an administrator verifies and approves the payment.`);
        document.getElementById('cashoutAmount').value = '';
        document.getElementById('cashoutPhone').value = '';
        await loadCashoutDepositRequests();
    } catch (error) {
        alert(error instanceof Error ? error.message : 'Unable to submit the deposit request.');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Submit deposit request'; }
    }
}


// Helper function to log transactions into localStorage history
function saveTransactionRecord(type, amount, status) {
    const txs = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    txs.unshift({
        id: 'TXN' + Math.floor(1000 + Math.randfom() * 9000),
        network: type,
        package: `Wallet Funding`,
        price: amount.toFixed(2),
        status: status,
        date: new Date().toLocaleDateString()
    });
    localStorage.setItem('skaitechOrders', JSON.stringify(txs));
}

// 4. Claim Wallet Credit Handler (Using MoMo Transaction ID)
function claimWalletCredit() {
    alert("Claiming wallet credit is currently disabled. Please use Paystack Checkout.");
    return;
    const txId = document.getElementById('claimTxId').value.trim();
    const amount = parseFloat(document.getElementById('claimAmount').value);

    if (!txId) {
        alert("Please enter your MoMo Transaction ID.");
        return;
    }

    if (!amount || amount <= 0) {
        alert("Please enter a valid amount paid.");
        return;
    }

    alert(`Your claim for GHS ${amount.toFixed(2)} (${txId}) has been recorded for verification. Your wallet will be credited only after the payment is confirmed.`);
    document.getElementById('claimTxId').value = '';
    document.getElementById('claimAmount').value = '';
    return;

    // Update wallet balance in localStorage
    let balance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    balance += amount;
    localStorage.setItem('agent_wallet_balance', balance);

    // Save/Update transaction record history
    const existingOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    existingOrders.unshift({
        id: txId,
        network: 'Cashout Claimed',
        package: `Wallet Topup (MoMo)`,
        price: amount.toFixed(2),
        status: 'Success',
        date: new Date().toLocaleDateString()
    });
    localStorage.setItem('skaitechOrders', JSON.stringify(existingOrders));

    alert(`✅ Wallet Successfully Credited!\nGHS ${amount.toFixed(2)} has been added to your balance using Transaction ID: ${txId}`);
    location.reload(); // Refresh page to display new balance
}
// Bind deposit functions to window for HTML onclick attributes
window.payWithExpressPay = payWithExpressPay;
window.initiateCashoutDeposit = initiateCashoutDeposit;
window.claimWalletCredit = claimWalletCredit;
window.updateWalletDisplay = updateWalletDisplay;
