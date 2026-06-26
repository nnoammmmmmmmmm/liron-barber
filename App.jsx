// ============================================================
//  App.jsx — אפליקציית ניהול תורים לספר לירון
//  הגדרות נדרשות ב-.env.local:
//    VITE_SUPABASE_URL=...
//    VITE_SUPABASE_ANON_KEY=...
//    VITE_ADMIN_PASSWORD=liron2025
// ============================================================

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase client ────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ─── קבועים ─────────────────────────────────────────────────
const HEB_MONTHS = [
  "ינואר","פברואר","מרץ","אפריל","מאי","יוני",
  "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר",
];
const HEB_DAYS_SHORT = ["א׳","ב׳","ג׳","ד׳","ה׳","ו׳","ש׳"];
const DAY_NAMES = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];

// לו"ז שבועי: מפתח = יום בשבוע (0=ראשון), ערך = [פתיחה, סגירה]
const SCHEDULE = {
  0: ["09:00", "19:00"],
  2: ["09:00", "19:00"],
  3: ["09:00", "19:00"],
  4: ["09:00", "19:00"],
  5: ["09:00", "13:00"],
};

// ─── פונקציות עזר ───────────────────────────────────────────
function isBusinessDay(date) {
  return date.getDay() in SCHEDULE;
}

function generateDaySlots(date) {
  const hours = SCHEDULE[date.getDay()];
  if (!hours) return [];
  const slots = [];
  const [oh, om] = hours[0].split(":").map(Number);
  const [ch, cm] = hours[1].split(":").map(Number);
  let cur = oh * 60 + om;
  const end = ch * 60 + cm;
  while (cur < end) {
    const h = String(Math.floor(cur / 60)).padStart(2, "0");
    const m = String(cur % 60).padStart(2, "0");
    slots.push(`${h}:${m}`);
    cur += 10;
  }
  return slots;
}

