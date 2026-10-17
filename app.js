(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const form = $('#chatForm');
  const input = $('#messageInput');
  const list = $('#messageList');
  const stage = $('#orbStage');
  const stateLabel = $('#assistantState');
  const typing = $('#typingIndicator');
  const sendButton = $('#sendButton');
  const micToggle = $('#micToggle');
  const micLabel = $('#micLabel');
  const voiceToggle = $('#voiceToggle');
  const voiceLabel = $('#voiceLabel');
  const voiceNote = $('#voiceNote');
  const connectionPill = $('.system-pill');
  const connectionText = $('#connectionText');
  const phoneInput = $('#phoneInput');
  const callButton = $('#callButton');
  const clockLabel = $('#localClock');
  const clearButton = $('#clearChat');
  const callPanelToggle = $('#callPanelToggle');
  const callPanel = $('#callPanel');
  const featureNotice = $('#featureNotice');
  const featureCount = $('#featureCount');
  const featureTitle = $('#featureTitle');
  const featureText = $('#featureText');
  const featureProgress = $('#featureProgress');

  const conversationId = getConversationId();
  let micActive = false;
  let voiceActive = false;
  let micStream = null;
  let audioContext = null;
  let audioAnalyser = null;
  let audioSource = null;
  let audioFrame = 0;
  let speechRecorder = null;
  let speechChunks = [];
  let speechStartedAt = 0;
  let lastVoiceAt = 0;
  let noiseFloor = 0.006;
  let bargeInFrames = 0;
  let isRecordingSpeech = false;
  let recorderStopping = false;
  let isTranscribing = false;
  let isSending = false;
  let gestureTimer = null;
  const SILENCE_MS = 650;
  const BARGE_IN_CONFIRM_FRAMES = 8;
  const BARGE_IN_RMS = 0.045;
  const MAX_CLIP_MS = 15000;

  // ===== Humanoid life: gaze tracking, blinking, lip-sync, emotions, idle behaviour =====
  const headLook = document.querySelector('.head-look');
  const bodyEl = document.querySelector('.avatar-body');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  let pointerAt = 0;
  let typingAt = -10000;
  let wanderUntil = 0;
  let emotionTimer = null;
  let mouthOpen = 0;
  let mouthPulse = 0;
  let beat = 0;
  let lastMouthTarget = 0;
  let lipCtx = null;
  let lipAnalyser = null;
  let lipData = null;
  let speakingNow = false;

  function setEmotion(name, ms = 3200) {
    stage.dataset.emotion = name || 'neutral';
    window.clearTimeout(emotionTimer);
    if (name && name !== 'neutral') {
      emotionTimer = window.setTimeout(() => { stage.dataset.emotion = 'neutral'; }, ms);
    }
  }

  function emotionFromText(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(sorry|unfortunately|afsos|maaf|dukh|sad|couldn'?t|could not|can'?t|failed|nahi mil)\b|दुख|माफ|खेद|अफसोस/.test(t)) return 'sad';
    if (/\bwow\b|\bamazing\b|\bincredible\b|\bunbelievable\b|\barre\b|अरे|वाह/.test(t)) return 'surprised';
    if (/\b(thanks|thank you|great|awesome|congrat\w*|badhai|mubarak|shukriya|dhanyavaad|welcome|glad|happy|love|nice|wonderful|khushi)\b|😊|😄|🙂|🎉|धन्यवाद|बधाई|शुक्रिया|खुश/.test(t)) return 'happy';
    if (/\?\s*$/.test(t.trim())) return 'curious';
    return '';
  }

  function reactToUser(text) {
    const t = String(text || '').toLowerCase().trim();
    if (/^(hi+|hello+|hey+|hii+|namaste|namaskar|good\s+(morning|afternoon|evening)|नमस्ते)\b/.test(t)) {
      setGesture('wave');
      setEmotion('happy', 2800);
    } else if (/\b(thanks|thank you|shukriya|dhanyavaad|धन्यवाद|शुक्रिया)\b/.test(t)) {
      setGesture('namaste');
      setEmotion('happy', 2800);
    } else {
      setGesture('nod');
    }
    wanderUntil = 0;
  }

  function reactToReply(text) {
    const emotion = emotionFromText(text);
    if (emotion) setEmotion(emotion, 3600);
    if (emotion === 'happy' && Math.random() < 0.35) setGesture('excited');
    else if (emotion === 'sad') setGesture('empathetic');
    else if (emotion === 'surprised') setGesture('excited');
  }

  // --- lip-sync ---
  function attachLipSync(audio) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      lipCtx = lipCtx || new AC();
      if (lipCtx.state === 'suspended') lipCtx.resume();
      const source = lipCtx.createMediaElementSource(audio);
      lipAnalyser = lipCtx.createAnalyser();
      lipAnalyser.fftSize = 512;
      lipData = new Uint8Array(lipAnalyser.fftSize);
      source.connect(lipAnalyser);
      lipAnalyser.connect(lipCtx.destination);
    } catch (error) {
      lipAnalyser = null;
    }
  }

  function pulseMouth() { mouthPulse = 1; }

  function onStateChange(state) {
    speakingNow = state === 'speaking';
    if (!speakingNow) lipAnalyser = null;
    if (state === 'thinking') { gaze.tx = -0.55; gaze.ty = -0.6; }
    if (state === 'listening') setEmotion('curious', 1800);
  }

  // --- gaze: follows the pointer, looks down while the user types, wanders when idle ---
  window.addEventListener('pointermove', (event) => {
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height * 0.3;
    gaze.tx = Math.max(-1, Math.min(1, (event.clientX - cx) / (window.innerWidth * 0.5)));
    gaze.ty = Math.max(-1, Math.min(1, (event.clientY - cy) / (window.innerHeight * 0.6)));
    pointerAt = performance.now();
  }, { passive: true });
  input.addEventListener('input', () => { typingAt = performance.now(); });

  function lifeFrame(now) {
    if (!document.hidden) {
      if (now - typingAt < 1600) { gaze.tx = 0; gaze.ty = 0.85; }
      else if (stage.dataset.state === 'thinking') { gaze.tx = -0.55; gaze.ty = -0.6; }
      else if (now < wanderUntil) { /* keep the wander target */ }
      else if (now - pointerAt > 3500 && stage.dataset.state !== 'speaking') { gaze.tx *= 0.98; gaze.ty *= 0.98; }
      gaze.x += (gaze.tx - gaze.x) * 0.16;
      gaze.y += (gaze.ty - gaze.y) * 0.16;

      // lip-sync target: real audio level when available, natural random rhythm otherwise
      let target = 0;
      if (speakingNow) {
        if (lipAnalyser && lipData) {
          lipAnalyser.getByteTimeDomainData(lipData);
          let sum = 0;
          for (let i = 0; i < lipData.length; i += 1) { const v = (lipData[i] - 128) / 128; sum += v * v; }
          target = Math.min(1, Math.sqrt(sum / lipData.length) * 6);
        } else {
          target = 0.25 + 0.55 * Math.abs(Math.sin(now * 0.017 + Math.sin(now * 0.005) * 2));
          target = Math.max(target, mouthPulse * 0.9);
        }
        mouthPulse *= 0.86;
      }
      if (target > 0.6 && lastMouthTarget <= 0.6) beat = 1;
      lastMouthTarget = target;
      mouthOpen += (target - mouthOpen) * 0.5;
      beat *= 0.84;

      stage.style.setProperty('--gx', `${(gaze.x * 2.7).toFixed(2)}px`);
      stage.style.setProperty('--gy', `${(gaze.y * 1.9).toFixed(2)}px`);
      stage.style.setProperty('--mo', mouthOpen.toFixed(2));
      if (headLook && !reduceMotion) {
        headLook.style.transform = `translate(${(gaze.x * 3).toFixed(2)}px, ${(gaze.y * 1.6 + beat * 1.8).toFixed(2)}px) rotate(${(gaze.x * 3.2).toFixed(2)}deg)`;
      }
      if (bodyEl && !reduceMotion) bodyEl.style.setProperty('--bx', `${(gaze.x * 2).toFixed(2)}px`);
    }
    window.requestAnimationFrame(lifeFrame);
  }
  window.requestAnimationFrame(lifeFrame);

  // --- blinking (sometimes a double blink) ---
  function blinkOnce(done) {
    stage.classList.add('blink');
    window.setTimeout(() => { stage.classList.remove('blink'); if (done) done(); }, 120);
  }
  function scheduleBlink() {
    window.setTimeout(() => {
      if (!document.hidden && !reduceMotion) {
        blinkOnce(() => { if (Math.random() < 0.18) window.setTimeout(() => blinkOnce(), 140); });
      }
      scheduleBlink();
    }, 2200 + Math.random() * 3800);
  }
  scheduleBlink();

  // --- small spontaneous behaviours while idle, so it never looks frozen ---
  function scheduleIdleLife() {
    window.setTimeout(() => {
      const idle = stage.dataset.state === 'idle' && (!stage.dataset.gesture || stage.dataset.gesture === 'idle');
      if (idle && !document.hidden && !reduceMotion && performance.now() - typingAt > 2000) {
        const roll = Math.random();
        if (roll < 0.38) {            // glance around
          gaze.tx = (Math.random() * 2 - 1) * 0.9;
          gaze.ty = (Math.random() * 2 - 1) * 0.5;
          wanderUntil = performance.now() + 1600;
        } else if (roll < 0.58) {     // curious head tilt
          setEmotion('curious', 2200);
        } else if (roll < 0.76) {     // small smile
          setEmotion('happy', 1800);
        } else if (roll < 0.88) {
          setGesture('shrug');
        } else if (roll < 0.95) {
          setGesture('nod');
        } else {
          setGesture('wave');
        }
      }
      scheduleIdleLife();
    }, 6000 + Math.random() * 8000);
  }
  scheduleIdleLife();

  function getConversationId() {
    const storageKey = 'abhi-ai-conversation-id';
    let id = '';
    try { id = localStorage.getItem(storageKey) || ''; } catch (_error) { /* Private browsing may block storage. */ }
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(id)) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replaceAll('-', '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
      try { localStorage.setItem(storageKey, id); } catch (_error) { /* Continue with in-memory ID. */ }
    }
    return id;
  }

  function setState(state, label) {
    stage.dataset.state = state;
    stateLabel.textContent = label || ({ idle: 'Ready to listen', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' }[state] || 'Ready to listen');
    onStateChange(state);
  }

  function setGesture(gesture) {
    stage.dataset.gesture = gesture || 'idle';
    if (gesture === 'smile' || gesture === 'wave' || gesture === 'namaste') setEmotion('happy', 2600);
    else if (gesture === 'thinking') setEmotion('thinking', 2200);
    else if (gesture === 'empathetic') setEmotion('sad', 2600);
    else if (gesture === 'listening') setEmotion('curious', 2200);
    window.clearTimeout(gestureTimer);
    if (gesture && gesture !== 'idle') {
      gestureTimer = window.setTimeout(() => { stage.dataset.gesture = 'idle'; }, 2200);
    }
  }

  window.requestAnimationFrame(() => setGesture('namaste'));

  function parseAssistantReply(rawText) {
    const raw = String(rawText || '').trim();
    const cues = {
      'smiles': 'smile',
      'smiles warmly': 'smile',
      'nods': 'nod',
      'looks thoughtful': 'thinking',
      'waves': 'wave',
      'listens attentively': 'listening',
      'gives a reassuring nod': 'empathetic',
      'joins hands in a polite namaste': 'namaste',
      'namaste': 'namaste'
    };
    const match = raw.match(/^\[([a-z ]{2,32})\]\s*/i);
    if (!match) return { text: raw, gesture: '' };
    const gesture = cues[match[1].toLowerCase()];
    return gesture
      ? { text: raw.slice(match[0].length).trim(), gesture }
      : { text: raw, gesture: '' };
  }

  function setConnection(online, label) {
    connectionPill.classList.toggle('offline', !online);
    connectionText.textContent = label;
  }

  function updateClock() {
    const now = new Date();
    clockLabel.textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(now);
  }
  updateClock();
  window.setInterval(updateClock, 30_000);

  const featureItems = [
    { title: 'Voice chat', detail: 'Speak naturally or type a message.' },
    { title: 'Smart AI replies', detail: 'Ask questions and get helpful answers.' },
    { title: 'Play songs and open apps', detail: 'Say "play Tum Hi Ho on YouTube" or "open WhatsApp".' },
    { title: 'Time and date', detail: 'Get your local time, weekday and date.' },
    { title: 'Click-to-call', detail: 'Open your dialer and confirm the call.' }
  ];
  let activeFeature = 0;
  window.setInterval(() => {
    if (document.hidden || !featureNotice) return;
    activeFeature = (activeFeature + 1) % featureItems.length;
    featureNotice.classList.add('is-changing');
    window.setTimeout(() => {
      const item = featureItems[activeFeature];
      featureCount.textContent = `${String(activeFeature + 1).padStart(2, '0')} / ${String(featureItems.length).padStart(2, '0')}`;
      featureTitle.textContent = item.title;
      featureText.textContent = item.detail;
      featureProgress.style.animation = 'none';
      void featureProgress.offsetWidth;
      featureProgress.style.animation = '';
      featureNotice.classList.remove('is-changing');
    }, 130);
  }, 1000);

  function scrollConversation() {
    const panel = $('#conversation');
    panel.scrollTop = panel.scrollHeight;
  }

  // ---- Rich replies: tables, charts, lists, bold/code ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CHART_COLORS = ['#b6ff00', '#4dd2ff', '#ff8b78', '#c58bff', '#ffd24d', '#5eead4', '#f472b6', '#a3e635'];

  function appendInline(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      const token = match[0];
      const element = document.createElement(token.startsWith('**') ? 'strong' : 'code');
      element.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1);
      parent.append(element);
      last = match.index + token.length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|');
  }

  function renderTable(container, headerLine, bodyLines) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const cell of splitTableRow(headerLine)) {
      const th = document.createElement('th');
      appendInline(th, cell);
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const line of bodyLines) {
      const row = document.createElement('tr');
      for (const cell of splitTableRow(line)) {
        const td = document.createElement('td');
        appendInline(td, cell);
        row.append(td);
      }
      body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    container.append(wrap);
  }

  function svgEl(tag, attrs, parent) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs || {})) element.setAttribute(name, String(value));
    if (parent) parent.append(element);
    return element;
  }

  function formatNumber(value) {
    if (Math.abs(value) >= 1000) return Number(value.toPrecision(4)).toLocaleString('en-IN');
    return String(Number(value.toFixed(2)));
  }

  function renderChart(container, spec) {
    if (!spec || typeof spec !== 'object') return false;
    const type = ['bar', 'line', 'pie', 'doughnut'].includes(spec.type) ? spec.type : 'bar';
    const labels = (Array.isArray(spec.labels) ? spec.labels : []).slice(0, 30).map(String);
    const datasets = (Array.isArray(spec.datasets) ? spec.datasets : []).slice(0, 6).map((set) => ({
      label: String((set && set.label) || ''),
      data: (Array.isArray(set && set.data) ? set.data : []).slice(0, 30).map(Number).map((n) => (Number.isFinite(n) ? n : 0))
    })).filter((set) => set.data.length);
    if (!labels.length || !datasets.length) return false;

    const figure = document.createElement('figure');
    figure.className = 'chart-card';
    if (spec.title) {
      const caption = document.createElement('figcaption');
      caption.textContent = String(spec.title).slice(0, 120);
      figure.append(caption);
    }

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    const addLegend = (color, text) => {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = color;
      item.append(dot, document.createTextNode(text));
      legend.append(item);
    };

    if (type === 'pie' || type === 'doughnut') {
      const values = datasets[0].data.map((n) => Math.max(0, n));
      const total = values.reduce((sum, n) => sum + n, 0);
      if (total <= 0) return false;
      const svg = svgEl('svg', { viewBox: '0 0 220 220', class: 'chart-svg chart-pie', role: 'img', 'aria-label': spec.title || 'Chart' }, figure);
      const cx = 110; const cy = 110; const radius = 100;
      let angle = -Math.PI / 2;
      values.forEach((value, index) => {
        if (value <= 0) return;
        const color = CHART_COLORS[index % CHART_COLORS.length];
        const sweep = (value / total) * Math.PI * 2;
        if (value === total) {
          svgEl('circle', { cx, cy, r: radius, fill: color }, svg);
        } else {
          const x1 = cx + radius * Math.cos(angle); const y1 = cy + radius * Math.sin(angle);
          const x2 = cx + radius * Math.cos(angle + sweep); const y2 = cy + radius * Math.sin(angle + sweep);
          svgEl('path', { d: `M${cx} ${cy}L${x1.toFixed(2)} ${y1.toFixed(2)}A${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}Z`, fill: color, stroke: '#070806', 'stroke-width': 1.5 }, svg);
        }
        angle += sweep;
        const percent = Math.round((value / total) * 100);
        addLegend(color, `${labels[index] || `#${index + 1}`}: ${formatNumber(value)} (${percent}%)`);
      });
      if (type === 'doughnut') svgEl('circle', { cx, cy, r: 55, fill: '#070806' }, svg);
      figure.append(legend);
      container.append(figure);
      return true;
    }

    const W = 420; const H = 240; const ml = 46; const mr = 12; const mt = 12; const mb = 44;
    const plotW = W - ml - mr; const plotH = H - mt - mb;
    const all = datasets.flatMap((set) => set.data);
    const minValue = Math.min(0, ...all);
    let maxValue = Math.max(0, ...all);
    if (maxValue === minValue) maxValue = minValue + 1;
    const yOf = (value) => mt + plotH * (1 - (value - minValue) / (maxValue - minValue));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': spec.title || 'Chart' }, figure);

    for (let tick = 0; tick <= 4; tick += 1) {
      const value = minValue + ((maxValue - minValue) * tick) / 4;
      const y = yOf(value);
      svgEl('line', { x1: ml, y1: y, x2: W - mr, y2: y, stroke: 'rgba(255,255,255,.09)', 'stroke-width': 1 }, svg);
      const label = svgEl('text', { x: ml - 6, y: y + 3, 'text-anchor': 'end', fill: '#a8aba7', 'font-size': 10 }, svg);
      label.textContent = formatNumber(value);
    }
    svgEl('line', { x1: ml, y1: yOf(0), x2: W - mr, y2: yOf(0), stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1 }, svg);

    const count = labels.length;
    const band = plotW / count;
    const step = Math.ceil(count / 8);
    labels.forEach((text, index) => {
      if (index % step) return;
      const label = svgEl('text', { x: ml + band * index + band / 2, y: H - mb + 16, 'text-anchor': 'middle', fill: '#a8aba7', 'font-size': 10 }, svg);
      label.textContent = text.length > 10 ? `${text.slice(0, 9)}…` : text;
    });

    datasets.forEach((set, j) => {
      const color = CHART_COLORS[j % CHART_COLORS.length];
      if (datasets.length > 1 || set.label) addLegend(color, set.label || `Series ${j + 1}`);
      if (type === 'bar') {
        const groupWidth = band * 0.72;
        const barWidth = groupWidth / datasets.length;
        set.data.slice(0, count).forEach((value, index) => {
          const x = ml + band * index + (band - groupWidth) / 2 + j * barWidth;
          const y0 = yOf(0); const y1 = yOf(value);
          svgEl('rect', { x: x.toFixed(2), y: Math.min(y0, y1).toFixed(2), width: Math.max(1, barWidth - 2).toFixed(2), height: Math.max(1, Math.abs(y0 - y1)).toFixed(2), rx: 2, fill: color }, svg);
        });
      } else {
        const points = set.data.slice(0, count).map((value, index) => [ml + band * index + band / 2, yOf(value)]);
        svgEl('polyline', { points: points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
        points.forEach((p) => svgEl('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 3.2, fill: color }, svg));
      }
    });
    if (legend.childElementCount) figure.append(legend);
    container.append(figure);
    return true;
  }

  function appendCodeBlock(container, source) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = source;
    pre.append(code);
    container.append(pre);
  }

  function renderRichText(container, text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let paragraph = [];
    const flush = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      paragraph.forEach((line, index) => {
        if (index) p.append(document.createElement('br'));
        appendInline(p, line);
      });
      container.append(p);
      paragraph = [];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([A-Za-z]*)\s*$/);
      if (fence) {
        flush();
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1;
        const source = body.join('\n');
        if (fence[1].toLowerCase() === 'chart') {
          let drawn = false;
          try { drawn = renderChart(container, JSON.parse(source)); } catch (_error) { drawn = false; }
          if (!drawn) appendCodeBlock(container, source);
        } else {
          appendCodeBlock(container, source);
        }
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flush();
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].includes('|') && lines[j].trim()) { rows.push(lines[j]); j += 1; }
        renderTable(container, line, rows);
        i = j;
        continue;
      }
      const item = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (item) {
        flush();
        const ordered = Boolean(item[1]);
        const listEl = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const next = lines[i].match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
          if (!next || Boolean(next[1]) !== ordered) break;
          const li = document.createElement('li');
          appendInline(li, next[2]);
          listEl.append(li);
          i += 1;
        }
        container.append(listEl);
        continue;
      }
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (heading) {
        flush();
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = heading[1];
        p.append(strong);
        container.append(p);
        i += 1;
        continue;
      }
      if (!line.trim()) { flush(); i += 1; continue; }
      paragraph.push(line);
      i += 1;
    }
    flush();
  }

  // ---- Image generation ("ek pahad ki image banao") ----
  function wantsImage(text) {
    const t = String(text || '').toLowerCase();
    const noun = /\b(image|photo|picture|pic|tasveer|tasvir|wallpaper|logo|poster|illustration|painting)\b|इमेज|तस्वीर|फोटो|चित्र/.test(t);
    const verb = /\b(bana|banao|banado|banaiye|banaye|bnao|bna|generate|create|make|draw|design|paint)\b|बना/.test(t);
    const other = /\b(explain|summari[sz]e|describe|read|ocr|how\s+to|kaise)\b/.test(t);
    return noun && verb && !other;
  }

  async function generateImage(promptText) {
    isSending = true;
    sendButton.disabled = true;
    typing.hidden = false;
    setState('thinking');
    scrollConversation();
    try {
      const response = await fetch('/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Image abhi nahi ban paayi. Thodi der baad try karein.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const article = addMessage('assistant', 'Ye lijiye, aapki image:');
      const img = document.createElement('img');
      img.className = 'generated-image';
      img.src = url;
      img.alt = promptText.slice(0, 120);
      img.addEventListener('load', scrollConversation);
      const download = document.createElement('a');
      download.className = 'action-link';
      download.href = url;
      download.download = 'abhi-ai-image.png';
      download.textContent = 'Download image';
      const content = article.querySelector('.message-content');
      content.append(img);
      const row = document.createElement('div');
      row.className = 'action-links';
      row.append(download);
      content.append(row);
      setGesture('smile');
      speak('Ye lijiye, aapki image.');
    } catch (error) {
      const message = error instanceof TypeError
        ? 'Server tak pahunch nahi paaya. Connection check karein.'
        : (error.message || 'Image abhi nahi ban paayi.');
      setGesture('empathetic');
      addMessage('assistant', message);
      speak(message);
    } finally {
      typing.hidden = true;
      sendButton.disabled = false;
      isSending = false;
      if (!voiceActive || !isAssistantSpeaking()) setState(micActive ? 'listening' : 'idle');
      input.focus({ preventScroll: true });
      scrollConversation();
    }
  }

  function addMessage(role, text, actions = []) {
    const article = document.createElement('article');
    article.className = `message ${role === 'user' ? 'user-message' : 'assistant-message'}`;

    const content = document.createElement('div');
    content.className = 'message-content';
    if (role !== 'user') {
      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'Abhi AI';
      const time = document.createElement('span');
      time.className = 'message-time';
      time.textContent = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(new Date());
      author.append(time);
      content.append(author);
    }

    if (role === 'user') {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      content.append(paragraph);
    } else {
      renderRichText(content, text);
    }

    if (actions.length) {
      const actionRow = document.createElement('div');
      actionRow.className = 'action-links';
      for (const item of actions) {
        if (!item || typeof item.label !== 'string') continue;
        let href = '';
        if (item.type === 'call') {
          const number = normalizePhone(item.number || '');
          if (!number) continue;
          href = `tel:${number}`;
        } else if (item.type === 'external' && isAllowedLink(item.href)) {
          href = item.href;
        }
        if (!href) continue;
        const link = document.createElement('a');
        link.className = 'action-link';
        link.href = href;
        link.textContent = item.label;
        if (item.type === 'external') {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        const arrow = document.createElement('span');
        arrow.className = 'link-arrow';
        arrow.textContent = item.type === 'call' ? '↗' : '↗';
        link.append(arrow);
        actionRow.append(link);
      }
      if (actionRow.childElementCount) content.append(actionRow);
    }

    article.append(content);
    list.append(article);
    scrollConversation();
    return article;
  }

  function normalizePhone(raw) {
    const cleaned = String(raw).trim().replace(/[\s().-]/g, '');
    return /^\+?\d{7,15}$/.test(cleaned) ? cleaned : '';
  }

  function formatLocalTime() {
    return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());
  }

  function formatLocalDate() {
    return new Intl.DateTimeFormat('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  }

  const ALLOWED_HOSTS = new Set([
    'www.youtube.com', 'www.instagram.com', 'web.whatsapp.com', 'wa.me', 'www.google.com', 'mail.google.com',
    'maps.google.com', 'www.facebook.com', 'x.com', 'www.linkedin.com', 'github.com', 'open.spotify.com',
    'www.amazon.in', 'www.flipkart.com', 'en.wikipedia.org', 'www.netflix.com', 'www.hotstar.com', 'web.telegram.org'
  ]);

  function isAllowedLink(href) {
    try {
      const url = new URL(href);
      return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
    } catch (error) {
      return false;
    }
  }

  const OPEN_SITES = [
    { re: /\b(whatsapp|whats app)\b/, label: 'Open WhatsApp', href: 'https://web.whatsapp.com/' },
    { re: /\b(gmail|email|mail)\b/, label: 'Open Gmail', href: 'https://mail.google.com/' },
    { re: /\b(facebook|fb)\b/, label: 'Open Facebook', href: 'https://www.facebook.com/' },
    { re: /\b(twitter|x\.com)\b/, label: 'Open X', href: 'https://x.com/' },
    { re: /\blinkedin\b/, label: 'Open LinkedIn', href: 'https://www.linkedin.com/' },
    { re: /\bgithub\b/, label: 'Open GitHub', href: 'https://github.com/' },
    { re: /\bspotify\b/, label: 'Open Spotify', href: 'https://open.spotify.com/' },
    { re: /\bamazon\b/, label: 'Open Amazon', href: 'https://www.amazon.in/' },
    { re: /\bflipkart\b/, label: 'Open Flipkart', href: 'https://www.flipkart.com/' },
    { re: /\bwikipedia\b/, label: 'Open Wikipedia', href: 'https://en.wikipedia.org/' },
    { re: /\bnetflix\b/, label: 'Open Netflix', href: 'https://www.netflix.com/' },
    { re: /\b(hotstar|disney)\b/, label: 'Open Hotstar', href: 'https://www.hotstar.com/' },
    { re: /\btelegram\b/, label: 'Open Telegram', href: 'https://web.telegram.org/' },
    { re: /\b(google)\b/, label: 'Open Google', href: 'https://www.google.com/' }
  ];

  const MEDIA_WORDS = /\b(open|launch|kholo|khol|khol\s*do|chalao|chala\s*do|chalado|play|bajao|baja\s*do|bajado|sunao|suna\s*do|search|karo|kar\s*do|kardo|kar|dikhao|dikha\s*do|youtube|you\s*tube|yt|pe|par|per|on|me|mein|se|ka|ki|ke|ek|ye|wo|vo|please|plz|song|gaana|gana|video|music|my|mere|liye|for|the|a|to)\b|खोल|चलाओ|खोलो|बजाओ|सुनाओ|गाना|यूट्यूब/g;

  function cleanMediaQuery(text) {
    return text.replace(MEDIA_WORDS, ' ').replace(/\s+/g, ' ').trim();
  }

  function matchLocalAction(text) {
    const normalized = text.trim().toLocaleLowerCase();
    const openIntent = /\b(open|launch|kholo|khol|chalao|dikhao|jao|open karo)\b|खोल|चलाओ|खोलो|जाओ/.test(normalized);
    const hasYoutube = /\b(youtube|you tube|yt)\b|यूट्यूब/.test(normalized);
    const hasInstagram = /\b(instagram|insta)\b/.test(normalized);
    const playIntent = /\b(play|bajao|baja\s*do|bajado|chalao|chala\s*do|chalado|sunao|suna\s*do)\b|बजाओ|चलाओ|सुनाओ/.test(normalized)
      && (hasYoutube || /\b(song|gaana|gana|music|video|bhajan|ringtone|trailer)\b|गाना/.test(normalized) || /^\s*play\b/.test(normalized));

    // YouTube: "play Tum Hi Ho", "YouTube pe Arijit Singh songs", "open youtube"
    if (hasYoutube || playIntent) {
      const query = cleanMediaQuery(normalized);
      if (query) {
        return { type: 'youtube', query, play: playIntent, reply: '' };
      }
      return { type: 'external', label: 'Open YouTube', href: 'https://www.youtube.com/', reply: 'Opening YouTube.' };
    }

    // WhatsApp with a number: "whatsapp 9876543210 message hello"
    if (/\b(whatsapp|whats app)\b/.test(normalized)) {
      const numberMatch = text.match(/\+?\d[\d\s().-]{8,}\d/);
      let digits = numberMatch ? normalizePhone(numberMatch[0]).replace('+', '') : '';
      if (digits.length === 10) digits = `91${digits}`;
      if (digits) {
        const msgMatch = text.match(/\b(?:message|msg|text|bolo|likho|bhejo)\s+(.+)$/i);
        const suffix = msgMatch ? `?text=${encodeURIComponent(msgMatch[1].trim().slice(0, 500))}` : '';
        return { type: 'external', label: 'Open WhatsApp chat', href: `https://wa.me/${digits}${suffix}`, reply: 'Opening WhatsApp. You press send yourself.' };
      }
    }

    if (hasInstagram) {
      return { type: 'external', label: 'Open Instagram', href: 'https://www.instagram.com/', reply: 'Opening Instagram.' };
    }

    // Google Maps: "pizza near me", "Meerut to Delhi route", "maps Shamli"
    if (/\b(maps?|directions?|route|nearby|near\s+me|rasta)\b/.test(normalized) && !/\b(news|score|price)\b/.test(normalized)) {
      const place = normalized.replace(/\b(open|show|dikhao|kholo|google|maps?|directions?|route|rasta|please|mein|ka|ki|ke|from)\b/g, ' ').replace(/\s+/g, ' ').trim();
      const trip = place.match(/^(.+?)\s+to\s+(.+)$/);
      if (trip) {
        return { type: 'external', label: 'Open route in Google Maps', href: `https://www.google.com/maps/dir/${encodeURIComponent(trip[1])}/${encodeURIComponent(trip[2])}`, reply: `Opening the route from ${trip[1]} to ${trip[2]}.` };
      }
      if (place) {
        return { type: 'external', label: 'Open in Google Maps', href: `https://www.google.com/maps/search/${encodeURIComponent(place)}`, reply: `Opening Google Maps for ${place}.` };
      }
    }

    // Other sites, only when the user clearly asks to open them.
    if (openIntent) {
      const site = OPEN_SITES.find((item) => item.re.test(normalized) && !/\b(news|score|price|weather)\b/.test(normalized));
      if (site) return { type: 'external', label: site.label, href: site.href, reply: `${site.label.replace('Open ', 'Opening ')}.` };
    }

    // Leave questions that need live info (score, news, weather...) to the backend search.
    const needsSearch = /\b(score|news|khabar|weather|mausam|price|match|ipl|cricket|latest|result|stock)\b|स्कोर|खबर|मौसम|न्यूज|रिजल्ट|क्रिकेट/.test(normalized);
    if (!needsSearch) {
      const asksTime = /\b(time|waqt|samay|kitne\s+baje)\b|समय|वक्त|कितने\s+बजे|टाइम/.test(normalized)
        && !/\b(time\s*table|timetable|timer|times)\b/.test(normalized);
      const asksDate = /\b(date|tareekh|tarikh|tithi|weekday|which\s+day|what\s+day|kaun\s*sa\s+din|konsa\s+din)\b|तारीख|तिथि|कौन\s*सा\s+दिन|आज\s+(?:की\s+)?(?:तारीख|तिथि|दिन)|aaj\s+(?:ki\s+)?(?:date|tareekh|tarikh)|today'?s\s+date/.test(normalized);
      if (asksTime && asksDate) {
        return { type: 'text', reply: `Today is ${formatLocalDate()}, and the time is ${formatLocalTime()}.` };
      }
      if (asksTime) {
        return { type: 'text', reply: `Your local time is ${formatLocalTime()}.` };
      }
      if (asksDate) {
        return { type: 'text', reply: `Today is ${formatLocalDate()}.` };
      }
    }
    if (/\b(call|phone|dial|ring|number|call\s+lagao)\b|\bकॉल\b|फोन\s*कर/.test(normalized)) {
      const match = text.match(/\+?\d[\d\s().-]{5,}\d/);
      const number = match ? normalizePhone(match[0]) : '';
      return number
        ? { type: 'call', reply: `Tap below to open your phone dialer for ${number}. You confirm the call on your device.`, number }
        : { type: 'text', reply: 'Enter the phone number in the Call panel and choose Open dialer. You confirm the call on your device.' };
    }
    return null;
  }

  // Opens the site/video in a new tab by itself. Browsers only allow this right after a click/Enter,
  // so if it is blocked (for example when the command came from the microphone) a button is shown instead.
  async function openLinkAutomatically(action) {
    let popup = null;
    try { popup = window.open('', '_blank'); } catch (error) { popup = null; }
    let href = action.href;
    let reply = action.reply;
    let label = action.label;
    if (action.type === 'youtube') {
      href = `https://www.youtube.com/results?search_query=${encodeURIComponent(action.query)}`;
      label = 'Open on YouTube';
      reply = `Searching YouTube for "${action.query}".`;
      if (action.play) {
        try {
          const response = await fetch(`/api/youtube?q=${encodeURIComponent(action.query)}`, { headers: { Accept: 'application/json' } });
          if (response.ok) {
            const info = await response.json();
            if (/^[A-Za-z0-9_-]{11}$/.test(info.videoId || '')) {
              href = `https://www.youtube.com/watch?v=${info.videoId}`;
              label = 'Play on YouTube';
              reply = `Playing: ${String(info.title || action.query).slice(0, 120)}`;
            }
          }
        } catch (error) { /* keep the search link */ }
      }
    }
    let opened = false;
    if (popup && !popup.closed && isAllowedLink(href)) {
      try { popup.opener = null; popup.location.href = href; opened = true; } catch (error) { opened = false; }
    } else if (popup && !popup.closed) {
      popup.close();
    }
    setGesture('wave');
    addMessage('assistant', opened ? reply : `${reply} The browser blocked the automatic open, so tap the button below.`,
      [{ type: 'external', label, href }]);
    speak(reply);
  }

  async function sendMessage(rawText, options = {}) {
    const text = String(rawText || '').trim();
    if (!text || isSending) return;
    addMessage('user', text);
    input.value = '';
    reactToUser(text);
    if (wantsImage(text)) {
      await generateImage(text);
      return;
    }
    const localAction = matchLocalAction(text);

    if (localAction) {
      if (localAction.type === 'external' || localAction.type === 'youtube') {
        await openLinkAutomatically(localAction);
        return;
      }
      setGesture('nod');
      addMessage('assistant', localAction.reply, localAction.type === 'call'
        ? [{ type: 'call', label: 'Open phone dialer', number: localAction.number }]
        : []);
      speak(localAction.reply);
      return;
    }

    isSending = true;
    sendButton.disabled = true;
    typing.hidden = false;
    setState('thinking');
    scrollConversation();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ message: text, conversation_id: conversationId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'I could not answer just now. Please try again.');
      const rawReply = typeof payload.reply === 'string' ? payload.reply : 'I could not read that answer. Please try again.';
      const parsedReply = parseAssistantReply(rawReply);
      const reply = parsedReply.text || 'I could not read that answer. Please try again.';
      setGesture(parsedReply.gesture || 'nod');
      reactToReply(reply);
      addMessage('assistant', reply);
      speak(reply);
      setConnection(true, 'Assistant ready');
    } catch (error) {
      const message = error instanceof TypeError
        ? 'I could not reach the assistant. Check your connection and try again.'
        : (error.message || 'I could not answer just now. Please try again.');
      setGesture('empathetic');
      addMessage('assistant', message);
      setConnection(false, 'Setup needed');
      speak(message);
    } finally {
      typing.hidden = true;
      sendButton.disabled = false;
      isSending = false;
      if (!voiceActive || !isAssistantSpeaking()) setState(micActive ? 'listening' : 'idle');
      input.focus({ preventScroll: true });
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage(input.value, { userGesture: true });
  });

  document.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => void sendMessage(button.dataset.command || '', { userGesture: true }));
  });

  function selectPreferredVoice() {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    const sargamVoice = voices.find((voice) => /\bsargam\b/i.test(voice.name));
    if (sargamVoice) return sargamVoice;
    const indianEnglish = voices.filter((voice) => /^en[-_]in$/i.test(voice.lang));
    const feminineNames = /\b(?:female|woman|heera|aditi|neerja|priya|sara|sargam)\b/i;
    return indianEnglish.find((voice) => String(voice.gender || '').toLowerCase() === 'female' || feminineNames.test(voice.name))
      || indianEnglish[0]
      || voices.find((voice) => /^en[-_]/i.test(voice.lang))
      || null;
  }

  // Prevent the assistant's own speaker output from entering the microphone.
  // Keep the MediaStream alive; only disable its audio tracks while speaking.
  function setMicrophoneMuted(muted) {
    if (!micStream) return;
    micStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  let currentAudio = null;
  let currentAudioUrl = '';
  let currentAudioDone = null;
  let sarvamSpeaking = false;
  let speakToken = 0;

  function isAssistantSpeaking() {
    return sarvamSpeaking || Boolean(window.speechSynthesis?.speaking);
  }

  function finishSpeechOutput() {
    setMicrophoneMuted(false);
    setState(micActive ? 'listening' : 'idle');
  }

  // Stops both Sarvam audio and the browser fallback voice.
  function stopSpeechOutput() {
    speakToken += 1;
    const wasSarvam = sarvamSpeaking;
    sarvamSpeaking = false;
    if (currentAudio) {
      try { currentAudio.pause(); } catch (error) { /* ignore */ }
      currentAudio = null;
    }
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = '';
    }
    if (currentAudioDone) {
      const done = currentAudioDone;
      currentAudioDone = null;
      done();
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (wasSarvam) finishSpeechOutput();
  }

  function cleanTextForSpeech(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_#`>~|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function speakWithSarvam(text, token) {
    const response = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch (error) { /* ignore */ }
      throw new Error(detail || `Sarvam voice failed (${response.status})`);
    }
    const blob = await response.blob();
    if (token !== speakToken) return; // a newer reply or stop request replaced this one
    currentAudioUrl = URL.createObjectURL(blob);
    const audio = new Audio(currentAudioUrl);
    currentAudio = audio;
    attachLipSync(audio);
    await new Promise((resolve, reject) => {
      currentAudioDone = resolve;
      audio.onended = resolve;
      audio.onerror = () => reject(new Error('Sarvam audio could not be played.'));
      audio.play().catch(reject);
    });
    currentAudioDone = null;
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = '';
    }
    if (currentAudio === audio) currentAudio = null;
  }

  function speakWithBrowser(text) {
    if (!('speechSynthesis' in window)) {
      finishSpeechOutput();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const preferredVoice = selectPreferredVoice();
    utterance.lang = preferredVoice?.lang || 'en-IN';
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.rate = 0.97;
    utterance.pitch = 1.05;
    utterance.onstart = () => {
      setMicrophoneMuted(true);
      setState('speaking');
    };
    utterance.onboundary = () => pulseMouth();
    utterance.onend = finishSpeechOutput;
    utterance.onerror = finishSpeechOutput;
    window.speechSynthesis.speak(utterance);
  }

  async function speak(text) {
    if (!voiceActive) return;
    const spoken = cleanTextForSpeech(text);
    if (!spoken) return;
    stopSpeechOutput();
    const token = speakToken;
    // Mute before audio starts so the first syllable cannot be recorded.
    setMicrophoneMuted(true);
    sarvamSpeaking = true;
    setState('speaking');
    try {
      await speakWithSarvam(spoken, token);
    } catch (error) {
      console.warn('Sarvam voice error, using browser voice:', error);
      if (token === speakToken) {
        sarvamSpeaking = false;
        voiceNote.textContent = `Sarvam voice nahi chali: ${error.message}. Browser voice use ho rahi hai.`;
        speakWithBrowser(spoken);
      }
      return;
    }
    if (token === speakToken) {
      sarvamSpeaking = false;
      finishSpeechOutput();
    }
  }

  voiceToggle.addEventListener('click', () => {
    voiceActive = !voiceActive;
    voiceToggle.setAttribute('aria-pressed', String(voiceActive));
    voiceLabel.textContent = voiceActive ? 'Voice On' : 'Voice Off';
    if (!voiceActive) {
      stopSpeechOutput();
      finishSpeechOutput();
    }
    voiceNote.textContent = voiceActive ? 'Spoken replies use Sarvam voice.' : 'Voice replies are off.';
  });

  function preferredAudioType() {
    if (!window.MediaRecorder?.isTypeSupported) return '';
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  async function startMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      micActive = false;
      updateMicButton();
      voiceNote.textContent = 'This browser does not support enhanced voice input. Please type instead.';
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (!micActive) {
        micStream.getTracks().forEach((track) => track.stop());
        micStream = null;
        return;
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio processing is unavailable in this browser.');
      audioContext = new AudioContextClass();
      await audioContext.resume();
      audioAnalyser = audioContext.createAnalyser();
      audioAnalyser.fftSize = 1024;
      audioSource = audioContext.createMediaStreamSource(micStream);
      audioSource.connect(audioAnalyser);
      noiseFloor = 0.006;
      voiceNote.textContent = 'Noise reduction is enabled when supported. Speak, then pause to send.';
      setState('listening');
      monitorMicrophone();
    } catch (_error) {
      micActive = false;
      updateMicButton();
      releaseMicrophone();
      voiceNote.textContent = 'Allow microphone access and try again. Use HTTPS or localhost.';
      setState('idle');
    }
  }

  function startSpeechRecording() {
    if (!micActive || !micStream || isTranscribing || isSending || recorderStopping) return;
    const mimeType = preferredAudioType();
    const options = mimeType ? { mimeType } : undefined;
    try {
      speechRecorder = new MediaRecorder(micStream, options);
      speechChunks = [];
      speechStartedAt = Date.now();
      lastVoiceAt = speechStartedAt;
      isRecordingSpeech = true;
      speechRecorder.ondataavailable = (event) => {
        if (event.data?.size) speechChunks.push(event.data);
      };
      speechRecorder.onerror = () => {
        voiceNote.textContent = 'The microphone recording failed. Please try again.';
        stopSpeechRecording(true);
      };
      speechRecorder.start(250);
      voiceNote.textContent = 'Listening. Pause to send your words.';
    } catch (_error) {
      isRecordingSpeech = false;
      speechRecorder = null;
      voiceNote.textContent = 'The microphone could not start recording. Please try again.';
    }
  }

  function stopSpeechRecording(discard = false) {
    const recorder = speechRecorder;
    if (!recorder || recorder.state === 'inactive') return;
    const duration = Date.now() - speechStartedAt;
    const mimeType = recorder.mimeType || 'audio/webm';
    isRecordingSpeech = false;
    recorderStopping = true;
    speechRecorder = null;
    recorder.onstop = () => {
      const blob = new Blob(speechChunks, { type: mimeType });
      speechChunks = [];
      recorderStopping = false;
      if (!discard && duration >= 350 && blob.size > 0) void transcribeAudio(blob, mimeType);
      else if (micActive) voiceNote.textContent = 'Listening for speech.';
    };
    try { recorder.stop(); } catch (_error) { recorderStopping = false; }
  }

  function monitorMicrophone() {
    if (!micActive || !audioAnalyser) return;
    const samples = new Uint8Array(audioAnalyser.fftSize);
    audioAnalyser.getByteTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      total += value * value;
    }
    const level = Math.sqrt(total / samples.length);
    const threshold = Math.max(0.022, noiseFloor * 2.2);
    const now = Date.now();
    const assistantSpeaking = Boolean(voiceActive && isAssistantSpeaking());
    if (assistantSpeaking && !isTranscribing && !isSending && !recorderStopping && !isRecordingSpeech) {
      if (level > Math.max(BARGE_IN_RMS, noiseFloor * 3.5)) {
        bargeInFrames += 1;
        if (bargeInFrames >= BARGE_IN_CONFIRM_FRAMES) {
          stopSpeechOutput();
          bargeInFrames = 0;
          setState('listening');
          voiceNote.textContent = 'I hear you. Speak, then pause to send.';
          startSpeechRecording();
          lastVoiceAt = now;
        }
      } else {
        bargeInFrames = Math.max(0, bargeInFrames - 1);
      }
    } else if (!assistantSpeaking && !isTranscribing && !isSending && !recorderStopping) {
      bargeInFrames = 0;
      if (level > threshold) {
        if (!isRecordingSpeech) startSpeechRecording();
        lastVoiceAt = now;
      } else if (!isRecordingSpeech) {
        noiseFloor = (noiseFloor * 0.97) + (level * 0.03);
      } else if (now - lastVoiceAt >= SILENCE_MS || now - speechStartedAt >= MAX_CLIP_MS) {
        stopSpeechRecording();
      }
    }
    audioFrame = window.requestAnimationFrame(monitorMicrophone);
  }

  async function transcribeAudio(blob, mimeType) {
    isTranscribing = true;
    setState('thinking', 'Transcribing');
    voiceNote.textContent = 'Transcribing your voice…';
    try {
      const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${extension}`);
      const response = await fetch('/api/transcribe', { method: 'POST', body: formData, headers: { 'Accept': 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Voice transcription failed. Please try again.');
      const transcript = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!transcript) throw new Error('I could not detect speech. Please speak clearly and try again.');
      input.value = transcript;
      await sendMessage(transcript);
    } catch (error) {
      voiceNote.textContent = error.message || 'Voice transcription failed. Please try again.';
      if (error.message?.includes('not set up')) setConnection(false, 'Setup needed');
    } finally {
      isTranscribing = false;
      if (micActive) {
        setState('listening');
        voiceNote.textContent = 'Noise reduction is enabled when supported. Speak, then pause to send.';
      }
    }
  }

  function releaseMicrophone() {
    if (audioFrame) window.cancelAnimationFrame(audioFrame);
    audioFrame = 0;
    if (speechRecorder?.state === 'recording') stopSpeechRecording(true);
    if (audioSource) { try { audioSource.disconnect(); } catch (_error) { /* Already disconnected. */ } }
    audioSource = null;
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    audioAnalyser = null;
    if (audioContext && audioContext.state !== 'closed') void audioContext.close();
    audioContext = null;
  }

  function updateMicButton() {
    micToggle.setAttribute('aria-pressed', String(micActive));
    micLabel.textContent = micActive ? 'Mic On' : 'Mic Off';
  }

  micToggle.addEventListener('click', () => {
    micActive = !micActive;
    updateMicButton();
    if (micActive) {
      void startMicrophone();
    } else {
      releaseMicrophone();
      setState('idle');
      voiceNote.textContent = 'Microphone is off. Turn it on when you are ready to speak.';
    }
  });

  callPanelToggle.addEventListener('click', () => {
    callPanel.hidden = !callPanel.hidden;
    callPanelToggle.setAttribute('aria-expanded', String(!callPanel.hidden));
    if (!callPanel.hidden) phoneInput.focus();
  });

  callButton.addEventListener('click', () => {
    const number = normalizePhone(phoneInput.value);
    if (!number) {
      phoneInput.setCustomValidity('Enter a valid phone number with 7–15 digits.');
      phoneInput.reportValidity();
      return;
    }
    phoneInput.setCustomValidity('');
    // Opening a native dialer is explicitly user-triggered; the user confirms the call there.
    window.location.href = `tel:${number}`;
  });
  phoneInput.addEventListener('input', () => phoneInput.setCustomValidity(''));

  clearButton.addEventListener('click', async () => {
    const confirmed = window.confirm('Clear this conversation?');
    if (!confirmed) return;
    try {
      await fetch('/api/clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId })
      });
    } catch (_error) { /* Clear the visible panel even if offline. */ }
    list.replaceChildren();
    addMessage('assistant', 'Chat cleared. What would you like to ask next?');
    setState('idle');
  });

  async function loadHistory() {
    try {
      const response = await fetch(`/api/history?conversation_id=${encodeURIComponent(conversationId)}`);
      if (!response.ok) return;
      const payload = await response.json();
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.length) return;
      list.replaceChildren();
      for (const message of messages) {
        if (message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string') {
          if (message.role === 'assistant') {
            const parsed = parseAssistantReply(message.content);
            setGesture(parsed.gesture || '');
            addMessage('assistant', parsed.text || message.content);
          } else {
            addMessage('user', message.content);
          }
        }
      }
    } catch (_error) { /* New conversations still work if history is unavailable. */ }
  }

  // ---- "+" file upload: image / PDF / text -> Tesseract OCR -> smart answer ----
  const UPLOAD_ACCEPT = 'image/*,.pdf,.txt,.md,.csv,.json,.py,.js,.html,.css,.log';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = UPLOAD_ACCEPT;
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  function findPlusButton() {
    return document.querySelector(
      '#attachButton, #plusButton, #uploadButton, #fileButton, #addButton, [data-attach], [data-upload], .attach-button, .plus-button, .upload-button, '
      + '[aria-label*="attach" i], [aria-label*="upload" i], [title*="attach" i], [title*="upload" i]'
    );
  }

  let plusButton = findPlusButton();
  if (!plusButton) {
    // index.html has no "+" button yet: add one in front of the message box.
    plusButton = document.createElement('button');
    plusButton.type = 'button';
    plusButton.id = 'attachButton';
    plusButton.textContent = '+';
    plusButton.setAttribute('aria-label', 'Upload a file');
    plusButton.title = 'Upload image, PDF or text file';
    plusButton.style.cssText = 'width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit;font-size:24px;line-height:1;cursor:pointer;flex:none;';
    form.insertBefore(plusButton, input);
  }
  plusButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (!isSending) fileInput.click();
  });

  async function uploadFile(file) {
    if (!file || isSending) return;
    if (file.size > 8 * 1024 * 1024) {
      addMessage('assistant', 'File 8 MB se badi hai. Chhoti file try karein.');
      return;
    }
    const question = input.value.trim();
    addMessage('user', `📎 ${file.name}${question ? ` — ${question}` : ''}`);
    input.value = '';
    isSending = true;
    sendButton.disabled = true;
    typing.hidden = false;
    setState('thinking', 'Reading file');
    scrollConversation();
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('conversation_id', conversationId);
      formData.append('language', 'eng+hin');
      if (question) formData.append('question', question);
      const response = await fetch('/api/ocr', { method: 'POST', body: formData, headers: { 'Accept': 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'File padhi nahi ja saki. Dobara try karein.');
      const parsed = parseAssistantReply(String(payload.reply || ''));
      const reply = parsed.text || 'File mili, par mujhe usme se kuch samajh nahi aaya.';
      setGesture(parsed.gesture || 'nod');
      addMessage('assistant', reply);
      speak(reply);
    } catch (error) {
      setGesture('empathetic');
      addMessage('assistant', error instanceof TypeError ? 'Server tak pahunch nahi paaya. Connection check karein.' : error.message);
    } finally {
      typing.hidden = true;
      sendButton.disabled = false;
      isSending = false;
      if (!isAssistantSpeaking()) setState(micActive ? 'listening' : 'idle');
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    void uploadFile(file);
  });

  fetch('/api/health', { headers: { 'Accept': 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error('offline');
      setConnection(true, 'Assistant ready');
    })
    .catch(() => setConnection(false, 'Offline'));
  void loadHistory();
})();