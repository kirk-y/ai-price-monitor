const axios = require('axios');
const store = require('./store');

const API_KEY = 'sk-63717f37ae9b4cd19185fe269289815b';
const API_URL = 'https://api.deepseek.com/chat/completions';

const CATEGORIES = [
  ['gpt', 'plus_已接码, plus_未接码, plus_质保, pro, team, k12, go, max, free, image2, cyber'],
  ['claude', 'pro, max'],
  ['gemini', 'pro年卡, 优惠链接, 成品号'],
  ['grok', 'super_grok, 普号'],
  ['ai_platform', 'cursor, perplexity, kiro, koro, 其他AI平台'],
  ['sms', '接码'],
  ['邮箱', 'gmail, outlook, icloud, hotmail, 教育邮箱, 企业邮箱, 其他邮箱'],
  ['号码', '美国, 印度, 英国, 巴西, 印尼, 随机国家, 其他号码'],
  ['社交账号', 'twitter, telegram, discord, tiktok, instagram, facebook, 其他社交'],
  ['视频会员', '腾讯视频, bilibili, 芒果TV, 华为视频, 咪咕视频, 埋堆堆, 剪映, 醒图, 其他视频'],
  ['音乐会员', '酷狗音乐, 网易云, QQ音乐, 其他音乐'],
  ['生活券', '美团, 瑞幸, 古茗, 星巴克, 霸王茶姬, 其他券'],
  ['IP代理', '住宅IP, 机房IP, vpn, 其他网络'],
  ['卡密兑换', '有效期卡密, 兑换码, 充值码'],
  ['虚拟卡', 'visa虚拟卡, 其他虚拟卡'],
  ['开发工具', 'cursor, codex, api'],
  ['电商工具', '闲鱼助手, 其他电商'],
  ['企业服务', '公司注册, 营业执照, 其他企业'],
  ['其他', '其他'],
];

const PROMPT = `你是一个商品分类助手。请将以下商品名分类到最合适的二级分类。
分类体系为两级：一级大类_二级子类，例如 gpt_plus_已接码, gpt_pro, 邮箱_gmail, 号码_美国, 视频会员_腾讯视频。

一级大类可选：${CATEGORIES.map(c => c[0]).join(', ')}
二级子类可选（对应各自一级）：${
  CATEGORIES.map(([l1, l2]) => `${l1}: ${l2}`).join('; ')
}

规则：
- GPT相关（Plus、Pro、Team、K12、Free、GO等）分到gpt大类
- Claude产品分到claude大类
- Gemini产品分到gemini大类
- 各类邮箱（Gmail、Outlook、iCloud等）分到邮箱大类
- 接码/号码类分到号码或sms大类
- 视频/音乐会员卡分到对应大类（注意剪映、醒图归入视频会员）
- Cursor分到ai_platform
- 无法确定时用"其他_其他"
- 如果商品名包含多个特征，选择最主要的分类
- 注意区分gpt_free（免费GPT产品）和gpt_plus_未接码（未接码的Plus）

请严格按照以下JSON格式返回，不要有额外文字：
{"results": [{"name": "商品名", "category": "一级_二级"}]}`;

async function classifyBatch(products) {
  const items = products.map(p => ({ name: p.name }));
  try {
    const res = await axios.post(API_URL, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: JSON.stringify(items, null, 2) }
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    const content = res.data.choices[0].message.content;
    const parsed = JSON.parse(content.replace(/```json\n?/g, '').replace(/```\n?/g, ''));
    return parsed.results || [];
  } catch (e) {
    console.error('API error:', e.message);
    if (e.response) console.error('Status:', e.response.status, 'Data:', JSON.stringify(e.response.data).slice(0, 200));
    return [];
  }
}

async function main() {
  const all = store.getLabeledData();
  let other = all.filter(l => l.category === '其他');

  console.log(`Remaining unclassified: ${other.length}`);

  const normMap = {
    'gpt_plus_已接码': 'plus_已接码',
    'gpt_plus_未接码': 'plus_未接码',
    'gpt_plus_质保': 'plus_质保',
    'gpt_k12': 'gptk12',
  };

  let totalUpdated = 0;
  const batchSize = 30;

  for (let i = 0; i < other.length; i += batchSize) {
    const batch = other.slice(i, i + batchSize);
    console.log(`Batch ${Math.floor(i/batchSize)+1}/${Math.ceil(other.length/batchSize)} (${i}-${i+batch.length})...`);
    
    const res = await classifyBatch(batch);
    
    for (const r of res) {
      if (!r.name || !r.category || r.category === '其他_其他') continue;
      const product = batch.find(p => p.name === r.name);
      if (!product) continue;
      const finalCat = normMap[r.category] || r.category;
      store.upsertProductLabel(product.product_key, product.name, finalCat, 0.8, 0);
      totalUpdated++;
    }
    
    console.log(`  -> ${res.filter(r => r.category && r.category !== '其他_其他').length} classified in this batch`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Check results
  const now = store.getLabeledData();
  const stillOther = now.filter(l => l.category === '其他');
  console.log(`\nDone! Updated ${totalUpdated} products. Remaining 其他: ${stillOther.length}`);
}

main().catch(console.error);
