import axios from "axios";
import crypto from "crypto";
import { db, ref, set, update } from "../config/firebase.js";

const SARVAM_API_KEY = process.env.SARVAM_API_KEY || process.env.SARVAM_SAMVAAD_API_KEY || "sk_samvaad_9ftdufex_vNECuTAEF1AlilEgjPloy0Ss";
const SARVAM_API_BASE = "https://api.sarvam.ai";
const SARVAM_APPS_BASE = "https://apps.sarvam.ai";

// In-memory audio buffer cache (stores synthesized WAV/MP3 clips by ID with TTL)
const audioBufferCache = new Map();

/**
 * Sarvam AI Service for Indian Voice Calling (Bulbul TTS, Saaras STT & Samvaad Agent)
 */
export class SarvamService {
  constructor() {
    this.apiKey = SARVAM_API_KEY;
    this.orgId = process.env.SARVAM_ORG_ID || "";
    this.workspaceId = process.env.SARVAM_WORKSPACE_ID || "";
    this.appId = process.env.SARVAM_APP_ID || "";
    this.defaultModel = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
    this.defaultSpeaker = process.env.SARVAM_SPEAKER || "simran";
  }

  isConfigured() {
    const key = this.getApiKey();
    return !!key && key.trim().length > 10;
  }

  getApiKey() {
    return (process.env.SARVAM_API_KEY || this.apiKey || process.env.SARVAM_SAMVAAD_API_KEY || "").trim();
  }

  /**
   * Place an outbound call via Sarvam Samvaad Voice Agents API
   */
  async makeOutboundCall({ to, customerName, metadata = {}, baseUrl = null, persona = "aayla", language = "en" }) {
    const callId = "sarvam_" + Date.now();
    const cleanTo = to.startsWith("+") ? to : `+${to}`;
    const orgId = metadata.org_id || metadata.orgId || this.orgId || process.env.SARVAM_ORG_ID;
    const workspaceId = metadata.workspace_id || metadata.workspaceId || this.workspaceId || process.env.SARVAM_WORKSPACE_ID;
    const appId = metadata.app_id || metadata.appId || this.appId || process.env.SARVAM_APP_ID;
    const agentPhoneNumber = metadata.agent_phone_number || process.env.SARVAM_AGENT_PHONE_NUMBER || "";

    // Record initial call session in Firebase RTDB
    await set(ref(db, `calls/${callId}`), {
      call_id: callId,
      provider: "sarvam",
      from: agentPhoneNumber || "Sarvam Samvaad",
      to: cleanTo,
      customer_name: customerName || "Guest",
      persona: persona || "aayla",
      language: language || "en",
      direction: "outbound",
      status: "initiated",
      lead_status: "pending",
      payment_status: "none",
      start_time: Date.now(),
      created_at: Date.now(),
      metadata: metadata
    });

    console.log(`[Sarvam Samvaad] Placing outbound call to ${cleanTo} using Sarvam AI Agent...`);

    if (!orgId || !workspaceId || !appId) {
      const errMsg = "Missing Sarvam Samvaad configurations (org_id, workspace_id, app_id). Please provide your Sarvam App ID and Org/Workspace from your Sarvam dashboard URL.";
      console.warn(`[Sarvam Samvaad]:`, errMsg);
      await update(ref(db, `calls/${callId}`), {
        status: "pending_config",
        error: errMsg
      });
      return {
        success: false,
        callId,
        error: errMsg,
        requiresConfig: ["SARVAM_ORG_ID", "SARVAM_WORKSPACE_ID", "SARVAM_APP_ID"]
      };
    }

    try {
      const response = await axios.post(
        `${SARVAM_APPS_BASE}/api/outbounds/v1/orgs/${orgId}/workspaces/${workspaceId}/outbounds`,
        {
          app_config: {
            app_id: appId,
            app_version: 1,
            connection_config: {
              ...(metadata.connection_id ? { connection_id: metadata.connection_id } : {}),
              ...(agentPhoneNumber ? { agent_phone_number: agentPhoneNumber } : {})
            }
          },
          user_config: {
            user_phone_number: cleanTo,
            ...(customerName ? { user_name: customerName } : {})
          }
        },
        {
          headers: {
            "X-API-Key": this.getApiKey(),
            "Content-Type": "application/json"
          }
        }
      );

      console.log(`[Sarvam Samvaad Call Success]:`, response.data);

      await update(ref(db, `calls/${callId}`), {
        provider_session_id: response.data.attempt_id || response.data.id || callId,
        status: "ringing"
      });

      return { success: true, callId, data: response.data, persona, language };
    } catch (err) {
      const errDetails = err.response?.data || err.message;
      console.error("[Sarvam Samvaad Call Error]:", err.response?.status, errDetails);
      await update(ref(db, `calls/${callId}`), {
        status: "failed",
        error: errDetails
      });
      return { success: false, callId, error: errDetails };
    }
  }

