import { db, ref, get, set, update, push } from "../config/firebase.js";

const DEFAULT_COST_PER_CALL = 11; // Commercial rate: Rs. 11.00 per call
const DEFAULT_INITIAL_BALANCE = 550; // Initial default wallet: Rs. 550 (50 calls)

class WalletService {
  constructor() {
    this.costPerCall = DEFAULT_COST_PER_CALL;
  }

  /**
   * Fetch current wallet balance and metrics from Firebase RTDB
   */
  async getWallet() {
    try {
      const snap = await get(ref(db, "billing_wallet"));
      if (snap.exists()) {
        const data = snap.val();
        return {
          balance: Number(data.balance || 0),
          cost_per_call: Number(data.cost_per_call || this.costPerCall),
          total_recharged: Number(data.total_recharged || 0),
          total_spent: Number(data.total_spent || 0),
          total_calls_deducted: Number(data.total_calls_deducted || 0),
          last_updated: data.last_updated || Date.now(),
          callsRemaining: Math.floor(Number(data.balance || 0) / (data.cost_per_call || this.costPerCall))
        };
      }

      // Initialize default wallet if none exists
      const initialWallet = {
        balance: DEFAULT_INITIAL_BALANCE,
        cost_per_call: this.costPerCall,
        total_recharged: DEFAULT_INITIAL_BALANCE,
        total_spent: 0,
        total_calls_deducted: 0,
        last_updated: Date.now()
      };
      await set(ref(db, "billing_wallet"), initialWallet);
      return {
        ...initialWallet,
        callsRemaining: Math.floor(DEFAULT_INITIAL_BALANCE / this.costPerCall)
      };
    } catch (err) {
      console.error("[WalletService] Error fetching wallet:", err.message);
      return {
        balance: 0,
        cost_per_call: this.costPerCall,
        total_recharged: 0,
        total_spent: 0,
        total_calls_deducted: 0,
        callsRemaining: 0,
        error: err.message
      };
    }
  }

  /**
   * Recharge client wallet balance
   * @param {number} amount - Recharge amount in INR
   * @param {string} notes - Optional recharge note/description
   */
  async recharge(amount, notes = "Web Dashboard Quick Recharge") {
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error("Invalid recharge amount. Must be greater than 0.");
    }

    const currentWallet = await this.getWallet();
    const newBalance = Number((currentWallet.balance + numAmount).toFixed(2));
    const newTotalRecharged = Number(((currentWallet.total_recharged || 0) + numAmount).toFixed(2));
    const timestamp = Date.now();

    // Record recharge transaction
    const txRef = push(ref(db, "billing_wallet/transactions"));
    await set(txRef, {
      id: txRef.key,
      type: "recharge",
      amount: numAmount,
      balance_after: newBalance,
      notes: notes,
      timestamp: timestamp
    });

    // Update wallet
    await update(ref(db, "billing_wallet"), {
      balance: newBalance,
      total_recharged: newTotalRecharged,
      last_updated: timestamp
    });

    console.log(`[WalletService] Recharged Rs. ${numAmount}. New Balance: Rs. ${newBalance} (${Math.floor(newBalance / this.costPerCall)} calls left)`);

    return {
      success: true,
      balance: newBalance,
      cost_per_call: this.costPerCall,
      total_recharged: newTotalRecharged,
      callsRemaining: Math.floor(newBalance / this.costPerCall),
      amountRecharged: numAmount,
      transactionId: txRef.key
    };
  }

  /**
   * Check if wallet has sufficient balance to place a call
   */
  async canPlaceCall() {
    const wallet = await this.getWallet();
    const allowed = wallet.balance >= this.costPerCall;
    return {
      allowed,
      balance: wallet.balance,
      costPerCall: this.costPerCall,
      callsRemaining: Math.floor(wallet.balance / this.costPerCall)
    };
  }

  /**
   * Deduct Rs. 11 for an answered/connected call
   * @param {string} callId - Call ID
   * @param {string} customerPhone - Customer phone number
   */
  async deductCall(callId, customerPhone = "") {
    try {
      const currentWallet = await this.getWallet();
      if (currentWallet.balance < this.costPerCall) {
        console.warn(`[WalletService] Insufficient balance to deduct call ${callId}. Current balance: Rs. ${currentWallet.balance}`);
        return { success: false, balance: currentWallet.balance, error: "Insufficient balance" };
      }

      const newBalance = Number(Math.max(0, currentWallet.balance - this.costPerCall).toFixed(2));
      const newTotalSpent = Number(((currentWallet.total_spent || 0) + this.costPerCall).toFixed(2));
      const newDeductedCount = (currentWallet.total_calls_deducted || 0) + 1;
      const timestamp = Date.now();

      // Record transaction
      const txRef = push(ref(db, "billing_wallet/transactions"));
      await set(txRef, {
        id: txRef.key,
        type: "call_charge",
        call_id: callId,
        customer_phone: customerPhone,
        amount: -this.costPerCall,
        balance_after: newBalance,
        timestamp: timestamp
      });

      // Update wallet
      await update(ref(db, "billing_wallet"), {
        balance: newBalance,
        total_spent: newTotalSpent,
        total_calls_deducted: newDeductedCount,
        last_updated: timestamp
      });

      console.log(`[WalletService] Deducted Rs. ${this.costPerCall} for call ${callId}. Remaining balance: Rs. ${newBalance} (${Math.floor(newBalance / this.costPerCall)} calls left)`);

      return {
        success: true,
        balance: newBalance,
        cost_per_call: this.costPerCall,
        callsRemaining: Math.floor(newBalance / this.costPerCall)
      };
    } catch (err) {
      console.error(`[WalletService] Error deducting call charge for ${callId}:`, err.message);
      return { success: false, error: err.message };
    }
  }
}

export const walletService = new WalletService();
