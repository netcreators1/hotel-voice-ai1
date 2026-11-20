import axios from "axios";
import { getHotelKnowledge, getAgentScript } from "../models/hotelKnowledge.js";
import { createPaymentLink } from "./paymentGateway.js";
import { sendPaymentLinkNotification } from "./notificationService.js";
import { db, ref, get, update } from "../config/firebase.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

/**
 * Available Agent Tools (Function Calling definitions)
 */
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_room_availability",
      description: "Check if a specific room type is available for the given dates and get pricing.",
      parameters: {
        type: "object",
        properties: {
          room_type: {
            type: "string",
            enum: ["deluxe", "executive_suite", "presidential_suite"],
            description: "The category of room requested."
          },
          nights: {
            type: "integer",
            description: "Number of nights stay."
          }
        },
        required: ["room_type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_and_send_payment_link",
      description: "Generates a secure payment link for room booking deposit and sends it via WhatsApp/SMS to the guest.",
      parameters: {
        type: "object",
        properties: {
          room_type: {
            type: "string",
            description: "Room category booked."
          },
          nights: {
            type: "integer",
            description: "Number of nights."
          },
          amount: {
            type: "number",
            description: "Total or deposit amount in INR to collect."
          }
        },
        required: ["room_type", "amount"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_guest_interest",
      description: "Records the lead qualification status, dates, and special requests from the guest.",
      parameters: {
        type: "object",
        properties: {
          interest_level: {
            type: "string",
            enum: ["hot", "warm", "cold"],
            description: "Hot = wants to book, warm = considering/inquiring, cold = not interested."
          },
          intent: {
            type: "string",
            description: "Summary of guest intent, e.g., 'weekend stay with family', 'corporate inquiry'."
          },
          unanswered_question: {
            type: "string",
            description: "Any query the agent could not confidently answer, to escalate to human front-desk."
          }
        },
        required: ["interest_level", "intent"]
      }
    }
  }
];

/**
 * Execute a tool called by the LLM
 */
export async function executeTool(name, args, sessionContext) {
  const hotel = await getHotelKnowledge();
  const { callId, customerName, customerPhone } = sessionContext;

  console.log(`[Agent Tool Call] ${name}:`, JSON.stringify(args));

  switch (name) {
    case "check_room_availability": {
      const roomKey = (args.room_type || "deluxe").toLowerCase().replace(" ", "_");
      const room = hotel.room_types[roomKey] || hotel.room_types.deluxe;
      const nights = args.nights || 1;
      const totalAmount = room.base_rate * nights * (1 + room.tax_percentage / 100);

      return {
        available: true,
        room_name: room.name,
        base_rate_per_night: room.base_rate,
        tax_percentage: room.tax_percentage,
        nights: nights,
        total_estimated_amount: Math.round(totalAmount),
        features: room.features,
        cancellation: hotel.cancellation_policy
      };
    }

    case "generate_and_send_payment_link": {
      let targetPhone = customerPhone;
      if (!targetPhone && callId) {
        try {
          const snap = await get(ref(db, `calls/${callId}`));
          if (snap.exists()) {
            targetPhone = snap.val()?.to || snap.val()?.customer_phone;
          }
        } catch (_) {}
      }
      if (!targetPhone) {
        targetPhone = sessionContext?.customerPhone || "+919167584555";
      }

      console.log(`[Tool: generate_and_send_payment_link] Generating link for ${targetPhone} (${args.room_type}, ₹${args.amount})...`);
      const paymentRecord = await createPaymentLink({
        customerName: customerName || "Guest",
        customerPhone: targetPhone,
        amount: args.amount,
        description: `Booking deposit for ${args.room_type} (${args.nights || 1} nights)`,
        callId: callId,
        roomType: args.room_type,
        nights: args.nights || 1
      });

      // Dispatch via WhatsApp/SMS
      await sendPaymentLinkNotification({
        customerPhone: targetPhone,
        customerName: customerName,
        hotelName: hotel.hotel_name,
        roomType: args.room_type,
        amount: args.amount,
        paymentUrl: paymentRecord.payment_url,
        callId: callId
      });

      return {
        success: true,
        payment_id: paymentRecord.payment_id,
        payment_url: paymentRecord.payment_url,
        status: "link_sent_to_customer_whatsapp"
      };
    }

    case "log_guest_interest": {
      if (callId) {
        await update(ref(db, `calls/${callId}`), {
          lead_status: args.interest_level,
          intent: args.intent,
          unanswered_question: args.unanswered_question || null,
          updated_at: Date.now()
        });
      }
      return { success: true, recorded: args };
    }

    default:
      return { error: `Tool ${name} not found` };
  }
}

/**
 * Multiple Agentic AI Personas for Telecalling with Hindi & English Support and SSML Pauses
 */
function formatHindiGreetingName(name) {
  if (!name || name.toLowerCase() === "guest") return "ji";
  const clean = name.replace(/^(mr\.?|ms\.?|mrs\.?|dr\.?)\s+/i, "").trim();
  return `${clean} ji`;
}

export const AGENT_PERSONAS = {
  aayla: {
    id: "aayla",
    name: "Aayla",
    hindiName: "आयला",
    role: "Reservation Specialist",
    title: "Reservation Specialist (Luxury & Bookings)",
    tone: "Lively, warm, polite, and energetic young Indian voice",
    voice: "Polly.Kajal",
    generateGreeting: (hotelName, guestName, lang = "en") => {
      const hName = hotelName || "Vivaant Retreat";
      const isHindi = (lang || "").toLowerCase() === "hi";
      const namePart = (guestName && guestName.trim() && guestName.toLowerCase() !== "guest")
        ? guestName.trim()
        : "";
      if (isHindi) {
        const gName = formatHindiGreetingName(guestName);
        return `Namaste ${gName}! ${hName} se Aayla. Main aapki kya sahayata kar sakti hoon?`;
      }
      return `Namaste${namePart ? " " + namePart : ""}! Aayla from ${hName}. How may I assist your booking today?`;
    },
    systemPromptDescription: {
      en: "You are 'Aayla', a lively, warm, and professional reservation specialist for luxury hotel stays, room categories, tariffs, and direct booking links.",
      hi: "Aap 'Aayla' hain, Vivaant Retreat ki polite, energetic aur professional hotel reservation specialist. Aap mehmaanon se madhur, vinamra aur enthusiastic Hindi mein baat karti hain."
    }
  },
  kabir: {
    id: "kabir",
    name: "Kabir",
    hindiName: "कबीर",
    role: "Corporate & Banquet Concierge",
    title: "Corporate & Banquet Concierge (MICE & Events)",
    tone: "Executive, crisp, and professional",
    voice: "Polly.Kajal",
    generateGreeting: (hotelName, guestName, lang = "en") => {
      const hName = hotelName || "Vivaant Retreat";
      const isHindi = (lang || "").toLowerCase() === "hi";
      const namePart = (guestName && guestName.trim() && guestName.toLowerCase() !== "guest")
        ? guestName.trim()
        : "";
      if (isHindi) {
        const gName = formatHindiGreetingName(guestName);
        return `Namaste ${gName}... Main ${hName} se Kabir baat kar raha hoon... Kya main aapki aagami conference, banquet ya business stay mein sahayata kar sakta hoon?`;
      }
      return `Namaste${namePart ? " " + namePart : ""}... I am Kabir, Corporate & Banquet Concierge at ${hName}... How may I assist your upcoming conference, banquet, or business stay?`;
    },
    systemPromptDescription: {
      en: "You are 'Kabir', an executive corporate concierge specializing in corporate bookings, conference halls, MICE events, and business executive suites.",
      hi: "Aap 'Kabir' hain, Vivaant Retreat ke corporate aur banquet specialist. Aap conference aur business bookings mein vinamra Hindi mein sahayata karte hain."
    }
  },
  rhea: {
    id: "rhea",
    name: "Rhea",
    hindiName: "रिया",
    role: "VIP Guest Experience Manager",
    title: "VIP Guest Relations (Dining, Spa & Transfers)",
    tone: "Lively, attentive, courteous, and hospitable young voice",
    voice: "Polly.Kajal",
    generateGreeting: (hotelName, guestName, lang = "en") => {
      const hName = hotelName || "Vivaant Retreat";
      const isHindi = (lang || "").toLowerCase() === "hi";
      const namePart = (guestName && guestName.trim() && guestName.toLowerCase() !== "guest")
        ? guestName.trim()
        : "";
      if (isHindi) {
        const gName = formatHindiGreetingName(guestName);
        return `Namaste ${gName}... Main ${hName} Guest Experience se Rhea baat kar rahi hoon... Aapki aagami yatra ko sukhad aur yaadgaar banane mein main kis prakaar sahayata kar sakti hoon?`;
      }
      return `Namaste${namePart ? " " + namePart : ""}... I am Rhea from ${hName} Guest Experience... Thank you for taking my call. How may I make your upcoming visit comfortable and memorable?`;
    },
    systemPromptDescription: {
      en: "You are 'Rhea', a VIP guest relations manager specializing in dining, rooftop pool, spa, airport luxury transfers, and curated hospitality experiences.",
      hi: "Aap 'Rhea' hain, Vivaant Retreat ki VIP guest relations manager. Aap dining, rooftop pool aur hospitality mein vinamra Hindi mein sahayata karti hain."
    }
  },
  vikram: {
    id: "vikram",
    name: "Vikram",
    hindiName: "विक्रम",
    role: "Promotions & Offers Specialist",
    title: "Promotions Specialist (Deals & Weekend Offers)",
    tone: "Dynamic, persuasive, and enthusiastic",
    voice: "Polly.Kajal",
    generateGreeting: (hotelName, guestName, lang = "en") => {
      const hName = hotelName || "Vivaant Retreat";
      const isHindi = (lang || "").toLowerCase() === "hi";
      const namePart = (guestName && guestName.trim() && guestName.toLowerCase() !== "guest")
        ? guestName.trim()
        : "";
      if (isHindi) {
        const gName = formatHindiGreetingName(guestName);
        return `Namaste ${gName}... Main ${hName} se Vikram baat kar raha hoon... Aaj hamare paas weekend getaway aur special room discount packages uplabdh hain. Kya aap inke baare mein jaanna chahenge?`;
      }
      return `Namaste${namePart ? " " + namePart : ""}... I am Vikram from ${hName}... I am reaching out with exclusive seasonal rates and weekend getaway packages for you. Would you like to hear today's special offers?`;
    },
    systemPromptDescription: {
      en: "You are 'Vikram', a promotional specialist presenting exclusive seasonal packages, discounted tariffs, weekend offers, and instant payment links.",
      hi: "आप 'विक्रम' (Vikram) हैं, होटल के प्रमोशनल और स्पेशल ऑफर विशेषज्ञ। आप मेहमानों को वीकेंड और डिस्काउंट पैकेज के बारे में उत्साहपूर्वक और आदरणीय हिंदी में जानकारी देते हैं।"
    }
  }
};

/**
 * Core Agent Conversation Step
 * Generates natural, concise voice-friendly responses and triggers tool calls
 */
export async function processConversationStep(messages, sessionContext = {}) {
  const hotel = await getHotelKnowledge();
  const dbScript = await getAgentScript();
  const personaKey = (sessionContext?.persona || "aayla").toLowerCase();
  const persona = AGENT_PERSONAS[personaKey] || AGENT_PERSONAS.aayla;

  const lastUserRaw = messages.filter(m => m.role === "user").pop()?.content || "";
  const lastUserMsg = lastUserRaw.toLowerCase().trim();

  // Dynamic tariffs from Live Hotel Knowledge Base
  const deluxeRate = hotel.room_types?.deluxe?.base_rate || 3500;
  const execRate = hotel.room_types?.executive_suite?.base_rate || 6000;
  const presRate = hotel.room_types?.presidential_suite?.base_rate || 14000;

  // Determine language preference: check if caller wants Hindi or spoke Hindi
  const wantsHindi = 
    lastUserMsg === "2" ||
    lastUserMsg.includes("hindi") ||
    lastUserMsg.includes("hindee") ||
    lastUserMsg.includes("हिंदी") ||
    lastUserMsg.includes("हिन्दी") ||
    lastUserMsg.includes("inde") ||
    lastUserMsg.includes("handy") ||
    lastUserMsg.includes("in the") ||
    lastUserMsg.includes("in hindi") ||
    lastUserMsg.includes("talk in hindi") ||
    lastUserMsg.includes("speak in hindi") ||
    lastUserMsg.includes("can we talk in hindi") ||
    lastUserMsg.includes("can we speak in hindi") ||
    lastUserMsg.includes("speak hindi") ||
    lastUserMsg.includes("can you speak hindi") ||
    lastUserMsg.includes("do you speak hindi") ||
    lastUserMsg.includes("hindi please") ||
    lastUserMsg.includes("please hindi") ||
    lastUserMsg.includes("hindi mein") ||
    lastUserMsg.includes("hindi me") ||
    lastUserMsg.includes("hindi bolo") ||
    lastUserMsg.includes("hindi boliye") ||
    lastUserMsg.includes("hindi bolie") ||
    lastUserMsg.includes("hindi batao") ||
    lastUserMsg.includes("hindi me baat") ||
    lastUserMsg.includes("hindi mein baat") ||
    lastUserMsg.includes("boliye") ||
    lastUserMsg.includes("bolo") ||
    lastUserMsg.includes("batao") ||
    lastUserMsg.includes("baat karo") ||
    lastUserMsg.includes("baat kijiye") ||
    lastUserMsg.includes("baat karein") ||
    lastUserMsg.includes("english nahi") ||
    lastUserMsg.includes("angrezi nahi") ||
    lastUserMsg.includes("angreji nahi") ||
    lastUserMsg.includes("english samajh") ||
    lastUserMsg.includes("nahi aati") ||
    lastUserMsg.includes("hindi aati hai");

  const wantsEnglish =
    lastUserMsg.includes("english please") ||
    lastUserMsg.includes("speak in english") ||
    lastUserMsg.includes("talk in english") ||
    lastUserMsg.includes("in english") ||
    lastUserMsg.includes("can you speak english") ||
    lastUserMsg.includes("english only");

  const hasHindiKeywords = 
    wantsHindi ||
    lastUserMsg.includes("namaste") ||
    lastUserMsg.includes("namaskar") ||
    lastUserMsg.includes("kya") ||
    lastUserMsg.includes("kaise") ||
    lastUserMsg.includes("kitna") ||
    lastUserMsg.includes("kitne") ||
    lastUserMsg.includes("chahiye") ||
    lastUserMsg.includes("karo") ||
    lastUserMsg.includes("kariye") ||
    lastUserMsg.includes("karna") ||
    lastUserMsg.includes("karein") ||
    lastUserMsg.includes("bhai") ||
    lastUserMsg.includes("bhaiya") ||
    lastUserMsg.includes("ji ") ||
    lastUserMsg.endsWith(" ji") ||
    lastUserMsg.includes("ha ") ||
    lastUserMsg.includes("haan") ||
    lastUserMsg.includes("nahi") ||
    lastUserMsg.includes("kamra") ||
    lastUserMsg.includes("kamre") ||
    lastUserMsg.includes("kiraya") ||
    lastUserMsg.includes("bhejo") ||
    lastUserMsg.includes("bhej") ||
    lastUserMsg.includes("khana") ||
    lastUserMsg.includes("nashta") ||
    lastUserMsg.includes("suvidha") ||
    lastUserMsg.includes("paas") ||
    lastUserMsg.includes("shuru") ||
    lastUserMsg.includes("bataye") ||
    lastUserMsg.includes("batao") ||
    lastUserMsg.includes("bolo") ||
    lastUserMsg.includes("boliye") ||
    lastUserMsg.includes("baat") ||
    lastUserMsg.includes("rokna") ||
    lastUserMsg.includes("ruko") ||
    lastUserMsg.includes("kripya") ||
    lastUserMsg.includes("dhanyavaad") ||
    lastUserMsg.includes("shukriya") ||
    /[\u0900-\u097F]/.test(lastUserRaw);

  const explicitLang = (sessionContext?.language || sessionContext?.lang || "").toLowerCase();
  const isHindi = !wantsEnglish && (wantsHindi || explicitLang === "hi" || explicitLang.startsWith("hi") || hasHindiKeywords);
  const activeLanguage = isHindi ? "hi" : "en";

  // Active client custom script & greeting (from simulation turn or saved Firebase script)
  const activeCustomScript = (sessionContext?.customScript || dbScript?.custom_script || "").trim();
  const activeCustomGreeting = (sessionContext?.customGreeting || (isHindi ? dbScript?.custom_greeting_hi : dbScript?.custom_greeting_en) || "").trim();

  const roleDesc = isHindi ? persona.systemPromptDescription.hi : persona.systemPromptDescription.en;

  const systemPrompt = isHindi
    ? `${roleDesc} आप ${hotel.hotel_name}, ${hotel.location} की ओर से बोल रहे हैं।
आपका उद्देश्य:
1. मेहमान का आत्मीयता से स्वागत करें और बताएं कि आप ${persona.hindiName || persona.name} बात कर रहे हैं।
2. मेहमान के प्रश्नों का संक्षिप्त, विनम्र और सटीक उत्तर दें (डीलक्स रूम किराया ₹${hotel.room_types?.deluxe?.base_rate || 3500}, चेक-इन ${hotel.check_in_time}, चेक-आउट ${hotel.check_out_time}, स्विमिंग पूल, डाइनिंग, सुविधाएं)।
3. फोन कॉल के अनुसार उत्तर बहुत स्वाभाविक, आत्मीय और 1 से 2 वाक्यों में रखें ताकि बातचीत रोबोटिक न लगे।
4. जब मेहमान कमरा बुक करना चाहे, तो 'check_room_availability' टूल चलाएं।
5. जब वे सहमति दें, तो 'generate_and_send_payment_link' टूल चलाएं ताकि उनके व्हाट्सएप पर तुरंत लिंक चला जाए।
6. केवल स्पष्ट, मधुर और प्राकृतिक हिंदी का प्रयोग करें।

होटल विवरण:
${JSON.stringify(hotel, null, 2)}`
    : `${roleDesc} calling on behalf of ${hotel.hotel_name} in ${hotel.location}.
Your goal:
1. Greet the guest warmly with natural breath pauses and introduce yourself as ${persona.name}.
2. Answer guest questions accurately regarding room tariffs, check-in (${hotel.check_in_time}), check-out (${hotel.check_out_time}), pool, dining, amenities, and policies.
3. Keep spoken replies short, natural, and conversational (1 to 2 sentences per turn) with pauses so it sounds genuine and human rather than robotic.
4. When the guest expresses interest in booking, call the tool 'check_room_availability'.
5. Once they agree on room and pricing, offer to send a secure booking link and execute 'generate_and_send_payment_link'.
6. Keep replies concise and warm.

Current Hotel Knowledge:
${JSON.stringify(hotel, null, 2)}`;

  // 1. OpenAI GPT-4o-mini Integration (if valid key is provided)
  if (OPENAI_API_KEY && OPENAI_API_KEY.startsWith("sk-")) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          tools: AGENT_TOOLS,
          tool_choice: "auto",
          temperature: 0.6,
          max_tokens: 200
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const choice = response.data.choices[0];
      const message = choice.message;

      // Handle tool calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolResponses = [];
        for (const tc of message.tool_calls) {
          const fnName = tc.function.name;
          const fnArgs = JSON.parse(tc.function.arguments);
          const toolResult = await executeTool(fnName, fnArgs, sessionContext);

          toolResponses.push({
            tool_call_id: tc.id,
            role: "tool",
            name: fnName,
            content: JSON.stringify(toolResult)
          });
        }

        // Get final conversational response after tool execution
        const followUp = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: systemPrompt },
              ...messages,
              message,
              ...toolResponses
            ],
            temperature: 0.6,
            max_tokens: 150
          },
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );

        return {
          reply: followUp.data.choices[0].message.content,
          toolCallsExecuted: message.tool_calls.map(tc => tc.function.name),
          isFinal: false
        };
      }

      return {
        reply: message.content,
        toolCallsExecuted: [],
        isFinal: false
      };
    } catch (err) {
      console.warn("OpenAI API call failed, using intelligent rule agent:", err.response?.data || err.message);
    }
  }

  // 2. Intelligent Built-in Hospitality Agent Fallback (Works zero-config with Hindi & English)
  let reply = "";
  let holdIntro = null;
  let hasHoldJingle = false;
  let isFinal = false;
  const toolCallsExecuted = [];
  const userMsgCount = messages.filter(m => m.role === "user").length;

  // Language switch requests (Customer asks to speak in Hindi or English)
  const isLanguageSwitchToHindi = wantsHindi && !lastUserMsg.includes("book") && !lastUserMsg.includes("rate") && !lastUserMsg.includes("price") && !lastUserMsg.includes("kiraya");
  const isLanguageSwitchToEnglish = wantsEnglish && !lastUserMsg.includes("book") && !lastUserMsg.includes("rate") && !lastUserMsg.includes("price");

  const previousAssistantMessages = messages.filter(m => m.role === "assistant");
  const lastAssistantMsg = previousAssistantMessages.length > 0 
    ? previousAssistantMessages[previousAssistantMessages.length - 1].content.toLowerCase() 
    : "";
  const wasAskedAnythingElse = 
    lastAssistantMsg.includes("anything else") || 
    lastAssistantMsg.includes("kisi aur cheez") || 
    lastAssistantMsg.includes("assist you with today");

  const wasOfferedBookingLink = 
    lastAssistantMsg.includes("booking link") || 
    lastAssistantMsg.includes("reservation link") ||
    lastAssistantMsg.includes("link on whatsapp") ||
    lastAssistantMsg.includes("bhej doon") ||
    lastAssistantMsg.includes("reserve a room") ||
    lastAssistantMsg.includes("reserve your stay");

  const isThankYou = 
    lastUserMsg.includes("thank") || 
    lastUserMsg.includes("thanks") || 
    lastUserMsg.includes("thx") || 
    lastUserMsg.includes("dhanyavaad") || 
    lastUserMsg.includes("dhanyawad") || 
    lastUserMsg.includes("shukriya") || 
    lastUserMsg.includes("धन्यवाद") || 
    lastUserMsg.includes("शुक्रिया");

  const isExitStatement = 
    lastUserMsg.includes("that's all") ||
    lastUserMsg.includes("thats all") ||
    lastUserMsg.includes("that is all") ||
    lastUserMsg.includes("nothing else") ||
    lastUserMsg.includes("that's it") ||
    lastUserMsg.includes("thats it") ||
    lastUserMsg.includes("that will be all") ||
    lastUserMsg.includes("no thanks") ||
    lastUserMsg.includes("no thank you") ||
    lastUserMsg.includes("no thank u") ||
    lastUserMsg.includes("nahi bas") ||
    lastUserMsg.includes("bas itna hi") ||
    lastUserMsg.includes("kuch nahi") ||
    lastUserMsg.includes("kuch nahi chahiye") ||
    lastUserMsg.includes("nahi chahiye") ||
    lastUserMsg.includes("nahi lena") ||
    lastUserMsg.includes("baad mein") ||
    lastUserMsg.includes("not interested") ||
    lastUserMsg.startsWith("bye") ||
    lastUserMsg.includes("goodbye") ||
    lastUserMsg.includes("alvida") ||
    lastUserMsg.includes("take care") ||
    lastUserMsg.includes("have a good day") ||
    lastUserMsg.includes("have a nice day") ||
    lastUserMsg.includes("अलविदा") ||
    (wasAskedAnythingElse && (
      lastUserMsg === "no" || 
      lastUserMsg === "nahi" || 
      lastUserMsg === "nah" || 
      lastUserMsg === "nope" || 
      lastUserMsg === "nahi ji" ||
      lastUserMsg === "no no" ||
      lastUserMsg === "nahi nahi" ||
      lastUserMsg === "nahi nahi ji" ||
      lastUserMsg.startsWith("no ") ||
      lastUserMsg.startsWith("nahi ") ||
      lastUserMsg === "नहीं"
    ));

  const isAudioCheck = 
    lastUserMsg.includes("hear me") || 
    lastUserMsg.includes("can't hear") || 
    lastUserMsg.includes("cant hear") || 
    lastUserMsg.includes("can you hear") ||
    lastUserMsg.includes("audible") ||
    lastUserMsg.includes("awaz") ||
    lastUserMsg.includes("aawaz") ||
    lastUserMsg.includes("aawaj") ||
    lastUserMsg.includes("sunai") ||
    lastUserMsg.includes("आवाज") ||
    lastUserMsg.includes("आवाज़") ||
    lastUserMsg.includes("सुनाई");

  const isHoldRequest =
    lastUserMsg.includes("hold") ||
    lastUserMsg.includes("wait") ||
    lastUserMsg.includes("ruko") ||
    lastUserMsg.includes("ek minute") ||
    lastUserMsg.includes("rukna") ||
    lastUserMsg.includes("रुकिए") ||
    lastUserMsg.includes("होल्ड");

  const isGreeting = 
    lastUserMsg === "hello" || 
    lastUserMsg.startsWith("hello") || 
    lastUserMsg.includes("hello") || 
    lastUserMsg === "hi" || 
    lastUserMsg.startsWith("hi ") || 
    lastUserMsg === "hey" || 
    lastUserMsg.startsWith("hey ") || 
    lastUserMsg.includes("who is this") || 
    lastUserMsg.includes("who are you") || 
    lastUserMsg.includes("who's this") ||
    lastUserMsg.includes("speaking") ||
    lastUserMsg.includes("namaste") ||
    lastUserMsg.includes("kon bol") ||
    lastUserMsg.includes("नमस्ते") ||
    lastUserMsg.includes("नमस्कार") ||
    lastUserMsg.includes("प्रणाम") ||
    lastUserMsg === "";

  const hasLinkWord = 
    lastUserMsg.includes("link") || 
    lastUserMsg.includes("लिंक") || 
    lastUserMsg.includes("whatsapp") || 
    lastUserMsg.includes("what's app") || 
    lastUserMsg.includes("whats app") || 
    lastUserMsg.includes("व्हाट्सएप") ||
    lastUserMsg.includes("व्हाट्स");

  const isBookingLinkRequest = 
    hasLinkWord ||
    lastUserMsg.includes("send link") ||
    lastUserMsg.includes("payment link") ||
    lastUserMsg.includes("booking link") ||
    lastUserMsg.includes("open link") ||
    lastUserMsg.includes("share link") ||
    lastUserMsg.includes("book") ||
    lastUserMsg.includes("reserve") ||
    lastUserMsg.includes("reservation") ||
    lastUserMsg.includes("advance") ||
    lastUserMsg.includes("बुक") ||
    lastUserMsg.includes("लिंक") ||
    lastUserMsg.includes("पेमेंट") ||
    lastUserMsg.includes("bhej do") ||
    lastUserMsg.includes("bhejo") ||
    lastUserMsg.includes("bhej") ||
    lastUserMsg.includes("भेज दीजिए") ||
    lastUserMsg.includes("भेज दो") ||
    lastUserMsg.includes("भेजो") ||
    (wasOfferedBookingLink && (
      lastUserMsg.includes("yes") ||
      lastUserMsg.includes("yeah") ||
      lastUserMsg.includes("yep") ||
      lastUserMsg.includes("sure") ||
      lastUserMsg.includes("ok") ||
      lastUserMsg.includes("okay") ||
      lastUserMsg.includes("please") ||
      lastUserMsg.includes("haan") ||
      lastUserMsg.includes("हाँ") ||
      lastUserMsg.includes("ha ") ||
      lastUserMsg.includes("zaroor") ||
      lastUserMsg.includes("bhejiye") ||
      lastUserMsg.includes("kar do") ||
      lastUserMsg.includes("send")
    ));

  const isCancellationQuery =
    lastUserMsg.includes("cancel") ||
    lastUserMsg.includes("cancellation") ||
    lastUserMsg.includes("refund") ||
    lastUserMsg.includes("refundable") ||
    lastUserMsg.includes("money back") ||
    lastUserMsg.includes("radd") ||
    lastUserMsg.includes("रद्द") ||
    lastUserMsg.includes("रिफंड");

  const isPetQuery =
    lastUserMsg.includes("pet") ||
    lastUserMsg.includes("pets") ||
    lastUserMsg.includes("dog") ||
    lastUserMsg.includes("dogs") ||
    lastUserMsg.includes("cat") ||
    lastUserMsg.includes("cats") ||
    lastUserMsg.includes("animal") ||
    lastUserMsg.includes("kutta") ||
    lastUserMsg.includes("kutte") ||
    lastUserMsg.includes("janwar") ||
    lastUserMsg.includes("पालतू");

  const hasWifiOrParking = (lastUserMsg.includes("wifi") || lastUserMsg.includes("wi-fi") || lastUserMsg.includes("internet") || lastUserMsg.includes("parking") || lastUserMsg.includes("valet")) &&
    !(lastUserMsg.includes("breakfast") || lastUserMsg.includes("break fast") || lastUserMsg.includes("buffet") || lastUserMsg.includes("nashta") || lastUserMsg.includes("food") || lastUserMsg.includes("khana"));

  const isBreakfastQuery = !hasWifiOrParking && (
    lastUserMsg.includes("breakfast") ||
    lastUserMsg.includes("break fast") ||
    lastUserMsg.includes("brakefast") ||
    lastUserMsg.includes("brekfast") ||
    lastUserMsg.includes("buffet") ||
    lastUserMsg.includes("nashta") ||
    lastUserMsg.includes("nasta") ||
    lastUserMsg.includes("naashta") ||
    lastUserMsg.includes("complimentary") ||
    lastUserMsg.includes("complementary") ||
    lastUserMsg.includes("complimentry") ||
    lastUserMsg.includes("free food") ||
    lastUserMsg.includes("morning food") ||
    lastUserMsg.includes("subah ka khana") ||
    lastUserMsg.includes("नाश्ता") ||
    lastUserMsg.includes("ब्रेकफास्ट")
  );

  const isDiningFoodQuery =
    lastUserMsg.includes("food") ||
    lastUserMsg.includes("dining") ||
    lastUserMsg.includes("restaurant") ||
    lastUserMsg.includes("khana") ||
    lastUserMsg.includes("lunch") ||
    lastUserMsg.includes("dinner") ||
    lastUserMsg.includes("room service") ||
    lastUserMsg.includes("खाना") ||
    lastUserMsg.includes("रेस्टोरेंट");

  const isPoolQuery =
    lastUserMsg.includes("pool") ||
    lastUserMsg.includes("swimming") ||
    lastUserMsg.includes("पूल") ||
    lastUserMsg.includes("स्विमिंग");

  const isSpaGymQuery =
    lastUserMsg.includes("spa") ||
    lastUserMsg.includes("gym") ||
    lastUserMsg.includes("fitness") ||
    lastUserMsg.includes("massage") ||
    lastUserMsg.includes("workout") ||
    lastUserMsg.includes("स्पा") ||
    lastUserMsg.includes("जिम");

  const isPaymentQuery =
    lastUserMsg.includes("payment") ||
    lastUserMsg.includes("how to pay") ||
    lastUserMsg.includes("upi") ||
    lastUserMsg.includes("credit card") ||
    lastUserMsg.includes("debit card") ||
    lastUserMsg.includes("cash") ||
    lastUserMsg.includes("net banking") ||
    lastUserMsg.includes("advance") ||
    lastUserMsg.includes("भुगतान");

  const isAirportQuery =
    lastUserMsg.includes("airport") ||
    lastUserMsg.includes("pickup") ||
    lastUserMsg.includes("drop") ||
    lastUserMsg.includes("cab") ||
    lastUserMsg.includes("taxi") ||
    lastUserMsg.includes("transfer") ||
    lastUserMsg.includes("एयरपोर्ट") ||
    lastUserMsg.includes("पिकअप");

  const isAmenities = 
    lastUserMsg.includes("amenit") ||
    lastUserMsg.includes("facilit") ||
    lastUserMsg.includes("service") ||
    lastUserMsg.includes("feature") ||
    lastUserMsg.includes("suvidha") ||
    lastUserMsg.includes("suvidhaen") ||
    lastUserMsg.includes("suvidhayein") ||
    lastUserMsg.includes("wifi") ||
    lastUserMsg.includes("wi-fi") ||
    lastUserMsg.includes("internet") ||
    lastUserMsg.includes("parking") ||
    lastUserMsg.includes("valet") ||
    lastUserMsg.includes("सुविधा") ||
    lastUserMsg.includes("वाईफाई");

  const isTariffQuery = 
    lastUserMsg.includes("price") || 
    lastUserMsg.includes("tariff") || 
    lastUserMsg.includes("rate") || 
    lastUserMsg.includes("cost") || 
    lastUserMsg.includes("room") || 
    lastUserMsg.includes("charge") ||
    lastUserMsg.includes("deluxe") ||
    lastUserMsg.includes("suite") ||
    lastUserMsg.includes("stay") ||
    lastUserMsg.includes("rent") ||
    lastUserMsg.includes("how much") ||
    lastUserMsg.includes("kitna") ||
    lastUserMsg.includes("kiraya") ||
    lastUserMsg.includes("dam") ||
    lastUserMsg.includes("paisa") ||
    lastUserMsg.includes("किराया") ||
    lastUserMsg.includes("रेट") ||
    lastUserMsg.includes("दाम") ||
    lastUserMsg.includes("प्राइस") ||
    lastUserMsg.includes("रूम") ||
    lastUserMsg.includes("कमरा") ||
    lastUserMsg.includes("चार्ज") ||
    lastUserMsg.includes("कितना") ||
    lastUserMsg.includes("डीलक्स") ||
    lastUserMsg.includes("सूट");

  const isLocationQuery = 
    lastUserMsg.includes("location") ||
    lastUserMsg.includes("where") ||
    lastUserMsg.includes("address") ||
    lastUserMsg.includes("kahan") ||
    lastUserMsg.includes("kaha") ||
    lastUserMsg.includes("kidhar") ||
    lastUserMsg.includes("hyderabad") ||
    lastUserMsg.includes("banjara") ||
    lastUserMsg.includes("कहाँ") ||
    lastUserMsg.includes("कहा") ||
    lastUserMsg.includes("लोकेशन") ||
    lastUserMsg.includes("एड्रेस");

  const isDetailsOrEmail = 
    lastUserMsg.includes("email") ||
    lastUserMsg.includes("mail") ||
    lastUserMsg.includes("details") ||
    lastUserMsg.includes("brochure") ||
    lastUserMsg.includes("send me") ||
    lastUserMsg.includes("share") ||
    lastUserMsg.includes("bhejo") ||
    lastUserMsg.includes("जानकारी") ||
    lastUserMsg.includes("ब्रोशर");

  const isCorporateOrEvent = 
    lastUserMsg.includes("conference") ||
    lastUserMsg.includes("banquet") ||
    lastUserMsg.includes("meeting") ||
    lastUserMsg.includes("event") ||
    lastUserMsg.includes("hall") ||
    lastUserMsg.includes("wedding") ||
    lastUserMsg.includes("shadi") ||
    lastUserMsg.includes("कॉन्फ्रेंस") ||
    lastUserMsg.includes("बैंक्वेट") ||
    lastUserMsg.includes("हॉल") ||
    lastUserMsg.includes("मीटिंग") ||
    lastUserMsg.includes("इवेंट") ||
    lastUserMsg.includes("शादी");

  const wasPromptedSayYes = 
    lastAssistantMsg.includes("say yes") || 
    lastAssistantMsg.includes("reservation at vivaant") ||
    lastAssistantMsg.includes("igatpuri") ||
    lastAssistantMsg.includes("इगतपुरी") ||
    lastAssistantMsg.includes("विवांत") ||
    lastAssistantMsg.includes("हाँ कहें") ||
    lastAssistantMsg.includes("haan kahein") ||
    lastAssistantMsg.includes("kahiye haan") ||
    lastAssistantMsg.includes("if yes, then say yes") ||
    lastAssistantMsg.includes("if yes then say yes") ||
    (activeCustomGreeting && (
      activeCustomGreeting.toLowerCase().includes("say yes") ||
      activeCustomGreeting.toLowerCase().includes("igatpuri") ||
      activeCustomGreeting.includes("इगतपुरी") ||
      activeCustomGreeting.includes("विवांत") ||
      activeCustomGreeting.includes("हाँ कहें") ||
      activeCustomGreeting.toLowerCase().includes("reservation at vivaant")
    ));

  const isAffirmativeYes = 
    lastUserMsg === "1" ||
    lastUserMsg === "yes" || 
    lastUserMsg === "yeah" || 
    lastUserMsg === "yep" || 
    lastUserMsg === "haan" || 
    lastUserMsg === "haa" || 
    lastUserMsg === "ha" || 
    lastUserMsg === "haan ji" || 
    lastUserMsg === "haa ji" || 
    lastUserMsg === "ha ji" || 
    lastUserMsg === "haanji" || 
    lastUserMsg === "haaji" || 
    lastUserMsg === "haji" || 
    lastUserMsg === "ji" || 
    lastUserMsg === "ji haan" || 
    lastUserMsg === "ji ha" || 
    lastUserMsg === "हाँ" || 
    lastUserMsg === "हाँ जी" || 
    lastUserMsg === "हां" || 
    lastUserMsg === "हां जी" || 
    lastUserMsg === "yes please" || 
    lastUserMsg === "sure" || 
    lastUserMsg === "ok" || 
    lastUserMsg === "okay" || 
    lastUserMsg === "hum" || 
    lastUserMsg === "hmm" || 
    lastUserMsg === "hun" || 
    lastUserMsg.startsWith("yes") || 
    lastUserMsg.startsWith("haan") ||
    lastUserMsg.startsWith("haa") ||
    lastUserMsg.startsWith("ha ") ||
    lastUserMsg.startsWith("ji ") ||
    lastUserMsg.startsWith("हाँ") ||
    lastUserMsg.startsWith("हां") ||
    lastUserMsg.includes("yes") ||
    lastUserMsg.includes("haan") ||
    lastUserMsg.includes("haa") ||
    lastUserMsg.includes("हाँ") ||
    lastUserMsg.includes("हां") ||
    lastUserMsg.includes("ji haan") ||
    lastUserMsg.includes("ji ha") ||
    lastUserMsg.includes("kanhaiya") ||
    lastUserMsg.includes("sure") ||
    lastUserMsg.includes("confirm") ||
    lastUserMsg.includes("interested") ||
    lastUserMsg.includes("correct") ||
    lastUserMsg.includes("right") ||
    lastUserMsg.includes("book") ||
    lastUserMsg.includes("booking") ||
    lastUserMsg.includes("karna hai") ||
    lastUserMsg.includes("chahiye") ||
    lastUserMsg.includes("bilkul") ||
    lastUserMsg.includes("zaroor");

  const isNegativeNo =
    isExitStatement ||
    lastUserMsg === "no" ||
    lastUserMsg === "nahi" ||
    lastUserMsg === "nah" ||
    lastUserMsg === "nope" ||
    lastUserMsg === "no thanks" ||
    lastUserMsg === "नहीं" ||
    lastUserMsg === "नहीं जी" ||
    lastUserMsg.startsWith("no ") ||
    lastUserMsg.startsWith("nahi ") ||
    lastUserMsg.startsWith("नहीं") ||
    lastUserMsg.includes("no") ||
    lastUserMsg.includes("nahi") ||
    lastUserMsg.includes("nah") ||
    lastUserMsg.includes("नहीं");

  // ALWAYS check YES/NO first — the greeting ALWAYS asks the customer to say YES/Haa
  // This handles both when wasPromptedSayYes is true AND when activeCalls memory was cleared (Render restart)
  if (isAffirmativeYes && !isBookingLinkRequest && !isTariffQuery && !isLanguageSwitchToHindi) {
    reply = isHindi
      ? "Aapka bahut-bahut dhanyavaad, hamari team aapse jald hi sampark karegi."
      : "Thank you very much and we shall get back to you.";
    isFinal = true;
    executeTool("log_guest_interest", { interest_level: "hot", intent: "Confirmed Reservation Interest (Said YES / HAAN)" }, sessionContext).catch(() => {});
  } else if (isNegativeNo && !isBookingLinkRequest && !isTariffQuery && !isLanguageSwitchToHindi) {
    reply = isHindi
      ? "Bahut-bahut dhanyavaad aur aapka din shubh ho."
      : "Thank you very much. Have a wonderful day ahead!";
    isFinal = true;
    executeTool("log_guest_interest", { interest_level: "cold", intent: "Declined Reservation (Said NO / NAHI)" }, sessionContext).catch(() => {});
  } else if (wasPromptedSayYes) {
    if (isThankYou && userMsgCount > 2) {
      reply = isHindi
        ? "Bahut-bahut dhanyavaad aur aapka din shubh ho."
        : "Thank you very much and we shall get back to you.";
      isFinal = true;
      executeTool("log_guest_interest", { interest_level: "warm", intent: "Customer acknowledged with thanks" }, sessionContext).catch(() => {});
    } else if (wantsHindi || isLanguageSwitchToHindi) {
      reply = "जी बिल्कुल! क्या आप विवांत रिट्रीट इगतपुरी में रिज़र्वेशन करना चाहते हैं? यदि हाँ, तो हाँ कहें।";
      isFinal = false;
      executeTool("log_guest_interest", { interest_level: "warm", intent: "Customer requested Hindi language" }, sessionContext).catch(() => {});
    } else {
      // Customer said something unclear or audio check in current language
      reply = isHindi
        ? "जी बिल्कुल! क्या आप विवांत रिट्रीट इगतपुरी में रिज़र्वेशन करना चाहते हैं? यदि हाँ, तो हाँ कहें।"
        : "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES";
      isFinal = false;
      executeTool("log_guest_interest", { interest_level: "warm", intent: isHindi ? "Customer requested Hindi language" : "General Inquiry" }, sessionContext).catch(() => {});
    }
  } else if (isLanguageSwitchToHindi || wantsHindi) {
    reply = "जी बिल्कुल! क्या आप विवांत रिट्रीट इगतपुरी में रिज़र्वेशन करना चाहते हैं? यदि हाँ, तो हाँ कहें।";
    isFinal = false;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Customer requested Hindi language" }, sessionContext).catch(() => {});
  } else if (isThankYou) {
    reply = "Thank you very much and we shall get back to you.";
    isFinal = true;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Customer acknowledged with thanks" }, sessionContext).catch(() => {});
  } else if (isLanguageSwitchToEnglish) {
    reply = `Certainly! I will gladly speak with you in English. Welcome to Vivaant Retreat! Our Deluxe rooms start at Rupees ${deluxeRate} plus taxes. How may I assist your stay or room reservation today?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Customer requested English language" }, sessionContext).catch(() => {});
  } else if (isAudioCheck) {
    reply = isHindi
      ? `Haan ji, mujhe aapki aawaz bilkul saaf sunai de rahi hai. Hamare Deluxe room 3500 Rupees se shuru hote hain. Bataiye, main aapki booking mein kya help kar sakti hoon?`
      : `Yes, I can hear you loud and clear! Our Deluxe rooms start at Rupees 3500. How may I assist your stay or room reservation today?`;
  } else if (isHoldRequest) {
    holdIntro = isHindi
      ? `Ji bilkul, main call ko ek brief hotel chime ke saath hold par rakh rahi hoon. Jab bhi aap ready hon, please continue karein...`
      : `Certainly! Putting your call on a brief hold with our hotel concierge chime. Whenever you are ready, please continue...`;
    hasHoldJingle = true;
    reply = isHindi
      ? `Hold par bane rehne ke liye dhanyavaad! Hamare Deluxe room 3500 Rupees aur Executive Suite 6000 Rupees hain. Bataiye, main aapki kya sahayata kar sakti hoon?`
      : `Thank you for holding! Our Deluxe rooms are Rupees 3500 and Executive Suite is 6000 plus taxes per night. How may I assist your reservation?`;
  } else if (isBookingLinkRequest) {
    const isExecutive = lastUserMsg.includes("executive") || lastUserMsg.includes("suite") || lastAssistantMsg.includes("executive");
    const isPresidential = lastUserMsg.includes("presidential") || lastAssistantMsg.includes("presidential");

    let chosenRoom = "Deluxe Room";
    let chosenAmount = 3920; // 3500 + 12% tax
    if (isPresidential) {
      chosenRoom = "Presidential Suite";
      chosenAmount = 14160; // 12000 + 18% tax
    } else if (isExecutive) {
      chosenRoom = "Executive Suite";
      chosenAmount = 7080; // 6000 + 18% tax
    }

    console.log(`[VoiceAgent] Initiating booking payment link dispatch for ${chosenRoom} (₹${chosenAmount})...`);
    executeTool("generate_and_send_payment_link", { room_type: chosenRoom, nights: 1, amount: chosenAmount }, sessionContext)
      .then(res => console.log("[VoiceAgent] Payment link dispatched:", res))
      .catch(err => console.error("[VoiceAgent] Payment link error:", err));

    reply = isHindi
      ? `Maine aapke WhatsApp par booking link bhej diya hai! Kya main aapke liye kisi aur cheez mein sahayata kar sakti hoon?`
      : `I have sent the booking link to your WhatsApp! Is there anything else I can do for you?`;
    toolCallsExecuted.push("generate_and_send_payment_link");
    executeTool("log_guest_interest", { interest_level: "hot", intent: "Requested booking payment link" }, sessionContext).catch(() => {});
  } else if (isCancellationQuery) {
    reply = isHindi
      ? `${hotel.hotel_name || "Vivaant Retreat"} mein check-in se 24 ghante pehle cancel karne par 100% full refund milta hai. Uske baad non-refundable rehta hai. Kya main aapke liye room reservation link share kar doon?`
      : `At ${hotel.hotel_name || "Vivaant Retreat"}, we offer a 100% full refund for cancellations made 24 hours prior to check-in. Cancellations within 24 hours are non-refundable. Would you like me to send you the reservation link?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired cancellation policy" }, sessionContext).catch(() => {});
  } else if (isPetQuery) {
    reply = isHindi
      ? `Ji haan! ${hotel.hotel_name || "Vivaant Retreat"} 12 kg tak ke chhote pets ke liye ek pet-friendly hotel hai, jisme ek refundable deposit hota hai. Kya main aapka room reserve kar doon?`
      : `Yes! ${hotel.hotel_name || "Vivaant Retreat"} is a pet-friendly hotel for small pets up to 12 kilograms with a refundable deposit. We welcome your pets! Would you like me to reserve a room for you?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired pet policy" }, sessionContext).catch(() => {});
  } else if (isBreakfastQuery) {
    if (lastUserMsg.includes("deluxe") || lastUserMsg.includes("डीलक्स")) {
      reply = isHindi
        ? `Deluxe room mein buffet breakfast included nahi hai, lekin aap sirf 550 Rupees per person mein lavish buffet breakfast add karwa sakte hain. Hamare Executive aur Presidential Suites ke saath buffet breakfast bilkul complimentary hai. Kya main aapka room reserve kar doon?`
        : `For Deluxe rooms, our lavish buffet breakfast is not included by default, but can easily be added for just 550 Rupees per person. Our Executive and Presidential suites come with complimentary buffet breakfast included. Would you like me to book an Executive Suite or Deluxe room for you?`;
    } else {
      reply = isHindi
        ? `Ji haan! Hamare Executive Suites aur Presidential Suites ke saath lavish buffet breakfast bilkul complimentary hai. Deluxe room ke liye lavish buffet breakfast sirf 550 Rupees per person mein add kiya ja sakta hai. Kya main aapke liye complimentary breakfast ke saath Executive Suite ya Deluxe room reserve kar doon?`
        : `Yes! A lavish complimentary buffet breakfast is included with all our Executive and Presidential suites. For our Deluxe rooms, the lavish buffet breakfast can be added for just 550 Rupees per person. Would you like me to reserve an Executive Suite with complimentary breakfast or a Deluxe room for you?`;
    }
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired breakfast" }, sessionContext).catch(() => {});
  } else if (isDiningFoodQuery) {
    reply = isHindi
      ? `Hamare hotel mein 24-hour multi-cuisine restaurant aur room service uplabdh hai jisme authentic Indian aur Continental dishes shamil hain. Kya main aapke WhatsApp par booking link share kar doon?`
      : `We feature 24/7 multi-cuisine dining and 24-hour room service with authentic Indian and international menus. Would you like me to send you our booking link?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired dining and food" }, sessionContext).catch(() => {});
  } else if (isPoolQuery) {
    reply = isHindi
      ? `Hamare hotel mein rooftop infinity swimming pool hai jo subah 6:00 baje se raat 9:00 baje tak open rehta hai aur sabhi in-house guests ke liye complimentary hai. Kya main aapka room book kar doon?`
      : `We feature an infinity rooftop swimming pool open from 6:00 AM to 9:00 PM with panoramic city views, complimentary for all in-house guests. Would you like me to book your stay?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired swimming pool" }, sessionContext).catch(() => {});
  } else if (isSpaGymQuery) {
    reply = isHindi
      ? `Hotel mein luxury wellness spa aur 24-hour fitness gym uplabdh hai. Kya aap room rates ya booking link chahte hain?`
      : `We have a luxury wellness spa and a fully equipped 24/7 fitness center for our guests. Would you like to know our room rates or receive our booking link?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired spa and gym" }, sessionContext).catch(() => {});
  } else if (isPaymentQuery) {
    reply = isHindi
      ? `Hum sabhi credit aur debit cards, UPI, net banking aur check-in par cash accept karte hain. Kya main aapke WhatsApp par direct booking link bhej doon?`
      : `We accept all major credit and debit cards, UPI, Net Banking, and cash at check-in with advance token. Would you like me to send an instant reservation link to your WhatsApp?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired payment methods" }, sessionContext).catch(() => {});
  } else if (isAirportQuery) {
    reply = isHindi
      ? `Hum Banjara Hills mein airport se sirf 30 minute ki doori par hain. Request par airport pickup aur luxury car transfer uplabdh hai. Kya main booking details share karoon?`
      : `We are located in Banjara Hills, just 30 minutes from the airport, and provide luxury airport pickup and drop for 1200 Rupees on request. Would you like me to reserve your stay?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired airport transfer" }, sessionContext).catch(() => {});
  } else if (isLocationQuery) {
    reply = isHindi
      ? `${hotel.hotel_name || "Vivaant Retreat"}, ${hotel.location || "Banjara Hills, Hyderabad"} mein sthit hai, jo airport se sirf 30 minute ki doori par hai. Hamare Deluxe room ka kiraya ${deluxeRate} Rupees plus taxes hai. Kya main booking link bhej doon?`
      : `${hotel.hotel_name || "Vivaant Retreat"} is located in ${hotel.location || "Banjara Hills, Hyderabad"}, just 30 minutes from the airport. Our Deluxe rooms start at Rupees ${deluxeRate} plus taxes per night. Would you like me to send you the booking link?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired hotel location" }, sessionContext).catch(() => {});
  } else if (isTariffQuery || lastUserMsg.includes("offer") || lastUserMsg.includes("discount") || lastUserMsg.includes("deal") || lastUserMsg.includes("promo") || lastUserMsg.includes("package") || lastUserMsg.includes("छूट") || lastUserMsg.includes("ऑफर")) {
    if (activeCustomScript && (lastUserMsg.includes("offer") || lastUserMsg.includes("discount") || lastUserMsg.includes("deal") || lastUserMsg.includes("promo") || lastUserMsg.includes("package") || activeCustomScript.toLowerCase().includes("discount") || activeCustomScript.toLowerCase().includes("offer"))) {
      reply = isHindi
        ? `${activeCustomScript} Kya main aapke WhatsApp par direct booking link bhej doon?`
        : `${activeCustomScript} Would you like me to send you the direct booking link?`;
    } else if (lastUserMsg.includes("presidential") || lastUserMsg.includes("प्रेसिडेंशियल")) {
      reply = isHindi
        ? `Presidential Suite ${presRate} Rupees plus taxes hai. Kya booking link bhej doon?`
        : `Our Presidential Suite is ${presRate} Rupees plus taxes per night. Shall I send the booking link?`;
    } else if (lastUserMsg.includes("executive") || (lastUserMsg.includes("suite") && !lastUserMsg.includes("deluxe")) || lastUserMsg.includes("सूट")) {
      reply = isHindi
        ? `Executive Suite ${execRate} Rupees plus taxes hai breakfast ke saath. Kya booking link bhej doon?`
        : `Our Executive Suite is ${execRate} Rupees plus taxes with breakfast. Shall I send the booking link?`;
    } else if (lastUserMsg.includes("deluxe") || lastUserMsg.includes("डीलक्स")) {
      reply = isHindi
        ? `Deluxe room ${deluxeRate} Rupees plus taxes hai. Kya booking link bhej doon?`
        : `Our Deluxe room is ${deluxeRate} Rupees plus taxes per night. Shall I send the booking link?`;
    } else {
      if (activeCustomScript && activeCustomScript.length > 15) {
        reply = isHindi
          ? `${activeCustomScript} Kya main aapke WhatsApp par booking link share kar doon?`
          : `${activeCustomScript} Shall I send you the direct booking link on WhatsApp?`;
      } else {
        reply = isHindi
          ? `Deluxe room ${deluxeRate} Rupees aur Executive Suite ${execRate} plus taxes hai. Kya booking link bhej doon?`
          : `Deluxe room is ${deluxeRate} Rupees and Executive Suite is ${execRate} plus taxes. Shall I send the booking link?`;
      }
    }
    toolCallsExecuted.push("check_room_availability");
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired room tariffs" }, sessionContext).catch(() => {});
  } else if (isAmenities) {
    reply = isHindi
      ? `Hotel mein rooftop infinity pool, luxury spa, 24-hour dining aur complimentary Wi-Fi uplabdh hai. Deluxe room ${deluxeRate} Rupees se start hain. Kya main booking link bhej doon?`
      : `We offer a rooftop infinity pool, luxury spa, 24-hour dining, and complimentary Wi-Fi. Deluxe rooms start at Rupees ${deluxeRate}. Shall I send the booking link?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired hotel amenities" }, sessionContext).catch(() => {});
  } else if (isCorporateOrEvent) {
    reply = isHindi
      ? `Hamare paas 50 se 300 guests ke liye 2 luxury banquet halls available hain. Kya main aapke WhatsApp par details bhej doon?`
      : `We have 2 luxury banquet halls accommodating 50 to 300 guests. Would you like me to send the details to your WhatsApp?`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Inquired conference and banquet halls" }, sessionContext).catch(() => {});
  } else if (isDetailsOrEmail) {
    reply = isHindi
      ? `Zaroor! Hamare Deluxe room ${deluxeRate} Rupees aur Executive Suite ${execRate} Rupees hain. Hum aapke WhatsApp par room tariff brochure aur reservation link turant share kar rahe hain.`
      : `Certainly! Our Deluxe rooms are Rupees ${deluxeRate} and Executive Suite is ${execRate} plus taxes. We would be delighted to send the complete brochure and reservation link directly to your WhatsApp.`;
    executeTool("log_guest_interest", { interest_level: "warm", intent: "Requested details / brochure" }, sessionContext).catch(() => {});
  } else if (lastUserMsg.includes("check in") || lastUserMsg.includes("check out") || lastUserMsg.includes("checkin") || lastUserMsg.includes("checkout") || lastUserMsg.includes("timing") || lastUserMsg.includes("time") || lastUserMsg.includes("samay") || lastUserMsg.includes("समय") || lastUserMsg.includes("टाइमिंग")) {
    reply = isHindi
      ? `Hotel mein check-in time dopahar ${hotel.check_in_time || "2:00 PM"} aur check-out subah ${hotel.check_out_time || "11:00 AM"} hai. Early check-in bhi arrange ho sakta hai. Kya main aapka room reserve kar doon?`
      : `Our check-in is at ${hotel.check_in_time || "2:00 PM"} and check-out is at ${hotel.check_out_time || "11:00 AM"}. Early check-in is available on request. Would you like me to send you the reservation link?`;
  } else if (isExitStatement) {
    isFinal = true;
    reply = isHindi
      ? `Aapse baat karke bahut khushi hui! ${hotel.hotel_name || "Vivaant Retreat"} mein aapka swagat karne ke liye hum utsuk hain. Aapka din shubh ho aur namaste!`
      : `It was an absolute pleasure assisting you! We look forward to welcoming you to ${hotel.hotel_name || "Vivaant Retreat"}. Have a wonderful day and goodbye!`;
    executeTool("log_guest_interest", { interest_level: "completed", intent: "Guest completed call" }, sessionContext).catch(() => {});
  } else if (isThankYou) {
    isFinal = false;
    reply = isHindi
      ? `Aapka bahut-bahut swagat hai! Kya main aapke liye kisi aur cheez mein sahayata kar sakti hoon?`
      : `You are most welcome! Is there anything else I can do for you today?`;
  } else if (isGreeting) {
    if (activeCustomGreeting && activeCustomGreeting.length > 5) {
      reply = activeCustomGreeting;
    } else if (userMsgCount <= 1) {
      reply = isHindi
        ? `Namaste ji! Main ${hotel.hotel_name || "Vivaant Retreat"} se Aayla baat kar rahi hoon. Hamare Deluxe room ${deluxeRate} Rupees aur Executive Suite ${execRate} Rupees se shuru hote hain. Aaj main aapki room booking mein kaise sahayata kar sakti hoon?`
        : `Hello! I am Aayla from ${hotel.hotel_name || "Vivaant Retreat"}. Our Deluxe rooms start at Rupees ${deluxeRate} and Executive Suite at ${execRate} plus taxes per night. How may I assist your stay or room reservation today?`;
    } else {
      reply = isHindi
        ? `Ji, main sun rahi hoon! Hamare Deluxe room ${deluxeRate} Rupees aur Executive Suite ${execRate} Rupees se shuru hote hain. Kya main aapke WhatsApp par booking link share kar doon?`
        : `Yes, I am right here with you! Our Deluxe rooms start at Rupees ${deluxeRate} and Executive Suite at ${execRate} plus taxes per night. Would you like me to send you the booking link on WhatsApp?`;
    }
  } else if (lastUserMsg === "help options") {
    reply = isHindi
      ? `Main sun rahi hoon ji! Kya aap room rates, breakfast, pet policy ya cancellation details ke baare mein jaanna chahte hain?`
      : `I am right here with you! Would you like to know about our room rates, breakfast and dining, pet policy, or cancellation details?`;
  } else {
    if (activeCustomScript && activeCustomScript.length > 20) {
      reply = isHindi
        ? `${activeCustomScript} Kya main aapke WhatsApp par booking link bhej doon?`
        : `${activeCustomScript} Would you like me to send you the booking link on WhatsApp?`;
    } else {
      reply = isHindi
        ? `Main sun rahi hoon ji! Hamare Deluxe room ka kiraya ${deluxeRate} Rupees aur Executive Suite ka ${execRate} Rupees plus taxes per night hai. Kya main aapke WhatsApp par direct booking link bhej doon?`
        : `I am right here with you! Our Deluxe rooms start at Rupees ${deluxeRate} and Executive Suite at ${execRate} plus taxes per night. Would you like me to send you the booking link on WhatsApp?`;
    }
  }

  // Calculate Lead Quality & Intent classification based on query & dialogue context
  let leadStatus = "warm";
  let leadIntent = "General Inquiry";
  let leadScore = 50;

  if (isAffirmativeYes && !isBookingLinkRequest && !isTariffQuery && !isLanguageSwitchToHindi) {
    leadStatus = "hot";
    leadIntent = "Confirmed Reservation Interest (Said YES / HAAN)";
    leadScore = 95;
  } else if (isNegativeNo && !isBookingLinkRequest && !isTariffQuery && !isLanguageSwitchToHindi) {
    leadStatus = "cold";
    leadIntent = "Declined Reservation (Said NO / NAHI)";
    leadScore = 20;
  } else if (wantsHindi || isLanguageSwitchToHindi) {
    leadStatus = "warm";
    leadIntent = "Customer Requested Hindi Language";
    leadScore = 60;
  } else if (isBookingLinkRequest) {
    leadStatus = "hot";
    leadIntent = "Requested Booking / Payment Link";
    leadScore = 95;
  } else if (isTariffQuery) {
    leadStatus = "warm";
    leadIntent = "Inquired Room Tariffs";
    leadScore = 75;
  } else if (isCorporateOrEvent) {
    leadStatus = "warm";
    leadIntent = "Inquired Corporate / Banquet";
    leadScore = 80;
  } else if (isAmenities || isBreakfastQuery || isPoolQuery || isSpaGymQuery || isDiningFoodQuery) {
    leadStatus = "warm";
    leadIntent = "Inquired Hotel Amenities";
    leadScore = 65;
  } else if (isCancellationQuery || isPetQuery || isAirportQuery || isLocationQuery || isDetailsOrEmail) {
    leadStatus = "warm";
    leadIntent = "Inquired Hotel Policies / Location";
    leadScore = 60;
  } else if (isExitStatement || lastUserMsg.includes("not interested") || lastUserMsg.includes("wrong number") || lastUserMsg.includes("nahi chahiye")) {
    leadStatus = "cold";
    leadIntent = "Not Interested / Call Ended";
    leadScore = 15;
  } else if (isThankYou) {
    const userHistoryText = messages.filter(m => m.role === "user").map(m => m.content.toLowerCase()).join(" ");
    if (userHistoryText.includes("link") || userHistoryText.includes("book") || userHistoryText.includes("whatsapp") || userHistoryText.includes("send")) {
      leadStatus = "hot";
      leadIntent = "Booking Link Dispatched / Confirmed";
      leadScore = 95;
    } else {
      leadStatus = "warm";
      leadIntent = "Inquiry Completed";
      leadScore = 65;
    }
  }

  // Asynchronously update Firebase RTDB with lead classification if callId is active
  if (sessionContext?.callId) {
    update(ref(db, `calls/${sessionContext.callId}`), {
      lead_status: leadStatus,
      intent: leadIntent,
      lead_score: leadScore,
      updated_at: Date.now()
    }).catch(() => {});
  }

  return { 
    reply, 
    toolCallsExecuted, 
    holdIntro, 
    hasHoldJingle, 
    isFinal, 
    leadStatus, 
    intent: leadIntent, 
    score: leadScore,
    language: activeLanguage 
  };
}
