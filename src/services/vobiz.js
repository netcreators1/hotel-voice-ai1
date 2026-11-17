import axios from "axios";
import fs from "fs";
import path from "path";
import { db, ref, set, update } from "../config/firebase.js";
import { AGENT_PERSONAS } from "./voiceAgent.js";
import { sarvamService } from "./sarvamService.js";

const VOBIZ_AUTH_ID = process.env.VOBIZ_AUTH_ID || "MA_UQ3I13SF";
const VOBIZ_AUTH_SECRET = process.env.VOBIZ_AUTH_SECRET || "GpkMfgbwbCSO0CZZJeA9E2jARLRuOq0jJ3Pj55wo3BfFIDrRtJfU9btQ4XG9m1V2";
const VOBIZ_PHONE_NUMBER = process.env.VOBIZ_PHONE_NUMBER || "+918064260572";
const VOBIZ_API_BASE = "https://api.vobiz.ai/api/v1";

function getPublicUrl(customUrl = null) {
  if (customUrl && customUrl.startsWith("https://") && !customUrl.includes("localhost") && !customUrl.includes("127.0.0.1") && !customUrl.includes("trycloudflare.com")) {
    return customUrl;
  }
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith("https://") && !process.env.PUBLIC_URL.includes("localhost") && !process.env.PUBLIC_URL.includes("trycloudflare.com")) {
    return process.env.PUBLIC_URL;
  }
  if (process.env.FLY_APP_NAME) {
    return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  }
  return "https://hotel-voice-ai.fly.dev";
}