  /**
   * Synthesize natural, human-like Indian speech using Sarvam Bulbul TTS
   * @param {string} text Spoken content (Hindi, Indian English, or code-mixed Hinglish)
   * @param {string} lang Target language code ('hi-IN' or 'en-IN')
   * @param {string} publicBaseUrl Base URL of the deployment for audio serving
   * @returns {Promise<{success: boolean, audioUrl?: string, error?: string}>}
   */
  async synthesizeSpeech(text, lang = "hi-IN", publicBaseUrl = null) {
    if (!this.isConfigured()) {
      return { success: false, error: "SARVAM_API_KEY not configured" };
    }

    if (!text || !text.trim()) {
      return { success: false, error: "Empty speech text" };
    }

    try {
      const apiKey = this.getApiKey();
      const targetLang = (lang || "").toLowerCase().startsWith("hi") ? "hi-IN" : "en-IN";
      const cleanText = text
        .replace(/<[^>]+>/g, " ")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const host = (publicBaseUrl && publicBaseUrl.startsWith("https://"))
        ? publicBaseUrl
        : (process.env.PUBLIC_URL || "https://hotel-voice-ai.fly.dev");

      // Content-addressable cache ID: instant 0ms audio retrieval for repeated/common phrases
      const textHash = crypto.createHash("md5").update(`${cleanText}_${targetLang}_${this.defaultSpeaker}`).digest("hex");
      const audioId = `sarvam_${textHash}`;

      if (audioBufferCache.has(audioId)) {
        const cached = audioBufferCache.get(audioId);
        return {
          success: true,
          audioUrl: `${host}/api/telephony/audio/${audioId}.wav`,
          audioId,
          durationBytes: cached.buffer.length,
          cached: true
        };
      }

      const payload = {
        text: cleanText,
        target_language_code: targetLang,
        model: this.defaultModel,
        speaker: this.defaultSpeaker,
        pace: 1.0,
        speech_sample_rate: 8000, // 8kHz telecom standard for telephony codecs
        audio_format: "wav"
      };

      const response = await axios.post(`${SARVAM_API_BASE}/text-to-speech`, payload, {
        headers: {
          "api-subscription-key": apiKey,
          "Content-Type": "application/json"
        },
        timeout: 4000
      });

      const audios = response.data?.audios;
      if (!audios || !audios.length || !audios[0]) {
        throw new Error("No audio returned by Sarvam API");
      }

      const audioBuffer = Buffer.from(audios[0], "base64");

      // Cache audio in memory with 24-hour expiration
      audioBufferCache.set(audioId, {
        buffer: audioBuffer,
        contentType: "audio/wav",
        createdAt: Date.now()
      });

      const audioUrl = `${host}/api/telephony/audio/${audioId}.wav`;

      return { success: true, audioUrl, audioId, durationBytes: audioBuffer.length };
    } catch (err) {
      console.warn("[Sarvam TTS Warning]:", err.response?.data || err.message);
      return { success: false, error: err.response?.data || err.message };
    }
  }

  /**
   * Retrieve cached audio buffer by ID
   */
  getAudioBuffer(audioId) {
    const cleanId = audioId.replace(/\.(wav|mp3)$/i, "");
    return audioBufferCache.get(cleanId);
  }

  /**
   * Pre-warm top conversational phrases in background so response latency is 0ms
   */
  prewarmCommonPhrases() {
    // Disabled to prevent automatic API charges
    return Promise.resolve();
  }
}

export const sarvamService = new SarvamService();
