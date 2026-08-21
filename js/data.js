/* ===================================================================
 * data.js — 模拟数据层（不调用任何真实 AI API）
 * 双模式：
 *   ① 看产品（拍产品）→ 识别色号/质地/是否适合肤色
 *   ② 看人（拍自己）  → 分析肤质/脸型/产品推荐
 * ================================================================== */

// ================================================================
// 双模式判断命题
// ================================================================
// 拍产品：可选预设判断命题（用户也可自行输入自定义命题）
const PRESET_QUESTIONS_PRODUCT = [
  "这张口红是否适合亚洲暖黄皮？",
  "这张口红是否适合白皙冷白皮？",
  "这张口红是否适合健康小麦色皮肤？",
  "这张口红在黄黑皮上显白吗？",
  "这支口红的颜色偏暖调还是偏冷调？",
  "这支口红的质地更适合日常还是晚宴？"
];

// 拍自己：可选预设诊断命题（用户也可自行输入自定义命题）
const PRESET_QUESTIONS_PERSON = [
  "根据我的肤质，推荐适合我的底妆产品",
  "我的脸型适合哪种妆容风格？",
  "我的皮肤状态适合什么护肤步骤？",
  "我更适合暖调还是冷调的彩妆？",
  "针对我的肤质，有什么上妆避坑建议？",
  "我的肤色属于冷调还是暖调？"
];

const PROMPT_PRODUCT = PRESET_QUESTIONS_PRODUCT[0];
const PROMPT_PERSON  = PRESET_QUESTIONS_PERSON[0];
const JUDGMENT_PROMPT = PROMPT_PRODUCT; // 兼容旧引用

// ================================================================
// ① 看产品：美妆垂直语义模拟结果库
//   色号名称 / 颜色描述 / 质地描述 / 肤色匹配原因 / 使用建议 / 口语化理由
//   judgment: "yes" 适合黄皮 | "no" 不太适合
// ================================================================
const MOCK_RESULTS = [
  {
    judgment: "yes",
    confidence: 0.94,
    shadeName: "兰蔻 #132 菁纯",
    colorDesc: "蓝调正红",
    textureDesc: "哑光质地",
    matchReason: "蓝调能中和黄皮肤的黄色调，上脸立刻提亮一个度",
    advice: "薄涂日常通勤，厚涂晚宴气场全开",
    reason: "这支是蓝调正红，对黄皮特别友好。蓝调把脸上的黄气悄悄中和掉，涂上去又显白又显气色，闭眼入都不会错。"
  },
  {
    judgment: "no",
    confidence: 0.86,
    shadeName: "雅诗兰黛 #420 蜜橘",
    colorDesc: "暖橘调",
    textureDesc: "滋润质地",
    matchReason: "橘调偏多，会和黄皮肤'撞色'，反而显黄显黑",
    advice: "想用橘调，建议叠涂一层玫瑰色中和，或只做咬唇妆",
    reason: "这支橘调偏多，黄皮涂了容易和肤色糊在一起，显黑显黄。喜欢橘调的话，挑带玫调或蓝调的版本会更聪明。"
  },
  {
    judgment: "yes",
    confidence: 0.89,
    shadeName: "阿玛尼 #405 烂番茄",
    colorDesc: "红棕番茄调",
    textureDesc: "丝绒质地",
    matchReason: "红里带棕，和黄皮是互补色，素颜涂也显白",
    advice: "薄涂提气色，厚涂复古感拉满，四季都能用",
    reason: "烂番茄是黄皮亲妈色。红里带一点棕，和黄皮肤形成漂亮的对比，不用化妆底子也能显白，素颜涂都好看。"
  },
  {
    judgment: "no",
    confidence: 0.81,
    shadeName: "YSL #12 斩男色",
    colorDesc: "粉调水红",
    textureDesc: "镜面水光",
    matchReason: "粉调偏冷，黄皮上脸容易显得暗沉没精神",
    advice: "黄皮想用粉调，先涂一层橘调打底再叠它",
    reason: "这支粉调偏冷，黄皮直接涂容易显得嘴部发灰、没精神。想要粉嫩感，先用橘调唇膏打底，再薄薄叠一层。"
  },
  {
    judgment: "yes",
    confidence: 0.91,
    shadeName: "迪奥 #999 经典正红",
    colorDesc: "蓝调复古红",
    textureDesc: "滋润质地",
    matchReason: "高饱和蓝调红，和肤色强对比，牙齿都显白",
    advice: "点涂晕开自然，全涂气场，重要场合首选",
    reason: "迪奥 999 是蓝调正红里的标杆。饱和度高、和肤色强对比，一涂上去牙齿都显得更白，重要场合闭眼选它。"
  },
  {
    judgment: "no",
    confidence: 0.78,
    shadeName: "纪梵希 #304 西柚色",
    city: "",
    colorDesc: "橘粉调",
    textureDesc: "哑光质地",
    matchReason: "橘粉调明度偏高，黄皮涂了容易'浮'在脸上",
    advice: "适合白皮；黄皮建议选低明度的豆沙或砖红",
    reason: "这支西柚色明度偏高，黄皮涂容易显得和肤色脱节、有点'浮'。黄皮更推荐低明度的豆沙色或砖红色。"
  }
];

