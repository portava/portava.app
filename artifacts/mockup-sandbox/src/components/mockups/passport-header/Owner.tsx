import { Bookmark, UserCircle2, Globe, MapPin, ShieldCheck, Camera, CheckCircle2 } from "lucide-react";
import "./passport.css";

const CREAM = "#F5F0E8";
const SPINE_BG = "#E8E0D0";
const INK = "#1C1C1A";
const GOLD = "#B8974E";
const MUTED = "#8A7E6E";

// ── Decorative SVGs ──────────────────────────────────────────────────────────

function AdventureStamp() {
  return (
    <svg width="90" height="90" viewBox="0 0 90 90" fill="none">
      <circle cx="45" cy="45" r="42" stroke="#3B82F6" strokeWidth="2.5" strokeDasharray="4 2" />
      <circle cx="45" cy="45" r="36" stroke="#3B82F6" strokeWidth="1.2" />
      <text x="45" y="22" textAnchor="middle" fill="#3B82F6" fontSize="6.5" fontWeight="700" letterSpacing="1.5">ADVENTURE IS</text>
      <text x="45" y="73" textAnchor="middle" fill="#3B82F6" fontSize="6.5" fontWeight="700" letterSpacing="1.5">WORTHWHILE</text>
      {/* Plane */}
      <g transform="translate(28,30) scale(1.6)">
        <path d="M2 9l7-7 2 2-4 4 8 2-2 2-8-2 1 4-2 1z" fill="#3B82F6" opacity="0.85"/>
        <path d="M9 2l2 2-7 7-1-1z" fill="#3B82F6"/>
      </g>
      <circle cx="45" cy="45" r="1.5" fill="#3B82F6" opacity="0.3"/>
    </svg>
  );
}

function PortavaStamp() {
  return (
    <svg width="110" height="72" viewBox="0 0 110 72" fill="none">
      <rect x="2" y="2" width="106" height="68" rx="6" stroke={GOLD} strokeWidth="2" strokeDasharray="3 2"/>
      <rect x="6" y="6" width="98" height="60" rx="4" stroke={GOLD} strokeWidth="1" opacity="0.5"/>
      <text x="55" y="20" textAnchor="middle" fill={GOLD} fontSize="7" fontWeight="700" letterSpacing="2">PORTAVA PASSPORT</text>
      {/* Plane */}
      <g transform="translate(32,26) scale(2)">
        <path d="M2 9l7-7 2 2-4 4 8 2-2 2-8-2 1 4-2 1z" fill={GOLD} opacity="0.7"/>
      </g>
      <text x="55" y="60" textAnchor="middle" fill={GOLD} fontSize="6.5" fontWeight="700" letterSpacing="2">★ EXPLORE MORE ★</text>
    </svg>
  );
}

function ArrivalStamp() {
  return (
    <svg width="80" height="52" viewBox="0 0 80 52" fill="none">
      <rect x="1" y="1" width="78" height="50" rx="4" stroke="#2D6A4F" strokeWidth="1.5" strokeDasharray="2 2"/>
      <text x="40" y="14" textAnchor="middle" fill="#2D6A4F" fontSize="5.5" fontWeight="600" letterSpacing="1">2 8 5 8  3  ARRIVE</text>
      <text x="40" y="28" textAnchor="middle" fill="#2D6A4F" fontSize="10" fontWeight="800" letterSpacing="2">CEBU</text>
      <text x="40" y="42" textAnchor="middle" fill="#2D6A4F" fontSize="6" fontWeight="600" letterSpacing="1.5">PHILIPPINES</text>
    </svg>
  );
}

