import { piopiyService } from "./piopiy.js";
import { dotVoiceService } from "./dotvoice.js";
import { vapiService } from "./vapi.js";
import { vobizService } from "./vobiz.js";
import { sarvamService } from "./sarvamService.js";

const DEFAULT_PROVIDER = process.env.TELEPHONY_PROVIDER || "vobiz";

/**
 * Unified Telephony Adapter
 * Allows seamless switching between Vobiz, Sarvam AI Samvaad, Vapi.ai, PIOPIY, and DotVoice
 */
export class TelephonyAdapter {
  constructor(provider = DEFAULT_PROVIDER) {
    this.providerName = provider.toLowerCase();
  }

  getProvider() {
    if (this.providerName === "sarvam" || this.providerName === "sarvam_ai") {
      return sarvamService;
    }
    if (this.providerName === "vobiz") {
      return vobizService;
    }
    if (this.providerName === "vapi") {
      return vapiService;
    }
    if (this.providerName === "dotvoice") {
      return dotVoiceService;
    }
    return piopiyService;
  }

  setProvider(providerName) {
    this.providerName = providerName.toLowerCase();
    console.log(`[TelephonyAdapter] Switched telephony provider to: ${this.providerName}`);
  }

  /**
   * Place an outbound call
   */
  async makeCall({ to, customerName, metadata = {}, baseUrl = null, persona = "aayla", language = "en" }) {
    const provider = this.getProvider();
    return await provider.makeOutboundCall({ to, customerName, metadata, baseUrl: baseUrl || metadata?.baseUrl, persona, language });
  }
}

export const telephonyAdapter = new TelephonyAdapter();
