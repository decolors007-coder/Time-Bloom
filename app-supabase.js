// Time-Bloom — resilient build with live-status + debug helpers
(function(){
  const hasSupabaseLib = typeof window !== 'undefined' && window.supabase && window.supabase.createClient;

  // ======= CONFIG: fill these for live sync =======
  const SUPABASE_URL = 'YOUR_SUPABASE_URL';        // e.g., https://xyz.supabase.co
  const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
  // ================================================

  // Backend selector
  let backend = 'local';
  let supabase = null;

  if (hasSupabaseLib && SUPABASE_URL.startsWith('http') && !SUPABASE_ANON_KEY.includes('YOUR_')) {
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      backend = 'supabase';
      console.log('[Time-Bloom] Supabase enabled');
    } catch (e) {
      console.warn('[Time-Bloom] Supabase init failed, using local fallback:', e);
      backend = 'local';
    }
  } else {
    console.warn('[Time-Bloom] Using local fallback (set SUPABASE_URL & ANON_KEY for live sync)');
  }

  // Store abstraction
  const store = backend === 'supabase' ? {
    async loadAll(calendarId){
      const { data, error } = await supabase.from('events').select('date_key,hour,text').eq('calendar_id', calendarId);
      if (error) throw error;
      return data;
    },
    async upsert(calendarId, date_key, hour, text){
      if (text.trim() === '') {
        await supabase.from('events').delete().match({ calendar_id: calendarId, date_key, hour });
      } else {
        await supabase.from('events').upsert([{ calendar_id: calendarId, date_key, hour, text: text.trim() }], { onConflict: 'calendar_id,date_key,hour' });
      }
    },
    subscribe(calendarId, onChange){
      const ch = supabase
        .channel('timebloom_'+calendarId)
        .on('postgres_changes',{ event:'*', schema:'public', table:'events', filter:`calendar_id=eq.${calendarId}` }, (payload) => onChange(payload))
        .subscribe((status) => { if (status === 'SUBSCRIBED') setLiveBadge('Supabase'); });
      return () => { try { ch.unsubscribe(); } catch(_){} };
    }
  } : {
    // localStorage fallback (works within same browser; not cross-users)
    async loadAll(calendarId){
      const raw = localStorage.getItem('tb_'+calendarId) || '{}';
      const map = JSON.parse(raw);
      const rows = [];
      for (const dk of Object.keys(map)) {
        for (const h of Object.keys(map[dk])) {
          rows.push({ date_key: dk, hour: Number(h), text: map[dk][h] });
        }
      }
      setLiveBadge('Local only');
      return rows;
    },
    async upsert(calendarId, date_key, hour, text){
      const key = 'tb_'+calendarId;
      const map = JSON.parse(localStorage.getItem(key) || '{}');
      if (!map[date_key]) map[date_key] = {};
      if (text.trim() === '') { delete map[date_key][String(hour)]; } else { map[date_key][String(hour)] = text.trim(); }
      if (map[date_key] && Object.keys(map[date_key]).length === 0) delete map[date_key];
      localStorage.setItem(key, JSON.stringify(map));
      // notify other tabs on same origin
      localStorage.setItem('tb_ping', String(Date.now()));
    },
    subscribe(calendarId, onChange){
      const handler = (e) => { if (e.key === 'tb_ping') onChange({ eventType:'LOCAL' }); };
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    }
  };

  // ---------- UI + Logic ----------
  const now = new Date();
  let state = {
    month: now.getMonth(),
    year: now.getFullYear(),
    selectedDate: fmtDateKey(now),
    events: {}, // { [date]: { [hour]: text } }
    calendarId: null,
  };

  const $ = (id) => document.getElementById(id);
  const monthSelect = $('monthSelect');
  const yearSelect = $('yearSelect');
  const prevMonthBtn = $('prevMonthBtn');
  const nextMonthBtn = $('nextMonthBtn');
  const todayBtn = $('todayBtn');
  const monthLabel = $('monthLabel');
  const calendarGrid = $('calendarGrid');
  const seasonTag = $('seasonTag');
  const toCalendarBtn = $('toCalendarBtn');
  const toDayBtn = $('toDayBtn');
  const prevDayBtn = $('prevDayBtn');
  const nextDayBtn = $('nextDayBtn');
  const selectedDateKey = $('selectedDateKey');
  const prettyDate = $('prettyDate');
  const slotsContainer = $('slotsContainer');
  const saveBtn = $('saveBtn');
  const shareEditableBtn = $('shareEditableBtn');
  const liveModeEl = $('liveMode');

  // Expose simple debugger
  window.tbDebug = {
    get mode(){ return backend; },
    get id(){ return state.calendarId; },
    async ping(){
      if (backend !== 'supabase') return { ok:false, reason:'not_supabase' };
      try {
        const { error } = await supabase.from('events').select('date_key', { head:true, count:'exact' }).limit(1);
        return { ok: !error, error };
      } catch (e) { return { ok:false, error:e }; }
    }
  };

  init().catch(err => console.error(err));

  async function init(){
    initSelects();
    await initCalendarId();
    applyMonthBackground(state.month);
    render();
    await loadAllEventsForCalendar();
    subscribeRealtime();
    bindEvents();
    // If in Supabase mode but no realtime yet, label as "Supabase" after initial read succeeds
    if (backend==='supabase') setLiveBadge('Supabase');
  }

  function bindEvents(){
    prevMonthBtn.addEventListener('click', () => { const d = new Date(state.year, state.month - 1, 1); state.year=d.getFullYear(); state.month=d.getMonth(); render(); });
    nextMonthBtn.addEventListener('click', () => { const d = new Date(state.year, state.month + 1, 1); state.year=d.getFullYear(); state.month=d.getMonth(); render(); });
    todayBtn.addEventListener('click', () => { const d = new Date(); state.year=d.getFullYear(); state.month=d.getMonth(); state.selectedDate = fmtDateKey(d); render(); });
    monthSelect.addEventListener('change', (e) => { state.month = Number(e.target.value); render(); });
    yearSelect.addEventListener('change', (e) => { state.year = Number(e.target.value); render(); });
    toCalendarBtn.addEventListener('click', () => document.querySelector('.calendar-section').scrollIntoView({behavior:'smooth'}));
    toDayBtn.addEventListener('click', () => document.querySelector('.day-section').scrollIntoView({behavior:'smooth'}));
    prevDayBtn.addEventListener('click', () => { const d = parseDateKey(state.selectedDate); d.setDate(d.getDate() - 1); state.selectedDate = fmtDateKey(d); renderDay(); });
    nextDayBtn.addEventListener('click', () => { const d = parseDateKey(state.selectedDate); d.setDate(d.getDate() + 1); state.selectedDate = fmtDateKey(d); renderDay(); });

    saveBtn.addEventListener('click', () => saveCurrentDay());
    shareEditableBtn.addEventListener('click', () => makeShareLink());
  }

  function setLiveBadge(modeText){
    if (liveModeEl) liveModeEl.textContent = modeText;
  }

  function initSelects() {
    const months = Array.from({length:12}, (_, m) => new Date(2000, m, 1).toLocaleString(undefined, {month:'long'}));
    monthSelect.innerHTML = months.map((label, m) => `<option value="${m}">${label}</option>`).join('');
    monthSelect.value = state.month;

    const base = now.getFullYear();
    const years = Array.from({length:21}, (_, i) => base - 10 + i);
    yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSelect.value = state.year;
  }

  function render() {
    monthLabel.textContent = `${new Date(state.year, state.month, 1).toLocaleString(undefined, {month:'long'})} ${state.year}`;
    applyMonthBackground(state.month);
    renderCalendar();
    renderDay();
  }

  function renderCalendar() {
    const first = new Date(state.year, state.month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < startPad; i++) cells.push({ type: 'pad' });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = fmtDateKey(new Date(state.year, state.month, d));
      cells.push({ type: 'day', day: d, dateKey });
    }

    calendarGrid.innerHTML = '';
    cells.forEach((cell) => {
      if (cell.type === 'pad') {
        const div = document.createElement('div'); div.className = 'pad'; calendarGrid.appendChild(div); return;
      }
      const isToday = cell.dateKey === fmtDateKey(new Date());
      const hasItems = !!state.events[cell.dateKey] && Object.keys(state.events[cell.dateKey]).length > 0;

      const btn = document.createElement('button');
      btn.className = 'cell';
      btn.setAttribute('aria-label', `Open ${cell.dateKey}`);
      btn.addEventListener('click', () => { state.selectedDate = cell.dateKey; renderDay(); document.querySelector('.day-section').scrollIntoView({behavior:'smooth'}); });

      const num = document.createElement('div'); num.className = 'day-num'; num.textContent = cell.day; btn.appendChild(num);
      if (isToday) { const tag = document.createElement('span'); tag.className = 'today-tag'; tag.textContent='today'; btn.appendChild(tag); }
      if (hasItems) {
        const peek = document.createElement('div'); peek.className = 'peek';
        const entries = Object.entries(state.events[cell.dateKey])
          .sort((a,b) => Number(a[0]) - Number(b[0]))
          .slice(0,2)
          .map(([h, t]) => `${fmtHour(Number(h))}: ${t}`);
        peek.textContent = entries.join(' • '); btn.appendChild(peek);
      }
      calendarGrid.appendChild(btn);
    });
  }

  function renderDay() {
    selectedDateKey.textContent = state.selectedDate;
    prettyDate.textContent = fmtPrettyDate(state.selectedDate);

    const HOURS = Array.from({length:16}, (_, i) => 7 + i);
    slotsContainer.innerHTML = '';

    HOURS.forEach(h => {
      const row = document.createElement('div'); row.className = 'slot';
      const hour = document.createElement('div'); hour.className = 'hour'; hour.textContent = fmtHour(h);
      const text = document.createElement('textarea');
      text.placeholder = 'Add note or appointment…';
      text.value = (state.events[state.selectedDate] || {})[String(h)] || '';
      text.dataset.hour = String(h);
      text.addEventListener('input', (e) => scheduleSlotSave(state.selectedDate, h, e.target.value));

      row.appendChild(hour); row.appendChild(text); slotsContainer.appendChild(row);
    });
  }

  async function loadAllEventsForCalendar() {
    try {
      const rows = await store.loadAll(state.calendarId);
      const map = {};
      for (const row of rows) {
        if (!map[row.date_key]) map[row.date_key] = {};
        map[row.date_key][String(row.hour)] = row.text;
      }
      state.events = map;
      renderDay();
      renderCalendar();
      markOnline();
    } catch (e) {
      console.error('Load failed', e);
      markOffline();
    }
  }

  function subscribeRealtime() {
    try {
      const unsub = store.subscribe(state.calendarId, () => {
        loadAllEventsForCalendar();
      });
      window.__tb_unsub = unsub;
      markOnline();
    } catch (e) {
      console.error('Subscribe failed', e);
      markOffline();
    }
  }

  // Debounced single-slot writes
  const saveTimers = new Map();
  function scheduleSlotSave(dateKey, hour, value) {
    const k = `${dateKey}-${hour}`;
    if (saveTimers.has(k)) clearTimeout(saveTimers.get(k));
    saveTimers.set(k, setTimeout(() => saveSlot(dateKey, hour, value), 200));
  }

  async function saveSlot(dateKey, hour, value) {
    try {
      await store.upsert(state.calendarId, dateKey, hour, value);
      if (!state.events[dateKey]) state.events[dateKey] = {};
      if (String(value).trim() === '') {
        delete state.events[dateKey][String(hour)];
        if (Object.keys(state.events[dateKey]).length === 0) delete state.events[dateKey];
      } else {
        state.events[dateKey][String(hour)] = String(value).trim();
      }
      renderCalendar(); // refresh peeks
      markOnline();
    } catch (e) {
      console.error('Save failed', e);
      markOffline();
    }
  }

  async function saveCurrentDay() {
    const btn = saveBtn;
    const originalText = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const areas = slotsContainer.querySelectorAll('textarea[data-hour]');
      const ops = [];
      areas.forEach((ta) => {
        const h = Number(ta.dataset.hour);
        const val = ta.value || '';
        ops.push(store.upsert(state.calendarId, state.selectedDate, h, val));
        if (!state.events[state.selectedDate]) state.events[state.selectedDate] = {};
        if (val.trim() === '') {
          delete state.events[state.selectedDate][String(h)];
        } else {
          state.events[state.selectedDate][String(h)] = val.trim();
        }
      });
      await Promise.all(ops);
      renderCalendar();
      markOnline();
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 800);
    } catch (e) {
      console.error('Save day failed', e);
      btn.textContent = 'Error — see console';
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1200);
      markOffline();
    }
  }

  function applyMonthBackground(monthIndex) {
    const surface = document.getElementById('calendarGrid');
    const bg = monthGradient(monthIndex);
    surface.style.backgroundImage = `linear-gradient(180deg, rgba(17,24,39,0.25), rgba(17,24,39,0.25)), ${bg}`;
    seasonTag.textContent = seasonLabel(getSeason(monthIndex));
  }
  function monthGradient(m){
    const mk = (c1, c2) => `linear-gradient(135deg, ${c1}, ${c2})`;
    const map = {
      0: mk('#0b1220', '#3b82f6'),
      1: mk('#0b1220', '#ec4899'),
      2: mk('#0b1220', '#10b981'),
      3: mk('#0b1220', '#60a5fa'),
      4: mk('#0b1220', '#f59e0b'),
      5: mk('#0b1220', '#fb7185'),
      6: mk('#0b1220', '#93c5fd'),
      7: mk('#0b1220', '#14b8a6'),
      8: mk('#0b1220', '#ca8a04'),
      9: mk('#0b1220', '#f97316'),
      10: mk('#0b1220', '#b45309'),
      11: mk('#0b1220', '#818cf8'),
    };
    return map[m] || map[0];
  }
  function getSeason(m){ if (m===11||m===0||m===1) return '❄︎ Winter'; if (m>=2 && m<=4) return '🌸 Spring'; if (m>=5 && m<=7) return '☀︎ Summer'; return '🍂 Fall'; }
  function seasonLabel(label){ return label; }

  function makeShareLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('id', state.calendarId);
    const link = url.toString();
    navigator.clipboard?.writeText(link).then(() => {
      alert('Editable team link copied!' + (backend==='local' ? '\n(You are in local mode — set Supabase keys for live sync across devices.)' : ''));
    }).catch(() => { prompt('Copy this link:', link); });
  }

  async function initCalendarId() {
    const params = new URLSearchParams(window.location.search);
    let id = params.get('id');
    if (!id) {
      id = randomId(20);
      params.set('id', id);
      history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
    }
    state.calendarId = id;
  }
  function randomId(len=16) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    return out;
  }

  function markOnline(){ document.body.classList.remove('offline'); const live=document.getElementById('liveStatus'); if (live) live.style.opacity='1'; }
  function markOffline(){ document.body.classList.add('offline'); const live=document.getElementById('liveStatus'); if (live) live.style.opacity='1'; }

  function fmtDateKey(d){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
  function parseDateKey(key){ const [y,m,d]=key.split('-').map(Number); return new Date(y,(m||1)-1,d||1); }
  function fmtPrettyDate(dateKey){ const d=parseDateKey(dateKey); return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric'}); }
  function fmtHour(h){ const ampm=h>=12?'PM':'AM'; const hour12=((h+11)%12)+1; return `${hour12}:00 ${ampm}`; }
})();