// 兼容别名
const MOCK_RESULTS_PRODUCT = MOCK_RESULTS;

// ================================================================
// ② 看人：肤质 / 脸型 / 产品推荐 模拟结果库
//   judgment: 肤质类型；skinType/faceShape/productRec/advice/reason
// ================================================================
const MOCK_RESULTS_PERSON = [
  {
    judgment: "混油皮",
    confidence: 0.88,
    skinType: "T区偏油、两颊偏干的混合性皮肤",
    faceShape: "鹅蛋脸",
    productRec: "控油型粉底液 + 保湿妆前乳，T区局部散粉定妆",
    advice: "分区护理：T区控油、两颊保湿最稳",
    reason: "检测到T区偏油、两颊偏干，属于混合性皮肤。建议控油型粉底液搭配保湿妆前乳，适合哑光质感产品。"
  },
  {
    judgment: "干性皮肤",
    confidence: 0.92,
    skinType: "纹理细腻、毛孔不明显，但面部有轻微紧绷感",
    faceShape: "圆脸",
    productRec: "滋润型粉底液 + 高保湿妆前",
    advice: "妆前厚敷保湿，避免卡粉起皮",
    reason: "皮肤纹理细、毛孔不明显但有紧绷感，属于干性皮肤。建议滋润型粉底液，妆前做好保湿。"
  },
  {
    judgment: "敏感肌",
    confidence: 0.85,
    skinType: "泛红、有轻微刺痛感的敏感性皮肤",
    faceShape: "瓜子脸",
    productRec: "温和无刺激、无酒精无香精的化妆品",
    advice: "上脸前先做耳后测试，确认不过敏",
    reason: "皮肤泛红、有轻微刺痛，属于敏感肌。建议温和无刺激产品，避免酒精和香精。"
  },
  {
    judgment: "油性皮肤",
    confidence: 0.90,
    skinType: "T区毛孔粗大、油光明显的油性皮肤",
    faceShape: "方脸",
    productRec: "控油型粉底液 + 散粉定妆",
    advice: "避免厚重妆，分区控油",
    reason: "T区毛孔粗大、油光明显，属于油性皮肤。建议控油粉底液搭配散粉，避免厚重妆容。"
  }
];

// ================================================================
// 振动模式 — 颜色 + 质地双维度（跨感官翻译 / 触觉色卡）
// ================================================================
const VIBRATION_BY_COLOR = {
  "red":    [60, 30, 60, 30, 60],        // 红色 → 短促高频
  "pink":   [120, 80, 120, 80, 120],     // 粉色 → 轻柔长振
  "orange": [200, 100, 200],             // 橘色 → 中长振
  "brown":  [300, 150, 300],             // 棕红 → 沉稳两振
  "default":[150, 50, 150]
};

const VIBRATION_BY_TEXTURE = {
  "matte":  [100, 50, 100, 50, 100],     // 哑光 → 颗粒感
  "velvet": [200, 100, 200],             // 丝绒 → 顺滑两振
  "moist":  [400],                       // 滋润 → 单次长振
  "gloss":  [80, 40, 80, 40, 80],        // 镜面 → 清脆
  "default":[150, 50, 150]
};

// 拍自己：按肤质类型触发不同振动（跨感官翻译）
const VIBRATION_BY_SKIN = {
  "oil":      [80, 30, 80, 30, 80],        // 油皮/混油 → 短促有力
  "dry":      [200, 120, 200],             // 干皮 → 轻柔长振
  "sensitive":[120, 80, 120, 80, 120],     // 敏感肌 → 柔和
  "default":  [150, 50, 150]
};

// ================================================================
// 推荐搭配 — 按颜色关键词给出模拟搭配（选品→使用 延伸）
// ================================================================
const PAIRINGS = {
  red: [
    "同色系腮红，气场统一不抢戏",
    "细闪香槟金眼影，提亮眼周",
    "裸粉甲油，整体呼应协调"
  ],
  pink: [
    "蜜桃色腮红，少女感拉满",
    "珠光粉眼影，温柔收尾",
    "透明唇蜜叠涂，水光感加倍"
  ],
  orange: [
    "橘调腮红，元气满满",
    "金棕眼影，复古呼应",
    "奶橘甲油，夏日清新感"
  ],
  brown: [
    "豆沙腮红，高级耐看",
    "棕调眼影，氛围感十足",
    "奶茶甲油，低调又协调"
  ]
};

