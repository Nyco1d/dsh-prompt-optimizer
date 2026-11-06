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
        var payload = { text: text, mode: store.state.mode }
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
        var data = await res.json()
        if (!data || !data.ok) {
          store.set({ loading: false, error: (data && data.error) || '优化失败' })
          return
        }
        store.set({ loading: false, optimized: data.text, instruction: '' })
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

      function openSettings(r) {
        store.set({ menuOpen: true, anchor: r })
        loadModes()
        loadModels()
      }

      function onClick(e) {
        if (e && e.preventDefault) e.preventDefault()
        if (e && e.stopPropagation) e.stopPropagation()
        // Shift + 点击：绕过右键这个隐性交互，直接开设置
        if (e && e.shiftKey) { openSettings(rectOf(e)); return }
        if (disabled) return
        if (st.panelOpen) { store.set({ panelOpen: false }); return }
        store.inputActions = actions
        store.set({ panelRect: rectOf(e) })
        runOptimize(draft)
      }

      function onContextMenu(e) {
        if (e && e.preventDefault) e.preventDefault()
        if (e && e.stopPropagation) e.stopPropagation()
        openSettings(rectOf(e))
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
      } else if (st.loading) {
        body = h('div', { style: { padding: '26px 0', textAlign: 'center', color: COL.sub, fontSize: 13 } }, '正在优化…')
      } else if (st.error) {
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
      { id: 'context-message-optimize', name: '通用消息优化', description: '适度改写，保持原角色与语气；简单的话不会被扩成长文' },
      { id: 'general-optimize', name: '结构化重写', description: '重写成 Role / Profile / Skills / Rules / Workflows 的完整结构' },
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

    function SettingsPanel() {
      var st = useStore()
      if (!st.menuOpen) return null

      var vw = window.innerWidth || 1200
      var vh = window.innerHeight || 800
      var width = 400
      var rect = st.anchor
      var left = rect ? Math.max(8, Math.min(rect.left - 8, vw - width - 12)) : Math.max(8, (vw - width) / 2)
      var estH = Math.min(560, vh - 24)
      var top = 96
      if (rect) {
        var below = rect.bottom + 8
        top = (below + estH > vh - 12) ? Math.max(8, rect.top - estH - 8) : below
      }
      top = Math.max(8, Math.min(top, Math.max(8, vh - 140)))

      function close() { store.set({ menuOpen: false }) }

      function pickMode(id) {
        store.set({ mode: id })
        saveSettings({ mode: id })
      }

      function pickModel(provider, model) {
        var recent = pushRecent(provider, model)
        store.set({ selection: { provider: provider, model: model }, recent: recent })
        saveSettings({ provider: provider, model: model })
      }

      var modes = modeList(st)
      var modeCards = modes.map(function (m) {
        return h(ModeCard, {
          key: m.id,
          name: m.name || m.id,
          description: m.description || '',
          active: st.mode === m.id,
          onClick: function () { pickMode(m.id) },
        })
      })
      var customSection = h(CustomModeSection, { st: st })

      var models = st.models || []
      var q = String(st.modeQuery || '').trim().toLowerCase()
      var cur = st.selection

      var followRow = h(ModelRow, {
        key: '__follow',
        label: '跟随 DSH 默认模型',
        hint: '推荐',
        active: !cur.provider,
        onClick: function () { pickModel('', '') },
      })

      var body = null
      if (st.modelsLoading) {
        body = h('div', { style: { padding: '10px 8px', fontSize: 12, color: COL.sub } }, '读取模型列表…')
      } else if (st.modelsError) {
        body = h('div', { style: { padding: '10px 8px', fontSize: 12, color: COL.error } }, st.modelsError)
      } else if (models.length === 0) {
        body = h('div', { style: { padding: '10px 8px', fontSize: 12, color: COL.sub } }, '没有可用模型')
      } else if (q) {
        var hits = models.filter(function (m) {
          return String(m.name || '').toLowerCase().indexOf(q) >= 0
            || String(m.model || '').toLowerCase().indexOf(q) >= 0
            || String(m.provider || '').toLowerCase().indexOf(q) >= 0
            || String(m.providerName || '').toLowerCase().indexOf(q) >= 0
        })
        body = hits.length
          ? hits.slice(0, 60).map(function (m) {
              return h(ModelRow, {
                key: m.provider + '/' + m.model,
                label: m.name || m.model,
                hint: m.providerName || m.provider,
                active: cur.provider === m.provider && cur.model === m.model,
                onClick: function () { pickModel(m.provider, m.model) },
              })
            })
          : h('div', { style: { padding: '10px 8px', fontSize: 12, color: COL.sub } }, '没有匹配的模型')
      } else {
        var groups = {}
        var order = []
        models.forEach(function (m) {
          if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider) }
          groups[m.provider].push(m)
        })

        var blocks = []
        if (st.recent && st.recent.length) {
          blocks.push(h('div', { key: '__recentTitle', style: { padding: '8px 8px 2px', fontSize: 11, color: COL.sub } }, '最近使用'))
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
          blocks.push(h('div', { key: '__recentDiv', style: { height: 1, background: COL.border, margin: '6px 8px' } }))
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
        body = blocks
      }

      var currentLine = cur.provider
        ? ('当前指定：' + cur.provider + ' / ' + cur.model)
        : '当前使用会话默认模型'

      return h('div', null,
        h('div', {
          onClick: close,
          style: { position: 'fixed', inset: 0, zIndex: 2147482998, background: 'transparent' },
        }),
        h('div', {
          onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation() },
          style: {
            position: 'fixed',
            left: left,
            top: top,
            width: width,
            maxHeight: Math.max(160, vh - top - 16),
            display: 'flex',
            flexDirection: 'column',
            zIndex: 2147482999,
            background: COL.bg,
            border: '1px solid ' + COL.border,
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(0,0,0,.22)',
            boxSizing: 'border-box',
            overflow: 'hidden',
          },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: '1px solid ' + COL.border, flex: 'none' },
          },
            h('div', { style: { fontSize: 13, fontWeight: 600, color: COL.text } }, '提示词优化设置'),
            h('div', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              title: '关闭',
              onClick: close,
              style: { border: 'none', background: 'transparent', cursor: 'pointer', color: COL.sub, fontSize: 16, lineHeight: 1, padding: '0 2px' },
            }, '×'),
          ),
          h('div', { style: { overflow: 'auto', padding: '10px 14px 14px' } },
            h('div', { style: { fontSize: 11, color: COL.sub, marginBottom: 6, letterSpacing: '.04em' } }, '优化模式'),
            modeCards,
            customSection,
            h('div', { style: { height: 1, background: COL.border, margin: '10px 0' } }),
            h('div', { style: { fontSize: 11, color: COL.sub, marginBottom: 6, letterSpacing: '.04em' } }, '模型'),
            h('div', { style: { fontSize: 11.5, color: COL.sub, marginBottom: 6 } }, currentLine),
            followRow,
            h('input', {
              type: 'text',
              value: st.modeQuery,
              placeholder: '搜索模型 / provider…',
              onChange: function (e) { store.set({ modeQuery: e.target.value }) },
              style: {
                width: '100%',
                boxSizing: 'border-box',
                margin: '6px 0',
                padding: '6px 9px',
                fontSize: 12.5,
                color: COL.text,
                background: COL.layer,
                border: '1px solid ' + COL.border,
                borderRadius: 7,
                outline: 'none',
                fontFamily: 'inherit',
              },
            }),
            body,
          ),
          h('div', {
            style: { flex: 'none', padding: '8px 14px', borderTop: '1px solid ' + COL.border, fontSize: 11, color: COL.sub },
          }, '右键魔法棒，或 Shift + 点击，可随时打开这个面板'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
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

        ctx.slots.inject('conversation.input.overlay', function () {
          return ctx.slots.register({
            name: 'conversation.input.overlay',
            id: 'prompt-optimizer/menu',
            order: 21,
          }, SettingsPanel)
        })
      },
    }
  },
})
