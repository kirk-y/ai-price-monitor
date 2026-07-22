const axios = require('axios');
const store = require('./store');

const API_KEY = 'sk-63717f37ae9b4cd19185fe269289815b';
const PROMPT = `你是一个商品分类助手。请将以下商品名分类到最合适的二级分类。
格式：一级大类_二级子类，例如 gpt_free, 网盘_百度网盘, QQ会员_黄钻, 中转额度_中转券。

可选的分类：
- gpt_free, gpt_plus_未接码, gpt_pro
- claude_pro, claude_max
- 网盘_百度网盘, 网盘_夸克网盘, 网盘_其他网盘
- 阅读会员_百度文库, 阅读会员_咪咕阅读, 阅读会员_其他阅读
- QQ会员_黄钻, QQ会员_其他
- 云服务_云手机, 云服务_星辰之恋, 云服务_其他
- 中转额度_中转券, 中转额度_额度充值, 中转额度_其他
- 教程服务_教程, 教程服务_其他
- 社交账号_YouTube
- Adobe_Firefly
- 反重力_Antigravity
- 修图剪辑_剪映, 修图剪辑_醒图
- AI平台_云梦AI, AI平台_咕噜咕噜AI
- 其他_其他

规则：
- 包含百度网盘/夸克网盘的 -> 网盘
- QQ黄钻 -> QQ会员
- 包含中转/额度/刀 -> 中转额度
- 包含教程 -> 教程服务
- 反重力/Antigravity -> 反重力
- 剪映/醒图 -> 修图剪辑
- 咪咕阅读/百度文库 -> 阅读会员
- 星星云/iOS MAX -> 云服务
- 无法确定用 其他_其他

请严格按以下JSON格式返回，不要有额外文字：
{"results": [{"name": "商品名", "category": "一级_二级"}]}`;

async function main() {
  const all = store.getLabeledData();
  let other = all.filter(l => l.category === '其他');
  console.log('Remaining to classify:', other.length);

  if (!other.length) { console.log('Nothing to do.'); return; }

  const items = other.map(p => ({ name: p.name }));
  const res = await axios.post('https://api.deepseek.com/chat/completions', {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify(items, null, 2) }
    ],
    temperature: 0.1,
    max_tokens: 4096,
  }, {
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 120000,
  });

  const content = res.data.choices[0].message.content;
  const parsed = JSON.parse(content.replace(/```json\n?/g, '').replace(/```\n?/g, ''));
  const results = parsed.results || [];

  let updated = 0;
  for (const r of results) {
    if (!r.name || !r.category || r.category === '其他_其他') continue;
    const p = other.find(x => x.name === r.name);
    if (!p) continue;
    store.upsertProductLabel(p.product_key, p.name, r.category, 0.8, 0);
    updated++;
  }
  console.log('Updated:', updated);

  const now = store.getLabeledData();
  const left = now.filter(l => l.category === '其他');
  console.log('Still 其他:', left.length);
  left.forEach(l => console.log('  ' + l.name));
}

main().catch(e => console.error(e));