// 颜色关键词 → 振动 / 搭配分类
function colorCategory(colorDesc) {
  const t = (colorDesc || "").toLowerCase();
  if (t.includes("粉")) return "pink";
  if (t.includes("橘") || t.includes("橙")) return "orange";
  if (t.includes("棕") || t.includes("砖") || t.includes("番茄")) return "brown";
  if (t.includes("红") || t.includes("蓝调")) return "red";
  return "default";
}

function textureCategory(textureDesc) {
  const t = (textureDesc || "");
  if (t.includes("哑光")) return "matte";
  if (t.includes("丝绒")) return "velvet";
  if (t.includes("滋润") || t.includes("水光") || t.includes("镜面")) return "gloss";
  if (t.includes("水润")) return "moist";
  return "default";
}

function skinCategory(judgment) {
  const t = (judgment || "");
  if (t.includes("油")) return "oil";
  if (t.includes("干")) return "dry";
  if (t.includes("敏感")) return "sensitive";
  return "default";
}

// ================================================================
// 产品库（拍照识别 / 色卡用）
// ================================================================
const PRODUCTS = [
  {
    id: 1,
    name: "圣罗兰 YSL 小粉条 202",
    colorName: "珊瑚玫瑰色",
    shade: "#E8A0A0",
    rgb: [232, 160, 160],
    texture: "哑光",
    skinType: "适合所有肤色，尤其适合暖黄皮",
    desc: "这是一款温柔的珊瑚玫瑰色，哑光质地，上嘴丝滑不拔干。颜色偏粉调，日常通勤使用非常提气色。",
    whiteEffect: "这个颜色偏粉调，对黄皮肤来说有提亮效果，但不算特别显白，更适合打造温柔气质。"
  },
  {
    id: 2,
    name: "魅可 MAC Chili 小辣椒",
    colorName: "砖红色",
    shade: "#C0503C",
    rgb: [192, 80, 60],
    texture: "哑光",
    skinType: "适合所有肤色，对黄皮特别友好",
    desc: "经典小辣椒色，哑光质地，显色度高。橘调砖红色，上嘴气场全开，是黄皮亲妈色。",
    whiteEffect: "这是公认的显白神器！橘调砖红能中和黄皮肤的暗沉，涂上去皮肤立刻亮一个度。"
  },
  {
    id: 3,
    name: "阿玛尼 红管 405",
    colorName: "烂番茄色",
    shade: "#D4483A",
    rgb: [212, 72, 58],
    texture: "丝绒",
    skinType: "适合所有肤色，干皮友好",
    desc: "爆款烂番茄色，丝绒哑光质地，轻薄顺滑。红棕调番茄色，不挑季节，薄涂厚涂都好看。",
    whiteEffect: "番茄色对黄皮非常友好，红调中带一点棕，上嘴超级显白，素颜涂也好看。"
  },
  {
    id: 4,
    name: "迪奥 Dior 999 经典正红",
    colorName: "正红色",
    shade: "#C8102E",
    rgb: [200, 16, 46],
    texture: "滋润",
    skinType: "适合所有肤色",
    desc: "口红界的经典正红色，滋润质地，饱和度高。蓝调正红，气场强大，重要场合必备。",
    whiteEffect: "蓝调正红是最显白的颜色之一，和肤色形成强烈对比，涂上牙齿都显得更白。"
  },
  {
    id: 5,
    name: "纪梵希 N37 蓝调正红",
    colorName: "蓝调复古红",
    shade: "#B81C2A",
    rgb: [184, 28, 42],
    texture: "丝绒",
    skinType: "适合所有肤色，尤其适合冷白皮",
    desc: "蓝调复古红色，丝绒质地，高级感十足。这个颜色非常上镜，涂上有种复古美人的感觉。",
    whiteEffect: "蓝调红是显白届的天花板，冷白皮涂了白到发光，黄皮用了也能中和暗沉。"
  }
];

// ================================================================
// 内置示例图片（base64 口红产品图，约 200x200px）
// ================================================================
const EXAMPLE_IMAGE = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWQiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiNDODEwMkU7c3RvcC1vcGFjaXR5OjEiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiNGRkQ3MDA7c3RvcC1vcGFjaXR5OjEiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0idXJsKCNncmFkKSIvPjx0ZXh0IHg9IjEwMCIgeT0iOTAiIGZvbnQtZmFtaWx5PSJzZXJpZiIgZm9udC1zaXplPSIyOCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkRpcjwvdGV4dD48dGV4dCB4PSIxMDAiIHk9IjEzMCIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPjk5OSDnuq/lrZA8L3RleHQ+PC9zdmc+";
