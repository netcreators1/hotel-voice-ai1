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
  if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.startsWith("https://")) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith("https://") && !process.env.PUBLIC_URL.includes("localhost") && !process.env.PUBLIC_URL.includes("trycloudflare.com")) {
    return process.env.PUBLIC_URL;
  }
  if (process.env.FLY_APP_NAME) {
    return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  }
  return "https://hotel-voice-ai-hmzj.onrender.com";
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
    const voice = isHindi ? "Polly.Kajal" : (personaObj.voice || "Polly.Kajal");
    const langAttr = isHindi ? ' language="hi-IN"' : ' language="en-IN"';

    // Ensure loud, clear pre-recorded audio is always played (Vobiz FreeSWITCH requires Play)
    let audioTag = `<Play>${publicUrl}/api/telephony/audio/vivaant_new_greeting.wav</Play>`;
    if (!isHindi) {
      const diskNewGreeting = path.resolve("public/audio", "vivaant_new_greeting.wav");
      if (fs.existsSync(diskNewGreeting)) {
        audioTag = `<Play>${publicUrl}/api/telephony/audio/vivaant_new_greeting.wav</Play>`;
      }
    } else {
      const isAvinash = (guestName || "").toLowerCase().includes("avinash") || (customerPhone || "").includes("9167584555");
      const preRecordedGreeting = isAvinash ? "hi_greeting_avinash.wav" : "hi_vivaant_greeting.wav";
      const diskGreetingPath = path.resolve("public/audio", preRecordedGreeting);
      if (fs.existsSync(diskGreetingPath)) {
        audioTag = `<Play>${publicUrl}/api/telephony/audio/${preRecordedGreeting}</Play>`;
      } else {
        const fallbackWav = isAvinash ? "hi_greeting_avinash.wav" : "hi_greeting_generic.wav";
        if (fs.existsSync(path.resolve("public/audio", fallbackWav))) {
          audioTag = `<Play>${publicUrl}/api/telephony/audio/${fallbackWav}</Play>`;
        }
      }
    }

    const hints = "YES, yes, haan, ha, haan ji, NO, no, nahi, hindi, speak in hindi, hindi mein, hindi boliye, reservation, Igatpuri, Vivaant, booking";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${xmlGatherAction}" method="POST" inputType="speech" speechModel="telephony" language="en-IN" bargeIn="true" hints="${hints}" speechEndTimeout="2" executionTimeout="20">
        ${audioTag}
    </Gather>
    <Redirect method="POST">${xmlGatherAction}</Redirect>
</Response>`;
  }

  /**
   * Conversational turn XML: speaks the AI reply with Polly.Kajal Neural voice or pre-recorded studio audio
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
    const voice = isHindi ? "Polly.Kajal" : (personaObj.voice || "Polly.Kajal");
    const langAttr = isHindi ? ' language="hi-IN"' : ' language="en-IN"';

    // High-quality natural neural voice
    let audioTag = `<Speak voice="${voice}"${langAttr}>${formattedSpeech}</Speak>`;
    const lowerReply = formattedSpeech.toLowerCase();

    // ---- Map reply text to the correct pre-recorded WAV clip ----
    // Priority: exact phrase match → no fallback that could play wrong audio
    let preRecordedClip = null;

    if (isHindi) {
      // Hindi replies
      if (lowerReply.includes("ji bilkul") || lowerReply.includes("जी बिल्कुल") ||
          lowerReply.includes("reservation") || lowerReply.includes("रिज़र्वेशन") ||
          lowerReply.includes("haan kahein") || lowerReply.includes("हाँ कहें")) {
        // Hindi greeting / Hindi switch prompt
        preRecordedClip = "hi_switch_immediate.wav";
      } else if ((lowerReply.includes("dhanyavaad") || lowerReply.includes("धन्यवाद")) &&
                 !lowerReply.includes("din shubh") && !lowerReply.includes("shubh ho") && !lowerReply.includes("शुभ हो")) {
        // Hindi YES Thank You
        preRecordedClip = "hi_vivaant_yes_reply.wav";
      } else if ((lowerReply.includes("dhanyavaad") || lowerReply.includes("धन्यवाद")) &&
                 (lowerReply.includes("din shubh") || lowerReply.includes("shubh ho") || lowerReply.includes("शुभ हो") || isFinal)) {
        // Hindi NO / Goodbye
        preRecordedClip = "hi_goodbye.wav";
      } else if (lowerReply.includes("deluxe") || lowerReply.includes("3500") || lowerReply.includes("kamre")) {
        preRecordedClip = "hi_tariffs.wav";
      } else if (lowerReply.includes("bhej diya") || lowerReply.includes("link bhej")) {
        preRecordedClip = "hi_link_sent.wav";
      } else if (lowerReply.includes("swagat") || lowerReply.includes("sahayata")) {
        preRecordedClip = "hi_anything_else.wav";
      }
      // If nothing matched in Hindi, leave preRecordedClip = null → use TTS <Speak>
    } else {
      // English replies — check MORE SPECIFIC phrases first to avoid wrong match
      if ((lowerReply.includes("wonderful day") || lowerReply.includes("have a wonderful")) && isFinal) {
        // English NO / Goodbye — check BEFORE generic thank-you
        preRecordedClip = "vivaant_new_no_reply.wav";
      } else if (lowerReply.includes("shall get back to you") || lowerReply.includes("get back to you") ||
          (lowerReply.includes("thank you very much") && isFinal)) {
        // English YES Thank You
        preRecordedClip = "vivaant_new_yes_reply.wav";
      } else if (lowerReply.includes("say yes") || lowerReply.includes("reservation at vivaant") || lowerReply.includes("igatpuri") || lowerReply.includes("looking for reservation")) {
        // English greeting / triage prompt
        preRecordedClip = "vivaant_new_greeting.wav";
      } else if (lowerReply.includes("deluxe") || lowerReply.includes("3500") ||
                 lowerReply.includes("tariff") || lowerReply.includes("suite")) {
        preRecordedClip = "en_tariffs.wav";
      } else if (lowerReply.includes("sent the booking link") || lowerReply.includes("sent the direct booking link")) {
        preRecordedClip = "en_link_sent.wav";
      } else if (lowerReply.includes("wonderful day") || lowerReply.includes("goodbye")) {
        preRecordedClip = "en_goodbye.wav";
      }
      // If nothing matched in English, leave preRecordedClip = null → use TTS <Speak>
    }

    // Only override audioTag if the clip actually exists on disk
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

    const hints = "YES, yes, haan, ha, haan ji, NO, no, nahi, hindi, speak in hindi, hindi mein, hindi boliye, reservation, Igatpuri, Vivaant, booking";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${xmlGatherAction}" method="POST" inputType="speech" speechModel="telephony" language="en-IN" bargeIn="true" hints="${hints}" speechEndTimeout="2" executionTimeout="20">
        ${audioTag}
    </Gather>
    <Redirect method="POST">${xmlGatherAction}</Redirect>
</Response>`;
  }
}

export const vobizService = new VobizService();
