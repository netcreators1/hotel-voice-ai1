import express from "express";
import { generateDailyReport } from "../reports/eodReport.js";
import { db, ref, get, set, push, update } from "../config/firebase.js";
import { getHotelKnowledge, updateHotelKnowledge, getAgentScript, updateAgentScript } from "../models/hotelKnowledge.js";
import { telephonyAdapter } from "../services/telephonyAdapter.js";
import { walletService } from "../services/walletService.js";
import { authenticate, requireAdmin, validateSession } from "../services/authService.js";

const router = express.Router();

/**
 * Generate EOD Report on-demand
 */
router.post("/report/generate", async (req, res) => {
  try {
    const targetDate = req.query.date || req.body.date;
    const result = await generateDailyReport(targetDate);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get Today's EOD Report from Firebase RTDB
 */
router.get("/report/today", async (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split("T")[0];
    const snapshot = await get(ref(db, `daily_reports/${dateStr}`));

    if (snapshot.exists()) {
      res.json(snapshot.val());
    } else {
      res.status(404).json({ message: `No report found for ${dateStr}. Run generate first.` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fetch All Calls & Leads
 */
router.get("/calls", async (req, res) => {
  try {
    const snapshot = await get(ref(db, "calls"));
    const calls = snapshot.exists() ? snapshot.val() : {};
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to process and calculate CDR records with commercial per-call rate (default Rs. 11/call)
 */
function processCDRData(rawCalls, ratePerCall = 11) {
  const callsArray = Object.entries(rawCalls || {}).map(([id, call]) => {
    const durationSec = Number(call.duration_seconds || 0);
    const rawLead = (call.lead_status || "").trim().toLowerCase();
    const rawStatus = (call.status || "").trim().toLowerCase();
    const rawHangup = (call.hangup_cause || "").trim().toUpperCase();

    // Check if call was not picked up / unanswered
    const isUnanswered = durationSec === 0 ||
      rawLead === "not_picked_up" ||
      rawLead === "not picked up" ||
      ["failed", "no-answer", "busy", "canceled", "rejected"].includes(rawStatus) ||
      ["NO_USER_RESPONSE", "NO_ANSWER", "BUSY", "CALL_REJECTED", "ORIGINATOR_CANCEL", "NORMAL_TEMPORARY_FAILURE"].includes(rawHangup);

    const leadStatus = isUnanswered ? "Not Picked up" : (call.lead_status || "pending");

    // Standard billing: Rs. 11 per connected/completed call, 0 for unpicked
    const billedUnits = durationSec > 0 ? 1 : 0;
    const callCost = billedUnits * ratePerCall;

    // Format duration nicely (e.g., "4m 32s" or "44s")
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const durationFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Extract user statements from conversation history
    const userStatements = (call.conversation_history || [])
      .filter(m => m.role === "user")
      .map(m => m.content);
    const customerMentioned = userStatements.length > 0
      ? userStatements.join(" | ")
      : (call.intent || (isUnanswered ? "Customer did not answer / Call dropped" : "Initial greeting only"));

    // Formatted date string in IST
    const dateObj = new Date(call.start_time || call.created_at || Date.now());
    const formattedDate = dateObj.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

    return {
      call_id: call.call_id || id,
      provider: call.provider || "vobiz",
      customer_name: call.customer_name || "Guest",
      customer_phone: call.to || "",
      direction: call.direction || "outbound",
      status: isUnanswered && rawStatus === "completed" ? "failed" : (call.status || "unknown"),
      lead_status: leadStatus,
      intent: call.intent || "",
      customer_mentioned: customerMentioned,
      last_agent_reply: call.last_agent_reply || "",
      duration_seconds: durationSec,
      duration_formatted: durationFormatted,
      billed_units: billedUnits,
      rate_per_call: ratePerCall,
      rate_per_minute: ratePerCall,
      call_cost: callCost,
      start_time: call.start_time || call.created_at,
      date_formatted: formattedDate,
      payment_status: call.payment_status || "none",
      history: call.conversation_history || []
    };
  });

  // Sort descending by start time (newest calls first)
  callsArray.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));

  // Compute summary totals
  const totalCalls = callsArray.length;
  const connectedCalls = callsArray.filter(c => c.duration_seconds > 0).length;
  const notPickedUpCalls = totalCalls - connectedCalls;
  const totalDurationSeconds = callsArray.reduce((acc, c) => acc + c.duration_seconds, 0);
  const grandTotalAmount = callsArray.reduce((acc, c) => acc + c.call_cost, 0);

  const totalMins = Math.floor(totalDurationSeconds / 60);
  const totalSecs = totalDurationSeconds % 60;
  const totalDurationFormatted = totalMins > 0 ? `${totalMins}m ${totalSecs}s` : `${totalSecs}s`;

  return {
    records: callsArray,
    summary: {
      total_calls: totalCalls,
      connected_calls: connectedCalls,
      failed_or_missed_calls: notPickedUpCalls,
      not_picked_up_calls: notPickedUpCalls,
      total_duration_seconds: totalDurationSeconds,
      total_duration_formatted: totalDurationFormatted,
      rate_per_call: ratePerCall,
      rate_per_minute: ratePerCall,
      grand_total_amount: grandTotalAmount
    }
  };
}

/**
 * Call Detail Record (CDR) Report API with ₹11/call billing calculation
 * GET /api/admin/cdr?rate=11
 */
router.get("/cdr", async (req, res) => {
  try {
    const rate = Number(req.query.rate) || 11;
    const snapshot = await get(ref(db, "calls"));
    const rawCalls = snapshot.exists() ? snapshot.val() : {};
    const cdrData = processCDRData(rawCalls, rate);
    res.json(cdrData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Client Recharge Wallet API
 * GET /api/admin/wallet
 */
router.get("/wallet", async (req, res) => {
  try {
    const wallet = await walletService.getWallet();
    res.json({ success: true, ...wallet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * User Authentication Endpoint (Admin: admin/wpdyns76, Agent: agent/abc@1234)
 * POST /api/admin/auth/login or /api/auth/login
 */
router.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  const result = authenticate(username, password);
  if (!result.success) {
    return res.status(401).json(result);
  }
  res.json(result);
});

/**
 * Verify Active Session Token
 * GET /api/admin/auth/verify
 */
router.get("/auth/verify", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  const user = validateSession(token);
  if (!user) {
    return res.status(401).json({ success: false, error: "Session expired or invalid" });
  }
  res.json({ success: true, user });
});

/**
 * Client Recharge Endpoint (Admin Only with Approval Rights)
 * POST /api/admin/wallet/recharge
 * Body: { amount: 500, notes: "Quick Recharge" }
 */
router.post("/wallet/recharge", requireAdmin, async (req, res) => {
  try {
    const { amount, notes } = req.body;
    const adminUser = req.user?.username || "admin";
    const result = await walletService.recharge(amount, notes || `Recharged by Admin (${adminUser})`);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Download CDR Report as CSV with ₹11/call billing breakdown
 * GET /api/admin/cdr/download?rate=11
 */
router.get("/cdr/download", async (req, res) => {
  try {
    const rate = Number(req.query.rate) || 11;
    const snapshot = await get(ref(db, "calls"));
    const rawCalls = snapshot.exists() ? snapshot.val() : {};
    const { records, summary } = processCDRData(rawCalls, rate);

    // Build CSV content
    const headers = [
      "Call ID",
      "Customer Name",
      "Phone Number",
      "Call Date & Time (IST)",
      "Duration (Sec)",
      "Rate (Rs/Call)",
      "Billed Amount (Rs)",
      "Call Status",
      "Lead Quality",
      "Customer Queries / What Customer Mentioned",
      "Agent Action / Reply"
    ];

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const clean = String(str).replace(/"/g, '""').replace(/[\r\n]+/g, " ");
      return `"${clean}"`;
    };

    const rows = records.map(c => [
      escapeCsv(c.call_id),
      escapeCsv(c.customer_name),
      escapeCsv(c.customer_phone),
      escapeCsv(c.date_formatted),
      c.duration_seconds,
      `Rs. ${c.rate_per_call}/call`,
      `Rs. ${c.call_cost.toFixed(2)}`,
      escapeCsv(c.status),
      escapeCsv(c.lead_status),
      escapeCsv(c.customer_mentioned),
      escapeCsv(c.last_agent_reply || "AI Greeting Delivered")
    ].join(","));

    // Add summary totals at bottom
    const summaryRow = [
      escapeCsv("--- TOTAL SUMMARY ---"),
      escapeCsv(`Total Calls: ${summary.total_calls}`),
      escapeCsv(`Connected: ${summary.connected_calls}`),
      escapeCsv(`Not Picked Up: ${summary.not_picked_up_calls}`),
      summary.total_duration_seconds,
      escapeCsv(`Rs. ${summary.rate_per_call}/call`),
      escapeCsv(`Rs. ${summary.grand_total_amount.toFixed(2)}`),
      escapeCsv(""),
      escapeCsv(""),
      escapeCsv(`Grand Total: Rs. ${summary.grand_total_amount.toFixed(2)}`),
      escapeCsv("")
    ].join(",");

    const csvContent = [headers.join(","), ...rows, "", summaryRow].join("\r\n");

    const filename = `CDR_Report_Hotel_Voice_AI_${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Bulk Upload Contacts / Leads List (CSV / JSON)
 * POST /api/admin/contacts/bulk
 * Body: { contacts: [{ name: "Raj", phone: "+91...", campaign: "deluxe_promo" }] }
 */
router.post("/contacts/bulk", async (req, res) => {
  try {
    const { contacts, campaign = "general_campaign" } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: "Contacts array is required and must not be empty" });
    }

    const inserted = [];
    for (const c of contacts) {
      if (c.phone) {
        const newRef = push(ref(db, "contacts_queue"));
        const record = {
          id: newRef.key,
          name: c.name || "Guest",
          phone: c.phone.trim(),
          campaign: c.campaign || campaign,
          status: "pending",
          notes: c.notes || "",
          created_at: Date.now()
        };
        await set(newRef, record);
        inserted.push(record);
      }
    }

    res.json({ success: true, count: inserted.length, contacts: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get All Contacts in Queue
 * GET /api/admin/contacts/queue
 */
router.get("/contacts/queue", async (req, res) => {
  try {
    const snap = await get(ref(db, "contacts_queue"));
    const queue = snap.exists() ? Object.values(snap.val()) : [];
    res.json(queue);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global in-memory tracking of active outbound campaign
let activeCampaign = {
  running: false,
  stopped: false,
  name: null,
  concurrency: 1,
  total: 0,
  completed: 0,
  failed: 0,
  started_at: null
};

/**
 * Get Active Campaign Status
 * GET /api/admin/campaigns/status
 */
router.get("/campaigns/status", (req, res) => {
  res.json(activeCampaign);
});

/**
 * Stop Active Outbound Campaign
 * POST /api/admin/campaigns/stop
 */
router.post("/campaigns/stop", (req, res) => {
  activeCampaign.stopped = true;
  activeCampaign.running = false;
  console.log("[Campaign] Stop signal received from Admin.");
  res.json({
    success: true,
    message: "Outbound campaign stopping. In-flight calls will complete gracefully.",
    state: activeCampaign
  });
});

/**
 * Run Automated Outbound Calling Campaign
 * Iterates through pending contacts in the queue and dials them with configurable concurrency
 * POST /api/admin/campaigns/run
 */
router.post("/campaigns/run", async (req, res) => {
  try {
    const { campaignName, persona, agentPersona, language, lang } = req.body;
    const requestedConcurrency = parseInt(req.body.concurrency || 1, 10);
    const concurrency = Math.min(Math.max(isNaN(requestedConcurrency) ? 1 : requestedConcurrency, 1), 10);
    const selectedPersona = (agentPersona || persona || "aayla").toLowerCase();
    const selectedLang = (language || lang || "en").toLowerCase();

    const snap = await get(ref(db, "contacts_queue"));
    if (!snap.exists()) {
      return res.json({ message: "No contacts in queue" });
    }

    const contacts = snap.val();
    const pendingContacts = Object.entries(contacts).filter(([id, c]) => {
      if (c.status !== "pending") return false;
      if (campaignName && c.campaign !== campaignName) return false;
      return true;
    });

    if (pendingContacts.length === 0) {
      return res.json({ message: "No pending contacts to dial in this campaign" });
    }

    console.log(`[Campaign Runner] Starting outbound campaign with ${pendingContacts.length} contacts across ${concurrency} concurrent agent lines (persona: '${selectedPersona}', language: '${selectedLang}')...`);

    const host = req.get("host");
    const proto = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    let baseUrl = `${proto}://${host}`;
    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("0.0.0.0")) {
      baseUrl = (process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes("localhost"))
        ? process.env.PUBLIC_URL
        : (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : "https://hotel-voice-ai.fly.dev");
    }

    // Check initial wallet balance before starting campaign
    const initialCheck = await walletService.canPlaceCall();
    if (!initialCheck.allowed) {
      return res.status(402).json({
        success: false,
        error: `Insufficient wallet balance (₹${initialCheck.balance.toFixed(2)}). Each call requires ₹11.00. Please recharge your wallet.`
      });
    }

    // Set active campaign state
    activeCampaign = {
      running: true,
      stopped: false,
      name: campaignName || "all",
      concurrency,
      total: pendingContacts.length,
      completed: 0,
      failed: 0,
      started_at: Date.now()
    };

    // Asynchronously trigger calls using concurrent worker pool
    (async () => {
      let contactIndex = 0;
      const workerCount = Math.min(concurrency, pendingContacts.length);

      async function runWorker(workerId) {
        while (contactIndex < pendingContacts.length) {
          if (activeCampaign.stopped) {
            console.log(`[Campaign Line #${workerId}] Campaign stopped by user.`);
            break;
          }

          const idx = contactIndex++;
          if (idx >= pendingContacts.length) break;

          const [id, c] = pendingContacts[idx];

          try {
            // Check wallet balance before each call
            const check = await walletService.canPlaceCall();
            if (!check.allowed) {
              console.warn(`[Campaign Line #${workerId}] Insufficient balance (₹${check.balance.toFixed(2)}). Halting campaign.`);
              activeCampaign.stopped = true;
              await update(ref(db, `contacts_queue/${id}`), {
                status: "stopped",
                error: "Insufficient wallet credits (₹11/call required). Please recharge."
              });
              break;
            }

            console.log(`[Campaign Line #${workerId}] Dialing ${c.name} (${c.phone}) with persona ${selectedPersona} (${selectedLang}). Remaining credits: ${check.callsRemaining} calls...`);
            await update(ref(db, `contacts_queue/${id}`), {
              status: "calling",
              worker_id: workerId,
              called_at: Date.now()
            });

            const result = await telephonyAdapter.makeCall({
              to: c.phone,
              customerName: c.name,
              metadata: { campaign: c.campaign, queue_id: id, worker_id: workerId },
              baseUrl,
              persona: selectedPersona,
              language: selectedLang
            });

            await update(ref(db, `contacts_queue/${id}`), {
              status: result.success ? "dialed" : "failed",
              call_id: result.callId || null
            });

            if (result.success) {
              activeCampaign.completed++;
            } else {
              activeCampaign.failed++;
            }

            // Pacing delay between calls for this worker channel
            // Concurrency 1: 15 seconds; Concurrency > 1: staggered 3 to 6 seconds per channel
            const pacingMs = concurrency === 1 ? 15000 : Math.max(3000, Math.floor(12000 / concurrency));
            await new Promise(resolve => setTimeout(resolve, pacingMs));

          } catch (callErr) {
            console.error(`[Campaign Dial Error - Line #${workerId}] for ${c.phone}:`, callErr.message);
            await update(ref(db, `contacts_queue/${id}`), {
              status: "failed",
              error: callErr.message
            });
            activeCampaign.failed++;
          }
        }
      }

      // Launch worker channels with staggered starts (1.5s apart) to avoid burst CPS
      const workerPromises = [];
      for (let i = 1; i <= workerCount; i++) {
        workerPromises.push((async (wId) => {
          if (wId > 1) {
            await new Promise(r => setTimeout(r, (wId - 1) * 1500));
          }
          await runWorker(wId);
        })(i));
      }

      await Promise.all(workerPromises);
      activeCampaign.running = false;
      console.log(`[Campaign Runner] Outbound campaign concluded. Completed: ${activeCampaign.completed}, Failed: ${activeCampaign.failed}, Stopped: ${activeCampaign.stopped}`);
    })();

    res.json({
      success: true,
      message: `Campaign started for ${pendingContacts.length} contacts across ${concurrency} concurrent agent lines.`,
      totalQueued: pendingContacts.length,
      concurrency
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get & Update Hotel Knowledge Base & Tariffs
 * GET /api/admin/hotel-config
 * POST /api/admin/hotel-config
 */
router.get("/hotel-config", async (req, res) => {
  const config = await getHotelKnowledge(true);
  res.json(config);
});

router.post("/hotel-config", async (req, res) => {
  try {
    const newConfig = req.body;
    await set(ref(db, "hotel_config"), newConfig);
    updateHotelKnowledge(newConfig);
    console.log(`[Knowledge Base] Live hotel config & tariffs updated in Firebase RTDB and memory cache: ${newConfig.hotel_name}`);
    res.json({ success: true, updated: newConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get & Update Live Agent Script / Instructions
 * GET /api/admin/agent-script
 * POST /api/admin/agent-script
 */
router.get("/agent-script", async (req, res) => {
  try {
    const script = await getAgentScript(true);
    res.json({
      exists: true,
      data: {
        customGreeting: script.custom_greeting_en || "",
        customGreetingHi: script.custom_greeting_hi || "",
        scriptGuidelines: script.custom_script || ""
      },
      ...script
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/agent-script", async (req, res) => {
  try {
    const { 
      custom_script, 
      custom_greeting_en, 
      custom_greeting_hi, 
      scriptGuidelines, 
      customGreeting, 
      language 
    } = req.body;

    const activeScript = (scriptGuidelines || custom_script || "").trim();
    let greetingEn = (custom_greeting_en || "").trim();
    let greetingHi = (custom_greeting_hi || "").trim();

    if (customGreeting && customGreeting.trim()) {
      if ((language || "").toLowerCase() === "hi") {
        greetingHi = customGreeting.trim();
      } else {
        greetingEn = customGreeting.trim();
      }
    }

    const defaultIgGreeting = "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES";
    const scriptData = {
      custom_script: activeScript,
      custom_greeting_en: greetingEn || defaultIgGreeting,
      custom_greeting_hi: greetingHi || defaultIgGreeting,
      updated_at: Date.now()
    };

    await set(ref(db, "agent_script"), scriptData);
    updateAgentScript(scriptData);
    console.log(`[Agent Script] Live script updated in Firebase & cache: "${scriptData.custom_greeting_en.slice(0, 30)}..." | Pitch: "${scriptData.custom_script.slice(0, 30)}..."`);
    res.json({ success: true, script: scriptData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
