import { db, ref, get, set, onValue } from "../config/firebase.js";

// Default hotel knowledge base
export const defaultHotelConfig = {
  hotel_name: "Vivaant Retreat",
  location: "Banjara Hills, Hyderabad, India",
  contact_number: "+91-40-23456789",
  check_in_time: "14:00 (2:00 PM)",
  check_out_time: "11:00 (11:00 AM)",
  early_checkin_policy: "Subject to availability. Early check-in before 9 AM is charged 50% of the room rate.",
  cancellation_policy: "100% refund if cancelled 24 hours prior to check-in. Non-refundable after that.",
  amenities: [
    "Complimentary High-Speed Wi-Fi",
    "Buffet Breakfast included in Executive & Suite rooms",
    "Infinity Rooftop Swimming Pool (6:00 AM - 9:00 PM)",
    "24/7 Multi-Cuisine Dining & Room Service",
    "Fitness Center & Luxury Spa",
    "Airport Pickup & Drop on request (Chargeable: ₹1,200)",
    "Valet Parking"
  ],
  room_types: {
    deluxe: {
      name: "Deluxe Room",
      capacity: "2 Adults, 1 Child",
      bed_type: "King Size or Twin Beds",
      base_rate: 3500,
      tax_percentage: 12,
      total_inventory: 15,
      features: "City view, 43-inch smart TV, work desk, walk-in rain shower."
    },
    executive_suite: {
      name: "Executive Suite",
      capacity: "2 Adults, 2 Children",
      bed_type: "King Size Bed + Living Area",
      base_rate: 6000,
      tax_percentage: 18,
      total_inventory: 8,
      features: "Panoramic balcony, jacuzzi bathtub, complimentary breakfast & cocktail hours."
    },
    presidential_suite: {
      name: "Presidential Luxury Suite",
      capacity: "4 Adults",
      bed_type: "2 Master Bedrooms",
      base_rate: 14000,
      tax_percentage: 18,
      total_inventory: 2,
      features: "Private butler service, private dining room, lounge area, airport luxury transfer included."
    }
  },
  faqs: {
    "is_breakfast_included": "Buffet breakfast is included with Executive and Presidential suites, and can be added for Deluxe rooms at ₹550 per person.",
    "pet_friendly": "We are a pet-friendly hotel for small pets up to 12kg with a refundable deposit.",
    "payment_methods": "We accept UPI, Credit/Debit cards, Net Banking, and cash at check-in (with advance token).",
    "conference_hall": "Yes, we have 2 banquet halls with seating capacity of 50 to 300 guests for corporate and wedding events."
  }
};

export const defaultAgentScript = {
  custom_greeting_en: "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES",
  custom_greeting_hi: "नमस्ते! मैं विवांत रिट्रीट से आयला बात कर रही हूँ। क्या आप विवांत रिट्रीट इगतपुरी में रिज़र्वेशन करना चाहते हैं? यदि हाँ, तो हाँ कहें।",
  custom_script: "",
  updated_at: Date.now()
};

let cachedConfig = { ...defaultHotelConfig };
let cachedAgentScript = { ...defaultAgentScript };

// Setup real-time Firebase listeners so memory cache is ALWAYS current without blocking requests
try {
  onValue(ref(db, "hotel_config"), (snapshot) => {
    if (snapshot.exists()) {
      const val = snapshot.val();
      cachedConfig = { ...defaultHotelConfig, ...val };
      console.log(`[HotelKnowledge] Synced live hotel config from Firebase: ${cachedConfig.hotel_name}, Deluxe: ₹${cachedConfig.room_types?.deluxe?.base_rate}`);
    }
  });

  onValue(ref(db, "agent_script"), (snapshot) => {
    if (snapshot.exists()) {
      const val = snapshot.val();
      cachedAgentScript = { ...defaultAgentScript, ...val };
      console.log(`[AgentScript] Synced live agent script from Firebase. Greeting: "${(cachedAgentScript.custom_greeting_en || '').slice(0, 30)}..."`);
    }
  });
} catch (e) {
  console.warn("[HotelKnowledge] Failed to setup RTDB listener:", e.message);
}

/**
 * Fetch hotel knowledge base with instant zero-latency in-memory cache
 */
export async function getHotelKnowledge(forceRefresh = false) {
  if (forceRefresh) {
    try {
      const snap = await get(ref(db, "hotel_config"));
      if (snap.exists()) {
        cachedConfig = { ...defaultHotelConfig, ...snap.val() };
      }
    } catch (e) {}
  }
  return cachedConfig;
}

export function updateHotelKnowledge(newConfig) {
  cachedConfig = { ...defaultHotelConfig, ...newConfig };
}

export function invalidateHotelKnowledgeCache() {
  cachedConfig = { ...defaultHotelConfig };
}

/**
 * Fetch live Agent Script & Guidelines
 */
export async function getAgentScript(forceRefresh = false) {
  if (forceRefresh) {
    try {
      const snap = await get(ref(db, "agent_script"));
      if (snap.exists()) {
        cachedAgentScript = { ...defaultAgentScript, ...snap.val() };
      }
    } catch (e) {}
  }
  return cachedAgentScript;
}

export function updateAgentScript(newScript) {
  cachedAgentScript = { ...defaultAgentScript, ...newScript };
}
