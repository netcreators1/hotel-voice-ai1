import axios from "axios";
import https from "https";
import { db, ref, set } from "../config/firebase.js";

const ipv4HttpsAgent = new https.Agent({ family: 4 });

const FALLBACK_PHONE_ID = "1423499384184090";
const FALLBACK_ACCESS_TOKEN = "EAAqAZC4gNc3YBSZC5eefke3Gx2mbfP7ubsQeNoMa5d8atRqiPZApjOTq64P1MQgu5Ss0CFX3ODTJHjmyc6fNozO2xHIzhftZAmwZASolsoOiZA1n9xFZBhDUvdYUCB8ZCPkBpHZAtgLWZAyFsfcD1avKsGZBiiERvzuUV6fZALMXRZCSJ6kqYQejQIfavCtMsBZAe6ZB0Ac7dF7rppv6dnDxCJJ2ZC0kNUIGDbuQOPZAgYfXHPYHNBa35ZAZAGOZBKDi7VsagqzBPXxhnW9SJ7pd34eHLlgFGsMZD";

/**
 * Dispatch booking payment link to caller via WhatsApp or SMS
 */
export async function sendPaymentLinkNotification({
  customerPhone,
  customerName,
  hotelName,
  roomType,
  amount,
  paymentUrl,
  callId = null
}) {
  const notifId = "notif_" + Date.now();
  let cleanPhone = (customerPhone || "").replace(/\D/g, ""); // Strip non-digits
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone; // Auto-prefix India country code
  }

  const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_PHONE_NUMBER_ID.length > 5)
    ? process.env.WHATSAPP_PHONE_NUMBER_ID.trim()
    : FALLBACK_PHONE_ID;
  const token = (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_ACCESS_TOKEN.length > 200)
    ? process.env.WHATSAPP_ACCESS_TOKEN.trim()
    : FALLBACK_ACCESS_TOKEN;

  const messageText = `Namaste ${customerName || "Guest"}! Thank you for speaking with ${hotelName || "Vivaant Retreat"}. 
To confirm your reservation for ${roomType}, please click the secure link to pay the booking advance of ₹${amount}:
${paymentUrl}
If you have any questions, feel free to reply to this message.`;

  let deliveryStatus = "simulated";

  // 1. Meta WhatsApp Cloud API
  if (phoneId && token) {
    try {
      console.log(`[WhatsApp Dispatch] Sending to ${cleanPhone} via PhoneID ${phoneId}, token length: ${token.length}, suffix: ...${token.slice(-10)}`);
      const resp = await axios.post(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: cleanPhone,
          type: "text",
          text: { body: messageText }
        },
        {
          httpsAgent: ipv4HttpsAgent,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        }
      );
      console.log(`[WhatsApp Success] Delivered booking link to ${cleanPhone}:`, resp.data);
      deliveryStatus = "sent_whatsapp";
      return { id: notifId, status: deliveryStatus, data: resp.data };
    } catch (err) {
      const errDetails = err.response?.data || err.message;
      console.warn("WhatsApp dispatch error:", errDetails);
      deliveryStatus = "failed_whatsapp";
      return { id: notifId, status: deliveryStatus, error: errDetails };
    }
  } else {
    console.log(`[Notification Simulator] Sending WhatsApp/SMS to ${cleanPhone}:`);
    console.log(messageText);
  }

  // Save to Firebase RTDB for tracking
  await set(ref(db, `notifications/${notifId}`), {
    id: notifId,
    customer_phone: customerPhone,
    customer_name: customerName,
    call_id: callId,
    message: messageText,
    payment_url: paymentUrl,
    status: deliveryStatus,
    timestamp: Date.now()
  });

  return { id: notifId, status: deliveryStatus };
}
