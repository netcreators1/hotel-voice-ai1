import express from "express";
import fs from "fs";
import path from "path";
import { telephonyAdapter } from "../services/telephonyAdapter.js";
import { piopiyService } from "../services/piopiy.js";
import { vobizService } from "../services/vobiz.js";
import { sarvamService } from "../services/sarvamService.js";
import { walletService } from "../services/walletService.js";
import { getHotelKnowledge, getAgentScript } from "../models/hotelKnowledge.js";
import { processConversationStep, AGENT_PERSONAS } from "../services/voiceAgent.js";
import { db, ref, update, get } from "../config/firebase.js";
import { sendPaymentLinkNotification } from "../services/notificationService.js";

const router = express.Router();

// Fast in-memory cache for live active call state (avoids blocking DB roundtrips mid-call)
const activeCalls = new Map();

/**
 * In-memory audio cache for zero-latency telephony playback streaming
 */
const audioMemoryCache = new Map();
const audioDir = path.resolve("public/audio");
if (fs.existsSync(audioDir)) {
  for (const file of fs.readdirSync(audioDir)) {
    if (file.endsWith(".wav") || file.endsWith(".mp3")) {
      audioMemoryCache.set(file, fs.readFileSync(path.join(audioDir, file)));
    }
  }
  console.log(`[AudioCache] Preloaded ${audioMemoryCache.size} telephony audio clips directly into RAM.`);
}

/**
 * Serve dynamically synthesized audio clips (instant zero-latency from RAM cache)
 * GET /api/telephony/audio/:filename
 */
router.get("/audio/:filename", (req, res) => {
  const { filename } = req.params;
  let cleanName = filename;
  if (!cleanName.includes(".")) {
    cleanName = `${filename}.wav`;
  }
  
  if (audioMemoryCache.has(cleanName)) {
    const buf = audioMemoryCache.get(cleanName);
    const contentType = cleanName.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
    res.set({
      "Content-Type": contentType,
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=86400, immutable",
      "Accept-Ranges": "bytes"
    });
    return res.end(buf);
  }

  const diskPath = path.resolve("public/audio", cleanName);

  if (fs.existsSync(diskPath)) {
    const buf = fs.readFileSync(diskPath);
    audioMemoryCache.set(cleanName, buf);
    const contentType = cleanName.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
    res.set({
      "Content-Type": contentType,
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=86400, immutable",
      "Accept-Ranges": "bytes"
    });
    return res.end(buf);
  }

  const audioData = sarvamService.getAudioBuffer(filename);
  if (!audioData) {
    return res.status(404).send("Audio not found or expired");
  }

  res.set({
    "Content-Type": audioData.contentType || "audio/wav",
    "Content-Length": audioData.buffer.length,
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes"
  });
  res.send(audioData.buffer);
});

/**
 * Trigger an outbound AI call to a customer
 * POST /api/telephony/outbound
 * Body: { to: "+919876543210", customerName: "Aman", metadata: {}, persona: "aayla" }
 */
