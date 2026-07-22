const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'stores.db'));
const total = db.prepare('select count(1) as c from product_labels').get();
const visible = db.prepare('select count(1) as c from product_labels where manual=1 or confidence>0.3').get();
const otherVis = db.prepare("select count(1) as c from product_labels where category='其他' and (manual=1 or confidence>0.3)").get();
const otherAll = db.prepare("select count(1) as c from product_labels where category='其他'").get();
console.log('total:', total.c, 'visible:', visible.c, '其他_visible:', otherVis.c, '其他_all:', otherAll.c);
