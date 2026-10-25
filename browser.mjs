import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'www.xhslink.com']);
export function validateXhsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw Error('只允许 HTTPS 小红书官方页面或官方分享链接。');
  }
  return url.href;
}
export function noteId(value) {
  return new URL(value).pathname.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1] || '';
}

// Write-ahead journal: a crash or uncertain outcome never silently triggers
// another submission of the same comment.
export class CommentJournal {
  constructor(file) { this.file = file; this.rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
  key(note, text) { return crypto.createHash('sha256').update(note + '\0' + text.trim()).digest('hex'); }
  save() {
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.rows), {mode:0o600});
    fs.renameSync(temp, this.file);
  }
  reserve(note, text) {
    const key = this.key(note, text);
    if (this.rows[key]) throw Error('这条笔记已有相同评论的提交记录，未重复发送。请先人工核对。');
    this.rows[key] = {status:'pending', at:Date.now()}; this.save(); return key;
  }
  finish(key, status) { this.rows[key].status = status; this.save(); }
}

export class XhsBrowser {
  constructor(config) {
    this.config = config; this.context = null; this.page = null; this.launching = null;
    this.journal = new CommentJournal(path.join(config.dataDir, 'comment-journal.json'));
  }
  async ensure() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.launching) this.launching = this.launch().finally(() => { this.launching = null; });
    await this.launching; return this.page;
  }
  async launch() {
    const module = process.env.PLAYWRIGHT_MODULE;
    const {chromium} = await import(module ? pathToFileURL(module).href : 'playwright');
    fs.mkdirSync(this.config.dataDir, {recursive:true});
    const options = {headless:this.config.headless, viewport:{width:430,height:860}, locale:'zh-CN'};
    if (this.config.channel && this.config.channel !== 'chromium') options.channel = this.config.channel;
    this.context = await chromium.launchPersistentContext(path.join(this.config.dataDir, 'xhs-profile'), options);
    this.context.setDefaultTimeout(12000);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.context.on('page', page => { if(page!==this.page) page.close().catch(()=>{}); }); // One controlled tab.
    // Never navigate the controlled main frame to a third-party credential page.
    await this.page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
        try { validateXhsUrl(request.url()); } catch { await route.abort(); return; }
      }
      await route.continue();
    });
    this.page.on('dialog', dialog => dialog.dismiss().catch(()=>{}));
  }
  async open(url = 'https://www.xiaohongshu.com/explore') {
    url = validateXhsUrl(url);
    const page = await this.ensure();
    await page.goto(url, {waitUntil:'domcontentloaded',timeout:45000});
    // Give client-rendered note text and media a bounded chance to load.
    await page.waitForLoadState('networkidle',{timeout:4000}).catch(()=>{});
    validateXhsUrl(page.url());
    return this.read();
  }
  async read() {
    const page = await this.ensure();
    if (page.url() === 'about:blank') return {url:page.url(),text:'尚未打开小红书。',needsOpen:true};
    validateXhsUrl(page.url());
    const result = await page.evaluate(() => {
      const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      const bodyText = document.body?.innerText || '';
      const login = [...document.querySelectorAll('.login-container,.login-modal,.login-mask')].some(visible);
      const verification = /请完成验证|安全验证|拖动滑块|验证码验证/.test(bodyText);
      const detail = [...document.querySelectorAll('.note-detail-mask,.note-detail,.note-container')].find(visible);
      const root = detail || document.querySelector('main') || document.body;
      const links = [...root.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]')]
        .filter(visible).map(el=>({url:el.href,title:(el.closest('.note-item,section')?.innerText || el.innerText || '').slice(0,500)}));
      const seen = new Set();
      const notes = links.filter(item => { const id=item.url.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/i)?.[1]; if(!id||seen.has(id)) return false; seen.add(id);return true; }).slice(0,20);
      const images = [...root.querySelectorAll('img')].filter(visible)
        .map(el=>({url:el.currentSrc||el.src,alt:el.alt||''})).filter(x=>/^https:\/\//.test(x.url)).slice(0,16);
      const text=(root.innerText||'').slice(0,16000);
      return {title:document.title,text,notes,images,hasVideo:!!root.querySelector('video'),contentMayBeIncomplete:/加载中|正在加载/.test(text),loginRequired:login,verificationRequired:verification};
    });
    result.url = page.url(); result.noteId = noteId(result.url);
    result.notes = result.notes.filter(item => { try {validateXhsUrl(item.url);return true;} catch{return false;} });
    if (this.config.vision && !result.loginRequired && !result.verificationRequired) {
      result.screenshot = 'data:image/jpeg;base64,' + (await page.screenshot({type:'jpeg',quality:65})).toString('base64');
    }
    return result;
  }
  async search(query) {
    query = String(query || '').trim();
    if (!query || query.length > 200) throw Error('搜索词须为 1–200 个字符。');
    return this.open('https://www.xiaohongshu.com/search_result?keyword='+encodeURIComponent(query)+'&source=web_explore_feed');
  }
  async scroll(direction = 'down') {
    const page = await this.ensure(); validateXhsUrl(page.url());
    const size=page.viewportSize();
    await page.mouse.move(size.width*.5,size.height*.65); await page.mouse.wheel(0,(direction === 'up' ? -1 : 1)*Math.round(size.height*.65));
    await page.waitForTimeout(250); return this.read();
  }
  async screenshot() { const page = await this.ensure(); return page.screenshot({type:'jpeg',quality:65}); }
  async control(input) {
    const page = await this.ensure();
    if (page.url() === 'about:blank') await this.open();
    validateXhsUrl(page.url());
    const size=page.viewportSize();
    const point=(x,y)=>{
      if(![x,y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('操作位置不正确。');
      return {x:Math.min(size.width-1,Math.round(x*size.width)),y:Math.min(size.height-1,Math.round(y*size.height))};
    };
    if (input.action === 'click') {
      const p=point(input.x,input.y);await page.mouse.click(p.x,p.y);
    } else if (input.action === 'type') {
      if (typeof input.text !== 'string' || input.text.length > 2000) throw Error('输入内容过长。');
      await page.keyboard.insertText(input.text);
    } else if (input.action === 'key' && ['Enter','Backspace','Tab','Escape','Control+A','Meta+A'].includes(input.key)) {
      await page.keyboard.press(input.key);
    } else if (input.action === 'scroll') {
      if(!['up','down'].includes(input.direction))throw Error('翻页方向不正确。');
      const p=point(input.x??.5,input.y??.65);
      const delta=input.delta??Math.round(size.height*.65);
      if(!Number.isFinite(delta)||delta<1||delta>1600)throw Error('翻页距离不正确。');
      await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,(input.direction==='up'?-1:1)*delta);
    } else if (input.action === 'swipe') {
      const from=point(input.fromX,input.fromY),to=point(input.toX,input.toY);
      const session=await this.context.newCDPSession(page);
      try{
        const touch=p=>[{...p,id:1,radiusX:2,radiusY:2,force:1}];
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touch(from)});
        for(let i=1;i<=8;i++){
          await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch({x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8})});
          await page.waitForTimeout(16);
        }
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }finally{await session.detach();}
    } else throw Error('不支持的操作。');
    await page.waitForTimeout(input.action==='scroll'||input.action==='swipe'?160:80);
    return {ok:true};
  }
  async comment(url, text) {
    if (!this.config.allowComments) throw Error('服务尚未开启真实评论发布。请由你在 .env 中设置 ALLOW_COMMENTS=true 后重启。');
    validateXhsUrl(url); const target = noteId(url);
    if (!target) throw Error('发表评论需要完整笔记链接，不能对搜索页或首页发送。');
    text = typeof text === 'string' ? text.trim() : '';
    if (!text || Array.from(text).length > 500) throw Error('评论须为 1–500 个字符。');
    const page = await this.ensure();
    if (noteId(page.url()) !== target) await this.open(url);
    const view = await this.read();
    if (view.loginRequired || view.verificationRequired) throw Error('请先在插件画面中完成登录或验证。没有发送评论。');
    const panel = page.locator('.note-detail-mask,.note-detail,.note-container').filter({visible:true}).first();
    if (!await panel.count()) throw Error('没有识别到笔记详情区域，未发送评论。');
    const input = panel.locator('#content-textarea,textarea[placeholder*="评论"],.comment-input [contenteditable="true"],[contenteditable="true"][data-placeholder*="评论"]').filter({visible:true}).first();
    if (!await input.count()) throw Error('没有识别到评论输入框；小红书页面可能变化。未发送评论。');
    await input.fill(text);
    const send = panel.getByRole('button',{name:/^(发送|发布)$/}).filter({visible:true});
    if (await send.count() !== 1 || !await send.isEnabled()) throw Error('没有找到唯一可用的评论发送按钮，未发送评论。');
    if (noteId(page.url()) !== target) throw Error('笔记页面发生变化，未发送评论。');
    const key = this.journal.reserve(target,text);
    try {
      await send.click(); // Exactly one submit attempt, never automatically retried.
      this.journal.finish(key,'submitted_unverified');
      return {status:'submitted_unverified',noteId:target,text,message:'已点击发送，但尚未独立确认发布成功。请查看页面结果，不要自动重复发送。'};
    } catch (error) {
      this.journal.finish(key,'unknown');
      throw Error('评论提交结果不确定。请人工核对，不要重复发送。');
    }
  }
  async close() { await this.context?.close(); this.context=null;this.page=null; }
}
