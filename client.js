/**
 * dsh-prompt-optimizer-nyco1d — 浏览器半侧
 *
 * 手写 dsh.client bundle（ModuleLoader 格式，无需构建）。
 * 注册 id 必须等于 package name（dsh-prompt-optimizer-nyco1d）。
 *
 * 做三件事：
 *   1) 输入框左侧工具行加一个「优化提示词」按钮
 *   2) 左键：读当前草稿 → 调 Host 的 /prompt-opt/run → 浮层左右对比 → 采用后写回草稿
 *   3) 右键：模式 + 模型选择（偏好存到 Host 的 /prompt-opt/settings）
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer-nyco1d',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement

    var API = '/prompt-opt'
    var MODE_LABELS = {
      'context-message-optimize': '通用消息优化',
      'general-optimize': '结构化重写',
    }

    /* 整页面板：sidebar.panellist 的 id 与 main 的 key 必须是同一个值 */
    var PANEL_ID = 'prompt-optimizer'
    var PLUGIN_VERSION = '0.3.0'
    var REPO_URL = 'https://github.com/Nyco1d/dsh-prompt-optimizer'

    /* 排版尺度：全页只用这一套字号，避免各组件各写一个数字对不齐 */
    var FONT = '"Segoe UI Variable Text", "Segoe UI Variable Display", "Segoe UI", "HarmonyOS Sans SC", "MiSans", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    var FS = { h1: 15, body: 13.5, sub: 12.5, tiny: 11.5 }

    /* 图表色：只在数据可视化里出现，不参与正文 */
    var CHART = ['#4c8dff', '#34d399', '#a78bfa']
    var WEEK_DAYS = 21

    var PAGE_MAX = 1280
    var RAIL_W = 300

    /* 由 apply(ctx) 注入：整页面板靠它切换 */
    var pageOpener = null
    var pageCloser = null

    /* ------------------------------------------------------------------ */
    /* 模块级 store：按钮与浮层分属两个 slot，靠它共享状态                  */
    /* ------------------------------------------------------------------ */
    var RECENT_KEY = 'dsh-po-recent-models'

    function readRecent() {
      try {
        var raw = window.localStorage.getItem(RECENT_KEY)
        var arr = raw ? JSON.parse(raw) : []
        return Array.isArray(arr) ? arr.slice(0, 3) : []
      } catch (e) { return [] }
    }

    function pushRecent(provider, model) {
      if (!provider || !model) return []
      var key = provider + '/' + model
      var list = readRecent().filter(function (x) { return x.provider + '/' + x.model !== key })
      list.unshift({ provider: provider, model: model })
      list = list.slice(0, 3)
      try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch (e) { /* 隐私模式忽略 */ }
      return list
    }

    var store = {
      state: {
        panelOpen: false,
        loading: false,
        error: '',
        original: '',
        optimized: '',
        mode: 'context-message-optimize',
        /** 设置面板 */
        menuOpen: false,
        anchor: null,
        modes: null,
        /** 正在编辑的自定义模板：null 表示不在编辑态 */
        editingCustom: null,
        modeQuery: '',
        expandedProvider: '',
        recent: readRecent(),
        /** 优化结果浮层锚点 */
        panelRect: null,
        models: null,
        modelsLoading: false,
        modelsError: '',
        selection: { provider: '', model: '' },
        settingsLoaded: false,
        /** 迭代指令输入框的内容 */
        instruction: '',
        /** 优化历史（最近 20 条，Host 侧落盘） */
        history: [],
        historyOpen: false,
        historyLoading: false,
        /** 设置页当前标签页 */
        pageTab: 'mode',
        /** 设置页内联对比抽屉：非 null 时覆盖在设置页上方 */
        peek: null,
        /** 历史页按天筛选的 key（YYYY-M-D），空串表示不限 */
        dayPick: '',
      },
      listeners: new Set(),
      set: function (patch) {
        Object.assign(this.state, patch)
        this.emit()
      },
      emit: function () {
        this.listeners.forEach(function (fn) { fn() })
      },
      subscribe: function (fn) {
        this.listeners.add(fn)
        return function () { store.listeners.delete(fn) }
      },
    }

    /* 测试钩子：本地加载测试用它把 store 拨到打开态做真实渲染断言 */
    try { window.__PO_STORE__ = store } catch (e) { /* 无 window 时忽略 */ }

    function useStore() {
      var pair = React.useState(0)
      var tick = pair[0]
      var setTick = pair[1]
      React.useEffect(function () {
        return store.subscribe(function () { setTick(function (n) { return n + 1 }) })
      }, [])
      return store.state
    }

    function loadSettings() {
      if (store.state.settingsLoaded) return
      fetch(API + '/settings', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (data && data.ok) {
            store.set({
              settingsLoaded: true,
              mode: data.mode || store.state.mode,
              selection: { provider: data.provider || '', model: data.model || '' },
            })
          } else {
            store.set({ settingsLoaded: true })
          }
        })
        .catch(function () { store.set({ settingsLoaded: true }) })
    }

    function loadModes(force) {
      if (store.state.modes && !force) return
      fetch(API + '/modes', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (data && data.modes) store.set({ modes: data.modes })
          else store.set({ modes: [] })
        })
        .catch(function () { store.set({ modes: [] }) })
    }

    function saveSettings(patch) {
      return fetch(API + '/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(function () { /* 偏好保存失败不影响本次优化 */ })
    }

    function loadModels() {
      if (store.state.models || store.state.modelsLoading) return
      store.set({ modelsLoading: true, modelsError: '' })
      fetch(API + '/models', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (data && data.models) store.set({ models: data.models, modelsLoading: false, modelsError: data.error || '' })
          else store.set({ models: [], modelsLoading: false, modelsError: (data && data.error) || '读不到模型列表' })
        })
        .catch(function (err) {
          store.set({ models: [], modelsLoading: false, modelsError: String((err && err.message) || err) })
        })
    }

    /**
     * 跑一次优化。
     * - 普通优化：runOptimize(草稿)
     * - 带指令迭代：runOptimize(st.original, { instruction, previous: st.optimized })
     *   此时第一个参数仍传**原始诉求**，previous 是上一版结果。
     */
    async function runOptimize(text, opts) {
      var o = opts || {}
      var sel = store.state.selection
      var instruction = typeof o.instruction === 'string' ? o.instruction : ''
      var previous = typeof o.previous === 'string' ? o.previous : ''
      var iterating = instruction.trim().length > 0 && previous.trim().length > 0
      store.set({
        panelOpen: true,
        loading: true,
        error: '',
        historyOpen: false,
        // 迭代时左侧「原文」保持不动，右侧先显示上一版，出结果再替换
        original: iterating ? store.state.original : text,
        optimized: iterating ? previous : '',
      })
      try {
        var payload = { text: text, mode: store.state.mode, stream: true }
        if (sel.provider && sel.model) {
          payload.provider = sel.provider
          payload.model = sel.model
        }
        if (iterating) {
          payload.instruction = instruction
          payload.previous = previous
        }
        var res = await fetch(API + '/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })

        // 宿主不支持流式（无 body reader）时退回整包 JSON
        if (!res.body || typeof res.body.getReader !== 'function') {
          var whole = await res.json()
          if (!whole || !whole.ok) {
            store.set({ loading: false, error: (whole && whole.error) || '优化失败' })
            return
          }
          store.set({ loading: false, optimized: whole.text, instruction: '' })
          return
        }

        var reader = res.body.getReader()
        var decoder = new TextDecoder('utf-8')
        var buf = ''
        var acc = iterating ? previous : ''
        while (true) {
          var step = await reader.read()
          if (step.done) break
          buf += decoder.decode(step.value, { stream: true })
          var cut = buf.indexOf('\n\n')
          while (cut >= 0) {
            var frame = buf.slice(0, cut).trim()
            buf = buf.slice(cut + 2)
            if (frame.indexOf('data:') === 0) {
              var evt = null
              try { evt = JSON.parse(frame.slice(5).trim()) } catch (err2) { evt = null }
              if (evt && evt.type === 'delta' && typeof evt.text === 'string') {
                acc += evt.text
                store.set({ optimized: acc })
              } else if (evt && evt.type === 'done') {
                store.set({ loading: false, optimized: evt.text || acc, instruction: '' })
              } else if (evt && evt.type === 'error') {
                store.set({ loading: false, error: evt.error || '优化失败' })
              }
            }
            cut = buf.indexOf('\n\n')
          }
        }
        // 没收到 done 帧但已经流出了正文：保留已生成的内容，别丢
        if (store.state.loading) store.set({ loading: false, optimized: acc })
      } catch (err) {
        store.set({ loading: false, error: String((err && err.message) || err) })
      }
    }

    /** 拉一次历史（打开面板时） */
    async function loadHistory() {
      store.set({ historyLoading: true })
      try {
        var res = await fetch(API + '/history')
        var data = await res.json()
        store.set({ historyLoading: false, history: (data && data.items) || [] })
      } catch (err) {
        store.set({ historyLoading: false, history: [] })
      }
    }

    async function clearHistory() {
      try {
        await fetch(API + '/history', { method: 'DELETE' })
      } catch (err) { /* 忽略 */ }
      store.set({ history: [] })
    }

    /* ------------------------------------------------------------------ */
    /* 样式（inline，卸载即消失，不污染全局）                              */
    /* ------------------------------------------------------------------ */
    var COL = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      sub: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
      border2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.2))',
      bg: 'var(--dsw-alias-bg-overlay, #fff)',
      layer: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
      brand: 'var(--dsw-alias-brand-primary, #2159d6)',
      error: 'var(--dsw-alias-state-error-primary, #c62828)',
    }

    var BTN_SIZE = 26

    /* ------------------------------------------------------------------ */
    /* 输入框左侧的按钮                                                    */
    /* ------------------------------------------------------------------ */
    function OptimizeButton(props) {
      var useInput = props.useInput || function () { return undefined }
      var draft = useInput(function (s) { return s.draft })
      var phase = useInput(function (s) { return s.phase })
      var actions = props.inputActions
      var st = useStore()
      var hoverPair = React.useState(false)
      var hover = hoverPair[0]
      var setHover = hoverPair[1]

      React.useEffect(function () { loadSettings() }, [])

      var hasText = typeof draft === 'string' && draft.trim().length > 0
      var busyPhase = phase === 'submitting' || phase === 'adjudicating'
      var disabled = !hasText || busyPhase || st.loading

      function rectOf(e) {
        try {
          if (e && e.currentTarget && e.currentTarget.getBoundingClientRect) {
            return e.currentTarget.getBoundingClientRect()
          }
        } catch (err) { /* 忽略 */ }
        return null
      }

      function openPage() {
        loadModes()
        loadModels()
        loadHistory()
        try { if (pageOpener) pageOpener() } catch (err) { /* 宿主未就绪时静默 */ }
      }

      function onClick(e) {
        if (e && e.preventDefault) e.preventDefault()
        if (e && e.stopPropagation) e.stopPropagation()
        // Shift + 点击：绕过右键这个隐性交互，直接开设置页
        if (e && e.shiftKey) { openPage(); return }
        if (disabled) return
        if (st.panelOpen) { store.set({ panelOpen: false }); return }
        store.inputActions = actions
        store.set({ panelRect: rectOf(e) })
        runOptimize(draft)
      }

      function onContextMenu(e) {
        if (e && e.preventDefault) e.preventDefault()
        if (e && e.stopPropagation) e.stopPropagation()
        openPage()
      }

      var title = !hasText
        ? '先输入点什么，再一键优化'
        : st.loading
          ? '正在优化…'
          : st.panelOpen
            ? '收起优化结果'
            : '一键优化提示词（右键调整模式与模型）'

      return h('button', {
        type: 'button',
        title: title,
        'aria-label': '优化提示词',
        onClick: onClick,
        onContextMenu: onContextMenu,
        onMouseEnter: function () { setHover(true) },
        onMouseLeave: function () { setHover(false) },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: BTN_SIZE,
          height: BTN_SIZE,
          padding: 0,
          border: 'none',
          borderRadius: 6,
          cursor: disabled ? 'default' : 'pointer',
          color: st.panelOpen || hover ? COL.brand : COL.sub,
          background: hover && !disabled ? COL.layer : 'transparent',
          opacity: disabled ? 0.42 : 1,
          transition: 'background .12s ease, color .12s ease, opacity .12s ease',
          position: 'relative',
        },
      }, h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: st.loading ? { animation: 'dsh-po-pulse 1s ease-in-out infinite' } : undefined,
      },
        h('path', { d: 'M15 4V2M15 10V8M12.5 6h-2M19.5 6h-2' }),
        h('path', { d: 'M4 20l7.5-7.5' }),
        h('path', { d: 'M13.2 8.6l2.2 2.2' }),
        h('path', { d: 'M9.5 12.3l-1.2 3.4 3.4-1.2' }),
      ), h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute',
          right: 2,
          bottom: 2,
          width: 4,
          height: 4,
          borderRadius: 2,
          background: 'currentColor',
          opacity: 0.4,
          pointerEvents: 'none',
        },
      }), st.loading ? h('style', null, '@keyframes dsh-po-pulse{0%,100%{opacity:.35}50%{opacity:1}}') : null)
    }

    /* ------------------------------------------------------------------ */
    /* 浮层：对比 + 采用                                                   */
    /* ------------------------------------------------------------------ */
    function box(style, children) {
      return h('div', { style: Object.assign({
        border: '1px solid ' + COL.border,
        borderRadius: 10,
        background: COL.layer,
        padding: '10px 12px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 13,
        lineHeight: 1.62,
        color: COL.text,
        fontFamily: 'var(--dsh-font-family-text, inherit)',
      }, style) }, children)
    }

    function smallBtn(kind, label, onClick, extra) {
      var primary = kind === 'primary'
      var danger = kind === 'danger'
      return h('button', {
        type: 'button',
        onClick: onClick,
        style: Object.assign({
          border: '1px solid ' + (primary ? 'transparent' : COL.border),
          background: primary ? COL.brand : 'transparent',
          color: primary ? '#fff' : danger ? COL.error : COL.text,
          borderRadius: 8,
          padding: '6px 14px',
          fontSize: 13,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }, extra || {}),
      }, label)
    }

    function OptimizePanel(props) {
      var st = useStore()
      var actions = props.inputActions || store.inputActions
      var useInput = props.useInput || function () { return undefined }
      // 订阅草稿，确保「采用」写回时能感知当前会话存在
      useInput(function (s) { return s.phase })

      if (!st.panelOpen) return null

      function close() { store.set({ panelOpen: false, error: '' }) }

      function adopt() {
        if (actions && typeof actions.setDraft === 'function' && st.optimized) {
          actions.setDraft(st.optimized)
          if (typeof actions.persistDraft === 'function') actions.persistDraft()
        }
        close()
      }

      function retry() { runOptimize(st.original) }

      function iterate() {
        var ins = (st.instruction || '').trim()
        if (!ins || !st.optimized) return
        runOptimize(st.original, { instruction: ins, previous: st.optimized })
      }

      function toggleHistory() {
        var next = !st.historyOpen
        store.set({ historyOpen: next })
        if (next) loadHistory()
      }

      function historyView() {
        if (st.historyLoading) {
          return h('div', { style: { padding: '26px 0', textAlign: 'center', color: COL.sub, fontSize: 13 } }, '正在读历史…')
        }
        if (!st.history.length) {
          return h('div', { style: { padding: '26px 0', textAlign: 'center', color: COL.sub, fontSize: 13 } }, '还没有历史记录')
        }
        return h('div', { style: { maxHeight: '38vh', overflow: 'auto' } },
          st.history.map(function (item, i) {
            var when = ''
            try { when = new Date(item.at || Date.now()).toLocaleString() } catch (e) { when = '' }
            return h('div', {
              key: String(item.at || i),
              onClick: function () {
                store.set({ original: item.original || '', optimized: item.optimized || '', historyOpen: false, error: '' })
              },
              style: { padding: '8px 4px', borderBottom: '1px solid ' + COL.border, cursor: 'pointer' },
            },
              h('div', {
                style: { fontSize: 12.5, color: COL.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, (item.original || '').slice(0, 60) || '（空）'),
              h('div', { style: { fontSize: 11, color: COL.sub, marginTop: 3 } },
                (item.instruction ? '迭代 · ' : '') + (MODE_LABELS[item.mode] || item.mode || '') + (when ? ' · ' + when : '')),
            )
          }),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
            smallBtn('ghost', '清空历史', clearHistory)),
        )
      }

      var header = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
      },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: COL.text } }, '提示词优化'),
        h('div', { style: { fontSize: 12, color: COL.sub } }, MODE_LABELS[st.mode] || st.mode),
        h('div', { style: { flex: 1 } }),
        h('button', {
          type: 'button',
          title: st.historyOpen ? '返回对比' : '优化历史',
          onClick: toggleHistory,
          style: { border: 'none', background: 'transparent', cursor: 'pointer', color: COL.sub, fontSize: 12, padding: '0 6px' },
        }, st.historyOpen ? '返回' : '历史'),
        h('button', {
          type: 'button',
          title: '关闭',
          onClick: close,
          style: { border: 'none', background: 'transparent', cursor: 'pointer', color: COL.sub, fontSize: 16, lineHeight: 1, padding: '0 4px' },
        }, '×'),
      )

      var body
      if (st.historyOpen) {
        body = historyView()
      } else if (st.loading && !st.optimized) {
        body = h('div', { style: { padding: '26px 0', textAlign: 'center', color: COL.sub, fontSize: 13 } }, '正在优化…')
      } else if (st.error && !st.loading) {
        body = h('div', { style: { padding: '18px 0', color: COL.error, fontSize: 13 } }, st.error)
      } else {
        body = h('div', {
          style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
        },
          h('div', null,
            h('div', { style: { fontSize: 11, color: COL.sub, marginBottom: 6, letterSpacing: '.04em' } }, '原文'),
            box({ maxHeight: '38vh' }, st.original),
          ),
          h('div', null,
            h('div', { style: { fontSize: 11, color: COL.sub, marginBottom: 6, letterSpacing: '.04em' } }, '优化后'),
            box({ maxHeight: '38vh', borderColor: COL.border2, background: COL.bg }, st.optimized || '（空）'),
          ),
        )
      }

      var footer
      if (st.loading || st.historyOpen) {
        footer = null
      } else if (st.error) {
        footer = h('div', {
          style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 },
        },
          smallBtn('ghost', '丢弃', close),
          smallBtn('primary', '重试', retry),
        )
      } else {
        footer = h('div', {
          style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 },
        },
          smallBtn('ghost', '丢弃', close),
          smallBtn('ghost', '再优化一次', retry),
          smallBtn('primary', '采用', adopt),
        )
      }

      var iterateBar = st.loading || st.error || st.historyOpen ? null : h('div', {
        style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' },
      },
        h('input', {
          value: st.instruction || '',
          placeholder: '按指令改：再专业一点 / 太长，砍一半 / 去掉示例',
          onChange: function (e) { store.set({ instruction: e.target.value }) },
          onKeyDown: function (e) {
            if (e.key === 'Enter') { e.preventDefault(); iterate() }
          },
          style: {
            flex: 1, height: 30, padding: '0 10px', borderRadius: 8,
            border: '1px solid ' + COL.border, background: COL.bg,
            color: COL.text, fontSize: 12.5, outline: 'none',
          },
        }),
        smallBtn('ghost', '迭代', iterate),
      )

      var vw = window.innerWidth || 1200
      var vh = window.innerHeight || 800
      var rect = st.panelRect
      var pw = Math.min(900, vw - 40)
      var pleft = rect
        ? Math.max(16, Math.min(rect.left - 8, vw - pw - 16))
        : Math.max(16, (vw - pw) / 2)
      var pbottom = rect ? Math.max(16, vh - rect.top + 10) : 108

      return h('div', {
        style: {
          position: 'fixed',
          left: pleft,
          bottom: pbottom,
          width: pw,
          maxHeight: '72vh',
          zIndex: 2147483000,
          background: COL.bg,
          border: '1px solid ' + COL.border,
          borderRadius: 14,
          boxShadow: '0 18px 48px rgba(0,0,0,.20)',
          padding: 14,
          boxSizing: 'border-box',
        },
      }, header, body, iterateBar, footer)
    }

    /* ------------------------------------------------------------------ */
    /* 设置面板：模式卡片 + 模型搜索 / 最近使用 / provider 分组            */
    /* ------------------------------------------------------------------ */
    var DEFAULT_MODES = [
      { id: 'context-message-optimize', name: '消息优化', description: '把一句话改清楚：补指代、补条件、拆句子，保持原有语气和长度' },
      { id: 'general-optimize', name: '结构化重写', description: '扩写成角色设定：目的 / 定位 / 铁律 / 工作方式 / 能力 / 输出 / 假设，350-1400 字' },
    ]

    function modeList(st) {
      return (st.modes && st.modes.length) ? st.modes : DEFAULT_MODES
    }

    function ModeCard(props) {
      var hoverPair = React.useState(false)
      var hover = hoverPair[0]
      var setHover = hoverPair[1]
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        onMouseEnter: function () { setHover(true) },
        onMouseLeave: function () { setHover(false) },
        style: {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          border: '1px solid ' + (props.active ? COL.brand : hover ? COL.border2 : COL.border),
          background: props.active ? 'rgba(33,89,214,.07)' : hover ? COL.layer : 'transparent',
          borderRadius: 8,
          padding: '8px 10px',
          marginBottom: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: COL.text } },
          h('span', { style: { width: 14, flex: 'none', color: COL.brand } }, props.active ? '●' : '○'),
          h('span', { style: { flex: 1 } }, props.name),
        ),
        props.description
          ? h('div', { style: { fontSize: 11.5, color: COL.sub, lineHeight: 1.55, marginTop: 3, paddingLeft: 20 } }, props.description)
          : null,
      )
    }

    function ModelRow(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: props.active ? COL.layer : 'transparent',
          borderRadius: 6,
          padding: '5px 8px',
          fontSize: 12.5,
          color: COL.text,
          cursor: 'pointer',
          fontFamily: 'inherit',
        },
      },
        h('span', { style: { width: 12, flex: 'none', color: COL.brand } }, props.active ? '✓' : ''),
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.label),
        props.hint
          ? h('span', { style: { fontSize: 10.5, color: COL.sub, flex: 'none', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.hint)
          : null,
      )
    }

    function groupTitle(text, count, expanded, onClick) {
      return h('button', {
        type: 'button',
        onClick: onClick,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: 'transparent',
          padding: '6px 8px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 11.5,
          color: COL.sub,
        },
      },
        h('span', { style: { width: 10, flex: 'none' } }, expanded ? '▾' : '▸'),
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text),
        h('span', { style: { flex: 'none', opacity: 0.7 } }, String(count)),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 自定义模板：只有 source === 'custom' 的模式可改可删                  */
    /* ------------------------------------------------------------------ */
    var SMALL_BTN = {
      border: '1px solid ' + COL.border,
      background: 'transparent',
      color: COL.sub,
      borderRadius: 6,
      padding: '2px 8px',
      fontSize: 11,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }
    var FORM_INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      margin: '0 0 6px',
      padding: '6px 9px',
      fontSize: 12.5,
      color: COL.text,
      background: COL.layer,
      border: '1px solid ' + COL.border,
      borderRadius: 7,
      outline: 'none',
      fontFamily: 'inherit',
    }

    function customModesOf(st) {
      return (st.modes || []).filter(function (m) { return m.source === 'custom' })
    }

    function CustomModeSection(props) {
      var st = props.st
      var list = customModesOf(st)
      var editing = st.editingCustom

      function asPayload() {
        return list.map(function (m) {
          return { id: m.id, name: m.name, system: m.system || '' }
        })
      }

      function persist(next) {
        saveSettings({ customModes: next }).then(function () {
          store.set({ editingCustom: null })
          loadModes(true)
        })
      }

      function removeOne(id) {
        persist(list.filter(function (m) { return m.id !== id }).map(function (m) {
          return { id: m.id, name: m.name, system: m.system || '' }
        }))
      }

      function startNew() {
        store.set({ editingCustom: { id: '', name: '', system: '' } })
      }

      function startEdit(m) {
        store.set({ editingCustom: { id: m.id, name: m.name, system: m.system || '' } })
      }

      function patch(field, value) {
        var cur = st.editingCustom || { id: '', name: '', system: '' }
        var next = { id: cur.id, name: cur.name, system: cur.system }
        next[field] = value
        store.set({ editingCustom: next })
      }

      function submit() {
        var cur = st.editingCustom
        if (!cur) return
        var name = String(cur.name || '').trim()
        var system = String(cur.system || '').trim()
        if (!name || !system) return
        var id = cur.id || ('custom-' + Date.now().toString(36))
        var others = list.filter(function (m) { return m.id !== id }).map(function (m) {
          return { id: m.id, name: m.name, system: m.system || '' }
        })
        persist(others.concat([{ id: id, name: name, system: system }]))
      }

      if (editing) {
        var filled = String(editing.name || '').trim() && String(editing.system || '').trim()
        return h('div', { style: { marginTop: 4 } },
          h('input', {
            type: 'text',
            value: editing.name,
            placeholder: '模板名称，例如「技术方案模板」',
            onChange: function (e) { patch('name', e.target.value) },
            style: FORM_INPUT,
          }),
          h('textarea', {
            value: editing.system,
            placeholder: '写 system 提示词：告诉模型该怎么改写输入',
            rows: 6,
            onChange: function (e) { patch('system', e.target.value) },
            style: Object.assign({}, FORM_INPUT, { resize: 'vertical', lineHeight: 1.5 }),
          }),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('button', {
              type: 'button',
              onClick: submit,
              style: {
                border: '1px solid ' + (filled ? COL.brand : COL.border),
                background: filled ? 'rgba(33,89,214,.07)' : 'transparent',
                color: filled ? COL.brand : COL.sub,
                borderRadius: 6,
                padding: '3px 10px',
                fontSize: 11.5,
                cursor: filled ? 'pointer' : 'default',
                fontFamily: 'inherit',
              },
            }, '保存'),
            h('button', {
              type: 'button',
              onClick: function () { store.set({ editingCustom: null }) },
              style: SMALL_BTN,
            }, '取消'),
            filled ? null : h('span', { style: { fontSize: 11, color: COL.sub } }, '名称和正文都要填'),
          ),
        )
      }

      var rows = list.map(function (m) {
        return h('div', {
          key: m.id,
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12, color: COL.text },
        },
          h('span', {
            style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, m.name),
          h('button', { type: 'button', onClick: function () { startEdit(m) }, style: SMALL_BTN }, '改'),
          h('button', { type: 'button', onClick: function () { removeOne(m.id) }, style: SMALL_BTN }, '删'),
        )
      })

      return h('div', { style: { marginTop: 4 } },
        rows,
        h('button', {
          type: 'button',
          onClick: startNew,
          style: Object.assign({}, SMALL_BTN, { width: '100%', padding: '5px 0', marginTop: rows.length ? 6 : 0 }),
        }, '＋ 新建自定义模板'),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 整页面板：侧边栏图标 + main 键，两栏（左概览 / 右设置）              */
    /* ------------------------------------------------------------------ */

    /* 区块：标题 + 一句说明 + 内容；accent 只给有数据的区块 */
    function pageSection(title, description, children, accent) {
      return h('section', { style: { marginBottom: 32 } },
        h('h2', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '0 0 4px',
            fontSize: FS.h1,
            fontWeight: 650,
            color: COL.text,
            letterSpacing: '.01em',
          },
        },
          accent
            ? h('span', { style: { width: 3, height: 14, borderRadius: 2, background: accent, flex: 'none' } })
            : null,
          h('span', null, title),
        ),
        description
          ? h('div', { style: { fontSize: FS.sub, color: COL.sub, lineHeight: 1.75, margin: '0 0 12px' } }, description)
          : null,
        children,
      )
    }

    function timeAgo(ts) {
      var n = Number(ts)
      if (!n || isNaN(n)) return ''
      var diff = Date.now() - n
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      return Math.floor(diff / 86400000) + ' 天前'
    }

    /* 本地日期键：图表与筛选共用同一个口径，避免时区/补零不一致 */
    function dayKeyOf(ts) {
      var d = new Date(ts)
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
    }

    /* 状态概览：三格。vertical = 左栏竖排，否则横排三列 */
    function StatusStrip(props) {
      var st = props.st
      var last = (st.history && st.history[0]) || null
      var modelText = st.selection && st.selection.provider
        ? (st.selection.model || st.selection.provider)
        : '跟随 DSH 默认'
      var cells = [
        { k: '当前模式', v: (MODE_LABELS[st.mode] || st.mode || '—'), s: '左键点魔法棒时生效', c: CHART[0] },
        { k: '使用模型', v: modelText, s: st.selection && st.selection.provider ? '可在「模型」页单独指定' : '在「模型」页可单独指定', c: CHART[1] },
        { k: '上次优化', v: last ? timeAgo(last.at) : '还没有', s: '累计 ' + ((st.history && st.history.length) || 0) + ' 次', c: CHART[2] },
      ]
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: props.vertical ? '1fr' : 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          marginBottom: props.vertical ? 28 : 30,
        },
      }, cells.map(function (c) {
        return h('div', {
          key: c.k,
          style: {
            position: 'relative',
            border: '1px solid ' + COL.border,
            borderRadius: 14,
            background: COL.layer,
            padding: '13px 15px 13px 18px',
            boxSizing: 'border-box',
            overflow: 'hidden',
          },
        },
          h('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: c.c } }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.tiny, color: COL.sub } },
            h('span', { style: { width: 5, height: 5, borderRadius: 3, background: c.c, flex: 'none' } }),
            h('span', null, c.k),
          ),
          h('div', {
            style: {
              fontSize: 19,
              fontWeight: 650,
              color: COL.text,
              margin: '4px 0 3px',
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, c.v),
          h('div', { style: { fontSize: FS.tiny, color: COL.sub, lineHeight: 1.5 } }, c.s),
        )
      }))
    }

    /* 顶栏：返回会话 + 面包屑 + 当前模式 + 「更多」菜单 */
    function menuItem(label, onClick, muted) {
      var pair = React.useState(false)
      var hover = pair[0]
      var setHover = pair[1]
      return h('button', {
        type: 'button',
        onClick: onClick || function () {},
        onMouseEnter: function () { setHover(true) },
        onMouseLeave: function () { setHover(false) },
        style: {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: hover && onClick ? COL.layer : 'transparent',
          color: muted ? COL.sub : COL.text,
          borderRadius: 8,
          padding: '7px 9px',
          fontSize: FS.sub,
          cursor: onClick ? 'pointer' : 'default',
          fontFamily: 'inherit',
        },
      }, label)
    }

    function PageTopBar(props) {
      var st = props.st
      var pair = React.useState(false)
      var leaving = pair[0]
      var setLeaving = pair[1]

      var morePair = React.useState(false)
      var moreOpen = morePair[0]
      var setMoreOpen = morePair[1]

      function goBack() {
        if (leaving) return
        setLeaving(true)
        // 先让按钮进入「返回中…」，再让出一帧去切面板，避免点了像没反应
        requestAnimationFrame(function () {
          setTimeout(function () {
            if (pageCloser) pageCloser()
            setLeaving(false)
          }, 0)
        })
      }

      React.useEffect(function () {
        function onKey(e) {
          if (!e || e.key !== 'Escape') return
          var t = e.target
          var tag = t && t.tagName ? String(t.tagName).toUpperCase() : ''
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
          if (t && t.isContentEditable) return
          goBack()
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [leaving])

      return h('div', {
        style: {
          position: 'sticky',
          top: 0,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 'var(--dsh-frame-top-clearance, 48px)',
          paddingBottom: 12,
          paddingLeft: 28,
          paddingRight: 28,
          background: 'var(--dsw-alias-bg-base, #fff)',
          borderBottom: '1px solid ' + COL.border,
        },
      },
        h('button', {
          type: 'button',
          onClick: goBack,
          title: '返回会话（Esc）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            border: 'none',
            background: 'transparent',
            color: leaving ? COL.sub : COL.text,
            borderRadius: 8,
            padding: '5px 7px',
            fontSize: FS.sub,
            cursor: leaving ? 'default' : 'pointer',
            fontFamily: 'inherit',
          },
        },
          h('span', { style: { fontSize: 15, lineHeight: 1 } }, '‹'),
          h('span', null, leaving ? '返回中…' : '返回会话'),
        ),
        h('span', { style: { color: COL.border2, fontSize: FS.sub } }, '/'),
        h('span', { style: { fontSize: FS.h1, fontWeight: 650, color: COL.text } }, '提示词优化'),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { fontSize: FS.tiny, color: COL.sub } }, MODE_LABELS[st.mode] || st.mode || ''),
        h('div', { style: { position: 'relative' } },
          h('button', {
            type: 'button',
            title: '更多',
            onClick: function () { setMoreOpen(!moreOpen) },
            style: {
              border: '1px solid ' + COL.border,
              background: 'transparent',
              color: COL.text,
              borderRadius: 9,
              padding: '4px 11px',
              fontSize: FS.tiny,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          }, '更多'),
          moreOpen
            ? h('div', {
                style: {
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 6px)',
                  minWidth: 220,
                  background: COL.bg,
                  border: '1px solid ' + COL.border,
                  borderRadius: 12,
                  boxShadow: '0 14px 36px rgba(0,0,0,.20)',
                  padding: 6,
                  zIndex: 20,
                },
              },
                menuItem('查看源码 ↗', function () {
                  setMoreOpen(false)
                  try { window.open(REPO_URL, '_blank', 'noopener') } catch (err) { /* 弹窗被拦时静默 */ }
                }),
                h('div', { style: { borderTop: '1px solid ' + COL.border, margin: '5px 4px' } }),
                menuItem('v' + PLUGIN_VERSION + ' · MIT · 独立实现', null, true),
              )
            : null,
        ),
      )
    }

    /* 标签页：模式 / 模型 / 历史 */
    var PAGE_TABS = [
      { id: 'mode', label: '模式' },
      { id: 'model', label: '模型' },
      { id: 'history', label: '历史' },
    ]

    function pageTabs(st) {
      return h('div', {
        style: { display: 'flex', gap: 4, borderBottom: '1px solid ' + COL.border, marginBottom: 26 },
      }, PAGE_TABS.map(function (t) {
        var active = (st.pageTab || 'mode') === t.id
        return h('button', {
          key: t.id,
          type: 'button',
          onClick: function () { store.set({ pageTab: t.id }) },
          style: {
            border: 'none',
            background: 'transparent',
            color: active ? COL.text : COL.sub,
            borderBottom: '2px solid ' + (active ? COL.brand : 'transparent'),
            padding: '9px 12px',
            marginBottom: -1,
            fontSize: FS.body,
            fontWeight: active ? 650 : 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        }, t.label)
      }))
    }

    /* 当前模式的 system 摘要：告诉用户「这套规则实际要求模型做什么」 */
    var MODE_SUMMARY = {
      'context-message-optimize': '只改写不动手：补齐指代和缺失条件、拆长句、去掉含糊的词；保持原语言和原语气。不替你回答，也不把一句话扩成一篇。',
      'general-optimize': '先判断你这句话里最在意哪一条，再按「目的 / 定位 / 铁律 / 工作方式 / 能力 / 输出 / 假设」产出角色设定，铁律最多 5 条且每条带「违反长这样」。你说「简洁」就压到 350-650 字的五节版。',
    }

    function ModeSummary(props) {
      var st = props.st
      var m = (modeList(st) || []).filter(function (x) { return x.id === st.mode })[0]
      if (!m) return null
      var text = m.summary || MODE_SUMMARY[m.id] || m.description || ''
      if (!text) return null
      return h('div', {
        style: {
          marginTop: 14,
          border: '1px solid ' + COL.border,
          borderRadius: 14,
          background: COL.layer,
          padding: '14px 16px',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { fontSize: FS.tiny, color: COL.sub, marginBottom: 6 } }, '这套规则实际要求模型做什么'),
        h('div', { style: { fontSize: FS.sub, color: COL.text, lineHeight: 1.8 } }, text),
      )
    }

    /* 模式使用分布：环形图 + 带进度条的图例 */
    function modeStats(st) {
      var hist = st.history || []
      var modes = modeList(st) || []
      var nameOf = {}
      modes.forEach(function (m) { nameOf[m.id] = m.name || m.id })
      var groups = {}
      var order = []
      hist.forEach(function (it) {
        var k = it.mode || ''
        if (!k) return
        if (!groups[k]) { groups[k] = 0; order.push(k) }
        groups[k] += 1
      })
      return order.map(function (k) {
        return { id: k, name: nameOf[k] || k, count: groups[k] }
      }).sort(function (a, b) { return b.count - a.count })
    }

    function ModeDonut(props) {
      var st = props.st
      var rows = modeStats(st)
      var total = rows.reduce(function (n, r) { return n + r.count }, 0)
      if (!total) {
        return h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 120, padding: '10px 0',
            border: '1px solid ' + COL.border, borderRadius: 14, background: COL.layer,
            boxSizing: 'border-box',
          },
        }, h('div', {
          style: { fontSize: FS.sub, color: COL.sub, lineHeight: 1.85, textAlign: 'center' },
        }, '还没有优化记录', h('br'), '用魔法棒优化几次，这里会长出图表'))
      }

      var CIRC = 100
      var offset = 25
      var segs = rows.map(function (r, i) {
        var len = r.count / total * CIRC
        var seg = h('circle', {
          key: 's' + r.id,
          cx: 21, cy: 21, r: 15.9155, fill: 'none',
          stroke: CHART[i % CHART.length],
          strokeWidth: 5.6,
          strokeDasharray: len + ' ' + (CIRC - len),
          strokeDashoffset: offset,
          transform: 'rotate(-90 21 21)',
        })
        offset -= len
        return seg
      })

      var legend = rows.map(function (r, i) {
        var pct = Math.round(r.count / total * 100)
        var c = CHART[i % CHART.length]
        return h('div', { key: 'l' + r.id, style: { marginBottom: 12 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 2, background: c, flex: 'none' } }),
            h('span', {
              style: { fontSize: FS.sub, color: COL.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, r.name),
            h('span', { style: { fontSize: FS.tiny, color: COL.sub, fontVariantNumeric: 'tabular-nums', flex: 'none' } },
              r.count + ' 次 · ' + pct + '%'),
          ),
          h('div', { style: { height: 4, borderRadius: 3, background: COL.border, overflow: 'hidden' } },
            h('div', { style: { height: '100%', width: Math.max(pct, 2) + '%', background: c, borderRadius: 3 } }),
          ),
        )
      })

      return h('div', {
        style: props.compact
          ? { display: 'flex', flexDirection: 'column', gap: 12 }
          : { display: 'grid', gridTemplateColumns: '190px minmax(0, 1fr)', gap: 14, alignItems: 'stretch' },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid ' + COL.border, borderRadius: 14, background: COL.layer,
            padding: 16, boxSizing: 'border-box',
          },
        },
          h('svg', { viewBox: '0 0 42 42', width: 124, height: 124, role: 'img' },
            h('circle', { cx: 21, cy: 21, r: 15.9155, fill: 'none', stroke: COL.border, strokeWidth: 5.6 }),
            segs,
            h('text', { x: 21, y: 20.2, textAnchor: 'middle', fill: COL.text, fontSize: 7, fontWeight: 650 }, String(total)),
            h('text', { x: 21, y: 25.4, textAnchor: 'middle', fill: COL.sub, fontSize: 3.4 }, '次优化'),
          ),
        ),
        h('div', {
          style: {
            border: '1px solid ' + COL.border, borderRadius: 14, background: COL.layer,
            padding: '16px 16px 6px', boxSizing: 'border-box',
          },
        }, legend),
      )
    }

    /* 最近 7 天柱状图 */
    /* 使用趋势：最近 N 天，可横向滑动；点柱子只看那天的记录 */
    function WeekBars(props) {
      var st = props.st
      var hist = st.history || []
      var span = props.days || WEEK_DAYS
      var byDay = {}
      var max = 0
      hist.forEach(function (it) {
        if (!it || !it.at) return
        var d = new Date(it.at)
        var key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
        byDay[key] = (byDay[key] || 0) + 1
        if (byDay[key] > max) max = byDay[key]
      })

      var days = []
      for (var i = span - 1; i >= 0; i--) {
        var dd = new Date(Date.now() - i * 86400000)
        var k = dd.getFullYear() + '-' + (dd.getMonth() + 1) + '-' + dd.getDate()
        days.push({ key: k, label: (dd.getMonth() + 1) + '-' + dd.getDate(), n: byDay[k] || 0 })
      }
      var total = days.reduce(function (n, d) { return n + d.n }, 0)

      if (!total) {
        return h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 120, padding: '10px 0',
            border: '1px solid ' + COL.border, borderRadius: 14, background: COL.layer,
            boxSizing: 'border-box',
          },
        }, h('div', {
          style: { fontSize: FS.sub, color: COL.sub, lineHeight: 1.85, textAlign: 'center' },
        }, '最近 ' + span + ' 天还没有优化记录'))
      }

      return h('div', {
        style: {
          border: '1px solid ' + COL.border, borderRadius: 14, background: COL.layer,
          padding: '14px 10px 10px', boxSizing: 'border-box',
        },
      },
        h('div', { style: { overflowX: 'auto', overflowY: 'hidden', paddingBottom: 2 } },
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 156, width: 'max-content', minWidth: '100%' } },
            days.map(function (d) {
              var picked = props.picked === d.key
              var peak = d.n > 0 && d.n === max
              var barH = max > 0 ? Math.max(Math.round(d.n / max * 96), d.n > 0 ? 8 : 3) : 3
              return h('button', {
                key: d.key,
                type: 'button',
                title: d.label + ' · ' + d.n + ' 次',
                onClick: function () { if (props.onPick) props.onPick(picked ? '' : d.key) },
                style: {
                  width: 34,
                  flex: 'none',
                  height: '100%',
                  padding: '4px 0',
                  border: 'none',
                  borderRadius: 8,
                  background: picked ? 'rgba(76,141,255,.14)' : 'transparent',
                  boxShadow: picked ? 'inset 0 0 0 1px ' + COL.brand : 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 5,
                  fontFamily: 'inherit',
                },
              },
                h('div', { style: { fontSize: 10.5, color: picked ? COL.text : COL.sub, fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, d.n ? String(d.n) : ''),
                h('div', {
                  style: {
                    width: 20,
                    height: barH,
                    borderRadius: 4,
                    background: d.n === 0
                      ? COL.border
                      : peak
                        ? 'linear-gradient(180deg, #a78bfa, #4c8dff 60%, #3a6fd8)'
                        : 'linear-gradient(180deg, #6ea3ff, #4c8dff 55%, #3a6fd8)',
                  },
                }),
                h('div', { style: { fontSize: 10, color: picked ? COL.text : COL.sub, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, d.label),
              )
            }),
          ),
        ),
      )
    }

    /* 最近一次优化：原文与结果完整显示，各带复制 */
    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return
        }
      } catch (err) { /* 降级 */ }
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch (err2) { /* 复制失败不阻塞界面 */ }
    }

    function LastRun(props) {
      var st = props.st
      var it = (st.history && st.history[0]) || null
      if (!it) {
        return h('div', {
          style: {
            border: '1px dashed ' + COL.border, borderRadius: 14,
            padding: '18px 16px', textAlign: 'center',
            fontSize: FS.sub, color: COL.sub, lineHeight: 1.8,
          },
        }, '还没有优化记录。用魔法棒优化一次，这里会留下最近一次的原文与结果。')
      }

      function row(label, text, color) {
        return h('div', { style: { marginBottom: 12 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { style: { fontSize: FS.tiny, color: COL.sub, letterSpacing: '.04em' } }, label),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              title: '复制这一段',
              onClick: function (e) {
                if (e && e.stopPropagation) e.stopPropagation()
                copyText(text)
              },
              style: {
                border: '1px solid ' + COL.border,
                background: 'transparent',
                color: COL.sub,
                borderRadius: 7,
                padding: '2px 8px',
                fontSize: FS.tiny,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            }, '复制'),
          ),
          h('div', {
            style: {
              maxHeight: 180,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: FS.sub,
              color: color,
              lineHeight: 1.8,
            },
          }, text || '（空）'),
        )
      }

      return h('div', {
        onClick: function () {
          store.set({ peek: it })
        },
        title: '打开这次的左右对比',
        style: {
          border: '1px solid ' + COL.border,
          borderRadius: 14,
          background: COL.layer,
          padding: '14px 16px',
          boxSizing: 'border-box',
          cursor: 'pointer',
        },
      },
        row('原文', it.original, COL.sub),
        h('div', { style: { height: 1, background: COL.border, margin: '12px 0' } }),
        row('结果', it.optimized, COL.text),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: FS.tiny, color: COL.sub } },
          h('span', null, (it.mode || '未记录模式') + (it.at ? ' · ' + timeAgo(it.at) : '')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { color: COL.brand } }, '点击查看左右对比 →'),
        ),
      )
    }

    /* 设置页内的对比抽屉：不离开这一页就能看原文与结果。
       之前这里写的是打开会话里的浮层，可设置页占着 main，会话界面根本没渲染，
       点完只会「什么都没发生」——必须把对比做在设置页自己的层级里。 */
    function PeekOverlay(props) {
      var st = props.st
      var it = st.peek
      if (!it) return null

      function column(label, text, color) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flex: 'none' } },
            h('span', { style: { fontSize: FS.tiny, color: COL.sub, letterSpacing: '.04em' } }, label),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              onClick: function () { copyText(text) },
              style: {
                border: '1px solid ' + COL.border,
                background: 'transparent',
                color: COL.sub,
                borderRadius: 7,
                padding: '2px 8px',
                fontSize: FS.tiny,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            }, '复制'),
          ),
          h('div', {
            style: {
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: FS.sub,
              lineHeight: 1.8,
              color: color,
              border: '1px solid ' + COL.border,
              borderRadius: 12,
              background: COL.layer,
              padding: '12px 14px',
              boxSizing: 'border-box',
            },
          }, text || '（空）'),
        )
      }

      return h('div', {
        onClick: function () { store.set({ peek: null }) },
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 2147483000,
          background: 'rgba(0,0,0,.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          boxSizing: 'border-box',
        },
      },
        h('div', {
          onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation() },
          style: {
            width: 'min(1120px, 100%)',
            height: 'min(720px, 86vh)',
            background: COL.bg,
            border: '1px solid ' + COL.border,
            borderRadius: 16,
            boxShadow: '0 24px 64px rgba(0,0,0,.32)',
            padding: 18,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flex: 'none' } },
            h('span', { style: { fontSize: FS.h1, fontWeight: 650, color: COL.text } }, '左右对比'),
            h('span', { style: { fontSize: FS.tiny, color: COL.sub } },
              (it.mode || '未记录模式') + (it.at ? ' · ' + timeAgo(it.at) : ''),
            ),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              title: '关闭',
              onClick: function () { store.set({ peek: null }) },
              style: {
                border: 'none',
                background: 'transparent',
                color: COL.sub,
                fontSize: 18,
                lineHeight: 1,
                cursor: 'pointer',
                padding: '2px 6px',
              },
            }, '×'),
          ),
          h('div', {
            style: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
          },
            column('原文', it.original, COL.sub),
            column('优化后', it.optimized, COL.text),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            h('button', {
              type: 'button',
              onClick: function () {
                store.set({ peek: null })
                if (pageCloser) pageCloser()
                store.set({ panelOpen: true, original: it.original, optimized: it.optimized, error: '' })
              },
              style: {
                border: '1px solid ' + COL.border,
                background: 'transparent',
                color: COL.text,
                borderRadius: 9,
                padding: '6px 12px',
                fontSize: FS.sub,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            }, '在会话里打开'),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              onClick: function () { store.set({ peek: null }) },
              style: {
                border: '1px solid ' + COL.brand,
                background: 'transparent',
                color: COL.brand,
                borderRadius: 9,
                padding: '6px 14px',
                fontSize: FS.sub,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            }, '关闭'),
          ),
        ),
      )
    }

    /* 快捷键与手势 */
    var SHORTCUTS = [
      ['左键点魔法棒', '优化当前草稿；草稿为空时只提示，不动手'],
      ['右键魔法棒', '打开这个设置页'],
      ['Shift + 左键', '同上，给不习惯右键的场合'],
      ['Esc', '从设置页返回会话'],
      ['输入框下方的「迭代」', '按指令改一版，不推翻重来'],
      ['历史 / 最近一次优化', '点一条，在设置页内打开左右对比'],
      ['模型页的搜索框', '按模型名或 provider 过滤，收起时也能搜'],
    ]

    function Shortcuts() {
      return h('div', {
        style: { border: '1px solid ' + COL.border, borderRadius: 14, overflow: 'hidden', background: COL.layer },
      }, SHORTCUTS.map(function (row, i) {
        return h('div', {
          key: row[0],
          style: {
            padding: '10px 12px',
            borderTop: i === 0 ? 'none' : '1px solid ' + COL.border,
            boxSizing: 'border-box',
          },
        },
          h('div', {
            style: { fontSize: FS.sub, color: COL.text, fontWeight: 600, lineHeight: 1.5, marginBottom: 2 },
          }, row[0]),
          h('div', {
            style: { fontSize: FS.tiny, color: COL.sub, lineHeight: 1.7, wordBreak: 'break-word' },
          }, row[1]),
        )
      }))
    }

    /* 页脚只留品牌与版本；仓库入口在右上角「更多」里 */
    function AboutFooter() {
      return h('div', {
        style: {
          marginTop: 44,
          paddingTop: 16,
          borderTop: '1px solid ' + COL.border,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          fontSize: FS.tiny,
          color: COL.sub,
        },
      },
        h('span', null, 'dsh-prompt-optimizer-nyco1d'),
        h('span', { style: { opacity: 0.45 } }, '·'),
        h('span', null, 'v' + PLUGIN_VERSION),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { opacity: 0.7 } }, 'MIT'),
      )
    }

    /* 历史列表；选中某天后只列那一天的 */
    function HistoryTab(props) {
      var st = props.st
      var all = st.history || []
      var list = all.filter(function (it) {
        if (!st.dayPick) return true
        if (!it || !it.at) return false
        var d = new Date(it.at)
        return (d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()) === st.dayPick
      })
      if (st.historyLoading) {
        return h('div', { style: { padding: '16px 0', color: COL.sub, fontSize: FS.sub } }, '正在读历史…')
      }
      if (!all.length) {
        return h('div', { style: { padding: '16px 0', color: COL.sub, fontSize: FS.sub } }, '还没有历史记录')
      }
      if (!list.length) {
        return h('div', { style: { padding: '16px 0', color: COL.sub, fontSize: FS.sub, display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', null, '这一天没有记录'),
          h('button', {
            type: 'button',
            onClick: function () { store.set({ dayPick: '' }) },
            style: {
              border: '1px solid ' + COL.border,
              background: 'transparent',
              color: COL.text,
              borderRadius: 8,
              padding: '3px 10px',
              fontSize: FS.tiny,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          }, '看全部'),
        )
      }
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          h('span', { style: { fontSize: FS.sub, color: COL.sub, flex: 1 } },
            (st.dayPick ? '选中 ' + st.dayPick + ' · ' : '') + '共 ' + list.length + ' 条，点一条在设置页内打开对比'),
          st.dayPick
            ? h('button', {
                type: 'button',
                onClick: function () { store.set({ dayPick: '' }) },
                style: {
                  border: '1px solid ' + COL.border,
                  background: 'transparent',
                  color: COL.text,
                  borderRadius: 8,
                  padding: '4px 10px',
                  fontSize: FS.tiny,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                },
              }, '看全部')
            : null,
          h('button', {
            type: 'button',
            onClick: function () { clearHistory() },
            style: {
              border: '1px solid ' + COL.border,
              background: 'transparent',
              color: COL.sub,
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: FS.tiny,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          }, '清空'),
        ),
        list.map(function (it, i) {
          var preview = String(it.original || '').replace(/\s+/g, ' ').slice(0, 80)
          return h('div', {
            key: 'h' + i,
            onClick: function () {
              store.set({ peek: it })
            },
            style: {
              border: '1px solid ' + COL.border,
              borderRadius: 12,
              background: COL.layer,
              padding: '11px 14px',
              marginBottom: 8,
              cursor: 'pointer',
              boxSizing: 'border-box',
            },
          },
            h('div', { style: { fontSize: FS.body, color: COL.text, lineHeight: 1.55, marginBottom: 4 } }, preview || '（空）'),
            h('div', { style: { fontSize: FS.tiny, color: COL.sub } },
              (it.mode || '未记录模式') + (it.at ? ' · ' + timeAgo(it.at) : ''),
            ),
          )
        }),
      )
    }

    /* 左栏：常驻概览 */
    function LeftRail(props) {
      var st = props.st
      return h('aside', {
        style: {
          width: RAIL_W,
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          boxSizing: 'border-box',
          alignSelf: 'flex-start',
          padding: '16px 14px 0',
          borderRadius: 18,
          border: '1px solid ' + COL.border,
          background: 'linear-gradient(180deg, rgba(255,255,255,.065), rgba(255,255,255,.018))',
          backdropFilter: 'blur(18px) saturate(150%)',
          WebkitBackdropFilter: 'blur(18px) saturate(150%)',
          boxShadow: '0 16px 44px rgba(0,0,0,.20)',
        },
      },
        h(StatusStrip, { st: st, vertical: true }),
        pageSection('模式使用分布', '看看你实际在用哪套规则。', h(ModeDonut, { st: st, compact: true }), CHART[1]),
        pageSection('快捷键与手势', '这些操作界面上没有提示。', h(Shortcuts, null)),
      )
    }

    /* 整页：顶栏 + 两栏 */
    function PromptOptimizerPage() {
      var st = useStore()
      var tab = st.pageTab || 'mode'

      React.useEffect(function () {
        loadSettings()
        loadModes()
        loadModels()
        loadHistory()
      }, [])

      function pickMode(id) {
        store.set({ mode: id })
        saveSettings({ mode: id })
      }

      function pickModel(provider, model) {
        var recent = pushRecent(provider, model)
        store.set({ selection: { provider: provider, model: model }, recent: recent })
        saveSettings({ provider: provider, model: model })
      }

      var content = null

      if (tab === 'mode') {
        var modes = modeList(st) || []
        var cards = modes.map(function (m) {
          return h(ModeCard, {
            key: m.id,
            name: m.name || m.id,
            description: m.description || '',
            active: st.mode === m.id,
            onClick: function () { pickMode(m.id) },
          })
        })
        content = h('div', null,
          pageSection('优化模式', '左键点魔法棒时，用哪一套规则改写草稿。同一时间只用一套。',
            h('div', null, cards, h(ModeSummary, { st: st }))),
          pageSection('自定义模板', '把你自己的 system 提示词存成一种模式，和内置的三套并列。',
            h(CustomModeSection, { st: st })),
          pageSection('最近一次优化', '点开回到完整的左右对比。', h(LastRun, { st: st })),
        )
      } else if (tab === 'model') {
        var models = st.models || []
        var q = String(st.modeQuery || '').trim().toLowerCase()
        var cur = st.selection || { provider: '', model: '' }

        var followRow = h(ModelRow, {
          key: '__follow',
          label: '跟随 DSH 默认模型',
          hint: '推荐',
          active: !cur.provider,
          onClick: function () { pickModel('', '') },
        })

        var modelBody = null
        if (st.modelsLoading) {
          modelBody = h('div', { style: { padding: '10px 0', fontSize: FS.sub, color: COL.sub } }, '读取模型列表…')
        } else if (st.modelsError) {
          modelBody = h('div', { style: { padding: '10px 0', fontSize: FS.sub, color: COL.error } }, st.modelsError)
        } else if (models.length === 0) {
          modelBody = h('div', { style: { padding: '10px 0', fontSize: FS.sub, color: COL.sub } }, '没有可用模型')
        } else if (q) {
          var hits = models.filter(function (m) {
            return String(m.name || '').toLowerCase().indexOf(q) >= 0
              || String(m.model || '').toLowerCase().indexOf(q) >= 0
              || String(m.provider || '').toLowerCase().indexOf(q) >= 0
              || String(m.providerName || '').toLowerCase().indexOf(q) >= 0
          })
          modelBody = hits.length
            ? hits.slice(0, 60).map(function (m) {
                return h(ModelRow, {
                  key: m.provider + '/' + m.model,
                  label: m.name || m.model,
                  hint: m.providerName || m.provider,
                  active: cur.provider === m.provider && cur.model === m.model,
                  onClick: function () { pickModel(m.provider, m.model) },
                })
              })
            : h('div', { style: { padding: '10px 0', fontSize: FS.sub, color: COL.sub } }, '没有匹配的模型')
        } else {
          var groups = {}
          var order = []
          models.forEach(function (m) {
            if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider) }
            groups[m.provider].push(m)
          })

          var blocks = []
          if (st.recent && st.recent.length) {
            blocks.push(h('div', { key: '__recentTitle', style: { padding: '8px 0 4px', fontSize: FS.tiny, color: COL.sub } }, '最近使用'))
            st.recent.forEach(function (r) {
              var hit = models.filter(function (m) { return m.provider === r.provider && m.model === r.model })[0]
              blocks.push(h(ModelRow, {
                key: 'recent/' + r.provider + '/' + r.model,
                label: (hit && hit.name) || r.model,
                hint: (hit && hit.providerName) || r.provider,
                active: cur.provider === r.provider && cur.model === r.model,
                onClick: function () { pickModel(r.provider, r.model) },
              }))
            })
            blocks.push(h('div', { key: '__recentDiv', style: { height: 1, background: COL.border, margin: '10px 0' } }))
          }

          order.forEach(function (p) {
            var list = groups[p]
            var anySelected = list.some(function (m) { return cur.provider === m.provider && cur.model === m.model })
            var expanded = st.expandedProvider === p || anySelected
            var pname = list[0].providerName || p
            blocks.push(groupTitle(pname, list.length, expanded, function () {
              store.set({ expandedProvider: expanded ? '' : p })
            }))
            if (expanded) {
              list.forEach(function (m) {
                blocks.push(h(ModelRow, {
                  key: m.provider + '/' + m.model,
                  label: m.name || m.model,
                  hint: '',
                  active: cur.provider === m.provider && cur.model === m.model,
                  onClick: function () { pickModel(m.provider, m.model) },
                }))
              })
            }
          })
          modelBody = blocks
        }

        content = h('div', null,
          pageSection('默认模型', '不改这里就用 DSH 当前会话的模型；改了只影响这个插件。',
            h('div', null,
              followRow,
              h('input', {
                type: 'text',
                value: st.modeQuery,
                placeholder: '搜索模型 / provider…',
                onChange: function (e) { store.set({ modeQuery: e.target.value }) },
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  margin: '10px 0',
                  padding: '9px 12px',
                  fontSize: FS.body,
                  color: COL.text,
                  background: COL.layer,
                  border: '1px solid ' + COL.border,
                  borderRadius: 9,
                  outline: 'none',
                  fontFamily: 'inherit',
                },
              }),
              modelBody,
            ),
          ),
        )
      } else {
        content = h('div', null,
          pageSection(
            '使用趋势',
            '最近 ' + WEEK_DAYS + ' 天每天优化了几次；紫色是这段里最多的一天。点一根柱子，只看那天的记录，再点一次取消。',
            h(WeekBars, {
              st: st,
              days: WEEK_DAYS,
              picked: st.dayPick,
              onPick: function (key) {
                var patch = { dayPick: key }
                // 那天只有一条就直接开对比，省掉「点柱子 → 再点记录」两步
                if (key) {
                  var hits = (st.history || []).filter(function (it) {
                    return it && it.at && dayKeyOf(it.at) === key
                  })
                  if (hits.length === 1) patch.peek = hits[0]
                }
                store.set(patch)
              },
            }),
            CHART[2],
          ),
          pageSection(
            '优化历史',
            st.dayPick ? '当前只看选中那一天的记录。' : '点一条，在设置页内打开完整的左右对比。',
            h(HistoryTab, { st: st }),
          ),
        )
      }

      return h('div', {
        style: {
          height: '100%',
          overflow: 'auto',
          boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-base, #fff)',
          color: COL.text,
          fontFamily: FONT,
        },
      },
        h(PageTopBar, { st: st }),
        h('div', {
          style: {
            maxWidth: PAGE_MAX,
            margin: '0 auto',
            padding: '26px 28px 72px',
            boxSizing: 'border-box',
            display: 'flex',
            gap: 30,
            alignItems: 'flex-start',
          },
        },
          h(LeftRail, { st: st }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            pageTabs(st),
            content,
            h(AboutFooter, null),
          ),
        ),
        h(PeekOverlay, { st: st }),
      )
    }

    /* 侧边栏图标：魔法棒 */
    function SidebarIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.9,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M15 4V2' }),
        h('path', { d: 'M15 10V8' }),
        h('path', { d: 'M12.5 6h-2' }),
        h('path', { d: 'M19.5 6h-2' }),
        h('path', { d: 'M4 20l7.5-7.5' }),
        h('path', { d: 'M13.2 8.6l2.2 2.2' }),
        h('path', { d: 'M9.5 12.3l-1.2 3.4 3.4-1.2' }),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        pageOpener = function () {
          try {
            if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
              ctx.layout.selectPanel(PANEL_ID)
              return true
            }
          } catch (err) { /* 宿主未就绪时静默 */ }
          return false
        }
        pageCloser = function () {
          try {
            if (ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(null)
          } catch (err) { /* 宿主未就绪时静默 */ }
        }

        ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register({
            name: 'conversation.input.left',
            id: 'prompt-optimizer/button',
            order: 20,
            label: '优化提示词',
          }, OptimizeButton)
        })

        ctx.slots.inject('conversation.input.overlay', function () {
          return ctx.slots.register({
            name: 'conversation.input.overlay',
            id: 'prompt-optimizer/panel',
            order: 20,
          }, OptimizePanel)
        })

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 100,
            label: '提示词优化',
          }, SidebarIcon)
        })

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, PromptOptimizerPage)
        })
      },
    }

  },
})
