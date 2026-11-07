import { supabase, readFunctionError } from './supabaseClient.js';

// Load and display current wallet balance on page load
document.addEventListener('DOMContentLoaded', () => {
    updateWalletDisplay();
    handlePaymentReturn();
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
}

async function verifyWalletTopup(reference) {
    const { data, error } = await supabase.functions.invoke('verify-wallet-topup', {
        body: { reference },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
}

function wait(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function fetchWalletTopup(reference) {
    const { data, error } = await supabase
        .from('wallet_topups')
        .select('amount, status, provider, payment_reference')
        .eq('payment_reference', reference)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function handlePaymentReturn() {
    const reference = new URLSearchParams(window.location.search).get('reference');
    const statusElement = document.getElementById('walletPaymentStatus');
    if (!reference || !statusElement) return;

    statusElement.hidden = false;
    statusElement.textContent = 'Payment received. Confirming your wallet top-up...';

    let topup;
    try {
        topup = await fetchWalletTopup(reference);
    } catch (error) {
        console.warn('Could not load the returned wallet top-up:', error);
    }

    if (!topup) {
        statusElement.textContent = 'Payment submitted. Your wallet will update after the payment provider confirms the transaction.';
        return;
    }

    let verification = null;
    // Hubtel may redirect the browser before its server callback has finished.
    // Keep checking for up to 30 seconds so the agent sees the credit without
    // needing to refresh or leave the wallet flow manually.
    for (let attempt = 0; attempt < 15; attempt += 1) {
        if (topup?.status === 'paid') {
            verification = { credited: true };
            break;
        }
        if (topup?.status === 'failed') break;

        try {
            verification = await verifyWalletTopup(reference);
            if (verification?.credited === true || verification?.status === 'failed') break;
        } catch (verifyError) {
            console.warn('Wallet top-up verification is still pending:', verifyError);
        }

        if (attempt < 14) await wait(2000);
        try {
            topup = await fetchWalletTopup(reference);
        } catch (refreshError) {
            console.warn('Could not refresh wallet top-up status:', refreshError);
        }
    }

    if (verification?.credited === true) {
        const creditedAmount = Number(topup?.amount ?? verification.amount ?? 0);
        statusElement.textContent = `Wallet loaded successfully: GHS ${creditedAmount.toFixed(2)}.`;
        await updateWalletDisplay();
        window.setTimeout(() => {
            const amount = encodeURIComponent(creditedAmount.toFixed(2));
            window.location.replace(`agentWallet.html?deposit=success&amount=${amount}`);
        }, 1200);
        return;
    }

    if (topup?.status === 'failed' || verification?.status === 'failed') {
        statusElement.textContent = 'Payment was not successful. Your wallet was not loaded.';
        return;
    }

    statusElement.textContent = 'Payment is still being confirmed. Your wallet has not been loaded yet.';
}

// Paystack and Hubtel Checkout Handler
async function payWithExpressPay(provider = 'paystack') {
    const selectedProvider = String(provider).toLowerCase() === 'hubtel' ? 'hubtel' : 'paystack';
    const amountInput = document.getElementById('expressAmount');
    const amount = parseFloat(amountInput ? amountInput.value : 0);

    if (!amount || amount <= 0) {
        alert("Please enter a valid deposit amount in GHS.");
        return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        alert('Please sign in with your agent account before funding your wallet.');
        window.location.href = 'login.html';
        return;
    }

    const button = document.getElementById(`${selectedProvider}PayBtn`);
    const providerLabel = selectedProvider === 'hubtel' ? 'Hubtel' : 'Paystack';
    if (button) {
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Opening ${providerLabel} checkout…`;
    }

    try {
        const { data, error } = await supabase.functions.invoke('create-agent-wallet-payment', {
            body: { amount, provider: selectedProvider }
        });
        if (error) {
            const details = await readFunctionError(error);
            throw new Error(details.message || `Unable to open ${providerLabel} checkout.`);
        }
        if (!data?.authorizationUrl) throw new Error(data?.error || `Unable to open ${providerLabel} checkout.`);
        window.location.href = data.authorizationUrl;
    } catch (error) {
        alert(error.message || `Unable to start ${providerLabel} payment. Please try again.`);
        if (button) {
            button.disabled = false;
            button.innerHTML = `<i class="fa-solid fa-lock"></i> Pay with ${providerLabel}`;
        }
    }
}

// Bind functions to window for HTML onclick attributes
window.payWithExpressPay = payWithExpressPay;
window.updateWalletDisplay = updateWalletDisplay;
