/**
 * 前端配置中心 v2
 * 注意：AI 密钥已迁移到服务端，前端不再持有任何第三方 API Key
 */
const CONFIG = {
  API: {
    BASE_URL: '',
    ENDPOINTS: {
      MESSAGES: '/api/messages',
      FILES_UPLOAD: '/api/files/upload',
      FILES_DOWNLOAD: '/api/files/download',
      SYNC: '/api/sync',
      CLEAR_ALL: '/api/clear-all',
      CLEAR_ALL_LEGACY: '/api/sync/clear-all',
      AI_CONFIG: '/api/ai/config',
      AI_CHAT: '/api/ai/chat',
      AI_MESSAGE: '/api/ai/message',
      AI_IMAGE: '/api/ai/image',
      AI_IMAGE_SAVE: '/api/ai/image/save',
      AUTH_LOGIN: '/api/auth/login',
      AUTH_VERIFY: '/api/auth/verify',
      AUTH_LOGOUT: '/api/auth/logout',
      SEARCH: '/api/search',
      SEARCH_SUGGESTIONS: '/api/search/suggestions',
      EVENTS: '/api/events',
      POLL: '/api/poll',
      HEALTH: '/api/health',
      CONFIG: '/api/config'
    }
  },

  FILE: {
    MAX_SIZE: 50 * 1024 * 1024, // 50MB 兜底值，启动后会以服务端 /api/config 下发值为准
    ALLOWED_TYPES: '*',
    CHUNK_SIZE: 1024 * 1024
  },

  UI: {
    // 单次加载条数兜底值；实际以服务端 MESSAGE_LOAD_DEFAULT 为准（默认 5000）
    MESSAGE_LOAD_LIMIT: 5000,
    LOAD_MORE_BATCH_SIZE: 50,
    INFINITE_SCROLL_THRESHOLD: 80,
    SCROLL_DEBOUNCE_DELAY: 100,
    ANIMATION_DURATION: 200,
    // 自动刷新仅在「SSE / 长轮询都不可用」时作为兜底，5s 一次即可
    AUTO_REFRESH_INTERVAL: 5000,
    TOAST_DURATION: 2400,
    // 长轮询降级模式下的重试间隔
    POLL_RETRY_INTERVAL: 5000
  },

  /**
   * 服务端运行时下发项（可写，由 js/serverConfig.js 在启动时填充）
   * 为什么单独放一层：CONFIG 其余部分被 Object.freeze 锁死，
   * 而这些值必须能在拿到 /api/config 之后被覆盖。
   */
  RUNTIME: {
    loaded: false,
    messageLoadDefault: null,
    messageLoadMax: null,
    maxFileSize: null,
    maxFileSizeText: null,
    clearConfirmRequired: null,
    aiEnabled: null,
    imageGenEnabled: null,
    timezone: null
  },

  /** 读取运行时下发值，未下发时回落到静态默认值 */
  runtime(key, fallback) {
    const v = CONFIG.RUNTIME[key];
    return v === undefined || v === null ? fallback : v;
  },

  DEVICE: {
    ID_PREFIX: 'web-',
    NAME_MOBILE: '移动设备',
    NAME_DESKTOP: 'Web浏览器',
    STORAGE_KEY: 'deviceId'
  },

  MESSAGE_TYPES: {
    TEXT: 'text',
    FILE: 'file',
    SYSTEM: 'system',
    AI: 'ai'
  },

  AI: {
    ENABLED: true,
    THINKING_INDICATOR: '🤔 AI正在思考...',
    RESPONSE_INDICATOR: '🤖 AI助手',
    MODE_INDICATOR: '🤖 AI模式'
  },

  IMAGE_GEN: {
    ENABLED: true,
    DEFAULT_SIZE: '1024x1024',
    DEFAULT_STEPS: 20,
    DEFAULT_GUIDANCE: 7.5,
    MAX_PROMPT_LENGTH: 1000,
    GENERATING_INDICATOR: '🎨 AI正在生成图片...',
    SUCCESS_INDICATOR: '✅ 图片生成完成'
  },

  FILE_ICONS: {
    'image/': '🖼️',
    'image/gif': '🎞️',
    'image/svg+xml': '🎨',
    'video/': '🎥',
    'audio/': '🎵',
    'application/pdf': '📕',
    'application/msword': '📘',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📘',
    'application/vnd.ms-excel': '📗',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📗',
    'application/vnd.ms-powerpoint': '📙',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '📙',
    'application/zip': '📦',
    'application/x-rar-compressed': '📦',
    'application/x-7z-compressed': '📦',
    'text/': '📄',
    'text/markdown': '📝',
    'application/javascript': '⚡',
    'application/json': '📋',
    default: '📄'
  },

  FILE_EXTENSION_ICONS: {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🎞️', webp: '🖼️', svg: '🎨', heic: '🖼️',
    mp4: '🎥', mov: '🎥', avi: '🎥', mkv: '🎥', webm: '🎥',
    mp3: '🎵', wav: '🎵', aac: '🎵', flac: '🎵', m4a: '🎵',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    txt: '📄', md: '📝', html: '🌐', css: '🎨', js: '⚡', ts: '⚡', json: '📋', xml: '📋',
    py: '🐍', java: '☕', go: '🐹', rs: '🦀', apk: '📱', exe: '⚙️'
  },

  CLEAR: {
    TRIGGER_COMMANDS: ['/clear-all', '/clear', '/clean', '清空数据', '/清空', 'clear all'],
    CONFIRM_MESSAGE: '此操作将永久删除所有聊天记录和文件，无法恢复！',
    // 滑动确认的提示文案
    SLIDE_HINT: '按住滑块，向右滑动以确认清空',
    SLIDE_LABEL: '滑动确认清空',
    // 是否需要额外输入确认码：由服务端 CLEAR_CONFIRM_CODE 是否配置决定，
    // 通过 /api/config 的 clearConfirmRequired 下发（默认 false）
    CONFIRM_REQUIRED: false
  },

  PWA: {
    TRIGGER_COMMANDS: ['/pwa', '/install', '/安装', 'pwa', 'install', '安装'],
    INSTALL_BENEFITS: [
      '像原生应用一样使用',
      '快速启动，无需浏览器',
      '离线访问缓存内容',
      '自动更新到最新版本'
    ]
  },

  ERRORS: {
    NETWORK: '网络连接失败，请检查网络',
    FILE_TOO_LARGE: '文件大小超过限制',
    FILE_UPLOAD_FAILED: '文件上传失败',
    MESSAGE_SEND_FAILED: '消息发送失败',
    LOAD_MESSAGES_FAILED: '加载消息失败',
    DEVICE_SYNC_FAILED: '设备同步失败',
    CLEAR_FAILED: '数据清理失败',
    CLEAR_CANCELLED: '数据清理已取消',
    AI_REQUEST_FAILED: 'AI请求失败，请稍后重试',
    AI_STREAM_ERROR: 'AI流式响应中断',
    IMAGE_GEN_FAILED: 'AI图片生成失败',
    IMAGE_GEN_PROMPT_EMPTY: '请输入图片描述',
    IMAGE_GEN_PROMPT_TOO_LONG: '图片描述过长，请简化',
    SEARCH_FAILED: '搜索失败，请稍后重试',
    SEARCH_NO_RESULTS: '没有找到匹配的结果',
    UNAUTHORIZED: '登录已过期，请重新登录'
  },

  SUCCESS: {
    FILE_UPLOADED: '文件上传成功',
    MESSAGE_SENT: '消息发送成功',
    DEVICE_SYNCED: '设备同步成功',
    DATA_CLEARED: '数据清理成功',
    AI_MODE_ENABLED: 'AI模式已启用',
    AI_MODE_DISABLED: 'AI模式已关闭',
    IMAGE_GEN_SUCCESS: '图片生成成功',
    SEARCH_COMPLETED: '搜索完成'
  },

  SEARCH: {
    ENABLED: true,
    MAX_RESULTS: 100,
    RESULTS_PER_PAGE: 20,
    DEBOUNCE_DELAY: 300,
    MIN_QUERY_LENGTH: 1,
    HIGHLIGHT_CLASS: 'search-highlight',
    HISTORY_LIMIT: 20,
    HISTORY_KEY: 'wxchat_search_history'
  },

  EMOJIS: ['😀','😂','🥰','😍','🤔','👍','👏','🎉','🔥','✨','❤️','😊','🫡','🤝','💯','🚀','👀','😎','🤗','😅']
};

Object.freeze(CONFIG);
Object.freeze(CONFIG.API);
Object.freeze(CONFIG.API.ENDPOINTS);
Object.freeze(CONFIG.FILE);
Object.freeze(CONFIG.UI);
Object.freeze(CONFIG.DEVICE);
Object.freeze(CONFIG.MESSAGE_TYPES);
Object.freeze(CONFIG.AI);
Object.freeze(CONFIG.IMAGE_GEN);
Object.freeze(CONFIG.CLEAR);
Object.freeze(CONFIG.PWA);
Object.freeze(CONFIG.ERRORS);
Object.freeze(CONFIG.SUCCESS);
Object.freeze(CONFIG.SEARCH);
// 注意：CONFIG.RUNTIME 刻意不加 freeze —— 它需要在 /api/config 返回后被写入。
// Object.freeze 是浅冻结，CONFIG 本身被冻结不影响其子对象 RUNTIME 的字段赋值。

if (typeof window !== 'undefined') window.CONFIG = CONFIG;