router.post("/outbound", async (req, res) => {
  try {
    const { to, customerName, metadata, persona, agentPersona, language, lang } = req.body;
    if (!to) {
      return res.status(400).json({ error: "Phone number 'to' is required" });
    }

    // Check wallet balance before initiating outbound call (Rs. 11/call)
    const walletCheck = await walletService.canPlaceCall();
    if (!walletCheck.allowed) {
      return res.status(402).json({
        success: false,
        error: `Insufficient wallet balance (₹${walletCheck.balance.toFixed(2)}). Each call requires ₹11.00. Remaining credits: 0. Please recharge your account.`
      });
    }

    const selectedPersona = (agentPersona || persona || "aayla").toLowerCase();
    const selectedLang = (language || lang || "en").toLowerCase();
    const host = req.get("host");
    const proto = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    let baseUrl = `${proto}://${host}`;
    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("0.0.0.0")) {
      baseUrl = (process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes("localhost"))
        ? process.env.PUBLIC_URL
        : (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : "https://hotel-voice-ai.fly.dev");
    }

    const result = await telephonyAdapter.makeCall({
      to,
      customerName,
      metadata,
      baseUrl,
      persona: selectedPersona,
      language: selectedLang
    });

    if (result.callId) {
      activeCalls.set(result.callId, {
        customerName: customerName || "Guest",
        customerPhone: to,
        persona: selectedPersona,
        language: selectedLang,
        history: []
      });
    }

    res.json({ success: true, ...result, persona: selectedPersona });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PIOPIY Webhook: Action handler when call connects
 * GET or POST /api/telephony/piopiy/action
 */
router.all("/piopiy/action", async (req, res) => {
  const callId = req.query.call_id || req.body.call_id;
  console.log(`[PIOPIY Webhook] Action requested for Call ID: ${callId}`);

  if (callId) {
    update(ref(db, `calls/${callId}`), {
      status: "connected",
      connected_at: Date.now()
    }).catch(() => {});
  }

  // PIOPIY action: Welcome greeting
  const greeting = piopiyService.generateCallAction("speak", {
    text: "Namaste! I am Aayla from Vivaant Retreat. Thank you for speaking with us. How may I assist your stay or room reservation today?",
    voice: "en-IN"
  });

  res.json([greeting]);
});

/**
 * PIOPIY Webhook: Call Status Events (answered, ringing, completed)
 * POST /api/telephony/piopiy/status
 */
router.post("/piopiy/status", async (req, res) => {
  const callId = req.query.call_id || req.body.call_id;
  const status = req.body.status || req.body.event;
  const duration = req.body.duration || req.body.billsec || 0;

  console.log(`[PIOPIY Webhook] Status update for ${callId}: ${status} (duration: ${duration}s)`);

  if (callId) {
    update(ref(db, `calls/${callId}`), {
      status: status,
      duration_seconds: Number(duration),
      ended_at: Date.now()
    }).catch(() => {});
  }

  res.json({ status: "acknowledged" });
});

function extractCustomerPhone(req, callData) {
  const customPhone = req.query?.customer_phone || req.body?.customer_phone || "";
  if (customPhone && customPhone !== "+919167584555") return customPhone;

  const direction = (req.body?.Direction || req.query?.Direction || req.body?.direction || req.query?.direction || "").toLowerCase();
  const fromNum = req.body?.From || req.query?.From || req.body?.from || req.query?.from || "";
  const toNum = req.body?.To || req.query?.To || req.body?.to || req.query?.to || "";

  const hotelNums = ["918064260572", "918065354620"];
  const cleanFrom = fromNum.replace(/\D/g, "");
  const cleanTo = toNum.replace(/\D/g, "");

  if (direction === "inbound" && fromNum) return fromNum.startsWith("+") ? fromNum : `+${fromNum}`;
  if (direction === "outbound" && toNum) return toNum.startsWith("+") ? toNum : `+${toNum}`;

  if (hotelNums.some(num => cleanFrom.includes(num)) && toNum) return toNum.startsWith("+") ? toNum : `+${toNum}`;
  if (hotelNums.some(num => cleanTo.includes(num)) && fromNum) return fromNum.startsWith("+") ? fromNum : `+${fromNum}`;

  if (callData?.customerPhone) return callData.customerPhone;
  if (toNum) return toNum.startsWith("+") ? toNum : `+${toNum}`;
  if (fromNum) return fromNum.startsWith("+") ? fromNum : `+${fromNum}`;
  return customPhone || "+919167584555";
}

/**
 * Vobiz Webhook: Triggered when customer answers the outbound call
 * GET or POST /api/telephony/vobiz/answer
 */
router.all("/vobiz/answer", async (req, res) => {
  try {
    const callId = req.query?.call_id || req.body?.call_id;
    console.log(`[Vobiz Webhook] Call answered for Call ID: ${callId}`);

    const persona = (req.query?.persona || req.body?.persona || "aayla").toLowerCase();
    const lang = (req.query?.lang || req.body?.lang || "en").toLowerCase();
    const customerPhone = extractCustomerPhone(req, null);
    let customerName = req.query?.customer_name || req.body?.customer_name || "";
    if (!customerName && callId) {
      const cached = activeCalls.get(callId);
      if (cached?.customerName) customerName = cached.customerName;
    }
    if (!customerName) customerName = "Guest";

    const hotel = await getHotelKnowledge();
    const script = await getAgentScript();
    const isHindi = (lang || "").toLowerCase() === "hi";
    let customGreeting = isHindi ? script?.custom_greeting_hi : script?.custom_greeting_en;
    if (!customGreeting || !customGreeting.trim()) {
      customGreeting = null;
    }

    const activeGreeting = customGreeting || (isHindi
      ? `Namaste! Vivaant Retreat se Aayla. Main aapki kya sahayata kar sakti hoon?`
      : `Namaste! I am Aayla from Vivaant Retreat. How may I assist your booking today?`);

    // Keep active call cached in memory with the initial greeting recorded
    activeCalls.set(callId, {
      customerName,
      customerPhone,
      persona: persona,
      language: lang,
      history: [{ role: "assistant", content: activeGreeting }]
    });

    // Update Firebase asynchronously in background (zero block)
    if (callId) {
      update(ref(db, `calls/${callId}`), {
        status: "connected",
        to: customerPhone,
        customer_phone: customerPhone,
        language: lang,
        connected_at: Date.now(),
        conversation_history: [{ role: "assistant", content: activeGreeting, timestamp: Date.now() }]
      }).catch(() => {});

      // Deduct Rs. 11 for connected call from client wallet
      walletService.deductCall(callId, customerPhone).catch(err => {
        console.error(`[Vobiz Answer] Error deducting call fee for ${callId}:`, err.message);
      });
    }

    const xml = await vobizService.generateAnswerXML(hotel.hotel_name, customerName, callId, persona, null, lang, customerPhone, customGreeting);

    res.set("Content-Type", "text/xml");
    res.send(xml.trim());
  } catch (err) {
    console.error("[Vobiz Answer Error]:", err);
    res.type("application/xml");
    const isHindi = (lang || "").toLowerCase() === "hi";
    const msg = isHindi
      ? "Namaste! Main Vivaant Retreat se Aayla baat kar rahi hoon. Main aapki kya sahayata kar sakti hoon?"
      : "Namaste! I am Aayla from Vivaant Retreat. How may I assist your stay or room reservation today?";
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Speak voice="Polly.Aditi">${msg}</Speak></Response>`);
  }
});

/**
 * Vobiz Webhook: Process Live Caller Speech & Return Intelligent AI Reply
 * GET or POST /api/telephony/vobiz/gather
 */
router.all("/vobiz/gather", async (req, res) => {
  let lang = (req.query?.lang || req.body?.lang || "en").toLowerCase();
  try {
    const callId = req.query?.call_id || req.body?.call_id;

    const userSpeech = (
      req.body?.Speech ||
      req.body?.speech ||
      req.body?.SpeechResult ||
      req.body?.SpeechText ||
      req.body?.speech_result ||
      req.body?.RecognitionResult ||
      req.body?.text ||
      req.body?.transcript ||
      req.body?.speech_text ||
      req.body?.Digits ||
      req.body?.digits ||
      req.query?.Speech ||
      req.query?.speech ||
      req.query?.SpeechResult ||
      req.query?.SpeechText ||
      req.query?.Digits ||
      req.query?.digits ||
      ""
    ).trim();

    console.log(`[Vobiz Live Speech] Caller said: "${userSpeech}" for Call ID: ${callId}, payload:`, JSON.stringify(req.body || req.query));

    // Non-blocking real-time event log in Firebase (safe serialized object)
    if (callId) {
      setTimeout(() => {
        try {
          update(ref(db, `calls/${callId}/gather_events/${Date.now()}`), {
            speech: userSpeech,
            body: JSON.parse(JSON.stringify(req.body || {})),
            query: JSON.parse(JSON.stringify(req.query || {})),
            timestamp: Date.now()
          }).catch(() => {});
        } catch (_) {}
      }, 0);
    }

    // Zero-latency memory lookup: no blocking Firebase roundtrip
    let callData = activeCalls.get(callId);
    const customerPhone = extractCustomerPhone(req, callData);
    const customerName = req.query?.customer_name || req.body?.customer_name || callData?.customerName || "Guest";
    const persona = req.query?.persona || req.body?.persona || callData?.persona || "aayla";
    lang = (req.query?.lang || req.body?.lang || callData?.language || "en").toLowerCase();

    if (!callData) {
      const script = await getAgentScript().catch(() => ({}));
      const isHindi = (lang || "").toLowerCase() === "hi";
      const fallbackGreeting = (isHindi ? script?.custom_greeting_hi : script?.custom_greeting_en) ||
        (isHindi ? "Namaste! Main Vivaant Retreat se Aayla baat kar rahi hoon." : "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES");
      callData = {
        customerPhone,
        customerName,
        persona,
        language: lang,
        history: [{ role: "assistant", content: fallbackGreeting }]
      };
      activeCalls.set(callId, callData);
    } else {
      callData.customerPhone = customerPhone;
      callData.customerName = customerName;
      if (!callData.history || callData.history.length === 0) {
        const script = await getAgentScript().catch(() => ({}));
        const isHindi = (lang || "").toLowerCase() === "hi";
        const fallbackGreeting = (isHindi ? script?.custom_greeting_hi : script?.custom_greeting_en) ||
          (isHindi ? "Namaste! Main Vivaant Retreat se Aayla baat kar rahi hoon." : "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES");
        callData.history = [{ role: "assistant", content: fallbackGreeting }];
      }
    }

    const history = callData?.history || [];

    // If silence or empty speech from Vobiz, re-prompt in Hindi without hanging up prematurely
    if (!userSpeech) {
      callData.silenceCount = (callData.silenceCount || 0) + 1;
      console.log(`[Vobiz] Silence or timeout on call ${callId}, silence count: ${callData.silenceCount}`);
      if (callData.silenceCount < 2) {
        const prompt = "जी बिल्कुल! क्या आप विवांत रिट्रीट इगतपुरी में रिज़र्वेशन करना चाहते हैं? यदि हाँ, तो हाँ कहें।";
        lang = "hi";
        if (callData) callData.language = "hi";
        const xml = await vobizService.generateConversationalXML(prompt, callId, false, null, "hi", customerPhone, customerName, persona);
        res.set("Content-Type", "text/xml");
        return res.send(xml.trim());
      } else {
        const prompt = "विवांत रिट्रीट में कॉल करने के लिए धन्यवाद। आपका दिन शुभ हो!";
        const xml = await vobizService.generateConversationalXML(prompt, callId, true, null, "hi", customerPhone, customerName, persona);
        res.set("Content-Type", "text/xml");
        return res.send(xml.trim());
      }
    }
    callData.silenceCount = 0;

    history.push({ role: "user", content: userSpeech });

    const sessionContext = { callId, customerName, customerPhone, persona, language: lang };
    const result = await processConversationStep(history, sessionContext);

    // If caller preferred or responded in Hindi/English, dynamically switch active call language
    if (result.language && result.language !== lang) {
      console.log(`[Telephony Language Switch] Call ${callId} switching language from ${lang} to ${result.language}`);
      lang = result.language;
      if (callData) callData.language = lang;
    }

    // Append AI reply to history
    history.push({ role: "assistant", content: result.reply });
    if (callData) callData.history = history;

    // Check if conversation concluded (AI agent determined conclusion or explicit goodbye)
    const lowerSpeech = userSpeech.toLowerCase().trim();
    const isGoodbye = result.isFinal === true ||
                      lowerSpeech.startsWith("bye") || 
                      lowerSpeech.includes("goodbye") || 
                      lowerSpeech.includes("not interested") ||
                      lowerSpeech.includes("alvida");
    const xml = await vobizService.generateConversationalXML(result.reply, callId, isGoodbye, null, lang, customerPhone, customerName, persona);

    // ⚡ Return XML IMMEDIATELY to FreeSWITCH (Zero Delay)
    res.set("Content-Type", "text/xml");
    res.send(xml.trim());

    // Async background update to Firebase (non-blocking)
    if (callId) {
      update(ref(db, `calls/${callId}`), {
        conversation_history: history,
        last_agent_reply: result.reply,
        persona: persona,
        language: lang,
        updated_at: Date.now()
      }).catch(err => console.error("[Firebase Background Write Error]:", err.message));
    }
  } catch (err) {
    console.error("[Vobiz Gather Error]:", err);
    res.type("application/xml");
    const isHindi = (lang || "").toLowerCase() === "hi";
    const msg = isHindi
      ? "Hamare Deluxe room ki shuruaat 3500 Rupees plus taxes se hai... Kya main aapko direct booking link bhej doon?"
      : "Our Deluxe rooms start at Rupees 3500 plus taxes per night... Would you like me to send you a booking link?";
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Speak voice="Polly.Aditi">${msg}</Speak></Response>`);
  }
});

/**
 * Vobiz Webhook: Triggered on call completion/hangup
 * GET or POST /api/telephony/vobiz/hangup
 */
router.all("/vobiz/hangup", async (req, res) => {
  try {
    const callId = req.query?.call_id || req.body?.call_id;
    const duration = req.body?.Duration || req.body?.BillDuration || req.query?.Duration || 0;
    const hangupCause = req.body?.HangupCause || req.body?.hangup_cause || req.body?.Reason || req.body?.hangup_cause_code || "";
    console.log(`[Vobiz Webhook] Call ended for ${callId}, duration: ${duration}s, cause: ${hangupCause}, body:`, JSON.stringify(req.body));

    if (callId) {
      const durationNum = Number(duration || 0);
      const isNotPickedUp = durationNum === 0 || ["NO_USER_RESPONSE", "NO_ANSWER", "BUSY", "CALL_REJECTED", "ORIGINATOR_CANCEL", "NORMAL_TEMPORARY_FAILURE"].includes(String(hangupCause).toUpperCase());

      const updateData = {
        status: isNotPickedUp ? "failed" : "completed",
        duration_seconds: durationNum,
        hangup_cause: hangupCause,
        hangup_payload: req.body || {},
        ended_at: Date.now()
      };
      if (isNotPickedUp) {
        updateData.lead_status = "not_picked_up";
      }

      await update(ref(db, `calls/${callId}`), updateData);
    }

    res.set("Content-Type", "application/xml");
    res.send("<Response></Response>");
  } catch (err) {
    res.set("Content-Type", "application/xml");
    res.send("<Response></Response>");
  }
});

/**
 * Vapi.ai Webhook (Function/Tool calls & Call End reports)
 * POST /api/telephony/vapi/webhook
 */
router.post("/vapi/webhook", async (req, res) => {
  try {
    const { vapiService } = await import("../services/vapi.js");
    const response = await vapiService.handleWebhook(req.body);
    res.json(response);
  } catch (err) {
    console.error("[Vapi Webhook Error]:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Test & Interactive Simulator Endpoint
 * Simulates a voice dialog turn and runs tools (check availability, generate payment link)
 * POST /api/telephony/simulate-dialog
 */
router.post("/simulate-dialog", async (req, res) => {
  try {
    const { messages, callId = "sim_call_001", customerName = "Rahul Sharma", customerPhone = "+919876543210", persona, agentPersona, language, lang, customScript, customGreeting } = req.body;

    const sessionContext = {
      callId,
      customerName,
      customerPhone,
      persona: (agentPersona || persona || "aayla").toLowerCase(),
      language: (language || lang || "en").toLowerCase(),
      customScript,
      customGreeting
    };
    const result = await processConversationStep(messages || [], sessionContext);

    res.json({
      success: true,
      agentReply: result.reply,
      isFinal: !!result.isFinal,
      holdIntro: result.holdIntro || null,
      hasHoldJingle: !!result.hasHoldJingle,
      audioJingleUrl: result.hasHoldJingle ? "/audio/hotel_jingle.wav" : null,
      toolsExecuted: result.toolCallsExecuted,
      leadStatus: result.leadStatus || "warm",
      intent: result.intent || "General Inquiry",
      score: result.score || 50,
      language: result.language || sessionContext.language
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Diagnostic endpoint to verify WhatsApp Cloud API message delivery
 * GET /api/telephony/test-whatsapp?to=+919167584555
 */
router.get("/test-whatsapp", async (req, res) => {
  try {
    const to = req.query.to || "+919167584555";
    const result = await sendPaymentLinkNotification({
      customerPhone: to,
      customerName: "Avinash",
      hotelName: "Vivaant Retreat",
      roomType: "Executive Suite",
      amount: 7080,
      paymentUrl: "https://hotel-voice-ai.fly.dev/pay/test_live",
      callId: "test_call"
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