function toDateStr(date) {
  return date.toISOString().split("T")[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ב${HEB_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function getStatus(dateStr, timeSlot) {
  const now = new Date();
  const todayStr = toDateStr(now);
  const apptDt = new Date(`${dateStr}T${timeSlot}`);
  if (dateStr < todayStr) return "past";
  if (dateStr === todayStr) return apptDt > now ? "today" : "past";
  return "upcoming";
}

function initials(name) {
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2);
}

function isAdmin() {
  return (
    localStorage.getItem("liron_admin") ===
    import.meta.env.VITE_ADMIN_PASSWORD
  );
}

function loginAdmin(password) {
  if (password === import.meta.env.VITE_ADMIN_PASSWORD) {
    localStorage.setItem("liron_admin", password);
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════
//  HOOK — שעות פנויות (real-time)
// ════════════════════════════════════════════════════════════
function useAvailableSlots(selectedDate) {
  const [availableSlots, setAvailableSlots] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedDate) return;
    const dateStr = toDateStr(selectedDate);

    async function fetch() {
      setLoading(true);
      const { data: booked } = await supabase
        .from("appointments")
        .select("time_slot")
        .eq("date", dateStr);
      const bookedSet = new Set((booked || []).map((a) => a.time_slot.slice(0, 5)));
      const all = generateDaySlots(selectedDate);
      setAvailableSlots(all.filter((s) => !bookedSet.has(s)));
      setLoading(false);
    }

    fetch();

    const sub = supabase
      .channel(`slots-${dateStr}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments", filter: `date=eq.${dateStr}` },
        fetch
      )
      .subscribe();

    return () => supabase.removeChannel(sub);
  }, [selectedDate]);

  return { availableSlots, loading };
}

// ════════════════════════════════════════════════════════════
//  HOOK — כל התורים (real-time, לניהול)
// ════════════════════════════════════════════════════════════
function useAppointments() {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAll();
    const sub = supabase
      .channel("admin-appts")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, fetchAll)
      .subscribe();
    return () => supabase.removeChannel(sub);
  }, []);

  async function fetchAll() {
    setLoading(true);
    const { data } = await supabase
      .from("appointments")
      .select("*")
      .order("date", { ascending: true })
      .order("time_slot", { ascending: true });
    setAppointments(data || []);
    setLoading(false);
  }

  async function deleteAppointment(id) {
    await supabase.from("appointments").delete().eq("id", id);
  }

  return { appointments, loading, deleteAppointment };
}

// ════════════════════════════════════════════════════════════
//  BOOKING FLOW — זרימת קביעת תור (לקוח)
// ════════════════════════════════════════════════════════════
function BookingFlow() {
  const [step, setStep] = useState(1);
  const [viewDate, setViewDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const { availableSlots, loading: slotsLoading } = useAvailableSlots(selectedDate);

  // בניית תאי לוח שנה
  const calendarCells = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cells = Array(firstDay).fill(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      cells.push({
        date,
        dateStr: toDateStr(date),
        closed: !isBusinessDay(date),
        past: date < today,
      });
    }
    return cells;
  }, [viewDate]);

  function changeMonth(dir) {
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }

  async function handleSubmit() {
    if (!name.trim() || !phone.trim() || !selectedDate || !selectedSlot) return;
    setSubmitting(true);
    setError("");
    const { error: err } = await supabase.from("appointments").insert({
      date: toDateStr(selectedDate),
      time_slot: selectedSlot,
      customer_name: name.trim(),
      customer_phone: phone.trim(),
    });
    setSubmitting(false);
    if (err) {
      if (err.code === "23505") setError("השעה הזו נתפסה זה עתה — בחר שעה אחרת.");
      else setError("שגיאה בקביעת התור. נסה שוב.");
      return;
    }
    setStep(4);
  }

  function reset() {
    setStep(1);
    setSelectedDate(null);
    setSelectedSlot(null);
    setName("");
    setPhone("");
    setError("");
  }

  // ── עיצוב משותף ──
  const btn =
    "w-full py-2.5 rounded-xl text-sm font-medium transition-opacity disabled:opacity-30 disabled:cursor-not-allowed";
  const btnPrimary = `${btn} bg-zinc-900 text-white hover:opacity-90`;
  const btnGhost = `${btn} bg-transparent text-zinc-500 border border-zinc-200 hover:bg-zinc-50`;

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md">

        {/* לוגו */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-full bg-zinc-900 flex items-center justify-center mx-auto mb-3">
            <span className="text-amber-400 font-medium text-lg">L</span>
          </div>
          <h1 className="text-xl font-medium text-zinc-900">לירון — ספר</h1>
          <p className="text-sm text-zinc-400 mt-0.5">קביעת תור</p>
        </div>

        {/* מחוון שלב */}
        <div className="flex items-center justify-center gap-1.5 mb-8">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all ${
                s < step ? "w-4 bg-amber-400" : s === step ? "w-6 bg-zinc-900" : "w-1.5 bg-zinc-200"
              }`}
            />
          ))}
        </div>

        {/* ── שלב 1: לוח שנה ── */}
        {step === 1 && (
          <div className="bg-white border border-zinc-200 rounded-2xl p-5">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-4">בחר תאריך</p>

            {/* ניווט חודש */}
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => changeMonth(-1)}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50"
              >‹</button>
              <span className="text-sm font-medium">
                {HEB_MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
              </span>
              <button
                onClick={() => changeMonth(1)}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50"
              >›</button>
            </div>

            {/* כותרות ימים */}
            <div className="grid grid-cols-7 gap-1 mb-1">
              {HEB_DAYS_SHORT.map((d) => (
                <div key={d} className="text-center text-xs text-zinc-400 py-1 font-medium">{d}</div>
              ))}
            </div>

            {/* ימים */}
            <div className="grid grid-cols-7 gap-1">
              {calendarCells.map((cell, i) => {
                if (!cell) return <div key={`e-${i}`} />;
                const isSelected = selectedDate && toDateStr(selectedDate) === cell.dateStr;
                const disabled = cell.closed || cell.past;
                return (
                  <button
                    key={cell.dateStr}
                    disabled={disabled}
                    onClick={() => { setSelectedDate(cell.date); setSelectedSlot(null); }}
                    className={`aspect-square text-sm rounded-lg transition-all
                      ${disabled ? "text-zinc-300 cursor-not-allowed" : "hover:border hover:border-zinc-300"}
                      ${isSelected ? "bg-zinc-900 text-white" : "text-zinc-700"}`}
                  >
                    {cell.date.getDate()}
                  </button>
                );
              })}
            </div>

            <p className="text-xs text-zinc-400 text-center mt-3">ימי שני ושבת — סגור</p>

            <button
              disabled={!selectedDate}
              onClick={() => setStep(2)}
              className={`${btnPrimary} mt-5`}
            >
              המשך לבחירת שעה →
            </button>
          </div>
        )}

        {/* ── שלב 2: בחירת שעה ── */}
        {step === 2 && (
          <div>
            <button
              onClick={() => setStep(1)}
              className="flex items-center gap-1 text-sm text-zinc-500 mb-4 hover:text-zinc-700"
            >
              → חזרה לבחירת תאריך
            </button>

            <div className="bg-white border border-zinc-200 rounded-2xl p-5">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-1">
                שעות פנויות
              </p>
              <p className="text-sm text-zinc-600 mb-4">
                {selectedDate && formatDate(toDateStr(selectedDate))}
              </p>

              {slotsLoading ? (
                <p className="text-sm text-zinc-400 text-center py-8">טוען שעות...</p>
              ) : availableSlots.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-zinc-400">אין שעות פנויות ביום זה</p>
                  <button onClick={() => setStep(1)} className="text-xs text-zinc-500 underline mt-2">
                    בחר תאריך אחר
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {availableSlots.map((slot) => (
                    <button
                      key={slot}
                      onClick={() => setSelectedSlot(slot)}
                      className={`py-2 text-sm rounded-lg border transition-all
                        ${selectedSlot === slot
                          ? "bg-zinc-900 text-white border-zinc-900"
                          : "border-zinc-200 text-zinc-700 hover:border-zinc-800"}`}
                    >
                      {slot}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              disabled={!selectedSlot}
              onClick={() => setStep(3)}
              className={`${btnPrimary} mt-4`}
            >
              המשך לפרטים →
            </button>
          </div>
        )}

        {/* ── שלב 3: פרטי לקוח ── */}
        {step === 3 && (
          <div>
            <button
              onClick={() => setStep(2)}
              className="flex items-center gap-1 text-sm text-zinc-500 mb-4 hover:text-zinc-700"
            >
              → {selectedSlot} · {selectedDate && formatDate(toDateStr(selectedDate))}
            </button>

            <div className="bg-white border border-zinc-200 rounded-2xl p-5">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-widest mb-4">
                פרטי הלקוח
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1.5">שם מלא</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="ישראל ישראלי"
                    className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm
                               text-zinc-800 bg-zinc-50 focus:outline-none focus:border-zinc-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1.5">מספר טלפון</label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="050-000-0000"
                    className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm
                               text-zinc-800 bg-zinc-50 focus:outline-none focus:border-zinc-900"
                  />
                </div>
              </div>

              {/* סיכום */}
              <div className="mt-5 pt-4 border-t border-zinc-100 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-400">תאריך</span>
                  <span className="text-zinc-700 font-medium">
                    {selectedDate && formatDate(toDateStr(selectedDate))}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">שעה</span>
                  <span className="text-zinc-700 font-medium">{selectedSlot}</span>
                </div>
              </div>

              {error && (
                <p className="mt-3 text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
              )}
            </div>

            <button
              disabled={!name.trim() || !phone.trim() || submitting}
              onClick={handleSubmit}
              className={`${btnPrimary} mt-4`}
            >
              {submitting ? "שומר תור..." : "קביעת תור ✓"}
            </button>
          </div>
        )}

        {/* ── שלב 4: אישור ── */}
        {step === 4 && (
          <div className="bg-white border border-zinc-200 rounded-2xl p-8 text-center">
            <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto mb-4 text-2xl">
              ✓
            </div>
            <h2 className="text-lg font-medium text-zinc-900 mb-1">התור נקבע!</h2>
            <p className="text-sm text-zinc-400 mb-6">נשמח לראותך אצל לירון</p>

            <div className="border-t border-zinc-100 pt-4 space-y-2.5 text-sm text-right">
              {[
                ["לקוח", name],
                ["טלפון", phone],
                ["תאריך", selectedDate ? formatDate(toDateStr(selectedDate)) : ""],
                ["שעה", selectedSlot],
              ].map(([label, val]) => (
                <div key={label} className="flex justify-between">
                  <span className="text-zinc-400">{label}</span>
                  <span className="font-medium text-zinc-800">{val}</span>
                </div>
              ))}
            </div>

            <button onClick={reset} className={`${btnGhost} mt-6`}>
              קביעת תור נוסף
            </button>
          </div>
        )}

        {/* קישור לניהול */}
        <p className="text-center mt-6">
          <button
            onClick={() => window.location.hash = "#admin"}
            className="text-xs text-zinc-300 hover:text-zinc-500 transition-colors"
          >
            כניסה לניהול
          </button>
        </p>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  ADMIN LOGIN — מסך כניסה לניהול
// ════════════════════════════════════════════════════════════
function AdminLogin({ onSuccess }) {
  const [pass, setPass] = useState("");
  const [error, setError] = useState(false);

  function handleLogin() {
    if (loginAdmin(pass)) onSuccess();
    else { setError(true); setTimeout(() => setError(false), 1500); }
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white border border-zinc-200 rounded-2xl p-8 w-80 text-center">
        <div className="w-10 h-10 rounded-full bg-zinc-900 flex items-center justify-center mx-auto mb-4">
          <span className="text-amber-400 font-medium">L</span>
        </div>
        <h2 className="font-medium text-zinc-900 mb-1">כניסה לניהול</h2>
        <p className="text-xs text-zinc-400 mb-5">לירון בלבד</p>

        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
          placeholder="סיסמה"
          className={`w-full px-3 py-2 border rounded-lg text-sm mb-3 focus:outline-none
            text-zinc-800 bg-zinc-50 transition-colors
            ${error ? "border-red-300 focus:border-red-400" : "border-zinc-200 focus:border-zinc-900"}`}
        />
        {error && <p className="text-xs text-red-500 mb-2">סיסמה שגויה</p>}

        <button
          onClick={handleLogin}
          className="w-full py-2 bg-zinc-900 text-white text-sm rounded-xl hover:opacity-90 transition-opacity"
        >
          כניסה
        </button>

        <button
          onClick={() => { window.location.hash = ""; }}
          className="text-xs text-zinc-400 mt-4 hover:text-zinc-600 transition-colors"
        >
          ← חזרה לקביעת תור
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD — פאנל ניהול
// ════════════════════════════════════════════════════════════
function AdminDashboard({ onLogout }) {
  const { appointments, loading, deleteAppointment } = useAppointments();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const todayStr = useMemo(() => toDateStr(new Date()), []);

  const stats = useMemo(() => {
    const todayAppts = appointments.filter((a) => a.date === todayStr);
    const upcoming = appointments.filter((a) => a.date > todayStr);
    const nextAppt = appointments.find(
      (a) => a.date === todayStr && getStatus(a.date, a.time_slot) === "today"
    );
    return { todayCount: todayAppts.length, upcomingCount: upcoming.length, nextAppt };
  }, [appointments, todayStr]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return appointments.filter((a) => {
      const status = getStatus(a.date, a.time_slot);
      const matchFilter =
        filter === "all" ||
        (filter === "today" && a.date === todayStr) ||
        (filter === "upcoming" && (status === "today" || status === "upcoming"));
      const matchQ =
        !q ||
        a.customer_name.toLowerCase().includes(q) ||
        a.customer_phone.includes(q);
      return matchFilter && matchQ;
    });
  }, [appointments, filter, search, todayStr]);

  const grouped = useMemo(() => {
    return filtered.reduce((acc, a) => {
      if (!acc[a.date]) acc[a.date] = [];
      acc[a.date].push(a);
      return acc;
    }, {});
  }, [filtered]);

  function handleDelete(id) {
    if (window.confirm("למחוק תור זה?")) deleteAppointment(id);
  }

  function handleLogout() {
    localStorage.removeItem("liron_admin");
    onLogout();
  }

  function StatusBadge({ dateStr, timeSlot }) {
    const s = getStatus(dateStr, timeSlot);
    const map = {
      past:     ["bg-zinc-100 text-zinc-400", "עבר"],
      today:    ["bg-amber-50 text-amber-700", "היום"],
      upcoming: ["bg-green-50 text-green-700", "קרוב"],
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[s][0]}`}>
        {map[s][1]}
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-4 md:p-6" dir="rtl">
      <div className="max-w-4xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-zinc-900 flex items-center justify-center flex-shrink-0">
              <span className="text-amber-400 font-medium text-sm">L</span>
            </div>
            <div>
              <h1 className="text-sm font-medium text-zinc-900">פאנל ניהול · לירון</h1>
              <p className="text-xs text-zinc-400">מתעדכן בזמן אמת</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full bg-green-50 text-green-700 font-medium">
              ● חי
            </span>
            <button
              onClick={handleLogout}
              className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              יציאה
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: "תורים היום", value: stats.todayCount, sub: todayStr },
            { label: "תורים קרובים", value: stats.upcomingCount, sub: "מחר והלאה" },
            {
              label: "תור הבא",
              value: stats.nextAppt ? stats.nextAppt.time_slot.slice(0, 5) : "—",
              sub: stats.nextAppt ? stats.nextAppt.customer_name : "אין תורים",
            },
          ].map((s) => (
            <div key={s.label} className="bg-white border border-zinc-200 rounded-xl p-4">
              <p className="text-xs text-zinc-400 mb-1">{s.label}</p>
              <p className="text-2xl font-medium text-zinc-900">{s.value}</p>
              <p className="text-xs text-zinc-400 mt-1">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם או טלפון..."
            className="flex-1 min-w-[180px] px-3 py-2 text-sm border border-zinc-200 rounded-lg
                       bg-white text-zinc-800 focus:outline-none focus:border-zinc-900"
          />
          {[
            { key: "all", label: "הכל" },
            { key: "today", label: "היום" },
            { key: "upcoming", label: "קרוב" },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 text-xs rounded-lg border transition-all whitespace-nowrap
                ${filter === f.key
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400"}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          {loading ? (
            <p className="text-center text-sm text-zinc-400 py-12">טוען תורים...</p>
          ) : Object.keys(grouped).length === 0 ? (
            <p className="text-center text-sm text-zinc-400 py-12">לא נמצאו תורים</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ tableLayout: "fixed", minWidth: "560px" }}>
                <colgroup>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                </colgroup>
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200">
                    {["לקוח", "תאריך", "שעה", "טלפון", "סטטוס", ""].map((h) => (
                      <th
                        key={h}
                        className="text-right px-4 py-2.5 text-xs font-medium text-zinc-400"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(grouped)
                    .sort()
                    .map((date) => (
                      <>
                        <tr key={`h-${date}`}>
                          <td
                            colSpan={6}
                            className="px-4 py-2 text-xs font-medium text-zinc-400
                                       bg-zinc-50 border-y border-zinc-100 uppercase tracking-wide"
                          >
                            {formatDate(date)}
                          </td>
                        </tr>
                        {grouped[date].map((a) => (
                          <tr
                            key={a.id}
                            className="border-b border-zinc-100 hover:bg-zinc-50 transition-colors"
                          >
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div
                                  className="w-7 h-7 rounded-full bg-indigo-50 flex items-center
                                             justify-content text-xs font-medium text-indigo-600 flex-shrink-0"
                                  style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
                                >
                                  {initials(a.customer_name)}
                                </div>
                                <span className="font-medium text-zinc-800 truncate">
                                  {a.customer_name}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-zinc-500 text-xs">{formatDate(a.date)}</td>
                            <td className="px-4 py-3 font-medium text-zinc-900">
                              {a.time_slot.slice(0, 5)}
                            </td>
                            <td className="px-4 py-3 text-zinc-400 text-xs">{a.customer_phone}</td>
                            <td className="px-4 py-3">
                              <StatusBadge dateStr={a.date} timeSlot={a.time_slot} />
                            </td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => handleDelete(a.id)}
                                className="w-7 h-7 rounded-lg border border-zinc-200 text-zinc-400
                                           hover:bg-red-50 hover:border-red-200 hover:text-red-500
                                           flex items-center justify-center transition-all text-xs"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-center mt-4">
          <button
            onClick={() => { window.location.hash = ""; }}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← חזרה לממשק הלקוח
          </button>
        </p>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  APP ROOT — ניתוב ראשי
// ════════════════════════════════════════════════════════════
export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const [adminAuthed, setAdminAuthed] = useState(isAdmin());

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (hash === "#admin") {
    if (!adminAuthed) {
      return <AdminLogin onSuccess={() => setAdminAuthed(true)} />;
    }
    return <AdminDashboard onLogout={() => { setAdminAuthed(false); }} />;
  }

  return <BookingFlow />;
}
