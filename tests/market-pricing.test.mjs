import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../page/app.js',import.meta.url),'utf8');
const helperNames=new Set(['priceOf','taskPrices','money','modelDetailURL','modelCard','priceCondition','timedPriceExpression']);
const functions=[...source.matchAll(/  function (\w+)\([^\n]*\) \{[\s\S]*?\n  \}/g)].filter(m=>helperNames.has(m[1])).map(m=>m[0]).join('\n');
const model={name:'claude-fable-5',quota_type:0,model_ratio:5,completion_ratio:5,cache_ratio:0.1,billing_mode:'tiered_expr',billing_expr:'tier("standard", p * 10 + cr * 1 + cc * 12.5 + cc1h * 20 + c * 50)',enable_groups:['[🥚] Claude','[低价][满血] Claude 原生','[满血] CC 不降智精选']};
const groups={'[🥚] Claude':0.5,'[低价][满血] Claude 原生':1.5,'[满血] CC 不降智精选':1.8};
function context(group='',mode='standard',currency={}) {
  let toggles=0;
  const value={marketGroup:group,marketMode:mode,marketUnit:'M',pricing:()=>({groups,currency}),URL,Intl,disabledModels:new Set(),el:(tag,attrs,...children)=>({tag,attrs:attrs||{},children:children.flat(Infinity).filter(Boolean)}),groupBadge:name=>({tag:'badge',name,children:[]}),groupKind:()=>'chat',marketKindOf:()=>'chat',vendorOf:()=>'Anthropic',affURL:x=>x,toggleModel:()=>toggles++,copy:()=>{}};
  const c=vm.createContext(value);vm.runInContext(functions,c);return {c,toggles:()=>toggles};
}
function price(m,group='',mode='standard',currency={}){return context(group,mode,currency).c.priceOf(m)}
function nodes(node,predicate){return [...(predicate(node)?[node]:[]),...(node.children||[]).flatMap(x=>x&&typeof x==='object'?nodes(x,predicate):[])]}
test('所有分组维持最低倍率价格',()=>{const p=price(model);assert.equal(p.input,5);assert.equal(p.output,25);assert.equal(p.cache,0.5)});
test('选定 Claude 原生只按 1.5 倍率计价',()=>{const p=price(model,'[低价][满血] Claude 原生');assert.equal(p.input,15);assert.equal(p.output,75);assert.equal(p.cache,1.5)});
test('切到 CC 分组按 1.8 倍率计价',()=>{const p=price(model,'[满血] CC 不降智精选');assert.equal(p.input,18);assert.equal(p.output,90);assert.equal(p.cache,1.8)});
test('按次价格同样应用当前分组倍率',()=>{const p=price({name:'request-test',quota_type:1,model_price:0.096,enable_groups:['[🥚] Claude']},'[🥚] Claude');assert.equal(p.perCall,0.048)});

test('充值价使用 price / usd_exchange_rate',()=>{const p=price(model,'[低价][满血] Claude 原生','topup',{price:2,usd_exchange_rate:4});assert.equal(p.input,7.5);assert.equal(p.output,37.5)});
test('标准价随后按 CNY 展示汇率换算',()=>{const {c}=context('','standard',{quota_display_type:'CNY',usd_exchange_rate:4});assert.equal(c.money(15,'M'),'¥60');assert.equal(c.money(15,'K'),'¥0.06')});
test('USD 与 CUSTOM 符号不硬编码为人民币',()=>{assert.equal(context('','standard',{quota_display_type:'USD'}).c.money(2,'M'),'$2');assert.equal(context('','standard',{quota_display_type:'CUSTOM',custom_currency_symbol:'¤',custom_currency_exchange_rate:3}).c.money(2,'M'),'¤ 6')});
test('未提供缓存价格不显示免费缓存',()=>{const p=price({quota_type:0,model_ratio:1,completion_ratio:2,enable_groups:[]});assert.equal(p.cache,undefined)});
test('缺失价格与真实零价格区分',()=>{const {c}=context();assert.equal(c.money(undefined,'M'),'—');assert.equal(c.money(0,'M'),'¥0');assert.equal(price({quota_type:1,model_price:0,enable_groups:[]}).perCall,0)});
test('任务用量没有配置单价时不捏造零价格',()=>{assert.equal(price({quota_type:0,model_ratio:0,completion_ratio:0,billing_usage_schema:{clips:{type:'number',unit:'count'}}}).unconfigured,true)});
test('按秒任务计费保留单位并乘分组倍率',()=>{const p=price({billing_mode:'tiered_expr',billing_expr:'tier("base", u("seconds") * 0.066666666667)',billing_usage_schema:{seconds:{type:'number',unit:'second',description:{zh:'视频生成单价'}}},enable_groups:['[低价][满血] Claude 原生']},'[低价][满血] Claude 原生');assert(Array.isArray(p.entries));assert.equal(p.entries[0].unit,'秒');assert(Math.abs(p.entries[0].value-0.1)<1e-9)});
test('分档用量显示价格区间而不是第一档冒充全部',()=>{const p=price({billing_mode:'tiered_expr',billing_expr:'u("resolution") == "480P" ? tier("480P", u("seconds") * 0.8) : tier("720P", u("seconds") * 1)',billing_usage_schema:{seconds:{unit:'second'}},enable_groups:[]});assert(Array.isArray(p.entries));assert.equal(p.entries[0].value,0.8);assert.equal(p.entries[0].max,1)});
test('选组卡片只展示该组且无其他组计数',()=>{const {c}=context('[低价][满血] Claude 原生');const card=c.modelCard(model);assert.deepEqual(nodes(card,n=>n.tag==='badge').map(x=>x.name),['[低价][满血] Claude 原生']);assert.equal(nodes(card,n=>n.attrs?.class==='mc-more').length,0)});
test('详情直达官方对应模型并保留筛选与计价参数',()=>{const {c}=context('[低价][满血] Claude 原生','topup');c.marketUnit='K';const a=nodes(c.modelCard(model),n=>n.tag==='a')[0];const u=new URL(a.attrs.href);assert.equal(u.pathname,'/pricing/claude-fable-5');assert.equal(u.searchParams.get('group'),'[低价][满血] Claude 原生');assert.equal(u.searchParams.get('tokenUnit'),'K');assert.equal(u.searchParams.get('rechargePrice'),'true')});
test('点击详情不会冒泡切换模型启停',()=>{const t=context();const card=t.c.modelCard(model),a=nodes(card,n=>n.tag==='a')[0];let stopped=false;a.attrs.onclick?.({stopPropagation:()=>stopped=true});if(!stopped)card.attrs.onclick();assert.equal(t.toggles(),0)});
