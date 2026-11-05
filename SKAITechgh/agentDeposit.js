// 1. ExpressPay Checkout Handler
function payWithExpressPay() {
    const amountInput = document.getElementById('expressAmount');
    const emailInput = document.getElementById('expressEmail');
    
    const amount = parseFloat(amountInput ? amountInput.value : 0);
    const email = emailInput ? emailInput.value.trim() : '';

    if (!amount || amount <= 0) {
        alert("Please enter a valid deposit amount in GHS.");
        return;
    }

    if (!email || !email.includes('@')) {
        alert("Please enter a valid agent email address.");
        return;
    }

    // Calculate amount in pesewas (GHS * 100) as noted in the API instructions
    const amountInPesewas = Math.round(amount * 100);

    alert(`Preparing ExpressPay Checkout...\nAmount: GHS ${amount.toFixed(2)} (${amountInPesewas} pesewas)\nEmail: ${email}`);

    // Simulated successful gateway callback response
    setTimeout(() => {
        let balance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
        balance += amount;
        localStorage.setItem('agent_wallet_balance', balance);

        saveTransactionRecord('ExpressPay Deposit', amount, 'Success');

        alert(`✅ Payment Successful! GHS ${amount.toFixed(2)} added to your wallet.`);
        location.reload();
    }, 1500);
}

// 2. Direct Deposit (Manual Reference) Handler
function submitDirectDeposit() {
    const amount = parseFloat(document.getElementById('directAmount').value);
    const refId = document.getElementById('momoReference').value.trim();

    if (!amount || amount <= 0 || !refId) {
        alert("Please enter both the amount and the MoMo Transaction Reference/ID.");
        return;
    }

    const newDeposit = {
        id: 'DEP' + Math.floor(1000 + Math.random() * 9000),
        network: 'Direct Deposit',
        package: `Manual Ref: ${refId}`,
        price: amount.toFixed(2),
        status: 'Pending Verification',
        date: new Date().toLocaleDateString()
    };

    const existingOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    existingOrders.unshift(newDeposit);
    localStorage.setItem('skaitechOrders', JSON.stringify(existingOrders));

    alert(`✅ Deposit Request Submitted!\nReference: ${refId}\nYour wallet will be credited once verified.`);
    
    document.getElementById('directAmount').value = '';
    document.getElementById('momoReference').value = '';
}

// Update wallet balance display on load (both header and card)
document.addEventListener('DOMContentLoaded', () => {
    updateWalletDisplay();
});

function updateWalletDisplay() {
    let balance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    
    const headerDisplay = document.getElementById('walletHeaderDisplay');
    if (headerDisplay) {
        headerDisplay.innerText = `Wallet Balance: GHS ${balance.toFixed(2)}`;
    }

    const cardBalDisplay = document.getElementById('cashoutWalletBalDisplay');
    if (cardBalDisplay) {
        cardBalDisplay.innerText = `GHS ${balance.toFixed(2)}`;
    }
}

// 3. Cashout Deposit Flow Handler
function initiateCashoutDeposit() {
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

    alert(`✅ Deposit Request Submitted!\nAmount: GHS ${amount.toFixed(2)}\nNumber: ${phone}\nYou have joined the queue. Follow the admin booth workflow to complete settlement.`);

    // Log request as pending admin settlement/queue
    const newDeposit = {
        id: 'CSH' + Math.floor(1000 + Math.random() * 9000),
        network: 'Cashout Deposit',
        package: `Queue Request (${phone})`,
        price: amount.toFixed(2),
        status: 'Pending Booth Queue',
        date: new Date().toLocaleDateString()
    };

    const existingOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    existingOrders.unshift(newDeposit);
    localStorage.setItem('skaitechOrders', JSON.stringify(existingOrders));

    // Clear fields
    document.getElementById('cashoutAmount').value = '';
    document.getElementById('cashoutPhone').value = '';
}


// Helper function to log transactions into localStorage history
function saveTransactionRecord(type, amount, status) {
    const txs = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    txs.unshift({
        id: 'TXN' + Math.floor(1000 + Math.random() * 9000),
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
