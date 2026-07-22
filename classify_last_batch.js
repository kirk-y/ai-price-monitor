const store = require('./store');
const all = store.getLabeledData();
const other = all.filter(l => l.category === '其他');

const manualMap = {
  '【Adobe】 Firefly 普号   固定10积分': 'Adobe_Firefly',
  '百度网盘 超级会员 年卡': '网盘_百度网盘',
  '百度网盘 超级会员 季卡': '网盘_百度网盘',
  '百度网盘 超级会员 月卡': '网盘_百度网盘',
  '百度网盘 超级会员 周卡': '网盘_百度网盘',
  '夸克网盘 超级会员 年卡': '网盘_夸克网盘',
  '夸克网盘 超级会员 季卡': '网盘_夸克网盘',
  '夸克网盘 超级会员 月卡': '网盘_夸克网盘',
  '夸克网盘 超级会员 周卡': '网盘_夸克网盘',
  '咪咕阅读畅享会员 年卡': '阅读会员_咪咕阅读',
  '咪咕阅读畅享会员 季卡': '阅读会员_咪咕阅读',
  '咪咕阅读畅享会员 月卡': '阅读会员_咪咕阅读',
  '百度文库会员 年卡': '阅读会员_百度文库',
  '百度文库会员 季卡': '阅读会员_百度文库',
  '百度文库会员 月卡': '阅读会员_百度文库',
  'QQ黄钻年卡': 'QQ会员_黄钻',
  'QQ黄钻季卡': 'QQ会员_黄钻',
  'QQ黄钻月卡': 'QQ会员_黄钻',
  '反重力antigravity  24小时自助代过 CDK激活（扫码接码激活代过）': '反重力_Antigravity',
  '【香港ID】【无密保/API/可下APP】': '号码_香港',
  '正规渠道一个月支持个人账号': '其他_其他',
  '【不限时长余额】【50元】': '中转额度_额度充值',
  '【不限时长余额】【100元】': '中转额度_额度充值',
  '服务项目25:电脑端SVIP账号一年': '其他_其他',
  '漫想+ 画布 50元兑换码': '卡密兑换_兑换码',
  '月卡': '其他_其他',
  '服务项目2：谷歌账号配置': '教程服务_其他',
  '苹果下载号可用于APPStore': '号码_其他号码',
  '稳定  一卡一绑 质保首登': '其他_其他',
  '多合一系统天卡（每小时限制30次）': '中转额度_其他',
  'Gpt认证Kyc': 'gpt_其他',
  '➕客服V: ONE-AI-CLUB，拿货免手续费': '其他_其他',
  '印度UPI | 巴西PIX 提链10次卡 | 无质保': '卡密兑换_兑换码',
};

let updated = 0;
for (const p of other) {
  const cat = manualMap[p.name];
  if (cat) {
    store.upsertProductLabel(p.product_key, p.name, cat, 1.0, 1);
    updated++;
  }
}
console.log('Manually classified:', updated);

const now = store.getLabeledData();
const left = now.filter(l => l.category === '其他');
console.log('Still 其他:', left.length);
left.forEach(l => console.log('  ' + l.name));
