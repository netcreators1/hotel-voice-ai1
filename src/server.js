import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import cron from "node-cron";
import dotenv from "dotenv";

import path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.resolve(__dirname, "../public");

import telephonyRoutes from "./routes/telephonyRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import { generateDailyReport } from "./reports/eodReport.js";
import { getHotelKnowledge } from "./models/hotelKnowledge.js";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

const PORT = process.env.PORT || 5050;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicPath));

// Serve API Routes
app.use("/api/telephony", telephonyRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/pay", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    telephony_provider: process.env.TELEPHONY_PROVIDER || "vobiz",
    public_url: process.env.PUBLIC_URL,
    timestamp: new Date().toISOString()
  });
});

// Cloud Keep-Alive Heartbeat: Pings public endpoint every 3 minutes to keep Fly.io machine permanently warm
const KEEP_ALIVE_URL = process.env.PUBLIC_URL || "https://hotel-voice-ai.fly.dev";
setInterval(() => {
  fetch(`${KEEP_ALIVE_URL}/health`).catch(() => {});
}, 180000);

// Interactive Web Control Console with Campaigns, Knowledge Base & EOD Reports
app.get("/", async (req, res) => {
  const hotel = await getHotelKnowledge();
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Vivaant Retreat - Autonomous Voice AI Hub</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <style>
      body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; overflow-x: hidden; }
      .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; }
      .nav-tabs {
        display: flex;
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        border-bottom: 2px solid #334155;
        padding-bottom: 4px;
        scrollbar-width: thin;
      }
      .nav-tabs::-webkit-scrollbar { height: 4px; }
      .nav-tabs::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .nav-tabs .nav-item { flex: 0 0 auto; }
      .nav-tabs .nav-link { color: #94a3b8; border: none; font-weight: 600; padding: 10px 18px; white-space: nowrap; border-radius: 8px; margin-right: 4px; }
      .nav-tabs .nav-link.active { background: #1e293b; color: #38bdf8; border-bottom: 3px solid #38bdf8; }
      .chat-box { height: 320px; overflow-y: auto; background: #0b1329; border: 1px solid #334155; border-radius: 8px; padding: 12px; }
      .chat-msg { margin-bottom: 8px; padding: 8px 12px; border-radius: 8px; font-size: 14px; word-break: break-word; }
      .msg-agent { background: #1e3a8a; color: #93c5fd; margin-right: 20px; }
      .msg-user { background: #065f46; color: #a7f3d0; margin-left: 20px; text-align: right; }
      .msg-hold { background: #372b0f; color: #fde047; border: 1px dashed #ca8a04; margin: 8px 15px; border-radius: 8px; text-align: center; font-weight: 500; }
      pre { background: #0b1329; color: #38bdf8; padding: 12px; border-radius: 8px; max-height: 350px; overflow-x: auto; }
      .form-control, .form-select { background: #0b1329; color: #f8fafc; border-color: #334155; font-size: 15px; }
      .form-control:focus, .form-select:focus { background: #0b1329; color: #fff; border-color: #38bdf8; box-shadow: none; }
      .dropzone-hover { border-color: #38bdf8 !important; background: #172554 !important; }
      @media (max-width: 768px) {
        .container { padding-left: 12px; padding-right: 12px; }
        .card { padding: 16px !important; }
        .chat-box { height: 280px; }
        .msg-agent { margin-right: 8px; }
        .msg-user { margin-left: 8px; }
        .btn { padding: 9px 14px; }
        .quick-buttons { flex-wrap: wrap; }
      }
    </style>
  </head>
  <body class="py-4">
    <!-- Authentication Login Screen Overlay -->
    <div id="loginOverlay" class="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center" style="background: rgba(11, 19, 41, 0.97); z-index: 9999; backdrop-filter: blur(10px);">
      <div class="card p-4 shadow-lg border border-info border-opacity-50" style="max-width: 440px; width: 92%; background: #0f172a; border-radius: 16px;">
        <div class="text-center mb-4">
          <div class="fs-1 mb-2">🏨</div>
          <h3 class="text-white fw-bold mb-1">${hotel.hotel_name || "Vivaant Retreat"}</h3>
          <p class="text-secondary small mb-0">Autonomous Voice AI Operations & Calling Portal</p>
          <div class="badge bg-dark border border-secondary text-info mt-2 px-3 py-1">Authorized Operations Only</div>
        </div>

        <form id="loginForm" onsubmit="event.preventDefault(); submitLogin();">
          <div class="mb-3">
            <label class="form-label text-secondary small fw-semibold">Username / उपयोगकर्ता</label>
            <div class="input-group">
              <span class="input-group-text bg-dark border-secondary text-secondary">👤</span>
              <input type="text" id="loginUsername" class="form-control" placeholder="Enter username (admin or agent)" required autocomplete="username">
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label text-secondary small fw-semibold">Password / पासवर्ड</label>
            <div class="input-group">
              <span class="input-group-text bg-dark border-secondary text-secondary">🔑</span>
              <input type="password" id="loginPassword" class="form-control" placeholder="Enter password" required autocomplete="current-password">
            </div>
          </div>

          <div id="loginError" class="alert alert-danger py-2 small mb-3 d-none"></div>

          <button type="submit" id="loginSubmitBtn" class="btn btn-primary w-100 fw-bold py-2 mb-3">
            <span>Sign In to Portal</span>
          </button>

          <div class="p-2 px-3 rounded bg-dark border border-secondary border-opacity-50 small text-secondary" style="font-size: 11.5px;">
            <div class="fw-semibold text-info mb-1">Role Permissions:</div>
            <div>🛡️ <strong>Admin:</strong> Full access with rights to add/approve calling credits.</div>
            <div>👤 <strong>Agent:</strong> Telecalling dialer, live simulator & CDR view (Recharge restricted).</div>
          </div>
        </form>
      </div>
    </div>

    <div class="container">
      <!-- Header -->
      <div class="d-flex flex-column flex-md-row justify-content-between align-items-start align-items-md-center mb-4 pb-3 border-bottom border-secondary gap-3">
        <div>
          <h2 class="mb-1 text-white fs-3 fs-md-2">🏨 ${hotel.hotel_name || "Vivaant Retreat"}</h2>
          <span class="text-secondary small">Autonomous Hotel Voice AI Hub • Multiple Agentic AI Personas • Campaigns • Firebase RTDB</span>
        </div>
        <div class="d-flex flex-wrap align-items-center gap-2">
          <!-- Client Calling Credits & Recharge Pill -->
          <div class="d-flex align-items-center p-2 px-3 rounded border border-info border-opacity-50 gap-3" style="background: #0b1329;">
            <div>
              <div class="text-secondary small fw-semibold" style="font-size: 11px; letter-spacing: 0.5px;">CALLING CREDITS (₹11/CALL)</div>
              <div class="fs-5 fw-bold text-success mb-0 lh-1">
                <span id="headerWalletBalance">₹550.00</span>
                <span class="fs-6 text-white fw-normal ms-1">(<span id="headerCreditsLeft" class="text-warning fw-bold">50</span> calls left)</span>
              </div>
            </div>
            <button class="btn btn-sm btn-outline-success fw-bold px-2 py-1" id="headerRechargeBtn" onclick="switchToRecharge()" title="Add Client Recharge">⚡ + Recharge</button>
          </div>

          <!-- Active User Role Badge & Logout Button -->
          <div class="d-flex align-items-center gap-2">
            <span id="userRoleBadge" class="badge bg-danger p-2 px-3 fw-bold d-inline-flex align-items-center gap-1">
              <span>🛡️</span> <span id="userRoleText">Admin</span>
            </span>
            <button class="btn btn-sm btn-outline-danger py-1 px-2 fw-semibold" onclick="logout()" title="Sign out of portal">🚪 Logout</button>
          </div>
        </div>
      </div>

      <!-- Navigation Tabs (Mobile Horizontally Scrollable) -->
      <ul class="nav nav-tabs mb-4" id="mainTabs" role="tablist">
        <li class="nav-item">
          <button class="nav-link active" id="dialer-tab" data-bs-toggle="tab" data-bs-target="#dialer" type="button">📞 Live Dialer & Chat</button>
        </li>
        <li class="nav-item">
          <button class="nav-link" id="cdr-tab" data-bs-toggle="tab" data-bs-target="#cdr" type="button" onclick="loadCDRReport(11)">📑 CDR & Billing (₹11/call)</button>
        </li>
        <li class="nav-item">
          <button class="nav-link" id="campaigns-tab" data-bs-toggle="tab" data-bs-target="#campaigns" type="button" onclick="loadQueue()">📢 Campaigns & Bulk Upload</button>
        </li>
        <li class="nav-item">
          <button class="nav-link" id="kb-tab" data-bs-toggle="tab" data-bs-target="#kb" type="button" onclick="loadKnowledgeBase()">🧠 Knowledge Base & Tariffs</button>
        </li>
        <li class="nav-item">
          <button class="nav-link" id="reports-tab" data-bs-toggle="tab" data-bs-target="#reports" type="button">📊 EOD Reports</button>
        </li>
      </ul>

      <!-- Tab Content -->
      <div class="tab-content" id="mainTabContent">
        
        <!-- TAB 1: Live Dialer & Simulator -->
        <div class="tab-pane fade show active" id="dialer">
          <div class="row g-4">
            <div class="col-lg-5">
              <div class="card p-4 shadow">
                <h5 class="text-info mb-3">📞 Outbound Phone Call</h5>
                <p class="text-secondary small">Triggers a real phone call to the recipient using ${process.env.TELEPHONY_PROVIDER || "Vobiz"}.</p>
                <div class="mb-3">
                  <label class="form-label text-secondary fw-semibold">🤖 Select AI Telecaller Agent</label>
                  <select id="dialAgentPersona" class="form-select" onchange="syncAgentPersona(this.value)">
                    <option value="aayla" selected>👩‍💼 Aayla — Reservation Specialist (Energetic Voice - Polly.Aditi)</option>
                    <option value="kabir">👨‍💼 Kabir — Corporate & Banquet Concierge (MICE & Events)</option>
                    <option value="rhea">👩‍💼 Rhea — VIP Guest Relations (Dining, Spa & Transfers)</option>
                    <option value="vikram">👨‍💼 Vikram — Promotions Specialist (Deals & Offers)</option>
                  </select>
                  <div class="small text-info mt-1" id="agentPersonaDesc">Specializes in room tariffs, suite availability, and instant booking payment links.</div>
                </div>
                <div class="mb-3">
                  <label class="form-label text-secondary fw-semibold">🌐 Call Language / भाषा</label>
                  <select id="dialLanguage" class="form-select" onchange="syncLanguage(this.value)">
                    <option value="en" selected>English (Indian - Polly.Aditi Lively Cadence)</option>
                    <option value="hi">हिंदी - Hindi (Polly.Aditi Energetic Cadence)</option>
                  </select>
                  <div class="small text-muted mt-1">Amazon Polly Aditi bilingual voice with energetic Indian cadence and natural conversational flow.</div>
                </div>
                <div class="mb-3">
                  <div class="d-flex justify-content-between align-items-center mb-1">
                    <label class="form-label text-secondary fw-semibold mb-0">🎵 Hotel Signature Hold Chime</label>
                    <span class="badge bg-warning text-dark">Luxury Jingle</span>
                  </div>
                  <button type="button" class="btn btn-sm btn-outline-warning w-100 py-2 d-flex align-items-center justify-content-center gap-2" onclick="previewHotelJingle()">
                    <span>▶️</span> <span>Play Hotel Concierge Hold Jingle (4s)</span>
                  </button>
                  <audio id="hotelJinglePlayer" src="/audio/hotel_jingle.wav" preload="auto"></audio>
                </div>
                <div class="mb-3">
                  <label class="form-label text-secondary">Guest Phone Number</label>
                  <input type="text" id="dialPhone" class="form-control" value="+919167584555">
                </div>
                <div class="mb-3">
                  <label class="form-label text-secondary">Guest Name</label>
                  <input type="text" id="dialName" class="form-control" value="Mr. Avinash" placeholder="e.g. Mr. Avinash">
                </div>
                <button class="btn btn-primary w-100 fw-bold py-2" id="placeCallBtn" onclick="triggerCall()">📞 Place Live AI Call</button>
                <div class="d-flex justify-content-between align-items-center mt-2 small text-secondary">
                  <span>Rate: <strong class="text-info">₹11.00 / call</strong></span>
                  <span>Credits: <strong id="dialerCreditsLeft" class="text-warning">50 calls</strong> (<span id="dialerBalance">₹550.00</span>)</span>
                </div>
                <div id="callStatus" class="mt-2 text-warning small"></div>
              </div>
            </div>

            <div class="col-lg-7">
              <div class="card p-4 shadow h-100">
                <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
                  <div class="d-flex align-items-center gap-2">
                    <h5 class="text-success mb-0">🎙️ Live Agent Simulation</h5>
                    <span class="badge bg-primary" id="simAgentBadge">Agent: Aayla</span>
                    <span class="badge bg-secondary" id="simLangBadge">Lang: EN</span>
                  </div>
                  <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-outline-info d-flex align-items-center gap-1" type="button" data-bs-toggle="collapse" data-bs-target="#scriptCustomizerCollapse" aria-expanded="true">
                      <span>✏️</span> <span>Edit Live Agent Script</span>
                    </button>
                    <button class="btn btn-sm btn-outline-secondary" onclick="resetChat()">Clear</button>
                  </div>
                </div>

                <!-- Prominent Client Script & Greeting Customizer -->
                <div class="collapse show mb-3" id="scriptCustomizerCollapse">
                  <div class="p-3 rounded" style="background: #0b1329; border: 1px solid #38bdf8;">
                    <div class="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
                      <div class="fw-bold text-info small">📝 Customize Live Agent Script & Pitch</div>
                      <div class="d-flex align-items-center gap-1">
                        <label class="small text-secondary mb-0">Preset:</label>
                        <select id="scriptPresetSelect" class="form-select form-select-sm py-0" style="font-size: 12px; width: auto;" onchange="applyScriptPreset(this.value)">
                          <option value="standard">Standard Hospitality (Vivaant Retreat)</option>
                          <option value="discount">Weekend 20% Special Discount Offer</option>
                          <option value="corporate">Corporate Conference & Banquet</option>
                          <option value="custom">Custom Client Script</option>
                        </select>
                      </div>
                    </div>

                    <div class="mb-2">
                      <label class="form-label text-secondary small mb-1 fw-semibold">Agent Opening Greeting (What agent says first)</label>
                      <input type="text" id="customGreetingInput" class="form-control form-control-sm" placeholder="e.g. Namaste! I am Aayla from Vivaant Retreat. How may I assist your booking today?">
                    </div>

                    <div class="mb-2">
                      <label class="form-label text-secondary small mb-1 fw-semibold">Pitch Guidelines & Script Rules (Special offers, pricing, terms)</label>
                      <textarea id="customScriptInput" class="form-control form-control-sm" rows="3" placeholder="Enter special packages, discounts, check-in instructions, or custom rules to follow..."></textarea>
                    </div>

                    <div class="d-flex justify-content-between align-items-center">
                      <div class="d-flex gap-2">
                        <button type="button" class="btn btn-sm btn-success fw-bold px-3" onclick="saveAgentScript()">💾 Apply & Save Script</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="resetAgentScriptToDefault()">🔄 Reset Default</button>
                      </div>
                      <span id="scriptSaveFeedback" class="small text-success fw-semibold"></span>
                    </div>
                  </div>
                </div>

                <!-- Real-Time Lead Quality & Classification Banner -->
                <div class="d-flex flex-wrap justify-content-between align-items-center p-2 mb-2 rounded" id="liveLeadBanner" style="background: #0b1329; border: 1px solid #334155;">
                  <div class="d-flex align-items-center gap-2">
                    <span class="text-secondary small fw-semibold">Lead Classification:</span>
                    <span id="liveLeadBadge" class="badge bg-secondary">Pending Query</span>
                  </div>
                  <div class="small d-flex align-items-center gap-2">
                    <span class="text-secondary">Intent:</span> <span id="liveLeadIntent" class="text-info fw-semibold">Awaiting input</span>
                    <span class="text-secondary">| Score:</span> <span id="liveLeadScore" class="text-warning fw-bold">--</span>
                  </div>
                </div>

                <div id="chatBox" class="chat-box mb-3">
                  <div class="chat-msg msg-agent"><strong>Aayla (AI):</strong> Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES</div>
                </div>
                <div class="input-group">
                  <input type="text" id="userQuery" class="form-control" placeholder="Ask questions (e.g. 'What are Deluxe room rates?', 'डीलक्स रूम का किराया कितना है?')..." onkeypress="if(event.key === 'Enter') sendQuery()">
                  <button class="btn btn-success fw-bold px-4" onclick="sendQuery()">Send</button>
                </div>
                <div class="mt-2 d-flex flex-wrap gap-2 quick-buttons" id="quickButtonsContainer">
                  <button class="btn btn-sm btn-outline-info" onclick="quickQuery('What are the room tariffs?')">Rates Inquiry</button>
                  <button class="btn btn-sm btn-outline-info" onclick="quickQuery('Do you have pool and breakfast?')">Amenities</button>
                  <button class="btn btn-sm btn-outline-info" onclick="quickQuery('Can we host a 50-person corporate conference?')">Corporate / Banquet</button>
                  <button class="btn btn-sm btn-outline-warning" onclick="quickQuery('Yes, book 1 Deluxe room and send payment link')">Book & Send Payment Link</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: Campaigns & Bulk Upload -->
        <div class="tab-pane fade" id="campaigns">
          <div class="row g-4">
            <div class="col-md-6">
              <div class="card p-4 shadow">
                <h5 class="text-info mb-3">📁 Upload Contact List (CSV / Text)</h5>
                <p class="text-secondary small">Upload a list of guests to dial sequentially for promotions or inquiries.</p>
                <div class="mb-3">
                  <label class="form-label text-secondary fw-semibold">🤖 Campaign Telecaller Agent</label>
                  <select id="campaignPersona" class="form-select">
                    <option value="aayla" selected>👩‍💼 Aayla — Reservation Specialist (Energetic Voice - Polly.Aditi)</option>
                    <option value="vikram">👨‍💼 Vikram — Promotions Specialist (Deals & Offers)</option>
                    <option value="kabir">👨‍💼 Kabir — Corporate & Banquet Concierge (MICE & Events)</option>
                    <option value="rhea">👩‍💼 Rhea — VIP Guest Relations (Dining & Spa)</option>
                  </select>
                </div>
                <div class="mb-3">
                  <label class="form-label text-secondary fw-semibold">🌐 Campaign Language / भाषा</label>
                  <select id="campaignLanguage" class="form-select">
                    <option value="en" selected>English (Indian - Polly.Aditi)</option>
                    <option value="hi">हिंदी - Hindi (Polly.Aditi)</option>
                  </select>
                </div>
                <div class="mb-3">
                  <label class="form-label text-secondary">Campaign Name</label>
                  <input type="text" id="campaignName" class="form-control" value="Vivaant_Weekend_Promo">
                </div>

                <!-- Mode Selector: CSV File vs Manual Paste -->
                <div class="mb-3">
                  <div class="btn-group w-100 mb-3" role="group">
                    <input type="radio" class="btn-check" name="uploadMode" id="modeCsv" autocomplete="off" checked onchange="toggleUploadMode('csv')">
                    <label class="btn btn-outline-info" for="modeCsv">📄 Upload CSV File</label>

                    <input type="radio" class="btn-check" name="uploadMode" id="modeManual" autocomplete="off" onchange="toggleUploadMode('manual')">
                    <label class="btn btn-outline-info" for="modeManual">✍️ Paste Text Manually</label>
                  </div>

                  <!-- CSV File Upload Section -->
                  <div id="csvUploadSection">
                    <div class="p-3 border border-2 border-dashed border-secondary rounded text-center mb-3" id="dropZone" style="background: #0b1329; cursor: pointer;" onclick="document.getElementById('csvFileInput').click()">
                      <div class="fs-2 text-info mb-1">📁</div>
                      <div class="fw-semibold text-white mb-1">Drag & Drop CSV File here or Click to Browse</div>
                      <div class="text-secondary small mb-2">Columns: Name, Phone (or Mobile), Room_Preference, Notes</div>
                      <input type="file" id="csvFileInput" class="d-none" accept=".csv,text/csv" onchange="handleCsvFile(this.files[0])">
                      <div class="d-flex justify-content-center gap-2">
                        <button type="button" class="btn btn-sm btn-primary px-3" onclick="event.stopPropagation(); document.getElementById('csvFileInput').click()">Browse CSV File</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="event.stopPropagation(); downloadSampleCsv()">📥 Sample Template</button>
                      </div>
                    </div>

                    <!-- CSV Parsed Preview Section -->
                    <div id="csvPreviewSection" class="d-none mb-3">
                      <div class="d-flex justify-content-between align-items-center mb-2">
                        <span class="small text-secondary">Parsed <strong id="csvTotalCount" class="text-white">0</strong> contacts (<span id="csvValidCount" class="text-success fw-bold">0 valid</span>)</span>
                        <button class="btn btn-sm btn-outline-danger py-0" onclick="clearCsvUpload()">Clear CSV</button>
                      </div>
                      <div class="table-responsive" style="max-height: 180px; overflow-y: auto;">
                        <table class="table table-dark table-sm table-bordered small mb-0">
                          <thead>
                            <tr class="text-info"><th>#</th><th>Name</th><th>Phone</th><th>Status</th></tr>
                          </thead>
                          <tbody id="csvPreviewBody"></tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <!-- Manual Paste Section -->
                  <div id="manualPasteSection" class="d-none">
                    <label class="form-label text-secondary small mb-1">Paste Contacts (One per line: Name, Phone)</label>
                    <textarea id="bulkContactsText" class="form-control" rows="4" placeholder="Rohan Sharma, +919811122334&#10;Pooja Hegde, +919822233445&#10;Vikram Malhotra, +919833344556"></textarea>
                  </div>
                </div>

                <button class="btn btn-info w-100 fw-bold py-2" id="queueSubmitBtn" onclick="uploadBulkContacts()">Queue Contacts in Firebase RTDB</button>
                <div id="uploadStatus" class="mt-2 text-success small"></div>
              </div>
            </div>

            <div class="col-md-6">
              <div class="card p-4 shadow">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h5 class="text-warning mb-0">📋 Outbound Calling Queue</h5>
                  <button class="btn btn-sm btn-outline-secondary" onclick="loadQueue()">🔄 Refresh</button>
                </div>
                <div id="queueList" style="max-height: 230px; overflow-y: auto;" class="mb-3">
                  <div class="text-secondary small">Loading queue...</div>
                </div>

                <!-- Concurrency / Multi-Agent Dialing Selector -->
                <div class="p-3 mb-3 rounded" style="background: #0b132b; border: 1px solid #1e293b;">
                  <div class="d-flex justify-content-between align-items-center mb-1">
                    <label class="form-label text-warning fw-bold mb-0">⚡ Concurrent Dialing Agents</label>
                    <span class="badge bg-secondary px-2 py-1" id="concurrencyBadge">1 Agent (Sequential)</span>
                  </div>
                  <p class="text-secondary small mb-2">Select how many AI agents will dial simultaneously once the bulk contacts are queued.</p>
                  <select id="campaignConcurrency" class="form-select bg-dark text-white border-warning mb-2" onchange="updateConcurrencyBadge(this.value)">
                    <option value="1" selected>1 Agent — Sequential (1 call at a time, safe pacing)</option>
                    <option value="2">2 Agents — Parallel (2 calls simultaneously · 2x speed)</option>
                    <option value="3">3 Agents — Parallel (3 calls simultaneously · 3x speed)</option>
                    <option value="5">5 Agents — Parallel (5 calls simultaneously · 5x speed)</option>
                    <option value="10">10 Agents — High Speed (10 calls simultaneously · 10x speed)</option>
                  </select>
                  <div class="small text-secondary">
                    💡 <span class="text-white">Included:</span> Standard virtual line (+918064260572) supports 1–5 parallel channels at no extra software cost.
                  </div>
                </div>

                <div class="d-flex gap-2">
                  <button class="btn btn-warning flex-grow-1 fw-bold py-2" id="startCampaignBtn" onclick="runCampaign()">🚀 Run Automated Outbound Campaign</button>
                  <button class="btn btn-outline-danger fw-bold py-2 px-3 d-none" id="stopCampaignBtn" onclick="stopCampaign()">⏹️ Stop</button>
                </div>
                <div id="runStatus" class="mt-2 text-info small"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 3: Knowledge Base & Tariffs -->
        <div class="tab-pane fade" id="kb">
          <div class="card p-4 shadow">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h5 class="text-primary mb-0">🧠 Hotel Knowledge Base & Agent Memory</h5>
              <button class="btn btn-success fw-bold" onclick="saveKnowledgeBase()">Save Knowledge Base</button>
            </div>
            <p class="text-secondary small">The AI Voice Agent uses this exact live knowledge base to answer guest queries in real time.</p>
            
            <div class="row g-3">
              <div class="col-md-4">
                <label class="form-label text-secondary">Hotel Name</label>
                <input type="text" id="kbHotelName" class="form-control">
              </div>
              <div class="col-md-4">
                <label class="form-label text-secondary">Location</label>
                <input type="text" id="kbLocation" class="form-control">
              </div>
              <div class="col-md-4">
                <label class="form-label text-secondary">Check-in / Check-out</label>
                <div class="input-group">
                  <input type="text" id="kbCheckIn" class="form-control" placeholder="14:00">
                  <input type="text" id="kbCheckOut" class="form-control" placeholder="11:00">
                </div>
              </div>

              <div class="col-md-4">
                <label class="form-label text-secondary">Deluxe Room Rate (₹)</label>
                <input type="number" id="kbDeluxeRate" class="form-control">
              </div>
              <div class="col-md-4">
                <label class="form-label text-secondary">Executive Suite Rate (₹)</label>
                <input type="number" id="kbSuiteRate" class="form-control">
              </div>
              <div class="col-md-4">
                <label class="form-label text-secondary">Presidential Suite Rate (₹)</label>
                <input type="number" id="kbPresRate" class="form-control">
              </div>

              <div class="col-12">
                <label class="form-label text-secondary">Cancellation Policy</label>
                <input type="text" id="kbCancelPolicy" class="form-control">
              </div>

              <div class="col-12">
                <label class="form-label text-secondary">Amenities (Comma separated)</label>
                <textarea id="kbAmenities" class="form-control" rows="2"></textarea>
              </div>

              <div class="col-12">
                <label class="form-label text-secondary">Frequently Asked Questions (JSON format)</label>
                <textarea id="kbFaqs" class="form-control font-monospace" rows="4"></textarea>
              </div>
            </div>
            <div id="kbStatus" class="mt-3 text-success fw-bold"></div>
          </div>
        </div>

        <!-- TAB 4: EOD Reports -->
        <div class="tab-pane fade" id="reports">
          <div class="card p-4 shadow">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h5 class="text-warning mb-0">📈 Daily End-of-Day (EOD) Operations Report</h5>
              <button class="btn btn-warning fw-bold" onclick="generateReport()">Generate Today's Report Now</button>
            </div>
            <p class="text-secondary small">Automatically aggregated every night at ${process.env.EOD_REPORT_CRON || "9:00 PM"} and saved to Firebase RTDB (\`/daily_reports\`).</p>
            <pre id="reportPre">Click 'Generate Today\'s Report Now' to view the operational digest...</pre>
          </div>
        </div>

        <!-- TAB 5: CDR Report & Billing (Rs 11/call) -->
        <div class="tab-pane fade" id="cdr">
          <div class="card p-4 shadow mb-4">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
              <div>
                <div class="d-flex align-items-center gap-2 mb-1">
                  <h4 class="text-info mb-0">📑 Call Detail Record (CDR) & Billing Statement</h4>
                  <span class="badge bg-success bg-opacity-25 text-success border border-success border-opacity-50 small py-1 px-2 d-inline-flex align-items-center gap-1" style="font-size: 11px;">
                    <span class="spinner-grow spinner-grow-sm" style="width: 7px; height: 7px;"></span> Live Sync (3s)
                  </span>
                </div>
                <p class="text-secondary small mb-0">Live telecom call breakdown with <strong>₹11.00 / call</strong> commercial billing, customer queries, and call outcomes.</p>
              </div>
              <div class="d-flex gap-2">
                <button class="btn btn-outline-info btn-sm fw-bold" onclick="loadCDRReport(11)">🔄 Refresh CDR</button>
                <button class="btn btn-primary btn-sm fw-bold" onclick="downloadCDRCsv()">📥 Download CSV Report</button>
                <button class="btn btn-secondary btn-sm" onclick="window.print()">🖨️ Print / Save PDF</button>
              </div>
            </div>

            <!-- Client Calling Credits & Recharge Wallet Widget -->
            <div class="card p-3 mb-4 shadow" style="background: #0b1329; border: 1px solid #38bdf8;">
              <div class="row g-3 align-items-center">
                <div class="col-lg-5 col-md-6">
                  <div class="d-flex align-items-center gap-3">
                    <div class="fs-1 text-info">💳</div>
                    <div>
                      <div class="text-secondary small fw-semibold text-uppercase" style="letter-spacing: 0.5px;">Client Calling Credits Wallet</div>
                      <div class="d-flex align-items-baseline gap-2">
                        <span class="fs-3 fw-bold text-success" id="cdrWalletBalance">₹550.00</span>
                        <span class="badge bg-warning text-dark fs-6" id="cdrCreditsLeftBadge"><span id="cdrCreditsLeft">50</span> calls left</span>
                      </div>
                      <div class="text-muted small">Billing: <strong>₹11.00 per call</strong> • Automatic call cutoff when balance ends</div>
                    </div>
                  </div>
                </div>
                <!-- Admin Credit Approval & Recharge Controls (Admin Only) -->
                <div id="adminRechargeSection" class="col-lg-7 col-md-6">
                  <div class="d-flex flex-wrap align-items-center gap-2 justify-content-md-end">
                    <span class="badge bg-danger bg-opacity-25 text-danger border border-danger border-opacity-50 small py-1 px-2 fw-bold">🛡️ Admin Approver</span>
                    <span class="text-secondary small me-1">Add Credits:</span>
                    <button class="btn btn-sm btn-outline-success fw-bold" onclick="quickRecharge(550)">+ ₹550 <small>(50 calls)</small></button>
                    <button class="btn btn-sm btn-outline-success fw-bold" onclick="quickRecharge(1100)">+ ₹1,100 <small>(100 calls)</small></button>
                    <button class="btn btn-sm btn-outline-success fw-bold" onclick="quickRecharge(2200)">+ ₹2,200 <small>(200 calls)</small></button>
                    <div class="input-group input-group-sm" style="width: 195px;">
                      <span class="input-group-text bg-dark border-secondary text-secondary">₹</span>
                      <input type="number" id="customRechargeInput" class="form-control" placeholder="Amount" min="11" step="11">
                      <button class="btn btn-success fw-bold" type="button" onclick="submitCustomRecharge()">Approve</button>
                    </div>
                  </div>
                  <div id="rechargeAlert" class="small text-end mt-1 text-success fw-semibold" style="min-height: 20px;"></div>
                </div>

                <!-- Agent Locked Banner (Shown when Agent is logged in) -->
                <div id="agentLockedSection" class="col-lg-7 col-md-6 d-none">
                  <div class="p-2 px-3 rounded border border-warning border-opacity-50 text-warning small d-flex align-items-center gap-2 justify-content-md-end" style="background: rgba(234, 179, 8, 0.08);">
                    <span class="fs-5">🔒</span>
                    <div class="text-start">
                      <strong>Credit Management Restricted:</strong> Only the <strong>Admin</strong> has rights to add or approve credit limits. Contact administrator to top up.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Summary KPI Cards (Responsive 2x2 on Mobile) -->
            <div class="row g-2 g-md-3 mb-4">
              <div class="col-6 col-lg-3">
                <div class="p-3 rounded h-100" style="background: #0b1329; border: 1px solid #334155;">
                  <div class="text-secondary small">Total Calls Handled</div>
                  <div class="fs-4 fs-md-3 fw-bold text-white" id="cdrTotalCalls">0</div>
                  <div class="text-muted small" id="cdrConnectedRatio">0 connected, 0 not picked up</div>
                </div>
              </div>
              <div class="col-6 col-lg-3">
                <div class="p-3 rounded h-100" style="background: #0b1329; border: 1px solid #334155;">
                  <div class="text-secondary small">Total Talk Time</div>
                  <div class="fs-4 fs-md-3 fw-bold text-info" id="cdrTotalDuration">0s</div>
                  <div class="text-muted small" id="cdrTotalBilledMins">0 connected calls</div>
                </div>
              </div>
              <div class="col-6 col-lg-3">
                <div class="p-3 rounded h-100" style="background: #0b1329; border: 1px solid #334155;">
                  <div class="text-secondary small">Commercial Rate</div>
                  <div class="fs-4 fs-md-3 fw-bold text-warning">₹11.00 <span class="fs-6 text-muted">/ call</span></div>
                  <div class="text-muted small">Standard rate per call</div>
                </div>
              </div>
              <div class="col-6 col-lg-3">
                <div class="p-3 rounded h-100" style="background: #0b1329; border: 1px solid #38bdf8;">
                  <div class="text-secondary small">Grand Total Amount</div>
                  <div class="fs-4 fs-md-3 fw-bold text-success" id="cdrGrandTotal">₹0.00</div>
                  <div class="text-muted small">Sum of connected calls</div>
                </div>
              </div>
            </div>

            <!-- Filter & Search Input -->
            <div class="row g-2 mb-3 align-items-center">
              <div class="col-md-7">
                <div class="input-group">
                  <span class="input-group-text bg-dark border-secondary text-secondary">🔍</span>
                  <input type="text" id="cdrSearchInput" class="form-control" placeholder="Search by customer name, phone number, query, or status..." onkeyup="filterCDRTable()">
                </div>
              </div>
              <div class="col-md-3">
                <select id="cdrLeadFilter" class="form-select" onchange="filterCDRTable()">
                  <option value="">All Lead Statuses</option>
                  <option value="not picked up">Not Picked up</option>
                  <option value="hot">Hot (Ready to Book)</option>
                  <option value="warm">Warm (Rates Inquired)</option>
                  <option value="cold">Cold (Not Interested)</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
              <div class="col-md-2 text-md-end text-start">
                <span class="text-secondary small">Showing <span id="cdrFilteredCount" class="text-white fw-bold">0</span> calls</span>
              </div>
            </div>

            <!-- Detailed CDR Table -->
            <div class="table-responsive" style="max-height: 520px; overflow-y: auto; -webkit-overflow-scrolling: touch;">
              <table class="table table-dark table-hover table-bordered mb-0 align-middle" id="cdrTable" style="font-size: 13.5px; min-width: 800px;">
                <thead class="table-dark sticky-top" style="background: #1e293b; z-index: 2;">
                  <tr class="text-info">
                    <th style="width: 40px;">#</th>
                    <th>Customer Called</th>
                    <th>Date & Time (IST)</th>
                    <th>Call Duration</th>
                    <th>Rate</th>
                    <th class="text-success">Amount (₹)</th>
                    <th>Status</th>
                    <th>Lead Quality</th>
                    <th>What Customer Mentioned</th>
                    <th>AI Response / Actions</th>
                  </tr>
                </thead>
                <tbody id="cdrTableBody">
                  <tr><td colspan="10" class="text-center text-secondary py-4">Click "Refresh CDR" or select this tab to load call records...</td></tr>
                </tbody>
                <tfoot class="table-dark fw-bold sticky-bottom border-top border-info" style="background: #0b1329; z-index: 2;">
                  <tr>
                    <td colspan="3" class="text-end text-info fs-6">TOTAL AMOUNT CALCULATED:</td>
                    <td id="cdrFootDuration" class="text-white">0s</td>
                    <td class="text-muted">₹11/call</td>
                    <td id="cdrFootTotal" class="text-success fs-5">₹0.00</td>
                    <td colspan="4" class="text-secondary small">Commercial client billing at ₹11.00 per connected call</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>

      </div>

      <!-- Footer -->
      <footer class="mt-5 py-4 border-top border-secondary text-center">
        <div class="text-white fw-semibold mb-1">🏨 ${hotel.hotel_name} • Autonomous Hotel Voice AI</div>
        <div class="text-secondary small">Powered by - <span class="text-info fw-bold">Netcreators Automation</span></div>
      </footer>
    </div>

    <script>
      const PERSONAS = {
        aayla: {
          name: "Aayla",
          voice: "Polly.Aditi",
          badge: "Reservation Specialist (Lively Indian Voice)",
          desc: "Lively, energetic young Indian female voice specializing in room tariffs, suite availability, and instant booking payment links.",
          greeting_en: "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES",
          greeting_hi: "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES"
        },
        kabir: {
          name: "Kabir",
          badge: "Corporate & Banquet Concierge",
          desc: "Specializes in corporate conference bookings, MICE events, and business executive suites.",
          greeting_en: "Namaste! I am Kabir, Corporate & Banquet Concierge at Vivaant Retreat. How may I assist your upcoming conference, banquet, or business stay?",
          greeting_hi: "नमस्ते! मैं विवांत रिट्रीट से कबीर बात कर रहा हूँ। आपके आगामी सम्मेलन, बैंक्वेट या कॉर्पोरेट स्टे में मैं किस प्रकार सहायता कर सकता हूँ?"
        },
        rhea: {
          name: "Rhea",
          voice: "Polly.Aditi",
          badge: "VIP Guest Relations (Energetic Voice)",
          desc: "Lively, energetic young Indian female voice (Polly.Aditi) specializing in luxury dining, rooftop pool, spa wellness, and VIP airport transfers.",
          greeting_en: "Namaste! I am Rhea from Vivaant Retreat Guest Experience. Thank you for taking my call. How may I make your upcoming visit comfortable and memorable?",
          greeting_hi: "नमस्ते! मैं विवांत रिट्रीट से रिया बात कर रही हूँ। आपकी यात्रा को सुखद व यादगार बनाने के लिए मैं किस प्रकार सहायता कर सकती हूँ?"
        },
        vikram: {
          name: "Vikram",
          badge: "Promotions Specialist",
          desc: "Specializes in exclusive seasonal promotions, weekend getaway deals, and special discounts.",
          greeting_en: "Namaste! I am Vikram from Vivaant Retreat. I am reaching out with exclusive seasonal rates and weekend getaway packages for you. Would you like to hear today's special offers?",
          greeting_hi: "नमस्ते! मैं विवांत रिट्रीट से विक्रम बात कर रहा हूँ। आपके लिए हमारे पास विशेष वीकेंड व सीज़नल ऑफर्स उपलब्ध हैं। क्या आप आज के ऑफर्स जानना चाहेंगे?"
        }
      };

      const SCRIPT_PRESETS = {
        standard: {
          greeting_en: "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES",
          greeting_hi: "Namaste! I am Aayla from Vivaant Retreat. Are you looking for Reservation at Vivaant Retreat Igatpuri ? If Yes, then say YES",
          script: "Standard hospitality reservation guidelines. If caller says YES, confirm and notify that we shall get back to them immediately."
        },
        discount: {
          greeting_en: "Namaste! I am Aayla from Vivaant Retreat. We have an exclusive 20% weekend discount for you today! Would you like to check room rates?",
          greeting_hi: "नमस्ते! मैं विवांत रिट्रीट से आयला बात कर रही हूँ। आज हमारे पास आपके लिए वीकेंड पर 20% विशेष छूट का ऑफर है। क्या आप कमरे के रेट जानना चाहेंगे?",
          script: "Weekend Promo Pitch: Offer flat 20% instant discount on direct booking today. Deluxe room now at ₹2,800/night with breakfast included. Mention promo code VIVAANT20. Urge immediate booking and dispatch payment link via WhatsApp immediately."
        },
        corporate: {
          greeting_en: "Namaste! I am Kabir from Vivaant Retreat Corporate & Banquet Concierge. How may I assist your upcoming conference or group booking?",
          greeting_hi: "नमस्ते! मैं विवांत रिट्रीट कॉर्पोरेट एवं बैंक्वेट से कबीर बात कर रहा हूँ। आपके आगामी सम्मेलन या ग्रुप बुकिंग में किस प्रकार सहायता कर सकता हूँ?",
          script: "Corporate & MICE Focus: Grand Ballroom accommodates up to 250 delegates. Conference hall has high-definition projector, sound system, and buffet lunch/high tea. Corporate executive suite available at preferential corporate rate of ₹5,200."
        },
        custom: {
          greeting_en: "",
          greeting_hi: "",
          script: ""
        }
      };

      let currentPersona = "aayla";
      let currentLang = "en";
      let customScript = "";
      let customGreeting = "";

      function getGreeting(pKey, lang) {
        if (customGreeting && customGreeting.trim()) {
          return customGreeting.trim();
        }
        const p = PERSONAS[pKey] || PERSONAS.aayla;
        return (lang === "hi") ? p.greeting_hi : p.greeting_en;
      }

      function applyScriptPreset(presetKey) {
        const preset = SCRIPT_PRESETS[presetKey];
        if (!preset) return;
        const greetingInput = document.getElementById("customGreetingInput");
        const scriptInput = document.getElementById("customScriptInput");
        if (presetKey === "custom") {
          if (greetingInput) greetingInput.value = "";
          if (scriptInput) scriptInput.value = "";
          return;
        }
        if (greetingInput) greetingInput.value = (currentLang === "hi") ? preset.greeting_hi : preset.greeting_en;
        if (scriptInput) scriptInput.value = preset.script;
      }

      async function saveAgentScript() {
        const greetingInput = document.getElementById("customGreetingInput");
        const scriptInput = document.getElementById("customScriptInput");
        const feedback = document.getElementById("scriptSaveFeedback");
        
        customGreeting = greetingInput ? greetingInput.value.trim() : "";
        customScript = scriptInput ? scriptInput.value.trim() : "";

        if (feedback) feedback.innerText = "Saving to Firebase...";

        try {
          const res = await fetch("/api/admin/agent-script", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              persona: currentPersona,
              language: currentLang,
              customGreeting: customGreeting,
              scriptGuidelines: customScript
            })
          });
          const data = await res.json();
          if (feedback) {
            feedback.innerText = "✓ Script Applied & Saved to Firebase!";
            setTimeout(() => { feedback.innerText = ""; }, 3000);
          }
          resetChat();
        } catch (e) {
          if (feedback) feedback.innerText = "Error: " + e.message;
        }
      }

      function resetAgentScriptToDefault() {
        const p = PERSONAS[currentPersona] || PERSONAS.aayla;
        const defaultGreeting = (currentLang === "hi") ? p.greeting_hi : p.greeting_en;
        const gInput = document.getElementById("customGreetingInput");
        const sInput = document.getElementById("customScriptInput");
        const presetSelect = document.getElementById("scriptPresetSelect");
        if (gInput) gInput.value = defaultGreeting;
        if (sInput) sInput.value = SCRIPT_PRESETS.standard.script;
        if (presetSelect) presetSelect.value = "standard";
        customGreeting = defaultGreeting;
        customScript = SCRIPT_PRESETS.standard.script;
        saveAgentScript();
      }

      async function loadSavedAgentScript() {
        try {
          const res = await fetch("/api/admin/agent-script?persona=" + encodeURIComponent(currentPersona));
          const data = await res.json();
          const gInput = document.getElementById("customGreetingInput");
          const sInput = document.getElementById("customScriptInput");

          if (data.exists && data.data) {
            customGreeting = (currentLang === "hi" && data.data.customGreetingHi) ? data.data.customGreetingHi : (data.data.customGreeting || "");
            customScript = data.data.scriptGuidelines || "";
            if (gInput && customGreeting) gInput.value = customGreeting;
            if (sInput && customScript) sInput.value = customScript;
            resetChat();
          } else {
            const p = PERSONAS[currentPersona] || PERSONAS.aayla;
            const defGreeting = (currentLang === "hi") ? p.greeting_hi : p.greeting_en;
            if (gInput && !gInput.value) gInput.value = defGreeting;
            if (sInput && !sInput.value) sInput.value = SCRIPT_PRESETS.standard.script;
          }
        } catch(e) {
          console.warn("Could not load agent script from Firebase:", e);
        }
      }

      function updateLiveLeadBadge(status, intent, score) {
        const badge = document.getElementById("liveLeadBadge");
        const intentEl = document.getElementById("liveLeadIntent");
        const scoreEl = document.getElementById("liveLeadScore");
        if (!badge) return;

        const s = (status || "cold").toLowerCase();
        if (s === "hot") {
          badge.className = "badge bg-danger fs-6 px-2 py-1";
          badge.innerHTML = "🔥 HOT LEAD (Ready to Book)";
        } else if (s === "warm") {
          badge.className = "badge bg-warning text-dark fs-6 px-2 py-1";
          badge.innerHTML = "⚡ WARM LEAD (Inquiring Rates / Info)";
        } else {
          badge.className = "badge bg-info text-dark fs-6 px-2 py-1";
          badge.innerHTML = "❄️ COLD LEAD (General / Exit)";
        }

        if (intentEl) intentEl.innerText = intent || "General Inquiry";
        if (scoreEl) scoreEl.innerText = (score !== undefined && score !== null) ? score + "/100" : "--";
      }

      let messages = [
        { role: "assistant", content: getGreeting("aayla", "en") }
      ];

      function updateQuickButtons(lang) {
        const c = document.getElementById("quickButtonsContainer");
        if (!c) return;
        c.innerHTML = "";
        const buttons = (lang === "hi") ? [
          { text: "कमरे का किराया", query: "कमरे का किराया कितना है?", cls: "btn-outline-info" },
          { text: "सुविधाएं (Pool & Food)", query: "क्या स्विमिंग पूल और ब्रेकफास्ट उपलब्ध है?", cls: "btn-outline-info" },
          { text: "कॉन्फ्रेंस / हॉल", query: "क्या 50 लोगों का कॉन्फ्रेंस हॉल मिल सकता है?", cls: "btn-outline-info" },
          { text: "बुकिंग और पेमेंट लिंक", query: "हाँ, 1 डीलक्स रूम बुक करके पेमेंट लिंक भेज दीजिए", cls: "btn-outline-warning" }
        ] : [
          { text: "Rates Inquiry", query: "What are the room tariffs?", cls: "btn-outline-info" },
          { text: "Amenities", query: "Do you have pool and breakfast?", cls: "btn-outline-info" },
          { text: "Corporate / Banquet", query: "Can we host a 50-person corporate conference?", cls: "btn-outline-info" },
          { text: "Book & Send Payment Link", query: "Yes, book 1 Deluxe room and send payment link", cls: "btn-outline-warning" }
        ];

        buttons.forEach(b => {
          const btn = document.createElement("button");
          btn.className = "btn btn-sm " + b.cls;
          btn.innerText = b.text;
          btn.onclick = () => quickQuery(b.query);
          c.appendChild(btn);
        });
      }

      function syncLanguage(lang) {
        currentLang = (lang || "en").toLowerCase();
        const langBadge = document.getElementById("simLangBadge");
        if (langBadge) langBadge.innerText = "Lang: " + currentLang.toUpperCase();
        updateQuickButtons(currentLang);
        loadSavedAgentScript();
        resetChat();
      }

      function syncAgentPersona(personaKey) {
        currentPersona = (personaKey || "aayla").toLowerCase();
        const p = PERSONAS[currentPersona] || PERSONAS.aayla;
        const descEl = document.getElementById("agentPersonaDesc");
        if (descEl) descEl.innerText = p.desc;
        const badgeEl = document.getElementById("simAgentBadge");
        if (badgeEl) badgeEl.innerText = "Agent: " + p.name;
        loadSavedAgentScript();
        resetChat();
      }

      function resetChat() {
        const p = PERSONAS[currentPersona] || PERSONAS.aayla;
        const greeting = getGreeting(currentPersona, currentLang);
        messages = [{ role: "assistant", content: greeting }];
        document.getElementById("chatBox").innerHTML = '<div class="chat-msg msg-agent"><strong>' + p.name + ' (AI):</strong> ' + greeting + '</div>';
        
        const badge = document.getElementById("liveLeadBadge");
        if (badge) {
          badge.className = "badge bg-secondary";
          badge.innerText = "Pending Query";
        }
        const intentEl = document.getElementById("liveLeadIntent");
        if (intentEl) intentEl.innerText = "Awaiting input";
        const scoreEl = document.getElementById("liveLeadScore");
        if (scoreEl) scoreEl.innerText = "--";
      }

      // Tab 1: Single Call
      async function triggerCall() {
        const phone = document.getElementById("dialPhone").value.trim();
        const name = document.getElementById("dialName").value.trim();
        const persona = document.getElementById("dialAgentPersona") ? document.getElementById("dialAgentPersona").value : currentPersona;
        const lang = document.getElementById("dialLanguage") ? document.getElementById("dialLanguage").value : currentLang;
        const statusDiv = document.getElementById("callStatus");
        statusDiv.innerText = "Placing outbound call with agent " + persona.toUpperCase() + " in " + (lang === "hi" ? "HINDI" : "ENGLISH") + "...";

        try {
          const res = await fetch("/api/telephony/outbound", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: phone, customerName: name, persona: persona, language: lang })
          });
          const data = await res.json();
          statusDiv.innerText = data.success ? "✓ Call dialed! Call ID: " + data.callId : "Error: " + JSON.stringify(data.error);
        } catch(e) {
          statusDiv.innerText = "Error: " + e.message;
        }
      }

      // Tab 1: Chat Simulation
      async function sendQuery() {
        const input = document.getElementById("userQuery");
        const query = input.value.trim();
        if(!query) return;

        const p = PERSONAS[currentPersona] || PERSONAS.aayla;
        appendMsg("You (Caller)", query, "msg-user");
        messages.push({ role: "user", content: query });
        input.value = "";

        const gInput = document.getElementById("customGreetingInput");
        const sInput = document.getElementById("customScriptInput");
        const activeScript = sInput ? sInput.value.trim() : customScript;
        const activeGreeting = gInput ? gInput.value.trim() : customGreeting;

        try {
          const res = await fetch("/api/telephony/simulate-dialog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages,
              persona: currentPersona,
              language: currentLang,
              customScript: activeScript,
              customGreeting: activeGreeting
            })
          });
          const data = await res.json();
          
          if (data.leadStatus) {
            updateLiveLeadBadge(data.leadStatus, data.intent, data.score);
          }

          if (data.language && data.language !== currentLang) {
            currentLang = data.language;
            const langBadge = document.getElementById("simLangBadge");
            if (langBadge) langBadge.innerText = "Lang: " + currentLang.toUpperCase();
            updateQuickButtons(currentLang);
          }

          let toolsInfo = "";
          if(data.toolsExecuted && data.toolsExecuted.length > 0) {
            toolsInfo = " <i>[Executed Tool: " + data.toolsExecuted.join(", ") + "]</i>";
          }

          if(data.hasHoldJingle && data.holdIntro) {
            appendMsg(p.name + " (AI)", data.holdIntro, "msg-agent");
            appendMsg("🏨 Vivaant Concierge", "🎵 <i>[Playing signature hotel chime on hold...]</i>", "msg-hold");
            previewHotelJingle();
            setTimeout(() => {
              appendMsg(p.name + " (AI)", data.agentReply + toolsInfo, "msg-agent");
              messages.push({ role: "assistant", content: data.agentReply });
            }, 2000);
          } else {
            messages.push({ role: "assistant", content: data.agentReply });
            appendMsg(p.name + " (AI)", data.agentReply + toolsInfo, "msg-agent");
          }
        } catch(e) {
          appendMsg("System", "Error: " + e.message, "msg-agent");
        }
      }

      function previewHotelJingle() {
        const audio = document.getElementById("hotelJinglePlayer");
        if(audio) {
          audio.currentTime = 0;
          audio.play().catch(e => console.log("Audio autoplay prevented:", e));
        }
      }

      function quickQuery(text) {
        document.getElementById("userQuery").value = text;
        sendQuery();
      }

      function appendMsg(sender, text, cls) {
        const box = document.getElementById("chatBox");
        const div = document.createElement("div");
        div.className = "chat-msg " + cls;
        div.innerHTML = "<strong>" + sender + ":</strong> " + text;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      }

      // Tab 2: CSV Upload & Manual Bulk Upload Contacts
      let currentUploadMode = "csv";
      let parsedCsvContacts = [];

      function toggleUploadMode(mode) {
        currentUploadMode = mode;
        const csvSec = document.getElementById("csvUploadSection");
        const manSec = document.getElementById("manualPasteSection");
        if (mode === "csv") {
          if (csvSec) csvSec.classList.remove("d-none");
          if (manSec) manSec.classList.add("d-none");
        } else {
          if (csvSec) csvSec.classList.add("d-none");
          if (manSec) manSec.classList.remove("d-none");
        }
      }

      function downloadSampleCsv() {
        const sampleContent = "Name,Phone,Notes_or_Room_Preference\\n" +
          "Rohan Sharma,+919167584555,Deluxe Room Weekend Stay\\n" +
          "Pooja Hegde,+919820011223,Executive Suite Inquiry\\n" +
          "Vikram Malhotra,+919833445566,Corporate Conference 30 Pax\\n" +
          "Ananya Sen,+919811223344,Presidential Suite Luxury\\n" +
          "Amitabh Verma,+919899001122,Poolside Villa Vacation";
        const blob = new Blob([sampleContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "vivaant_retreat_contacts_sample.csv";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      function cleanPhoneNumber(raw) {
        if (!raw) return "";
        let clean = String(raw).trim().replace(/[\\s\\-\\(\\)]/g, "");
        if (clean.startsWith("+91")) clean = clean.substring(3);
        else if (clean.startsWith("91") && clean.length === 12) clean = clean.substring(2);
        else if (clean.startsWith("0") && clean.length === 11) clean = clean.substring(1);
        if (/^[6-9]\\d{9}$/.test(clean)) {
          return "+91" + clean;
        }
        return clean.startsWith("+") ? clean : (clean ? "+91" + clean : "");
      }

      function handleCsvFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
          parseCsvContent(e.target.result);
        };
        reader.readAsText(file);
      }

      function parseCsvContent(text) {
        if (!text) return;
        const lines = text.split(/\\r?\\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return;

        parsedCsvContacts = [];
        let startIndex = 0;
        const firstLine = lines[0].toLowerCase();
        if (firstLine.includes("name") || firstLine.includes("phone") || firstLine.includes("mobile") || firstLine.includes("contact")) {
          startIndex = 1;
        }

        for (let i = startIndex; i < lines.length; i++) {
          const row = lines[i];
          const delimiter = row.includes(",") ? "," : (row.includes(";") ? ";" : "\\t");
          const cols = row.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ""));
          if (cols.length === 0 || !cols[0]) continue;

          let name = "Guest";
          let rawPhone = "";
          let notes = "";

          if (cols.length === 1) {
            rawPhone = cols[0];
          } else if (cols.length === 2) {
            if (/\\d{6,}/.test(cols[0]) && !/\\d{6,}/.test(cols[1])) {
              rawPhone = cols[0];
              name = cols[1];
            } else {
              name = cols[0];
              rawPhone = cols[1];
            }
          } else {
            name = cols[0];
            rawPhone = cols[1];
            notes = cols.slice(2).join(" ");
          }

          const cleaned = cleanPhoneNumber(rawPhone);
          const isValid = /^\\+91[6-9]\\d{9}$/.test(cleaned);

          parsedCsvContacts.push({
            name: name || "Guest",
            phone: cleaned,
            notes: notes,
            valid: isValid
          });
        }

        renderCsvPreview();
      }

      function renderCsvPreview() {
        const previewSec = document.getElementById("csvPreviewSection");
        const tbody = document.getElementById("csvPreviewBody");
        const totalCountEl = document.getElementById("csvTotalCount");
        const validCountEl = document.getElementById("csvValidCount");
        if (!previewSec || !tbody) return;

        if (parsedCsvContacts.length === 0) {
          previewSec.classList.add("d-none");
          return;
        }

        previewSec.classList.remove("d-none");
        const validCount = parsedCsvContacts.filter(c => c.valid).length;
        if (totalCountEl) totalCountEl.innerText = parsedCsvContacts.length;
        if (validCountEl) validCountEl.innerText = validCount + " valid";

        let html = "";
        parsedCsvContacts.slice(0, 100).forEach((c, idx) => {
          const badge = c.valid ? '<span class="badge bg-success">Valid</span>' : '<span class="badge bg-danger">Invalid Format</span>';
          html += '<tr>' +
            '<td class="text-secondary small">' + (idx + 1) + '</td>' +
            '<td class="text-white">' + escapeHtml(c.name) + '</td>' +
            '<td class="font-monospace ' + (c.valid ? 'text-info' : 'text-danger') + '">' + escapeHtml(c.phone) + '</td>' +
            '<td>' + badge + '</td>' +
          '</tr>';
        });
        tbody.innerHTML = html;
      }

      function clearCsvUpload() {
        parsedCsvContacts = [];
        const fileInput = document.getElementById("csvFileInput");
        if (fileInput) fileInput.value = "";
        const previewSec = document.getElementById("csvPreviewSection");
        if (previewSec) previewSec.classList.add("d-none");
      }

      async function uploadBulkContacts() {
        const campaign = document.getElementById("campaignName").value.trim() || "Vivaant_Outbound";
        const status = document.getElementById("uploadStatus");
        status.innerText = "Queueing contacts in Firebase RTDB...";

        let contactsToQueue = [];

        if (currentUploadMode === "csv") {
          if (parsedCsvContacts.length === 0) {
            status.innerText = "Please upload a CSV file with valid contacts first.";
            return;
          }
          contactsToQueue = parsedCsvContacts.filter(c => c.valid).map(c => ({
            name: c.name,
            phone: c.phone,
            notes: c.notes || "",
            campaign: campaign
          }));
        } else {
          const text = document.getElementById("bulkContactsText").value.trim();
          if(!text) { status.innerText = "Please enter at least one contact"; return; }

          const lines = text.split("\\n");
          for (const line of lines) {
            const parts = line.split(",");
            if(parts.length >= 2) {
              const cleaned = cleanPhoneNumber(parts[1].trim());
              contactsToQueue.push({ name: parts[0].trim(), phone: cleaned, campaign: campaign });
            } else if(parts.length === 1 && parts[0].trim()) {
              const cleaned = cleanPhoneNumber(parts[0].trim());
              contactsToQueue.push({ name: "Guest", phone: cleaned, campaign: campaign });
            }
          }
        }

        if (contactsToQueue.length === 0) {
          status.innerText = "No valid contacts found to upload. Please check numbers.";
          return;
        }

        try {
          const res = await fetch("/api/admin/contacts/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contacts: contactsToQueue, campaign: campaign })
          });
          const data = await res.json();
          status.innerText = "✓ Successfully queued " + (data.count || contactsToQueue.length) + " contacts into Firebase RTDB!";
          if (currentUploadMode === "csv") {
            clearCsvUpload();
          } else {
            document.getElementById("bulkContactsText").value = "";
          }
          loadQueue();
        } catch(e) {
          status.innerText = "Error: " + e.message;
        }
      }

      function updateConcurrencyBadge(val) {
        const badge = document.getElementById("concurrencyBadge");
        if (!badge) return;
        const num = parseInt(val, 10);
        if (num === 1) {
          badge.innerText = "1 Agent (Sequential)";
          badge.className = "badge bg-secondary px-2 py-1";
        } else {
          badge.innerText = num + " Agents Parallel (" + num + "x speed)";
          badge.className = "badge bg-warning text-dark fw-bold px-2 py-1";
        }
      }

      async function stopCampaign() {
        if (!confirm("Are you sure you want to stop the active calling campaign?")) return;
        const runStatus = document.getElementById("runStatus");
        const stopBtn = document.getElementById("stopCampaignBtn");
        try {
          const res = await fetch("/api/admin/campaigns/stop", { method: "POST" });
          const data = await res.json();
          runStatus.innerText = data.message || "Campaign stopped.";
          if (stopBtn) stopBtn.classList.add("d-none");
          setTimeout(loadQueue, 1500);
        } catch(e) {
          runStatus.innerText = "Error stopping: " + e.message;
        }
      }

      async function loadQueue() {
        const listDiv = document.getElementById("queueList");
        listDiv.innerHTML = "Loading...";

        try {
          const res = await fetch("/api/admin/contacts/queue");
          const queue = await res.json();

          if(queue.length === 0) {
            listDiv.innerHTML = "<div class='text-secondary small'>Queue is empty. Upload contacts on the left.</div>";
          } else {
            let html = "<ul class='list-group bg-dark'>";
            for (const item of queue) {
              const badgeClass = item.status === "pending" ? "bg-warning" : item.status === "calling" ? "bg-info text-dark" : item.status === "dialed" ? "bg-success" : "bg-secondary";
              const workerInfo = item.worker_id ? "<span class='badge bg-secondary ms-1'>Line #" + item.worker_id + "</span>" : "";
              html += "<li class='list-group-item bg-dark text-white border-secondary d-flex justify-content-between align-items-center'>" +
                "<div><strong>" + (item.name || "Guest") + "</strong> (" + item.phone + ")" + workerInfo + "<br><small class='text-secondary'>Campaign: " + (item.campaign || "General") + "</small></div>" +
                "<span class='badge " + badgeClass + "'>" + item.status.toUpperCase() + "</span>" +
                "</li>";
            }
            html += "</ul>";
            listDiv.innerHTML = html;
          }

          // Check campaign status to toggle stop button & progress
          try {
            const stRes = await fetch("/api/admin/campaigns/status");
            const st = await stRes.json();
            const stopBtn = document.getElementById("stopCampaignBtn");
            const runStatus = document.getElementById("runStatus");
            if (st && st.running) {
              if (stopBtn) stopBtn.classList.remove("d-none");
              if (runStatus && !runStatus.innerText.includes("Starting")) {
                runStatus.innerHTML = "<span class='badge bg-warning text-dark me-1'>ACTIVE</span> Dialing across " + st.concurrency + " concurrent agent lines · Completed: " + st.completed + "/" + st.total;
              }
            } else {
              if (stopBtn) stopBtn.classList.add("d-none");
            }
          } catch(e) {}
        } catch(e) {
          listDiv.innerText = "Error: " + e.message;
        }
      }

      async function runCampaign() {
        const campaign = document.getElementById("campaignName").value.trim();
        const persona = document.getElementById("campaignPersona") ? document.getElementById("campaignPersona").value : "aayla";
        const lang = document.getElementById("campaignLanguage") ? document.getElementById("campaignLanguage").value : "en";
        const concurrency = document.getElementById("campaignConcurrency") ? parseInt(document.getElementById("campaignConcurrency").value, 10) : 1;
        const runStatus = document.getElementById("runStatus");
        const stopBtn = document.getElementById("stopCampaignBtn");

        runStatus.innerText = "Starting outbound campaign with " + concurrency + " concurrent agent line(s) [" + persona.toUpperCase() + " in " + (lang === "hi" ? "HINDI" : "ENGLISH") + "]...";
        if (stopBtn) stopBtn.classList.remove("d-none");

        try {
          const res = await fetch("/api/admin/campaigns/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              campaignName: campaign, 
              persona: persona, 
              language: lang,
              concurrency: concurrency
            })
          });
          const data = await res.json();
          if (data.error) {
            runStatus.innerText = "Error: " + data.error;
            if (stopBtn) stopBtn.classList.add("d-none");
          } else {
            runStatus.innerText = data.message || ("Campaign started across " + concurrency + " concurrent lines.");
          }
          setTimeout(loadQueue, 2000);
        } catch(e) {
          runStatus.innerText = "Error: " + e.message;
          if (stopBtn) stopBtn.classList.add("d-none");
        }
      }

      // Tab 3: Knowledge Base
      let currentKb = {};
      async function loadKnowledgeBase() {
        try {
          const res = await fetch("/api/admin/hotel-config");
          currentKb = await res.json();

          document.getElementById("kbHotelName").value = currentKb.hotel_name || "";
          document.getElementById("kbLocation").value = currentKb.location || "";
          document.getElementById("kbCheckIn").value = currentKb.check_in_time || "14:00";
          document.getElementById("kbCheckOut").value = currentKb.check_out_time || "11:00";
          document.getElementById("kbDeluxeRate").value = currentKb.room_types?.deluxe?.base_rate || 3500;
          document.getElementById("kbSuiteRate").value = currentKb.room_types?.executive_suite?.base_rate || 6000;
          document.getElementById("kbPresRate").value = currentKb.room_types?.presidential_suite?.base_rate || 14000;
          document.getElementById("kbCancelPolicy").value = currentKb.cancellation_policy || "";
          document.getElementById("kbAmenities").value = (currentKb.amenities || []).join(", ");
          document.getElementById("kbFaqs").value = JSON.stringify(currentKb.faqs || {}, null, 2);
        } catch(e) {
          console.error("Error loading KB:", e);
        }
      }

      async function saveKnowledgeBase() {
        const status = document.getElementById("kbStatus");
        status.innerText = "Saving to Firebase Realtime Database...";

        currentKb.hotel_name = document.getElementById("kbHotelName").value;
        currentKb.location = document.getElementById("kbLocation").value;
        currentKb.check_in_time = document.getElementById("kbCheckIn").value;
        currentKb.check_out_time = document.getElementById("kbCheckOut").value;
        currentKb.cancellation_policy = document.getElementById("kbCancelPolicy").value;
        currentKb.amenities = document.getElementById("kbAmenities").value.split(",").map(s => s.trim());
        
        if(!currentKb.room_types) currentKb.room_types = {};
        if(!currentKb.room_types.deluxe) currentKb.room_types.deluxe = { name: "Deluxe Room", tax_percentage: 12 };
        currentKb.room_types.deluxe.base_rate = Number(document.getElementById("kbDeluxeRate").value);

        if(!currentKb.room_types.executive_suite) currentKb.room_types.executive_suite = { name: "Executive Suite", tax_percentage: 18 };
        currentKb.room_types.executive_suite.base_rate = Number(document.getElementById("kbSuiteRate").value);

        if(!currentKb.room_types.presidential_suite) currentKb.room_types.presidential_suite = { name: "Presidential Luxury Suite", tax_percentage: 18 };
        currentKb.room_types.presidential_suite.base_rate = Number(document.getElementById("kbPresRate").value);

        try {
          currentKb.faqs = JSON.parse(document.getElementById("kbFaqs").value);
        } catch(e) {
          alert("Invalid JSON format in FAQs. Please check.");
          return;
        }

        try {
          const res = await fetch("/api/admin/hotel-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(currentKb)
          });
          const data = await res.json();
          status.innerText = "✓ Knowledge Base & Tariffs updated and live in memory and Firebase!";
          loadKnowledgeBase();
          setTimeout(() => { status.innerText = ""; }, 4000);
        } catch(e) {
          status.innerText = "Error: " + e.message;
        }
      }

      // Tab 4: EOD Report
      async function generateReport() {
        const pre = document.getElementById("reportPre");
        pre.innerText = "Aggregating today's metrics from Firebase RTDB...";

        try {
          const res = await fetch("/api/admin/report/generate", { method: "POST" });
          const data = await res.json();
          pre.innerText = data.markdownReport || JSON.stringify(data.reportData, null, 2);
        } catch(e) {
          pre.innerText = "Error: " + e.message;
        }
      }

      // ==========================================
      // Role-Based Authentication & Session Management
      // ==========================================
      function getStoredSession() {
        try {
          const raw = localStorage.getItem("voice_ai_session");
          if (!raw) return null;
          return JSON.parse(raw);
        } catch(e) {
          return null;
        }
      }

      function setStoredSession(session) {
        localStorage.setItem("voice_ai_session", JSON.stringify(session));
      }

      function clearStoredSession() {
        localStorage.removeItem("voice_ai_session");
      }

      async function initAuth() {
        const session = getStoredSession();
        if (!session || !session.token) {
          showLoginOverlay();
          return false;
        }

        try {
          const res = await fetch("/api/auth/verify", {
            headers: { "Authorization": "Bearer " + session.token }
          });
          const data = await res.json();
          if (data.success && data.user) {
            applyUserRole(data.user);
            hideLoginOverlay();
            return true;
          } else {
            showLoginOverlay();
            return false;
          }
        } catch(e) {
          if (session.user) {
            applyUserRole(session.user);
            hideLoginOverlay();
            return true;
          }
          showLoginOverlay();
          return false;
        }
      }

      function showLoginOverlay() {
        const overlay = document.getElementById("loginOverlay");
        if (overlay) overlay.classList.remove("d-none");
        document.body.style.overflow = "hidden";
        setTimeout(() => {
          const uInput = document.getElementById("loginUsername");
          if (uInput) uInput.focus();
        }, 100);
      }

      function hideLoginOverlay() {
        const overlay = document.getElementById("loginOverlay");
        if (overlay) overlay.classList.add("d-none");
        document.body.style.overflow = "auto";
      }

      async function submitLogin() {
        const uInput = document.getElementById("loginUsername");
        const pInput = document.getElementById("loginPassword");
        const errDiv = document.getElementById("loginError");
        const btn = document.getElementById("loginSubmitBtn");

        const username = (uInput?.value || "").trim();
        const password = (pInput?.value || "").trim();

        if (!username || !password) {
          if (errDiv) {
            errDiv.innerText = "Please enter both username and password";
            errDiv.classList.remove("d-none");
          }
          return;
        }

        if (errDiv) errDiv.classList.add("d-none");
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Authenticating...';
        }

        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (data.success) {
            setStoredSession({
              token: data.token,
              user: data.user,
              loginTime: Date.now()
            });
            applyUserRole(data.user);
            hideLoginOverlay();
            if (pInput) pInput.value = "";
            loadWalletBalance();
            loadCDRReport(11);
          } else {
            if (errDiv) {
              errDiv.innerText = data.error || "Invalid username or password";
              errDiv.classList.remove("d-none");
            }
          }
        } catch(e) {
          if (errDiv) {
            errDiv.innerText = "Connection error: " + e.message;
            errDiv.classList.remove("d-none");
          }
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.innerText = "Sign In to Portal";
          }
        }
      }

      function logout() {
        if (confirm("Are you sure you want to sign out of the portal?")) {
          clearStoredSession();
          showLoginOverlay();
          const uInput = document.getElementById("loginUsername");
          const pInput = document.getElementById("loginPassword");
          if (uInput) uInput.value = "";
          if (pInput) pInput.value = "";
        }
      }

      function applyUserRole(user) {
        if (!user) return;
        const role = user.role || "agent";
        const roleText = document.getElementById("userRoleText");
        const roleBadge = document.getElementById("userRoleBadge");
        const headerRechargeBtn = document.getElementById("headerRechargeBtn");
        const adminSection = document.getElementById("adminRechargeSection");
        const agentSection = document.getElementById("agentLockedSection");

        if (role === "admin") {
          if (roleText) roleText.innerText = "Admin (Full Access)";
          if (roleBadge) {
            roleBadge.className = "badge bg-danger p-2 px-3 fw-bold d-inline-flex align-items-center gap-1";
            roleBadge.innerHTML = "<span>🛡️</span> <span>Admin (Approver)</span>";
          }
          if (headerRechargeBtn) headerRechargeBtn.style.display = "inline-block";
          if (adminSection) adminSection.classList.remove("d-none");
          if (agentSection) agentSection.classList.add("d-none");
        } else {
          // Agent role
          if (roleText) roleText.innerText = "Agent (Staff)";
          if (roleBadge) {
            roleBadge.className = "badge bg-primary p-2 px-3 fw-bold d-inline-flex align-items-center gap-1";
            roleBadge.innerHTML = "<span>👤</span> <span>Agent (Staff)</span>";
          }
          if (headerRechargeBtn) headerRechargeBtn.style.display = "none";
          if (adminSection) adminSection.classList.add("d-none");
          if (agentSection) agentSection.classList.remove("d-none");
        }
      }

      // Tab 5: CDR & Billing Report (Rs. 11/call)
      let cdrDataCache = null;

      async function loadWalletBalance() {
        try {
          const res = await fetch("/api/admin/wallet");
          const data = await res.json();
          if (data.success) {
            const bal = Number(data.balance || 0).toFixed(2);
            const credits = data.callsRemaining !== undefined ? data.callsRemaining : Math.floor(Number(data.balance || 0) / 11);

            const hBal = document.getElementById("headerWalletBalance");
            if (hBal) hBal.innerText = "₹" + bal;
            const hCred = document.getElementById("headerCreditsLeft");
            if (hCred) hCred.innerText = credits;

            const cdrBal = document.getElementById("cdrWalletBalance");
            if (cdrBal) cdrBal.innerText = "₹" + bal;
            const cdrCred = document.getElementById("cdrCreditsLeft");
            if (cdrCred) cdrCred.innerText = credits;

            const dialerCred = document.getElementById("dialerCreditsLeft");
            if (dialerCred) dialerCred.innerText = credits + " calls";
            const dialerBal = document.getElementById("dialerBalance");
            if (dialerBal) dialerBal.innerText = "₹" + bal;

            const placeBtn = document.getElementById("placeCallBtn");
            const callStatus = document.getElementById("callStatus");
            if (placeBtn) {
              if (credits <= 0) {
                placeBtn.classList.add("disabled");
                placeBtn.setAttribute("disabled", "true");
                if (callStatus && !callStatus.innerText.includes("calling")) {
                  callStatus.innerHTML = "<span class='text-danger'>⚠️ Out of credits: Minimum ₹11 required to call. Please recharge.</span>";
                }
              } else {
                placeBtn.classList.remove("disabled");
                placeBtn.removeAttribute("disabled");
                if (callStatus && callStatus.innerText.includes("Out of credits")) {
                  callStatus.innerText = "";
                }
              }
            }
          }
        } catch(e) {
          console.error("Wallet balance fetch error:", e);
        }
      }

      async function quickRecharge(amount) {
        await rechargeWallet(amount, "Quick Recharge ₹" + amount);
      }

      async function submitCustomRecharge() {
        const input = document.getElementById("customRechargeInput");
        const val = Number(input.value);
        if (!val || val <= 0) {
          alert("Please enter a valid recharge amount (e.g. 550)");
          return;
        }
        await rechargeWallet(val, "Custom Recharge ₹" + val);
        input.value = "";
      }

      async function rechargeWallet(amount, notes) {
        const session = getStoredSession();
        if (session?.user?.role !== "admin") {
          alert("Access Denied: Only Admin can add or approve credit limits. Agent does not have approval rights.");
          return;
        }

        const alertDiv = document.getElementById("rechargeAlert");
        if (alertDiv) alertDiv.innerHTML = '<span class="text-info">Submitting credit approval to Firebase...</span>';
        try {
          const res = await fetch("/api/admin/wallet/recharge", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + (session?.token || ""),
              "X-User-Role": session?.user?.role || "admin"
            },
            body: JSON.stringify({ amount, notes: notes || ("Approved by " + (session?.user?.username || "admin")) })
          });
          const data = await res.json();
          if (data.success) {
            if (alertDiv) alertDiv.innerHTML = '<span class="text-success">✓ Credits Approved & Added: ₹' + amount + '! Balance: ₹' + data.balance.toFixed(2) + ' (' + data.callsRemaining + ' calls left)</span>';
            loadWalletBalance();
            setTimeout(() => { if (alertDiv) alertDiv.innerHTML = ""; }, 4000);
          } else {
            if (alertDiv) alertDiv.innerHTML = '<span class="text-danger">Failed: ' + (data.error || "Unknown error") + '</span>';
          }
        } catch(e) {
          if (alertDiv) alertDiv.innerHTML = '<span class="text-danger">Error: ' + e.message + '</span>';
        }
      }

      function switchToRecharge() {
        const session = getStoredSession();
        if (session?.user?.role !== "admin") {
          alert("Notice: Only the Administrator can add or approve credit limits.");
          return;
        }
        const cdrTabBtn = document.getElementById("cdr-tab");
        if (cdrTabBtn) {
          const tab = new bootstrap.Tab(cdrTabBtn);
          tab.show();
          loadCDRReport(11);
          const input = document.getElementById("customRechargeInput");
          if (input) {
            input.focus();
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }

      async function loadCDRReport(rate, isSilent = false) {
        if (!rate) rate = 11;
        const tbody = document.getElementById("cdrTableBody");
        if (!isSilent && tbody) {
          tbody.innerHTML = '<tr><td colspan="10" class="text-center text-info py-4"><div class="spinner-border spinner-border-sm text-info me-2"></div> Loading Call Detail Records from Firebase RTDB...</td></tr>';
        }

        try {
          const res = await fetch("/api/admin/cdr?rate=" + encodeURIComponent(rate));
          const data = await res.json();
          cdrDataCache = data;
          filterCDRTable();
        } catch(e) {
          if (!isSilent && tbody) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center text-danger py-4">Failed to load CDR data: ' + e.message + '</td></tr>';
          }
        }
      }

      function renderCDRTable(data) {
        const records = data.records || [];
        const summary = data.summary || {};

        document.getElementById("cdrTotalCalls").innerText = summary.total_calls || 0;
        document.getElementById("cdrConnectedRatio").innerText = (summary.connected_calls || 0) + " connected, " + (summary.failed_or_missed_calls || 0) + " not picked up";
        document.getElementById("cdrTotalDuration").innerText = summary.total_duration_formatted || "0s";
        document.getElementById("cdrTotalBilledMins").innerText = (summary.connected_calls || 0) + " billed calls";
        document.getElementById("cdrGrandTotal").innerText = "Rs. " + (summary.grand_total_amount || 0).toFixed(2);

        document.getElementById("cdrFootDuration").innerText = summary.total_duration_formatted || "0s";
        document.getElementById("cdrFootTotal").innerText = "Rs. " + (summary.grand_total_amount || 0).toFixed(2);

        document.getElementById("cdrFilteredCount").innerText = records.length;

        const tbody = document.getElementById("cdrTableBody");
        if (records.length === 0) {
          tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted py-4">No calls recorded yet. Place outbound calls to view records.</td></tr>';
          return;
        }

        let html = "";
        records.forEach((c, idx) => {
          let statusBadge = 'bg-secondary';
          if (c.status === 'completed') statusBadge = 'bg-success';
          else if (c.status === 'connected') statusBadge = 'bg-info text-dark';
          else if (c.status === 'failed') statusBadge = 'bg-danger';

          let leadBadge = 'bg-secondary';
          const lLower = (c.lead_status || '').toLowerCase();
          if (lLower.includes('not picked up') || lLower === 'not_picked_up') {
            leadBadge = 'bg-secondary text-light';
          } else if (lLower === 'hot') {
            leadBadge = 'bg-danger';
          } else if (lLower === 'warm') {
            leadBadge = 'bg-warning text-dark';
          } else if (lLower === 'cold') {
            leadBadge = 'bg-info text-dark';
          }

          html += '<tr>' +
            '<td class="text-secondary small text-center">' + (idx + 1) + '</td>' +
            '<td>' +
              '<div class="fw-bold text-white">' + escapeHtml(c.customer_name) + '</div>' +
              '<div class="small text-info font-monospace">' + escapeHtml(c.customer_phone) + '</div>' +
            '</td>' +
            '<td class="small text-secondary">' + c.date_formatted + '</td>' +
            '<td class="fw-bold text-white">' + c.duration_formatted + ' <span class="text-muted small">(' + c.duration_seconds + 's)</span></td>' +
            '<td class="text-muted small">Rs. ' + (c.rate_per_call || 11) + '/call</td>' +
            '<td class="text-success fw-bold fs-6">Rs. ' + c.call_cost.toFixed(2) + '</td>' +
            '<td><span class="badge ' + statusBadge + '">' + c.status + '</span></td>' +
            '<td><span class="badge ' + leadBadge + '">' + (c.lead_status || 'Pending') + '</span></td>' +
            '<td style="max-width: 250px; font-size: 13px;" class="text-light">' + escapeHtml(c.customer_mentioned) + '</td>' +
            '<td style="max-width: 250px; font-size: 13px;" class="text-secondary">' + escapeHtml(c.last_agent_reply || 'AI Greeting Delivered') + '</td>' +
          '</tr>';
        });
        tbody.innerHTML = html;
      }

      function filterCDRTable() {
        if (!cdrDataCache) return;
        const q = (document.getElementById("cdrSearchInput").value || "").toLowerCase().trim();
        const leadFilter = (document.getElementById("cdrLeadFilter").value || "").toLowerCase().trim();

        const filteredRecords = (cdrDataCache.records || []).filter(c => {
          const lStatus = (c.lead_status || "").toLowerCase();
          const matchQ = !q ||
            (c.customer_name && c.customer_name.toLowerCase().includes(q)) ||
            (c.customer_phone && c.customer_phone.toLowerCase().includes(q)) ||
            (c.customer_mentioned && c.customer_mentioned.toLowerCase().includes(q)) ||
            (c.status && c.status.toLowerCase().includes(q)) ||
            lStatus.includes(q);

          const matchLead = !leadFilter || lStatus === leadFilter || (leadFilter === "not picked up" && (lStatus === "not_picked_up" || lStatus === "not picked up"));
          return matchQ && matchLead;
        });

        const totalDuration = filteredRecords.reduce((acc, c) => acc + c.duration_seconds, 0);
        const grandTotal = filteredRecords.reduce((acc, c) => acc + c.call_cost, 0);
        const connectedCount = filteredRecords.filter(c => c.duration_seconds > 0).length;

        renderCDRTable({
          records: filteredRecords,
          summary: {
            total_calls: filteredRecords.length,
            connected_calls: connectedCount,
            failed_or_missed_calls: filteredRecords.length - connectedCount,
            total_duration_seconds: totalDuration,
            total_duration_formatted: Math.floor(totalDuration/60) + "m " + (totalDuration%60) + "s",
            rate_per_call: 11,
            grand_total_amount: grandTotal
          }
        });
      }

      function downloadCDRCsv() {
        window.location.href = "/api/admin/cdr/download?rate=11";
      }

      function escapeHtml(str) {
        if (!str) return "";
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // Auto-load on page load and initialize authentication & 3-second live refresh
      window.addEventListener("DOMContentLoaded", () => {
        initAuth();
        loadWalletBalance();
        loadCDRReport(11);
        loadSavedAgentScript();
        loadKnowledgeBase();

        // 3-Second Live Refresh Interval for CDR & Wallet Status
        setInterval(() => {
          loadWalletBalance();
          const cdrPane = document.getElementById("cdr");
          if (cdrPane && cdrPane.classList.contains("active")) {
            loadCDRReport(11, true); // true = silent background refresh without spinner
          }
        }, 3000);

        // Drag and drop for CSV file upload
        const dropZone = document.getElementById("dropZone");
        if (dropZone) {
          ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
          });
          ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add("border-info"), false);
          });
          ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove("border-info"), false);
          });
          dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files && files.length > 0) {
              handleCsvFile(files[0]);
            }
          });
        }
      });
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

// WebSocket Handler for Real-Time Telephony Bidirectional Audio
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callId = url.searchParams.get("call_id");
  console.log(`[WebSocket Audio Stream] Client connected for Call ID: ${callId}`);

  ws.on("message", (message) => {
    // Media stream packets handler
  });

  ws.on("close", () => {
    console.log(`[WebSocket Audio Stream] Stream closed for Call ID: ${callId}`);
  });
});

// Schedule Daily End-of-Day (EOD) Report via Cron
const cronSchedule = process.env.EOD_REPORT_CRON || "0 21 * * *"; // 9:00 PM daily
cron.schedule(cronSchedule, async () => {
  console.log(`[Cron Scheduler] Running automated daily EOD report at ${new Date().toISOString()}...`);
  try {
    await generateDailyReport();
  } catch (err) {
    console.error("[Cron Scheduler] Error running daily report:", err);
  }
});

export { app, server };

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun && !process.env.FUNCTION_TARGET && !process.env.K_SERVICE) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`=======================================================`);
    console.log(`🏨 Hotel AI Voice Agent & Telephony Gateway is ONLINE!`);
    console.log(`📡 Listening on http://0.0.0.0:${PORT}`);
    console.log(`📞 Telephony Provider: ${process.env.TELEPHONY_PROVIDER || "vobiz"}`);
    console.log(`🔥 Firebase RTDB URL: ${process.env.FIREBASE_DATABASE_URL}`);
    console.log(`🌐 Public Webhook URL: ${process.env.PUBLIC_URL}`);
    console.log(`=======================================================`);
  });
}

