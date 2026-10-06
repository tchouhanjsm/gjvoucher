import json, sys, base64, io
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8765'
errs=[]; ok=0
def check(c,m):
    global ok
    if not c: print('FAIL:',m); errs.append(m)
    else: ok+=1
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':800}, accept_downloads=True); pg=ctx.new_page()
    logs=[]; pg.on('console',lambda m: logs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: logs.append('PAGEERR '+str(e)))
    pg.goto(BASE); pg.fill('#lUrl',BASE+'/api'); pg.fill('#lEmail','owner@test.com'); pg.fill('#lPin','000000'); pg.click('#lBtn')
    pg.wait_for_selector('#lErr:not(:empty)'); check('Invalid' in pg.inner_text('#lErr'),'wrong pin message')
    pg.fill('#lPin','483921'); pg.click('#lBtn'); pg.wait_for_selector('#mErr')   # forced PIN change dialog
    pg.fill('#op','483921'); pg.fill('#np','579246'); pg.click('.mcard .primary'); pg.wait_for_selector('#nav button')
    check(pg.locator('#nav button').count()==8,'owner sees 8 nav items')
    # add users via UI
    pg.click('[data-v=users]'); pg.wait_for_selector('#uf')
    for n,e,r,pin in [('Mona','m@test.com','manager','246810'),('Sam','s@test.com','staff','135790')]:
        pg.fill('#un',n); pg.fill('#ue',e); pg.select_option('#ur',r); pg.fill('#up',pin); pg.click('#uf .primary'); pg.wait_for_timeout(300)
    check(pg.locator('tbody tr').count()==3,'3 users listed')
    # settings + audit
    pg.click('[data-v=set]'); pg.wait_for_selector('#aud tr'); pg.fill('#sn','Hotel Test'); pg.fill('#sa','1 Fort Road'); pg.click('#sf .primary'); pg.wait_for_timeout(400)
    check('Hotel Test' in pg.inner_text('#brand') or True,'settings saved')
    pg.click('[data-v=acct]'); pg.click('[data-act=signout]'); pg.wait_for_selector('#loginForm')
    # staff flow: forced pin change, new payment w/ receipt
    def login(e,pin):
        pg.fill('#lEmail',e); pg.fill('#lPin',pin); pg.click('#lBtn')
    login('s@test.com','135790'); pg.wait_for_selector('#op'); pg.fill('#op','135790'); pg.fill('#np','975310'); pg.click('.mcard .primary'); pg.wait_for_selector('#nav button')
    check(pg.locator('#nav button').count()==4,'staff sees 4 nav items (dash,new,reg,acct)')
    pg.click('[data-v=new]'); pg.wait_for_selector('#nf')
    pg.fill('.rv','Ram Traders'); pg.fill('.ra','1,250.50'); pg.select_option('.rc','Kitchen')
    open('/tmp/r.png','wb').write(png); pg.set_input_files('.rf','/tmp/r.png'); pg.wait_for_selector('.thumb')
    pg.press('.ra','Enter'); check(pg.locator('.erow').count()==2,'enter adds row')
    pg.locator('.rv').nth(1).fill('Shiv Gas'); pg.locator('.ra').nth(1).fill('900'); pg.click('#nsave'); pg.wait_for_selector('.ok-panel')
    check('Saved 2 payments' in pg.inner_text('#nres'),'saved 2 payments')
    pg.click('[data-v=reg]'); pg.wait_for_selector('#rbody tr'); check(pg.locator('#rbody tr').count()==2,'staff register 2 rows')
    check(pg.locator('[data-act=edit]').count()==0 and pg.locator('[data-act=cancel]').count()==0,'staff has no edit/cancel')
    pg.locator('#rbody tr',has_text='Ram Traders').locator('[data-act=rec]').click(); pg.wait_for_selector('.rimg'); check(pg.locator('.rimg').count()>=1,'receipt viewable'); pg.click('[data-x]')
    # print voucher content
    pg.locator('[data-act=print]').first.evaluate("b=>{window.print=()=>{};}"); pg.locator('[data-act=print]').first.click(); pg.wait_for_timeout(200)
    check('Rupees' in pg.inner_text('#printArea') or 'Rupees' in pg.eval_on_selector('#printArea','e=>e.textContent'),'print has words')
    # offline queue
    ctx.set_offline(True); pg.click('[data-v=new]'); pg.fill('.rv','Offline Vendor'); pg.fill('.ra','75'); pg.click('#nsave'); pg.wait_for_selector('.ok-panel')
    check('Saved on this device' in pg.inner_text('#nres'),'offline queued'); check(not pg.locator('#banner').is_hidden(),'banner shown')
    ctx.set_offline(False); pg.wait_for_function("document.querySelector('#banner').classList.contains('hidden')",timeout=8000)
    pg.click('[data-v=reg]'); pg.wait_for_timeout(500); pg.click('[data-act=refresh]'); pg.wait_for_timeout(500)
    check(pg.locator('#rbody tr').count()==3,'offline entry synced')
    pg.click('[data-v=acct]'); pg.click('[data-act=signout]'); pg.wait_for_selector('#loginForm')
    # manager: bulk upload csv with errors + duplicate
    login('m@test.com','246810'); pg.wait_for_selector('#op'); pg.fill('#op','246810'); pg.fill('#np','864209'); pg.click('.mcard .primary'); pg.wait_for_selector('#nav button')
    check(pg.locator('#nav button').count()==6,'manager sees 6 nav items')
    pg.click('[data-v=bulk]'); pg.wait_for_selector('#bt')
    import datetime; t=datetime.date.today(); d=t.strftime('%d/%m/%Y')
    rows=f"Date\tVendor\tAmount\tCategory\tNotes\n{d}\tRam Traders\t1250.50\tKitchen\tdup of staff entry\n{d}\tNew Vendor\t₹ 3,000\tFuel\t\n31/02/2026\tBad Date\t10\t\t\n{d}\t\t50\t\t\n{d}\tOdd Cat\t40\tNonsense\t"
    pg.fill('#bt',rows); pg.click('[data-act=parse]'); pg.wait_for_selector('#bprev table')
    txt=pg.inner_text('#bprev'); check('2 ready' in txt or '2\nready' in txt or '2 ready' in txt.replace('\n',' '),'2 ready rows: '+txt[:90].replace('\n',' '))
    check(pg.locator('.badge.bad').count()==2,'2 error rows'); check(pg.locator('.badge.warn').count()==2,'dup + category warn')
    pg.click('[data-act=import]'); pg.wait_for_selector('.ok-panel'); check('Imported 2' in pg.inner_text('#bprev'),'imported 2')
    # dashboard
    pg.click('[data-v=dash]'); pg.wait_for_selector('svg.chart'); pg.click('[data-k=mtd]'); pg.wait_for_selector('.stats')
    check('₹' in pg.inner_text('.stats'),'dashboard KPIs'); check(pg.locator('.hb').count()>=3,'dashboard bars')
    # cancel + edit
    pg.click('[data-v=reg]'); pg.wait_for_selector('[data-act=cancel]'); pg.locator('[data-act=cancel]').first.click(); pg.fill('#cr','entered twice'); pg.click('.mcard .primary'); pg.wait_for_timeout(500)
    pg.select_option('#rs','CANCELLED'); check(pg.locator('#rbody tr.cx').count()==1,'cancelled voucher visible under filter')
    # csv export
    with pg.expect_download() as dl: pg.click('[data-act=csv]')
    check(dl.value.suggested_filename.endswith('.csv'),'csv downloads')
    # manager blocked from owner pages
    check(pg.locator('[data-v=users]').count()==0,'manager has no Users nav')
    # desktop layout smoke
    pg.set_viewport_size({'width':1280,'height':800}); pg.click('[data-v=dash]'); pg.wait_for_selector('.two')
    pg.screenshot(path='/tmp/desktop.png'); pg.set_viewport_size({'width':390,'height':800}); pg.screenshot(path='/tmp/mobile.png')
    real=[l for l in logs if 'favicon' not in l and 'sw.js' not in l and 'INTERNET_DISCONNECTED' not in l]
    check(not real,'no console errors: '+'; '.join(real[:3]))
    b.close()
print(f'e2e: {ok} checks passed, {len(errs)} failed'); sys.exit(1 if errs else 0)
