// ==UserScript==
// @name         CIPTC 视频连续播放助手
// @namespace    local.ciptc
// @version      0.7.0
// @description  自动识别当前目录，按顺序播放视频，跨过独立练习目录项
// @match        *://elearning.ciptc.org.cn/*
// @match        *://resource.ciptc.org.cn/pri/courses/zscqfljc2019dxb/*
// @run-at       document-idle
// @grant        GM_info
// ==/UserScript==

(() => {
  'use strict';

  const isExerciseLabel = text => /练习|测试|测验|考试/.test(text);
  const isVideoLabel = text => text.length < 180
    && /^\d+\s*[.．、]/.test(text) && !isExerciseLabel(text);
  function nextVideoIndex(labels, currentIndex) {
    if (currentIndex < 0 || currentIndex >= labels.length) return -1;
    for (let i = currentIndex + 1; i < labels.length; i++) {
      if (isVideoLabel(labels[i])) return i;
    }
    return -1;
  }

  const textOf = el => el.textContent.replace(/\s+/g, ' ').trim();
  function frameDiagnostic(frame) {
    let origin = null;
    let path = null;
    try {
      const url = new URL(frame.getAttribute('src') || '', frame.ownerDocument.baseURI || undefined);
      if (/^https?:$/.test(url.protocol)) {
        origin = url.origin;
        path = url.pathname;
      } else {
        path = '[' + url.protocol + ']';
      }
    } catch {}
    let readable = false;
    try { readable = Boolean(frame.contentDocument?.documentElement); } catch {}
    return { origin, path, readable, srcdoc: frame.hasAttribute('srcdoc'),
      sandbox: frame.getAttribute('sandbox') };
  }
  function findDirectoryRow(el) {
    for (let depth = 0; depth < 9 && el?.parentElement; depth++, el = el.parentElement) {
      if (el === el.ownerDocument.body) break;
      if (textOf(el).length < 180
          && [...el.parentElement.children].filter(row => isVideoLabel(textOf(row))).length >= 2) return el;
    }
    return null;
  }
  function greenColor(color) {
    const values = String(color).match(/[\d.]+/g);
    if (!values || values.length < 3) return false;
    let [r, g, b, a = 1] = values.map(Number);
    if (/color\(srgb/i.test(color)) { r *= 255; g *= 255; b *= 255; }
    else if (String(color).includes('%')) { r *= 2.55; g *= 2.55; b *= 2.55; }
    return a > 0 && g >= 120 && g > r * 1.2 && g > b * 1.2;
  }

  // 使用实际目录结构和多种选中标记，包含旧站常见的 font/b/strong 标签。
  function recognizeDirectory(docs, options = {}) {
    const visible = options.visible || (() => true);
    const ignore = options.ignore || (() => false);
    const style = options.style || (el => el.ownerDocument.defaultView.getComputedStyle(el));
    // 已从本课程实际播放器源码确认：ui-selected 是当前项，绿色也用于鼠标悬停。
    const actualLists = docs.flatMap(doc => [...doc.querySelectorAll('.ui-playlist')]);
    const actualSelected = actualLists.flatMap(root => [...root.children]
      .filter(row => row.classList.contains('ui-selected')).map(row => ({ row, root })));
    if (actualLists.length && actualSelected.length <= 1) {
      return {
        row: actualSelected[0]?.row || null,
        root: actualSelected[0]?.root || null,
        groups: actualLists.length,
        rows: actualLists.reduce((count, list) => count + list.children.length, 0),
        candidates: actualSelected.length,
        reason: actualSelected.length ? '已按课程 ui-selected 标记识别' : '课程目录已找到，等待网站选中当前条目'
      };
    }
    const elements = docs.flatMap(doc => [...doc.querySelectorAll('*')])
      .filter(el => !ignore(el) && visible(el));
    const roots = new Set();
    for (const el of elements) {
      if (!isVideoLabel(textOf(el))) continue;
      const row = findDirectoryRow(el);
      if (row) roots.add(row.parentElement);
    }
    let groups = [...roots];
    // 从“自动播放列表”标签向上寻找最近的目录区域，排除正文中的编号。
    const markers = elements.filter(el => textOf(el) === '自动播放列表');
    const anchored = new Set();
    for (const marker of markers) {
      let ancestor = marker;
      for (let i = 0; i < 7 && ancestor; i++, ancestor = ancestor.parentElement) {
        if (ancestor === marker.ownerDocument.body) break;
        const nearby = groups.filter(root => ancestor.contains(root));
        if (nearby.length) { nearby.forEach(root => anchored.add(root)); break; }
      }
    }
    if (anchored.size) groups = [...anchored];
    const candidates = [];
    let rowCount = 0;
    for (const root of groups) {
      for (const row of root.children) {
        const label = textOf(row);
        if (!label || label.length >= 180) continue;
        rowCount++;
        let score = 0;
        for (const el of [row, ...row.querySelectorAll('*')]) {
          if (!visible(el)) continue;
          const aria = el.getAttribute('aria-current');
          const classes = (el.getAttribute('class') || '').split(/\s+/);
          if ((aria && aria !== 'false') || el.getAttribute('aria-selected') === 'true'
              || el.getAttribute('data-active') === 'true'
              || classes.some(c => /^(active|current|selected|on|cur|playing)$/i.test(c))) score = Math.max(score, 100);
          if (greenColor(style(el).color)) score = Math.max(score, 10);
        }
        if (score) candidates.push({ row, root, score });
      }
    }
    // 正文标题可作为独立练习页的选中依据。
    if (!candidates.length && groups.length === 1) {
      const normalize = text => text.replace(/^\d+\s*[.．、]\s*/, '').replace(/\s+/g, '');
      const headings = new Set(elements.filter(el => /^(H[1-4]|LEGEND|STRONG|B|FONT)$/.test(el.tagName)
        && !groups[0].contains(el) && textOf(el).length < 160).map(el => normalize(textOf(el))));
      for (const row of groups[0].children) {
        if (textOf(row) && headings.has(normalize(textOf(row)))) candidates.push({ row, root: groups[0], score: 5 });
      }
    }
    const bestScore = Math.max(0, ...candidates.map(c => c.score));
    const best = candidates.filter(c => c.score === bestScore);
    return {
      row: best.length === 1 ? best[0].row : null,
      root: best.length === 1 ? best[0].root : null,
      groups: groups.length, rows: rowCount, candidates: best.length,
      reason: !groups.length ? '没有找到编号视频列表'
        : !best.length ? '找到了目录，但没有识别到当前条目的选中标记'
        : best.length > 1 ? '有多个条目显示为选中状态' : '已自动识别'
    };
  }

  // 将切换决策与页面操作分开，便于本地验证。
  function createSequencer() {
    let key = null;
    let kind = null;
    let since = 0;
    let endedAt = null;
    let lastMedia = '';
    let staleEndedMedia = '';
    let pending = null;
    let blocked = false;
    return {
      expect(from, to, now) { pending = { from, to, at: now }; },
      step(s) {
        if (blocked) return { type: 'blocked' };
        if (pending) {
          if (s.key && s.key !== pending.from) {
            pending = null;
          } else if (s.now - pending.at >= 15000) {
            blocked = true;
            return { type: 'blocked' };
          } else return { type: 'transition', to: pending.to };
        }
        if (!s.key) return { type: 'locating' };
        if (s.key !== key) {
          staleEndedMedia = key !== null && s.kind === 'video'
            && s.media && s.media === lastMedia && s.ended ? s.media : '';
          key = s.key;
          kind = s.kind;
          since = s.now;
          endedAt = null;
        }
        lastMedia = s.media || lastMedia;
        if (s.kind === 'exercise') {
          return { type: s.now - since >= 2000 ? 'next' : 'exercise' };
        }
        if (!s.hasVideo) return { type: 'loading' };
        if (staleEndedMedia && s.media === staleEndedMedia && s.ended) {
          if (s.now - since >= 15000) {
            blocked = true;
            return { type: 'blocked' };
          }
          return { type: 'loading' };
        }
        staleEndedMedia = '';
        if (!s.ended) {
          endedAt = null;
          return { type: 'video' };
        }
        if (endedAt === null) endedAt = s.now;
        return { type: s.now - endedAt >= 5000 ? 'next' : 'saving' };
      }
    };
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = {
      createSequencer, nextVideoIndex, recognizeDirectory, greenColor, frameDiagnostic
    };
    return;
  }

  const VERSION = '0.7.0';
  const PANEL_ID = 'ciptc-local-video-helper';
  console.info('[CIPTC 助手] 脚本已注入，版本 ' + VERSION);

  function mount() {
    const isFrame = window.self !== window.top;
    const isResourceCourse = location.hostname === 'resource.ciptc.org.cn'
      && location.pathname.startsWith('/pri/courses/zscqfljc2019dxb/');
    if (!location.pathname.startsWith('/home/student/course/') && !isResourceCourse && !isFrame) return;
    if (!document.body || document.getElementById(PANEL_ID)) return;
    // 同源框架由父页面统一处理；跨域框架在自己的文档中识别与播放。
    if (isFrame) {
      try { if (window.parent.document.getElementById(PANEL_ID)) return; } catch {}
      const local = recognizeDirectory([document], { visible: el => Boolean(el.getClientRects().length) });
      if (!local.groups) return;
    }
    const coursePath = location.pathname;
    const storageKey = 'ciptc-auto-sequence:' + coursePath;
    let enabled = true;
    try { enabled = sessionStorage.getItem(storageKey) !== 'paused'; } catch {}
    let sequencer = createSequencer();
    let recognition = { groups: 0, rows: 0, candidates: 0, reason: '正在加载目录' };
    const startedAt = Date.now();
    const playAttempts = new WeakMap();
    let childHeartbeat = 0;

    // 内层控制器仅告知已接管；外层不再展示重复的未识别提示。
    function frameReady() {
      if (!isFrame) return;
      try {
        const parentURL = new URL(document.referrer);
        if (!['elearning.ciptc.org.cn', 'resource.ciptc.org.cn'].includes(parentURL.hostname)) return;
        window.parent.postMessage({ type: 'ciptc-course-frame-ready', version: VERSION }, parentURL.origin);
      } catch {}
    }
    function handleFrameReady(event) {
      if (!panel.isConnected) return;
      let sender;
      try { sender = new URL(event.origin); } catch { return; }
      if (!['http:', 'https:'].includes(sender.protocol) || sender.hostname !== 'resource.ciptc.org.cn') return;
      if (event.data?.type !== 'ciptc-course-frame-ready' || event.data?.version !== VERSION) return;
      const ownedFrame = [...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source);
      if (ownedFrame) childHeartbeat = Date.now();
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
      'background:#fff', 'color:#222', 'padding:12px', 'width:290px',
      'border:2px solid #167b48', 'border-radius:8px',
      'font:14px/1.5 sans-serif', 'box-shadow:0 3px 16px #0004', 'text-align:left'
    ].join(';');
    const title = document.createElement('strong');
    title.textContent = 'CIPTC 自动顺序播放 · v' + VERSION;
    title.style.color = '#167b48';
    const status = document.createElement('div');
    status.style.cssText = 'margin:8px 0;white-space:normal';
    panel.append(title, status);
    function say(text) { status.textContent = text; }
    function rowKey(row) {
      return [...row.parentElement.children].indexOf(row) + ':' + textOf(row);
    }
    function savePreference() {
      try { sessionStorage.setItem(storageKey, enabled ? 'running' : 'paused'); } catch {}
      toggle.textContent = enabled ? '暂停自动连播' : '恢复自动连播';
    }
    function button(text, action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText = 'margin:3px;padding:5px 8px;cursor:pointer;color:#222;background:#eee;border:1px solid #aaa;border-radius:4px';
      b.onclick = action;
      panel.append(b);
      return b;
    }
    const toggle = button(enabled ? '暂停自动连播' : '恢复自动连播', () => {
      enabled = !enabled;
      sequencer = createSequencer();
      savePreference();
      say(enabled ? '自动连播已恢复，正在识别当前课程。' : '助手已暂停；当前视频仍可正常播放。');
    });
    button('重新识别并启动', () => {
      enabled = true;
      sequencer = createSequencer();
      savePreference();
      say('正在重新识别右侧目录。');
    });
    button('导出目录诊断', () => {
      const snapshots = [];
      for (const doc of documents()) {
        const groups = new Set();
        const markers = [];
        for (const el of doc.querySelectorAll('*')) {
          if (panel.contains(el) || !el.getClientRects().length) continue;
          const text = textOf(el);
          if (text === '自动播放列表') markers.push(el);
          if (isVideoLabel(text)) {
            const row = findDirectoryRow(el);
            if (row) groups.add(row.parentElement);
          }
        }
        if (!groups.size) {
          for (const marker of markers) groups.add(marker.parentElement?.parentElement || marker);
        }
        let count = 0;
        function summarize(el, depth = 0) {
          if (++count > 500 || depth > 8 || panel.contains(el)) return null;
          const attrs = {};
          for (const name of ['id', 'class', 'aria-current', 'aria-selected', 'data-active']) {
            if (el.hasAttribute(name)) attrs[name] = el.getAttribute(name);
          }
          return { tag: el.tagName, attrs, text: textOf(el).slice(0, 180),
            color: doc.defaultView.getComputedStyle(el).color,
            clickHandler: el.hasAttribute('onclick'), link: el.hasAttribute('href'),
            children: [...el.children].map(child => summarize(child, depth + 1)).filter(Boolean) };
        }
        snapshots.push({ groups: [...groups].map(root => summarize(root)).filter(Boolean),
          frames: doc.querySelectorAll('iframe').length,
          frameDetails: [...doc.querySelectorAll('iframe')].map(frameDiagnostic),
          videos: doc.querySelectorAll('video').length });
      }
      const data = { version: VERSION, recognition: {
        groups: recognition.groups, rows: recognition.rows,
        candidates: recognition.candidates, reason: recognition.reason
      }, snapshots };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ciptc-directory-diagnostic.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    const isExercise = row => isExerciseLabel(textOf(row));
    function documents(doc = document, seen = new Set()) {
      if (seen.has(doc)) return [];
      seen.add(doc);
      const result = [doc];
      for (const frame of doc.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) result.push(...documents(frame.contentDocument, seen));
        } catch { /* 不访问跨域框架。 */ }
      }
      return result;
    }
    function locateCurrent(docs) {
      recognition = recognizeDirectory(docs, {
        ignore: el => panel.contains(el), visible: el => Boolean(el.getClientRects().length)
      });
      return recognition.row;
    }
    function selectNext(row) {
      const rows = [...row.parentElement.children];
      const next = rows[nextVideoIndex(rows.map(textOf), rows.indexOf(row))];
      if (!next) {
        enabled = false;
        savePreference();
        say('当前目录中没有后续视频，自动连播已停止。');
        return;
      }
      const target = next.matches('a,button') ? next
        : next.querySelector('a,button,[onclick],[role="button"]') || next;
      if (target.matches(':disabled,[aria-disabled="true"]')
          || next.matches('[aria-disabled="true"]')) {
        enabled = false;
        savePreference();
        say('下一视频不可用，请先完成平台要求的练习，再恢复连播。');
        return;
      }
      sequencer.expect(rowKey(row), rowKey(next), Date.now());
      target.click();
      say('正在自动切换到：' + textOf(next));
    }

    document.body.append(panel);
    window.addEventListener('message', handleFrameReady);
    say(enabled ? '自动顺序播放已开启，正在识别右侧目录。' : '自动连播已暂停，点击“恢复自动连播”继续。');
    function tick() {
      if (!panel.isConnected) return;
      if (location.pathname !== coursePath) { panel.remove(); return; }
      frameReady();
      if (!isFrame && childHeartbeat && Date.now() - childHeartbeat < 5000) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      const docs = documents();
      if (!enabled) return;
      // 已核实网站 ended 监听读取此复选框；交给助手统一顺序切换。
      for (const doc of docs) {
        const nativeAuto = doc.getElementById('auto_play_checkbox');
        if (nativeAuto?.checked) nativeAuto.checked = false;
      }
      const row = locateCurrent(docs);
      const exactPlayer = docs.map(doc => doc.getElementById('audioPlay'))
        .find(video => video?.tagName === 'VIDEO' && video.getClientRects().length);
      const video = exactPlayer || docs.flatMap(doc => [...doc.querySelectorAll('video')])
        .filter(v => v.getClientRects().length)
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      const decision = sequencer.step({
        key: row ? rowKey(row) : null, kind: row && isExercise(row) ? 'exercise' : 'video', now: Date.now(),
        hasVideo: Boolean(video), media: video?.currentSrc || video?.src || '', ended: Boolean(video?.ended)
      });
      const name = row ? textOf(row) : '';
      switch (decision.type) {
        case 'locating':
          {
          const inaccessible = docs.flatMap(doc => [...doc.querySelectorAll('iframe')])
            .map(frameDiagnostic).filter(frame => !frame.readable);
          say(Date.now() - startedAt < 12000 ? '正在自动识别课程目录。'
            : !recognition.groups && inaccessible.length
            ? '课程可能在无法直接读取的框架中：' + inaccessible.map(f => (f.origin || '') + (f.path || '')).join('；')
              + '。请导出目录诊断，以便匹配内层课程地址。'
            : '自动识别待适配：' + recognition.reason + '。目录组 ' + recognition.groups
              + '，条目 ' + recognition.rows + '，选中候选 ' + recognition.candidates
              + '。请点“导出目录诊断”，把下载的 JSON 文件发来继续适配。');
          break;
          }
        case 'next': selectNext(row); break;
        case 'transition': say('正在等待平台切换目录和播放器，请稍候。'); break;
        case 'exercise': say('当前为独立练习页，2 秒后自动选择后续视频。'); break;
        case 'saving': say('视频已结束，等待 5 秒让平台保存进度，然后自动进入下一视频。'); break;
        case 'loading': say('当前：' + name + '。等待播放器加载；若持续不变，播放器可能不兼容或平台要求答题。'); break;
        case 'blocked':
          enabled = false;
          savePreference();
          say('已点击后续视频，但平台未确认切换。请检查是否要求答题；处理后点“重新识别并启动”。');
          break;
        case 'video': {
          const source = video.currentSrc || video.src;
          if (source && playAttempts.get(video) !== source) {
            playAttempts.set(video, source);
            if (video.paused) {
              video.play().catch(() => {
                if (enabled) say('浏览器阻止自动播放，请手动点一次播放器的播放按钮；播完仍会自动切换。');
              });
            }
          }
          say(video.paused ? '当前：' + name + '。请手动点一次播放器播放，之后自动顺序切换。'
            : '自动连播中：' + name + '。正常播完后自动进入下一视频。');
          break;
        }
      }
    }
    const timer = setInterval(() => {
      if (!panel.isConnected) {
        clearInterval(timer);
        window.removeEventListener('message', handleFrameReady);
        return;
      }
      try { tick(); } catch (error) {
        enabled = false;
        savePreference();
        say('页面适配失败：' + String(error.message).slice(0, 120));
        console.error('[CIPTC 助手]', error);
      }
    }, 1000);
  }
  mount();
  setInterval(mount, 1500);
})();
