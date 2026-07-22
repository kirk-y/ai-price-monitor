const axios = require('axios');
const fs = require('fs');

const API_KEY = 'sk-63717f37ae9b4cd19185fe269289815b';
const API_URL = 'https://api.deepseek.com/chat/completions';

const CATEGORIES = [
  ['gpt', 'plus_已接码, plus_未接码, plus_质保, pro, team, k12, go, max, image2, cyber'],
  ['claude', 'pro, max'],
  ['gemini', 'pro年卡, 优惠链接, 成品号'],
  ['grok', 'super_grok, 普号'],
  ['ai_platform', 'cursor, perplexity, kiro, koro, 其他AI平台'],
  ['sms', '接码'],
  ['邮箱', 'gmail, outlook, icloud, hotmail, 教育邮箱, 企业邮箱, 其他邮箱'],
  ['号码', '美国, 印度, 英国, 巴西, 印尼, 随机国家, 其他号码'],
  ['社交账号', 'twitter, telegram, discord, tiktok, instagram, facebook, 其他社交'],
  ['视频会员', '腾讯视频, bilibili, 芒果TV, 华为视频, 咪咕视频, 埋堆堆, 其他视频'],
  ['音乐会员', '酷狗音乐, 网易云, QQ音乐, 其他音乐'],
  ['生活券', '美团, 瑞幸, 古茗, 星巴克, 其他券'],
  ['IP代理', '住宅IP, 机房IP, vpn, 其他网络'],
  ['卡密兑换', '有效期卡密, 兑换码, 充值码'],
  ['虚拟卡', 'visa虚拟卡, 其他虚拟卡'],
  ['开发工具', 'cursor, codex, api'],
  ['电商工具', '闲鱼助手, 其他电商'],
  ['企业服务', '公司注册, 营业执照, 其他企业'],
  ['其他', '其他'],
];

const PROMPT = `你是一个商品分类助手。请将以下商品名分类到合适的二级分类。
分类体系为两级：一级大类_二级子类，例如：gpt_plus_已接码, gpt_pro, 邮箱_gmail, 号码_美国, 视频会员_腾讯视频。

一级大类可选：${CATEGORIES.map(c => c[0]).join(', ')}
二级子类可选（对应各自一级）：${
  CATEGORIES.map(([l1, l2]) => `${l1}: ${l2}`).join('; ')
}

规则：
- 如果商品名称包含模型名（GPT、Claude、Gemini、Grok），优先分到gpt/claude/gemini/grok大类
- GPT相关的Plus、Pro、Team、K12子类保持原样
- 各类邮箱分到邮箱大类
- 接码/号码类分到号码或sms大类
- 视频/音乐会员卡分到对应大类
- Cursor、Perplexity等AI工具分到ai_platform
- 无法确定时用"其他_其他"

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
    return [];
  }
}

async function main() {
  const store = require('./store');
  const all = store.getLabeledData();
  const other = all.filter(l => l.category === '其他');

  console.log(`Total unclassified: ${other.length}`);

  const results = [];
  const batchSize = 30;

  for (let i = 0; i < other.length; i += batchSize) {
    const batch = other.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i/batchSize)+1}/${Math.ceil(other.length/batchSize)} (${i}-${i+batch.length})...`);
    const res = await classifyBatch(batch);
    results.push(...res);
    await new Promise(r => setTimeout(r, 1000));
  }

  const lines = ['product_key,name,category'];
  const lookup = {};
  other.forEach(p => lookup[p.name] = p.product_key);
  for (const r of results) {
    const pk = lookup[r.name] || '';
    lines.push(`${pk},${r.name.replace(/,/g,';')},${r.category}`);
  }

  fs.writeFileSync('classified_results.csv', '\uFEFF' + lines.join('\n'), 'utf8');
  console.log(`Done. Classified ${results.length}/${other.length} products. Results saved to classified_results.csv`);
}

main().catch(console.error);