// ── Trust Score ──────────────────────────────────────────────────────────────
function TrustScore({ score = 87 }: { score?: number }) {
  const pct = Math.min(100, Math.max(0, score));
  return (
    <div className="trust-score-card">
      <div className="trust-score-row">
        <ShieldCheck size={15} color="#2D6A4F" strokeWidth={2.5} />
        <span className="trust-label">TRUST SCORE</span>
        <span className="trust-number">{score}</span>
        <span className="trust-total">/ 100</span>
      </div>
      <div className="trust-bar-bg">
        <div className="trust-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Stat Ticket ──────────────────────────────────────────────────────────────
function StatTicket({
  value, label, icon, accent,
}: { value: string; label: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="stat-ticket">
      <div className="stat-icon-wrap" style={{ backgroundColor: accent + "18" }}>
        {icon}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-underline" style={{ backgroundColor: accent }} />
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────
export function Owner() {
  return (
    <div className="page-bg">
      {/* Nav bar */}
      <div className="nav-bar">
        <button className="nav-btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <span className="nav-title">Passport</span>
        <div className="nav-actions">
          <button className="nav-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/></svg>
          </button>
          <button className="nav-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          </button>
          <button className="nav-icon-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
          </button>
        </div>
      </div>

      {/* Passport card */}
      <div className="passport-card">

        {/* Spine */}
        <div className="passport-spine">
          <span className="spine-text">PORTAVA PASSPORT</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round" style={{opacity:0.6}}>
            <path d="M21 3l-7 7M21 3H13M21 3v8M3 21l7-7M3 21h8M3 21v-8"/>
          </svg>
        </div>

        {/* Card body */}
        <div className="card-body">

          {/* Top-left: Adventure stamp + avatar */}
          <div className="left-col">
            <div className="adventure-stamp"><AdventureStamp /></div>
            <div className="avatar-area">
              <div className="avatar-ring-gold">
                <div className="avatar-circle">
                  <img
                    src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&h=200&fit=crop&crop=face"
                    alt="Profile"
                    className="avatar-img"
                  />
                </div>
              </div>
              <button className="camera-btn" title="Change photo">
                <Camera size={14} color={INK} strokeWidth={2} />
              </button>
            </div>
            <div className="arrival-stamp-wrap"><ArrivalStamp /></div>
          </div>

          {/* Right col: identity info */}
          <div className="right-col">
            <div className="portava-stamp-wrap"><PortavaStamp /></div>

            <div className="traveler-label">TRAVELER ★</div>
            <div className="display-name-row">
              <span className="display-name">DRAIE</span>
              <CheckCircle2 size={20} color="#2563EB" fill="#2563EB" strokeWidth={0} className="verified-check" />
            </div>
            <div className="handle">@draie</div>

            <TrustScore score={87} />

            <div className="verified-pill">
              <CheckCircle2 size={12} color="#2563EB" fill="#2563EB" strokeWidth={0} />
              <span>Verified</span>
            </div>

            <div className="identity-tags">
              <Globe size={13} color={MUTED} strokeWidth={1.8} />
              <span>Traveler · Explorer · Connector</span>
            </div>

            <div className="location-row">
              <MapPin size={13} color={MUTED} strokeWidth={1.8} />
              <span>Cebu, Philippines</span>
            </div>

            {/* Owner actions */}
            <div className="owner-actions">
              <button className="action-card action-saved">
                <Bookmark size={18} color={INK} strokeWidth={1.8} />
                <span>Saved</span>
              </button>
              <button className="action-card action-edit">
                <UserCircle2 size={18} color={INK} strokeWidth={1.8} />
                <span>Edit Profile</span>
              </button>
            </div>
          </div>

        </div>{/* card-body */}

        {/* Stats boarding-pass strip */}
        <div className="stats-strip">
          {/* Decorative airplane */}
          <div className="strip-deco strip-deco-plane">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C4B89A" strokeWidth="1.2" strokeLinecap="round" opacity="0.7">
              <path d="M21 3l-7 7M21 3H13M21 3v8M3 21l7-7M3 21h8M3 21v-8"/>
            </svg>
          </div>

          <StatTicket value="124"  label="Trips"     icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>}  accent="#8B5CF6" />
          <StatTicket value="1.2K" label="Followers" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EC4899" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>} accent="#EC4899" />
          <StatTicket value="980"  label="Following" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}  accent="#10B981" />
          <StatTicket value="56"   label="Countries" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>} accent="#3B82F6" />
          <StatTicket value="32"   label="Stamps"    icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round"><path d="M12 2a5 5 0 015 5v3h1a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2h1V7a5 5 0 015-5z"/></svg>} accent="#F59E0B" />

          {/* Decorative palm */}
          <div className="strip-deco strip-deco-palm">
            <svg width="28" height="32" viewBox="0 0 28 32" fill="none" stroke="#C4B89A" strokeWidth="1.2" strokeLinecap="round" opacity="0.7">
              <line x1="14" y1="32" x2="14" y2="10"/>
              <path d="M14 12 C10 8 4 9 2 6 C6 5 11 8 14 12Z" fill="#C4B89A" opacity="0.5"/>
              <path d="M14 14 C18 10 24 11 26 8 C22 7 17 10 14 14Z" fill="#C4B89A" opacity="0.5"/>
              <path d="M14 10 C12 4 8 2 6 0 C8 4 11 7 14 10Z" fill="#C4B89A" opacity="0.4"/>
            </svg>
          </div>
        </div>

      </div>{/* passport-card */}
    </div>
  );
}