function cleanVoiceSpeech(text, isHindi = false) {
  if (!text) return "";
  let clean = text
    .replace(/<[^>]+>/g, " ") // Strip any XML/HTML/SSML tags completely to prevent FreeSWITCH XML/TTS crash
    .replace(/\.{2,}/g, ". ") // Replace slow ellipses with crisp sentence pause
    .replace(/₹/g, isHindi ? " रुपये " : " Rupees ")
    .replace(/&/g, isHindi ? " और " : " and ")
    .replace(/[<>]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean;
}

/**
 * Vobiz Direct Cloud Telephony Provider with 2-Way Speech Recognition & Amazon Polly Neural Voice
 */
export class VobizService {
  constructor() {
    this.authId = VOBIZ_AUTH_ID;
    this.authSecret = VOBIZ_AUTH_SECRET;
    this.fromNumber = VOBIZ_PHONE_NUMBER;
  }

  /**
   * Place an outbound call via Vobiz REST API
   */
  async makeOutboundCall({ to, customerName, metadata = {}, baseUrl = null, persona = "aayla", language = "en" }) {
    const callId = "vobiz_" + Date.now();
    const publicUrl = getPublicUrl(baseUrl || metadata?.baseUrl);
    const encodedName = encodeURIComponent(customerName || "");
    const encodedPersona = encodeURIComponent(persona || "aayla");
    const encodedLang = encodeURIComponent((language || "en").toLowerCase());
    const answerUrl = `${publicUrl}/api/telephony/vobiz/answer?call_id=${callId}&customer_name=${encodedName}&persona=${encodedPersona}&lang=${encodedLang}`;
    const hangupUrl = `${publicUrl}/api/telephony/vobiz/hangup?call_id=${callId}`;

    const cleanTo = to.startsWith("+") ? to : `+${to}`;

    // Record initial call session in Firebase RTDB
    await set(ref(db, `calls/${callId}`), {
      call_id: callId,
      provider: "vobiz",
      from: this.fromNumber,
      to: cleanTo,
      customer_name: customerName || "Guest",
      persona: persona || "aayla",
      language: language || "en",
      direction: "outbound",
      status: "initiated",
      lead_status: "pending",
      payment_status: "none",
      conversation_history: [],
      start_time: Date.now(),
      created_at: Date.now(),
      metadata: metadata
    });

    console.log(`[Vobiz] Placing outbound call from ${this.fromNumber} to ${cleanTo} using persona: ${persona}, lang: ${language}...`);

    try {
      const response = await axios.post(
        `${VOBIZ_API_BASE}/Account/${this.authId}/Call/`,
        {
          from: this.fromNumber,
          to: cleanTo,
          answer_url: answerUrl,
          answer_method: "POST",
          hangup_url: hangupUrl,
          hangup_method: "POST"
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Auth-ID": this.authId,
            "X-Auth-Token": this.authSecret
          }
        }
      );

      console.log(`[Vobiz Call Success]:`, response.data);

      await update(ref(db, `calls/${callId}`), {
        provider_session_id: response.data.request_uuid || response.data.api_id,
        status: "ringing"
      });

      return { success: true, callId, data: response.data, persona, language };
    } catch (err) {
      console.error("[Vobiz Call Error]:", err.response?.status, err.response?.data || err.message);
      await update(ref(db, `calls/${callId}`), {
        status: "failed",
        error: err.response?.data || err.message
      });
      return { success: false, callId, error: err.response?.data || err.message };
    }
  }

  /**
   * Initial Welcome & Speech Listening XML with Sarvam Bulbul TTS audio or Polly.Aditi fallback
   */
  async generateAnswerXML(hotelName, guestName, callId, persona = "aayla", customUrl = null, lang = "en", customerPhone = "", customGreeting = null) {
    const publicUrl = getPublicUrl(customUrl);
    const isHindi = (lang || "").toLowerCase() === "hi";
    const phoneParam = customerPhone ? `&customer_phone=${encodeURIComponent(customerPhone)}` : "";
    const nameParam = guestName ? `&customer_name=${encodeURIComponent(guestName)}` : "";
    const gatherAction = `${publicUrl}/api/telephony/vobiz/gather?call_id=${callId}${phoneParam}${nameParam}&lang=${lang}&persona=${persona}`;
    const xmlGatherAction = gatherAction.replace(/&/g, "&amp;");
    const personaObj = AGENT_PERSONAS[(persona || "aayla").toLowerCase()] || AGENT_PERSONAS.aayla;

    let rawGreeting = "";
    if (customGreeting && customGreeting.trim()) {
      rawGreeting = customGreeting.trim();
    } else {
      rawGreeting = personaObj.generateGreeting(hotelName || "Vivaant Retreat", guestName, isHindi ? "hi" : "en");
    }

    let greetingText = cleanVoiceSpeech(rawGreeting, isHindi);
    if (!greetingText) {
      greetingText = isHindi 
        ? "Namaste! Vivaant Retreat se Aayla. Main aapki kya sahayata kar sakti hoon?"
        : "Namaste! I am Aayla from Vivaant Retreat. How may I assist your booking today?";
    }
    const voice = personaObj.voice || "Polly.Aditi";

    // High-quality natural Indian voice (Sarvam Bulbul `simran` pre-cached on disk for 0ms delay)
    let audioTag = `<Speak voice="${voice}">${greetingText}</Speak>`;
    if (greetingText.includes("say YES") || greetingText.includes("say yes") || greetingText.includes("Igatpuri")) {
      const diskNewGreeting = path.resolve("public/audio", "vivaant_new_greeting.wav");
      if (fs.existsSync(diskNewGreeting)) {
        audioTag = `<Play>${publicUrl}/api/telephony/audio/vivaant_new_greeting.wav</Play>`;
      }
    } else {
      const isAvinash = (guestName || "").toLowerCase().includes("avinash");
      const preRecordedGreeting = isHindi 
        ? (isAvinash ? "hi_greeting_avinash.wav" : "hi_greeting_generic.wav")
        : "en_greeting.wav";

      const diskGreetingPath = path.resolve("public/audio", preRecordedGreeting);
      if (fs.existsSync(diskGreetingPath)) {
        audioTag = `<Play>${publicUrl}/api/telephony/audio/${preRecordedGreeting}</Play>`;
      }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${xmlGatherAction}" method="POST" inputType="speech" speechModel="telephony" language="en-IN" bargeIn="true" hints="YES, NO, haan, nahi, hindi, speak in hindi, hindi mein, reservation, Igatpuri, Vivaant, booking, room rate" speechEndTimeout="auto" executionTimeout="8">
        ${audioTag}
    </Gather>
    <Redirect method="POST">${xmlGatherAction}</Redirect>
</Response>`;
  }

  /**
   * Conversational turn XML: speaks the AI reply with Sarvam Bulbul TTS or Polly.Aditi
   * and listens for the next guest input.
   */
  async generateConversationalXML(replyText, callId, isFinal = false, customUrl = null, lang = "en", customerPhone = "", customerName = "", persona = "aayla") {
    const publicUrl = getPublicUrl(customUrl);
    const isHindi = (lang || "").toLowerCase() === "hi";
    const phoneParam = customerPhone ? `&customer_phone=${encodeURIComponent(customerPhone)}` : "";
    const nameParam = customerName ? `&customer_name=${encodeURIComponent(customerName)}` : "";
    const gatherAction = `${publicUrl}/api/telephony/vobiz/gather?call_id=${callId}${phoneParam}${nameParam}&lang=${lang}&persona=${persona}`;
    const xmlGatherAction = gatherAction.replace(/&/g, "&amp;");
    const personaObj = AGENT_PERSONAS[(persona || "aayla").toLowerCase()] || AGENT_PERSONAS.aayla;
    let formattedSpeech = cleanVoiceSpeech(replyText, isHindi);
    if (!formattedSpeech) {
      formattedSpeech = isHindi
        ? "Ji, main aapki kya sahayata kar sakti hoon?"
        : "How may I assist you with your booking today?";
    }
    const voice = personaObj.voice || "Polly.Aditi";

    // High-quality natural Indian voice (Sarvam Bulbul `simran` pre-cached on disk for 0ms delay)
    let audioTag = `<Speak voice="${voice}">${formattedSpeech}</Speak>`;
    const lowerReply = formattedSpeech.toLowerCase();

    let preRecordedClip = null;
    if (lowerReply.includes("shall get back to you") || lowerReply.includes("get back to you") || lowerReply.includes("thank you very much") || (lowerReply.includes("thank you") && isFinal)) {
      preRecordedClip = "vivaant_new_yes_reply.wav";
    } else if (lowerReply.includes("have a wonderful day ahead") && isFinal) {
      preRecordedClip = "vivaant_new_no_reply.wav";
    } else if (lowerReply.includes("deluxe") || lowerReply.includes("3500") || lowerReply.includes("tariffs") || lowerReply.includes("suite")) {
      preRecordedClip = isHindi ? "hi_tariffs.wav" : "en_tariffs.wav";
    } else if (lowerReply.includes("bhej diya") || lowerReply.includes("sent the booking link") || lowerReply.includes("sent the direct booking link")) {
      preRecordedClip = isHindi ? "hi_link_sent.wav" : "en_link_sent.wav";
    } else if (!lowerReply.includes("sampark") && (lowerReply.includes("din shubh") || lowerReply.includes("wonderful day"))) {
      preRecordedClip = isHindi ? "hi_goodbye.wav" : "en_goodbye.wav";
    } else if (lowerReply.includes("swagat") || lowerReply.includes("kisi aur cheez") || lowerReply.includes("anything else")) {
      preRecordedClip = isHindi ? "hi_anything_else.wav" : "en_link_sent.wav";
    }

    if (preRecordedClip && fs.existsSync(path.resolve("public/audio", preRecordedClip))) {
      audioTag = `<Play>${publicUrl}/api/telephony/audio/${preRecordedClip}</Play>`;
    }

    if (isFinal) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    ${audioTag}
    <Hangup/>
</Response>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${xmlGatherAction}" method="POST" inputType="speech" speechModel="telephony" language="en-IN" bargeIn="true" hints="YES, NO, haan, nahi, hindi, speak in hindi, hindi mein, reservation, Igatpuri, Vivaant, booking, room rate" speechEndTimeout="auto" executionTimeout="8">
        ${audioTag}
    </Gather>
    <Redirect method="POST">${xmlGatherAction}</Redirect>
</Response>`;
  }
}

export const vobizService = new VobizService();
